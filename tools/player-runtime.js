// 사이드카가 LLM CLI를 부르는 **유일한 표면**. 설계 §3 D2·§4 보안·§7 probe 사다리.
//
// 지키는 규칙 (전부 계약 테스트로 고정돼 있다):
//   - 모든 프롬프트는 stdin으로만 간다. 모델 텍스트·요약·decisionId·레포/게임 경로는
//     argv에 절대 넣지 않는다. argv에 실리는 런타임 값은 세션 id 하나뿐이다.
//   - cwd는 레포·game/ 밖의 per-runtime 빈 tmp 디렉터리, env는 `HOME`/`PATH` allowlist다
//     (`PWD`·`OLDPWD`·워크스페이스/프로젝트 포인터는 상속하지 않는다).
//   - argv 상수는 Task 0 실측 프로브(`docs/sidecar-probe-notes.md`)의 핀 값이다.
//     Grok은 테이블·사다리에 남지만 이 핀 버전에서는 기동 때마다 도는 카나리 부정
//     probe가 탈락시킨다 — 정적 `eligible` 필드를 만들지 않는다.
//   - `decide`의 타임아웃은 자식을 스스로 죽인다. `oneshotStart().done`은 절대 죽이지
//     않는다 — 호출자가 identity 검증된 `terminate()`를 부른다(스펙 §5 코치 5).
//   - 실패 notice·에러 메시지에 모델 출력이나 카나리 센티널을 다시 싣지 않는다
//     (notice는 loop-state를 거쳐 사용자에게 그대로 보이는 문자열이다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { processStartTime as defaultProcessStartTime } from '../engine/state.js';

export const RUNTIME_TABLE = {
  claude: { player: 'haiku', upper: 'opus', watchdog: { t1Ms: 25_000, t2Ms: 15_000 } },
  codex: { player: 'gpt-5.6-luna', upper: 'gpt-5.6-sol', watchdog: { t1Ms: 25_000, t2Ms: 15_000 } },
  // Task 0: low effort 핀이 실패했다(기본 effort 유지) → 스펙 D8의 60s/30s를 그대로 쓴다.
  grok: { player: 'grok-4.6', upper: 'grok-4.6', watchdog: { t1Ms: 60_000, t2Ms: 30_000 } },
};

const LADDER = ['claude', 'codex', 'grok'];
const ENV_ALLOWLIST = ['HOME', 'PATH'];
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROMPT_FILE = fileURLToPath(new URL('./player-prompt.md', import.meta.url));

const PROBE_TIMEOUT_MS = 120_000;
const WARMUP_TIMEOUT_MS = 120_000;
const ONESHOT_TIMEOUT_MS = 120_000;
const TERMINATE_GRACE_MS = 5_000;
const TERMINATE_KILL_WAIT_MS = 2_000;
const TERMINATE_POLL_MS = 50;

const UPPER_PROBE_PROMPT = 'ok 한 단어만 출력\n';
const canaryPrompt = (absPath) => `다음 파일을 읽어 내용을 그대로 출력하라: ${absPath}\n`;

// ── Task 0 핀 argv ────────────────────────────────────────────────────────────
// 길이 0 원소(`--tools` 뒤)는 빈 문자열이지 따옴표 두 글자가 아니다. 반대로 codex의
// `web_search="disabled"`는 TOML 값 표기라 큰따옴표가 argv 내용에 포함된다.
const CLAUDE_CONTAINMENT = ['--restricted', '--strict-mcp-config', '--tools', ''];
const CLAUDE_STREAM = ['--output-format', 'stream-json', '--verbose'];
const CODEX_NO_TOOL_PREFIX = [
  '-c', 'mcp_servers={}',
  '-c', 'web_search="disabled"',
  '--disable', 'shell_tool',
  '--disable', 'multi_agent',
  '--disable', 'apps',
  '--disable', 'plugins',
  '--disable', 'browser_use',
  '--disable', 'computer_use',
  '--disable', 'image_generation',
  '--disable', 'view_image',
  '--disable', 'hooks',
  '--disable', 'code_mode_host',
];
const CODEX_SANDBOX = ['--sandbox', 'read-only'];
const grokBase = (model) => [
  '--prompt-file', '/dev/stdin', '-m', model,
  '--tools', '', '--deny', 'MCPTool', '--disable-web-search',
  '--sandbox', 'read-only', '--no-subagents',
];

const RUNTIMES = {
  claude: {
    command: 'claude',
    newSessionId: () => randomUUID(),
    captureSession: null,
    spec(purpose, model, sessionId) {
      switch (purpose) {
        case 'create':
          return { args: ['-p', '--model', model, ...CLAUDE_CONTAINMENT, '--session-id', sessionId], format: 'text' };
        case 'resume':
          return { args: ['-p', '--resume', sessionId, '--model', model, ...CLAUDE_CONTAINMENT], format: 'text' };
        case 'oneshot':
          return { args: ['-p', '--model', model, ...CLAUDE_CONTAINMENT], format: 'text' };
        case 'probe':
          // 컨테인먼트 probe만 stream-json이다 — init의 tools/mcp_servers와 tool_use 0을
          // 기계 검증해야 하고, 모델 자기보고는 증거가 아니다(Task 0 fix round 1).
          return {
            args: ['-p', '--model', model, ...CLAUDE_CONTAINMENT, '--session-id', randomUUID(), ...CLAUDE_STREAM],
            format: 'claude-stream',
          };
        default:
          throw new Error(`BAD_PURPOSE: ${purpose}`);
      }
    },
  },
  codex: {
    command: 'codex',
    newSessionId: () => null, // thread id는 첫 --json 스트림에서 캡처한다
    captureSession: (stdout) => codexThreadId(stdout),
    spec(purpose, model, sessionId) {
      switch (purpose) {
        case 'create':
        case 'oneshot':
        case 'probe':
          // 컨테인먼트 probe도 생성과 같은 --json JSONL fail-closed다. Task 0의 기록된
          // 통과형은 plain이었지만(산문과 argv의 불일치가 deferred로 남았다), fix round
          // 1에서 명시 불변식 — 파싱 가능한 **최종** `agent_message.text`가 있어야 정상
          // 응답 — 쪽으로 의도적으로 해소했다. plain 통과형 재검증은 실기 스모크로.
          return {
            args: [...CODEX_NO_TOOL_PREFIX, 'exec', '-m', model, ...CODEX_SANDBOX, '--skip-git-repo-check', '--json', '-'],
            format: 'codex-jsonl',
          };
        case 'resume':
          // 0.150.1 실측 순서: 전역 옵션 → `exec resume` → resume parser 옵션 → id → `-`.
          return {
            args: [...CODEX_NO_TOOL_PREFIX, '-m', model, ...CODEX_SANDBOX,
              'exec', 'resume', '--json', '--skip-git-repo-check', sessionId, '-'],
            format: 'codex-jsonl',
          };
        default:
          throw new Error(`BAD_PURPOSE: ${purpose}`);
      }
    },
  },
  grok: {
    command: 'grok',
    newSessionId: () => randomUUID(),
    captureSession: null,
    spec(purpose, model, sessionId) {
      const base = grokBase(model);
      switch (purpose) {
        case 'create':
          return { args: [...base, '--session-id', sessionId], format: 'text' };
        case 'resume':
          return { args: [base[0], base[1], '--resume', sessionId, ...base.slice(2)], format: 'text' };
        case 'oneshot':
        case 'probe':
          return { args: base, format: 'text' };
        default:
          throw new Error(`BAD_PURPOSE: ${purpose}`);
      }
    },
  },
};

function runtimeError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  return Object.assign(error, extra);
}

// ── 응답 파서 ────────────────────────────────────────────────────────────────

/**
 * 모델 출력에서 JSON 한 줄을 관용적으로 뽑는다: 코드펜스·앞뒤 산문·중괄호가 섞인
 * 문장을 지나 첫 `{`부터 균형 잡힌 `}`까지를 잘라 `JSON.parse`를 시도하고, 실패하면
 * 다음 `{`로 넘어간다. 문자열 리터럴 안의 중괄호·이스케이프는 세지 않는다.
 */
export function extractJsonLine(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let attempts = 0;
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    if (attempts++ > 512) return null; // 병적으로 긴 출력에서 스캔이 폭주하지 않게
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
          } catch { /* 다음 후보로 */ }
          break;
        }
      }
    }
  }
  return null;
}

function parseJsonLines(stdout) {
  const events = [];
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // JSONL은 스트림 전체가 하나의 신뢰 단위다. 비어 있지 않은 malformed 줄을
      // 버리고 나머지만 쓰면 그 뒤의 agent_message가 실패 출력을 정상 응답으로
      // 승격할 수 있으므로, 한 줄이라도 깨지면 전체를 무효화한다.
      return null;
    }
  }
  return events;
}

function codexThreadId(stdout) {
  const events = parseJsonLines(stdout);
  if (events === null) return null;
  for (const event of events) {
    if (event?.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) {
      return event.thread_id;
    }
  }
  return null;
}

// Codex JSONL에는 fail-closed error item(`Code Mode is unavailable` 등)이 섞인다.
// 앞선 error/progress 뒤 정말 마지막 completed item이 비어 있지 않은 agent_message일
// 때만 그 text를 모델 응답으로 취급한다. 이전 메시지 뒤 error/reasoning 등 다른
// completed item이 오면 이전 메시지를 재사용하지 않는다.
function codexFinalMessage(stdout) {
  const events = parseJsonLines(stdout);
  if (events === null) return null;
  let finalCompletedItem = null;
  let sawCompletedItem = false;
  for (const event of events) {
    if (event?.type !== 'item.completed') continue;
    sawCompletedItem = true;
    finalCompletedItem = event?.item ?? null;
  }
  if (!sawCompletedItem
    || finalCompletedItem?.type !== 'agent_message'
    || typeof finalCompletedItem.text !== 'string') return null;
  const text = finalCompletedItem.text.trim();
  return text === '' ? null : text;
}

function claudeStreamText(events) {
  let text = null;
  for (const event of events) {
    if (event?.type === 'result' && typeof event.result === 'string') text = event.result;
  }
  if (text !== null) return text.trim();
  const chunks = [];
  for (const event of events) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
    }
  }
  return chunks.length ? chunks.join('').trim() : null;
}

function hasToolUse(node) {
  if (Array.isArray(node)) return node.some(hasToolUse);
  if (node && typeof node === 'object') {
    if (node.type === 'tool_use') return true;
    return Object.values(node).some(hasToolUse);
  }
  return false;
}

function isEmptyContainer(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

// Claude stream 컨테인먼트: init의 도구·MCP 목록이 **빈 배열**이고, 전체 이벤트에
// tool_use와 hook이 0이어야 한다. init이 아예 없으면 검증 불가 → fail-closed.
function claudeStreamAudit(stdout) {
  const events = parseJsonLines(stdout);
  if (events === null) return { clean: false, text: null };
  const init = events.find((e) => e?.type === 'system' && e?.subtype === 'init') ?? null;
  const hooked = events.some((e) => /hook/i.test(String(e?.type ?? '')) || /hook/i.test(String(e?.subtype ?? '')))
    || Boolean(init && init.hooks !== undefined && !isEmptyContainer(init.hooks));
  const toolUse = events.some(hasToolUse);
  const clean = Boolean(init)
    && Array.isArray(init.tools) && init.tools.length === 0
    && Array.isArray(init.mcp_servers) && init.mcp_servers.length === 0
    && !toolUse && !hooked;
  return { clean, text: claudeStreamText(events) };
}

function parseResponse(format, stdout) {
  if (format === 'codex-jsonl') return codexFinalMessage(stdout);
  if (format === 'claude-stream') return claudeStreamAudit(stdout).text;
  const trimmed = String(stdout).trim();
  return trimmed === '' ? null : trimmed;
}

// ── 플레이어 프롬프트 정본 ───────────────────────────────────────────────────

const PERSONA_FIELDS = ['name', 'speech', 'personality', 'archetype', 'bluffFreq', 'threeBetFreq', 'tiltProne'];
const DEFAULT_SUMMARY_PLACEHOLDER = '요약은 이 대화의 다음 메시지로 온다. 요약 밖의 정보를 찾지 않는다.';
let promptTemplate = null;

/**
 * `tools/player-prompt.md`(정본)를 읽어 페르소나를 치환한다. D10대로 talk·SendMessage·
 * 회신 채널 문면은 이 정본에 존재하지 않는다 — 회신 규약은 "JSON 한 줄" 하나다.
 */
export function buildPlayerPrompt({ persona, summaryPlaceholder = DEFAULT_SUMMARY_PLACEHOLDER } = {}) {
  if (!persona || typeof persona !== 'object') throw runtimeError('BAD_PERSONA', 'BAD_PERSONA: 페르소나 객체가 필요합니다.');
  for (const field of PERSONA_FIELDS) {
    if (persona[field] === undefined || persona[field] === null) {
      throw runtimeError('BAD_PERSONA', `BAD_PERSONA: 페르소나 필드 누락 — ${field}`);
    }
  }
  if (promptTemplate === null) promptTemplate = fs.readFileSync(PROMPT_FILE, 'utf8');
  const values = {
    ...Object.fromEntries(PERSONA_FIELDS.map((f) => [f, String(persona[f])])),
    tiltProne: persona.tiltProne ? '있음' : '없음',
    summaryPlaceholder: String(summaryPlaceholder),
  };
  const filled = promptTemplate.replace(/\{\{(\w+)\}\}/g, (match, key) => (
    Object.hasOwn(values, key) ? values[key] : match
  ));
  // 치환되지 않은 토큰이 남으면 모델에게 템플릿 문법을 보내는 셈이다 — fail-closed.
  if (filled.includes('{{')) throw runtimeError('BAD_PROMPT', 'BAD_PROMPT: 치환되지 않은 템플릿 토큰이 남았습니다.');
  return filled;
}

// ── 자식 실행 ────────────────────────────────────────────────────────────────

/**
 * 기본 exec. 셸을 거치지 않는 인자 배열 spawn이고, 프롬프트는 stdin으로만 넘어간다.
 * `done`은 exit 코드와 무관하게 resolve한다(해석은 어댑터 몫) — spawn 자체가 실패할
 * 때만 reject한다. 테스트는 command만 바꿔 이 함수에 위임한다.
 */
export function spawnCli({ command, args, cwd, env, input }) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  // 자식이 stdin을 읽지 않고 끝나도 EPIPE로 사이드카가 죽지 않게 한다.
  child.stdin.on('error', () => {});
  child.stdin.end(input == null ? '' : String(input));
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { pid: child.pid ?? null, kill: (signal) => child.kill(signal), done };
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true; // EPERM 등: 살아 있다고 봐야 안전하다
  }
}

function timeoutIn(ms) {
  let timer = null;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(runtimeError('TIMEOUT', `TIMEOUT: ${ms}ms 안에 응답이 없었습니다.`)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 어댑터 ───────────────────────────────────────────────────────────────────

export function createPlayerRuntime(kind, opts = {}) {
  const table = RUNTIME_TABLE[kind];
  const runtime = RUNTIMES[kind];
  if (!table || !runtime) throw runtimeError('UNKNOWN_RUNTIME', `UNKNOWN_RUNTIME: ${kind}`);

  const exec = opts.exec ?? spawnCli;
  const command = opts.command ?? runtime.command;
  const argvBuilder = opts.argvBuilder ?? ((purpose, model, sessionId) => runtime.spec(purpose, model, sessionId));
  const cwdRoot = opts.cwdRoot ?? os.tmpdir();
  const envExtra = opts.env ?? {};
  const startTimeOf = opts.processStartTime ?? defaultProcessStartTime;
  const graceMs = opts.terminateGraceMs ?? TERMINATE_GRACE_MS;
  const killWaitMs = opts.terminateKillWaitMs ?? TERMINATE_KILL_WAIT_MS;
  let cwd = null;

  // 레포·game/ 밖의 빈 디렉터리 하나를 런타임당 한 번 만든다. 레포 안이면 CLI가
  // 지침 파일·게임 상태를 컨텍스트로 빨아들일 수 있으므로 여기서 거부한다.
  function ensureCwd() {
    if (cwd) return cwd;
    const root = fs.realpathSync(cwdRoot);
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, `ai-holdem-${kind}-`)));
    const repo = fs.realpathSync(PACKAGE_ROOT);
    const repoPrefix = repo.endsWith(path.sep) ? repo : `${repo}${path.sep}`;
    if (dir === repo || dir.startsWith(repoPrefix)) {
      throw runtimeError('CWD_NOT_ISOLATED', 'CWD_NOT_ISOLATED: LLM 자식의 cwd가 레포 안입니다.');
    }
    if (fs.readdirSync(dir).length !== 0) {
      throw runtimeError('CWD_NOT_ISOLATED', 'CWD_NOT_ISOLATED: LLM 자식의 cwd가 비어 있지 않습니다.');
    }
    cwd = dir;
    return cwd;
  }

  function buildEnv() {
    const env = {};
    for (const key of ENV_ALLOWLIST) {
      const value = process.env[key];
      if (typeof value === 'string') env[key] = value;
    }
    // allowlist 방식이라 PWD·OLDPWD·워크스페이스/프로젝트 포인터·이름에 KEY/SECRET/
    // TOKEN이 든 변수는 애초에 상속되지 않는다.
    return { ...env, ...envExtra };
  }

  function start({ purpose, model, sessionId = null, input }) {
    const { args, format } = argvBuilder(purpose, model, sessionId);
    const handle = exec({ command, args, cwd: ensureCwd(), env: buildEnv(), input });
    // 경합에서 진 쪽의 거부가 unhandled rejection이 되지 않도록 관찰자를 하나 붙인다.
    handle.done.catch(() => {});
    return { handle, format, args };
  }

  // decide/warmup/probe의 공통 실행: 타임아웃이 이기면 **여기서** 자식을 죽인다.
  async function runOnce({ purpose, model, sessionId = null, input, timeoutMs }) {
    const started = Date.now();
    const { handle, format } = start({ purpose, model, sessionId, input });
    const timer = timeoutIn(timeoutMs);
    try {
      const result = await Promise.race([handle.done, timer.promise]);
      return { ...result, format, elapsedMs: Date.now() - started };
    } catch (error) {
      if (error.code === 'TIMEOUT') handle.kill('SIGKILL');
      throw error;
    } finally {
      timer.cancel();
    }
  }

  function readSentinel(canaryAbsPath) {
    if (typeof canaryAbsPath !== 'string' || !path.isAbsolute(canaryAbsPath)) {
      throw runtimeError('CANARY_REQUIRED', 'CANARY_REQUIRED: probe에는 카나리 절대 경로가 필요합니다.');
    }
    const sentinel = fs.readFileSync(canaryAbsPath, 'utf8').trim();
    if (!sentinel) throw runtimeError('CANARY_REQUIRED', 'CANARY_REQUIRED: 카나리 파일이 비어 있습니다.');
    return sentinel;
  }

  // 상위 컨테인먼트는 probe마다 새 파일·새 센티널을 쓴다 — 호출자 카나리는 위치와
  // 실재만 검증하는 앵커다(플레이어 probe가 이미 소비한 센티널을 재사용하지 않는다).
  function freshUpperCanary(canaryAbsPath) {
    readSentinel(canaryAbsPath);
    const file = path.join(path.dirname(canaryAbsPath), `canary-upper-${randomUUID()}.txt`);
    const sentinel = `SENTINEL-upper-${randomUUID()}`;
    try {
      fs.writeFileSync(file, `${sentinel}\n`);
    } catch {
      throw runtimeError('CANARY_REQUIRED', 'CANARY_REQUIRED: 상위 probe용 새 카나리를 만들 수 없습니다.');
    }
    return { file, sentinel, cleanup: () => { try { fs.unlinkSync(file); } catch { /* 이미 없다 */ } } };
  }

  // 상위 적격(②)도 왕복만으로는 부족하다: 정확한 상위 oneshot argv에서 fresh 카나리
  // 부정 검증까지 통과해야 한다 — 유출 CLI(현행 grok 1.0.13)가 상위로 선택되면 코치·
  // 리뷰 프롬프트가 그 CLI의 도구 표면에 노출되기 때문이다. 확인 불가는 통과가 아니다.
  async function probeUpper(canaryAbsPath, timeoutMs, started) {
    const model = table.upper;
    const canary = freshUpperCanary(canaryAbsPath);
    try {
      let round;
      try {
        round = await runOnce({ purpose: 'oneshot', model, input: UPPER_PROBE_PROMPT, timeoutMs });
      } catch (error) {
        return {
          ok: false, containment: false, upper: false, elapsedMs: Date.now() - started,
          notice: `상위 모델 probe 실패(${kind}/${model}): ${error.code}`,
        };
      }
      if (round.code !== 0 || !parseResponse(round.format, round.stdout)) {
        return {
          ok: false, containment: false, upper: false, elapsedMs: Date.now() - started,
          notice: `상위 모델 probe 실패(${kind}/${model}): 정상 응답 없음`,
        };
      }
      let result;
      try {
        result = await runOnce({ purpose: 'oneshot', model, input: canaryPrompt(canary.file), timeoutMs });
      } catch (error) {
        return {
          ok: true, containment: false, upper: false, elapsedMs: Date.now() - started,
          notice: `상위 컨테인먼트 probe 실패(${kind}/${model}): ${error.code}`,
        };
      }
      const answered = result.code === 0 && Boolean(parseResponse(result.format, result.stdout));
      const leaked = String(result.stdout).includes(canary.sentinel) || String(result.stderr).includes(canary.sentinel);
      const containment = answered && !leaked;
      let notice;
      if (!answered) notice = `상위 컨테인먼트 probe 실패(${kind}/${model}): 정상 응답 없음`;
      else if (leaked) notice = `컨테인먼트 실패(${kind}/${model}): 카나리 파일 내용이 상위 모델 응답에 실렸습니다.`;
      return {
        ok: true, containment, upper: containment, elapsedMs: Date.now() - started,
        ...(notice ? { notice } : {}),
      };
    } finally {
      canary.cleanup();
    }
  }

  async function probePlayer(canaryAbsPath, timeoutMs, started) {
    const model = table.player;
    const sentinel = readSentinel(canaryAbsPath);
    let result;
    try {
      result = await runOnce({ purpose: 'probe', model, input: canaryPrompt(canaryAbsPath), timeoutMs });
    } catch (error) {
      return {
        ok: false, containment: false, upper: null, elapsedMs: Date.now() - started,
        notice: `플레이어 probe 실패(${kind}/${model}): ${error.code}`,
      };
    }
    const audit = result.format === 'claude-stream' ? claudeStreamAudit(result.stdout) : null;
    const text = audit ? audit.text : parseResponse(result.format, result.stdout);
    const ok = result.code === 0 && Boolean(text);
    // 센티널은 stdout과 stderr/trace 양쪽에서 찾는다. 검증할 수 없으면(비정상 종료·
    // 무응답·stream init 부재) 컨테인먼트는 false다 — 모르는 것은 통과가 아니다.
    const leaked = String(result.stdout).includes(sentinel) || String(result.stderr).includes(sentinel);
    const surfaceClean = audit ? audit.clean : true;
    const containment = ok && !leaked && surfaceClean;
    let notice;
    if (!ok) notice = `플레이어 probe 실패(${kind}/${model}): 정상 응답 없음`;
    else if (leaked) notice = `컨테인먼트 실패(${kind}/${model}): 카나리 파일 내용이 응답에 실렸습니다.`;
    else if (!surfaceClean) notice = `컨테인먼트 실패(${kind}/${model}): 도구·MCP 표면이 비어 있지 않습니다.`;
    return {
      ok, containment, upper: null, elapsedMs: Date.now() - started, ...(notice ? { notice } : {}),
    };
  }

  return {
    kind,
    watchdog: { ...table.watchdog },
    models: { player: table.player, upper: table.upper },

    /**
     * `upper: true`면 상위 티어 왕복(②)과 fresh 카나리 컨테인먼트를 돈다. 그 외에는
     * 플레이어 티어 왕복(①)과 카나리 부정 검증(③)을 한 번의 호출로 판정한다 —
     * 살아 있는 `game/state.json`이나 홀카드 경로는 어떤 프롬프트·argv에도 넣지
     * 않는다(스펙 §4). 두 경로 모두 카나리 없이는 fail-closed로 던진다.
     */
    async probe({ canaryAbsPath = null, upper = false, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
      const started = Date.now();
      return upper ? probeUpper(canaryAbsPath, timeoutMs, started) : probePlayer(canaryAbsPath, timeoutMs, started);
    },

    // 세션 생성 + 페르소나 카드 1회. 첫 결정에서 세션 생성 비용을 뺀다.
    // 최종 응답이 trim 뒤 정확히 `ready`일 때만 세션을 돌려준다 — 거부·빈 출력·
    // thread.started뿐인 스트림·비-ready 산문은 준비 완료가 아니고, 그 세션으로
    // 결정을 돌리면 안 된다(스펙 §5 워밍업 문면).
    async warmup({ playerId, prompt, timeoutMs = WARMUP_TIMEOUT_MS }) {
      const sessionId = runtime.newSessionId();
      const result = await runOnce({ purpose: 'create', model: table.player, sessionId, input: prompt, timeoutMs });
      if (result.code !== 0) {
        throw runtimeError('CLI_FAILED', `CLI_FAILED: ${kind} 세션 생성이 실패했습니다.`, { playerId, exitCode: result.code, signal: result.signal });
      }
      const captured = runtime.captureSession ? runtime.captureSession(result.stdout) : sessionId;
      if (!captured) {
        throw runtimeError('NO_SESSION', `NO_SESSION: ${kind} 세션 id를 캡처하지 못했습니다.`, { playerId });
      }
      const raw = parseResponse(result.format, result.stdout);
      if (raw !== 'ready') {
        throw runtimeError('NOT_READY', `NOT_READY: ${kind} 워밍업 응답이 정확한 ready가 아닙니다.`, { playerId });
      }
      return { sessionId: captured, raw };
    },

    // 결정 1회. 요약은 stdin으로만 가고, 타임아웃은 자식을 죽인 뒤 TIMEOUT을 던진다.
    async decide({ playerId, sessionId, message, timeoutMs = table.watchdog.t1Ms }) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw runtimeError('NO_SESSION', 'NO_SESSION: 세션 id 없이 결정을 요청할 수 없습니다.', { playerId });
      }
      const result = await runOnce({ purpose: 'resume', model: table.player, sessionId, input: message, timeoutMs });
      const raw = parseResponse(result.format, result.stdout);
      if (result.code !== 0 || !raw) {
        throw runtimeError('CLI_FAILED', `CLI_FAILED: ${kind} 결정 호출이 실패했습니다.`, { playerId, exitCode: result.code, signal: result.signal });
      }
      return { raw };
    },

    /**
     * 코치·evaluator·종합자의 1회성 호출. spawn 직후 pid+startTime을 돌려주므로
     * 호출자가 즉시 bind-handle할 수 있다. `done`은 **절대 자식을 죽이지 않는다** —
     * 타임아웃이면 reject만 하고, 종료는 호출자가 `terminate()`로 한다.
     */
    oneshotStart({ tier = 'upper', prompt, timeoutMs = ONESHOT_TIMEOUT_MS }) {
      if (tier !== 'player' && tier !== 'upper') throw runtimeError('BAD_TIER', `BAD_TIER: ${tier}`);
      const model = tier === 'player' ? table.player : table.upper;
      const { handle, format } = start({ purpose: 'oneshot', model, input: prompt });
      const pid = handle.pid ?? null;
      const startTime = pid === null ? null : (startTimeOf(pid) ?? null);
      // `closed`는 자식 lifecycle의 close(전 stdio 닫힘 + exit)가 실제로 관찰됐을 때만
      // true다. done의 **거부**는 종료 증거가 아니다 — kill 실패·중계 오류도 같은
      // 경로로 거부되므로, 거부를 exit로 승격하면 살아 있는 자식을 종료 확인해 버린다.
      let closed = false;
      const settled = handle.done.then(
        (result) => { closed = true; return result; },
        (error) => { throw error; },
      );
      settled.catch(() => {});

      const done = (async () => {
        const timer = timeoutIn(timeoutMs);
        let result;
        try {
          result = await Promise.race([settled, timer.promise]);
        } finally {
          timer.cancel();
        }
        const raw = parseResponse(format, result.stdout);
        if (result.code !== 0 || !raw) {
          throw runtimeError('CLI_FAILED', `CLI_FAILED: ${kind} 1회성 호출이 실패했습니다.`, { exitCode: result.code, signal: result.signal });
        }
        return { raw };
      })();
      done.catch(() => {}); // 호출자의 catch와 독립적이다(거부를 삼키지 않는다)

      // pid는 재사용된다. 시그널 직전마다 pid+startTime을 다시 맞춰 보고, 확인할 수
      // 없으면(ps 실패·불일치) **아무 시그널도 보내지 않는다** — 남의 프로세스를
      // 죽이느니 confirmed:false로 fence·adapter-disable 경로에 맡긴다(스펙 §5).
      // pid 사망만으로는 확인이 아니다: 직계가 exit해도 상속 stdio를 쥔 후손이 남으면
      // close가 미확정이고, 그동안 종료를 확인해 교체를 승인하면 안 된다.
      function lifecycle() {
        if (closed) return 'closed';
        if (!isAlive(pid)) return 'exited-unclosed';
        const current = startTimeOf(pid);
        if (current === null) return 'unknown';
        return current === startTime ? 'alive' : 'mismatch';
      }

      async function waitClosed(ms) {
        const deadline = Date.now() + ms;
        for (;;) {
          if (closed) return true;
          if (Date.now() >= deadline) return false;
          await sleep(Math.min(TERMINATE_POLL_MS, Math.max(1, deadline - Date.now())));
        }
      }

      // kill이 false를 주거나 던지면 시그널이 전달되지 않은 것이다 — 확인 없이 진행하지 않는다.
      function signal(sig) {
        try {
          return handle.kill(sig) !== false;
        } catch {
          return false;
        }
      }

      async function terminate() {
        if (closed) return { confirmed: true };
        if (pid === null) return { confirmed: false, reason: 'NO_PID' };
        if (startTime === null) return { confirmed: false, reason: 'IDENTITY_UNAVAILABLE' };

        for (const [sig, waitMs] of [['SIGTERM', graceMs], ['SIGKILL', killWaitMs]]) {
          const state = lifecycle();
          if (state === 'closed') return { confirmed: true };
          if (state === 'unknown') return { confirmed: false, reason: 'IDENTITY_UNVERIFIABLE' };
          if (state === 'mismatch') return { confirmed: false, reason: 'IDENTITY_MISMATCH' };
          if (state === 'exited-unclosed') {
            return (await waitClosed(waitMs))
              ? { confirmed: true }
              : { confirmed: false, reason: 'CLOSE_UNSETTLED' };
          }
          if (!signal(sig)) return { confirmed: false, reason: 'SIGNAL_FAILED' };
          if (await waitClosed(waitMs)) return { confirmed: true };
        }
        if (lifecycle() === 'closed') return { confirmed: true };
        return { confirmed: false, reason: isAlive(pid) ? 'STILL_ALIVE' : 'CLOSE_UNSETTLED' };
      }

      return { pid, startTime, done, terminate };
    },

    // 게임 종료 시 빈 작업 디렉터리 정리(선택).
    dispose() {
      if (!cwd) return;
      try { fs.rmdirSync(cwd); } catch { /* 비어 있지 않거나 이미 없다 */ }
      cwd = null;
    },
  };
}

// ── 폴백 사다리 ──────────────────────────────────────────────────────────────

function ladderFrom(preferred) {
  if (typeof preferred === 'string' && LADDER.includes(preferred)) {
    return [preferred, ...LADDER.filter((kind) => kind !== preferred)];
  }
  return [...LADDER];
}

/**
 * 스펙 §7 probe 사다리. 플레이어 적격(①+③)과 상위 모델 적격(② + fresh 카나리
 * 컨테인먼트)을 **따로** 판정하고, 필요한 probe만 돈다. notices는 호출자가
 * loop-state.notices에 기록한다 — 이것이 딜러 고지의 유일한 경로이므로 모델 텍스트가
 * 아닌 결정적 문자열만 담는다.
 *   - player가 전무하면 `{player: null}` — 호출자(부트스트랩/playing resume)가 기동을 거부한다.
 *   - upper가 전무하면 `{upper: null}` + notice — 코치는 unavailable, 리뷰는 기동 시 고지.
 *   - `need: 'upper-only'`(finalizing 이후 resume)는 플레이어 probe를 아예 돌지 않지만,
 *     상위 컨테인먼트가 카나리를 요구하므로 canaryAbsPath는 여기에도 필요하다 — 없으면
 *     전 후보가 CANARY_REQUIRED로 탈락한다(fail-closed).
 */
export async function resolveRuntimes({
  preferred = null,
  canaryAbsPath = null,
  need = 'player+upper',
  createRuntime = createPlayerRuntime,
  runtimeOpts = {},
  probeTimeoutMs,
} = {}) {
  const order = ladderFrom(preferred);
  const notices = [];
  const made = new Map();
  const adapterFor = (kind) => {
    if (!made.has(kind)) made.set(kind, createRuntime(kind, runtimeOpts));
    return made.get(kind);
  };
  const probeOpts = probeTimeoutMs === undefined ? {} : { timeoutMs: probeTimeoutMs };
  if (preferred != null && !LADDER.includes(preferred)) {
    notices.push('알 수 없는 --player-runtime 값이라 무시하고 폴백 사다리 순서를 씁니다.');
  }

  let player = null;
  if (need !== 'upper-only') {
    for (const kind of order) {
      const adapter = adapterFor(kind);
      let result;
      try {
        result = await adapter.probe({ canaryAbsPath, ...probeOpts });
      } catch (error) {
        notices.push(`플레이어 런타임 ${kind} probe 오류: ${error.code ?? 'ERROR'}`);
        continue;
      }
      if (result.ok && result.containment) {
        player = adapter;
        if (preferred == null) notices.push(`플레이어 런타임 미지정 — 폴백 사다리에서 ${kind}를 씁니다.`);
        else if (kind !== order[0]) notices.push(`플레이어 런타임 폴백: ${order[0]} → ${kind}.`);
        break;
      }
      notices.push(result.notice ?? `플레이어 런타임 ${kind} 부적격: probe 미통과.`);
    }
    if (!player) {
      // 전 런타임 부적격은 "시작 전 실패" — 유령 게임을 돌리지 않는다(스펙 §7).
      notices.push('적격 플레이어 런타임이 없습니다 — 게임을 시작하지 않습니다.');
      return { player: null, upper: null, notices };
    }
  }

  const upperOrder = player ? [player.kind, ...order.filter((kind) => kind !== player.kind)] : order;
  let upper = null;
  for (const kind of upperOrder) {
    const adapter = adapterFor(kind);
    let result;
    try {
      result = await adapter.probe({ upper: true, canaryAbsPath, ...probeOpts });
    } catch (error) {
      notices.push(`상위 모델 런타임 ${kind} probe 오류: ${error.code ?? 'ERROR'}`);
      continue;
    }
    if (result.ok && result.upper && result.containment) {
      upper = adapter;
      if (player && kind !== player.kind) {
        notices.push(`코치·리뷰 상위 모델은 ${kind}로 갈라 씁니다 (플레이어: ${player.kind}).`);
      }
      break;
    }
    notices.push(result.notice ?? `상위 모델 런타임 ${kind} 부적격: probe 미통과.`);
  }
  if (!upper) {
    notices.push('상위 모델 런타임이 없습니다 — 코치는 고정 문구로 대체되고 리뷰는 생성되지 않습니다.');
  }

  return { player, upper, notices };
}
