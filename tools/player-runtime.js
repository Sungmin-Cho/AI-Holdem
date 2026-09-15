// 사이드카가 LLM CLI를 부르는 **유일한 표면**. 설계 §3 D2·§4 보안·§7 probe 사다리.
//
// 지키는 규칙 (전부 계약 테스트로 고정돼 있다):
//   - 모든 프롬프트는 stdin으로만 간다. 모델 텍스트·요약·decisionId·레포/게임 경로는
//     argv에 절대 넣지 않는다. argv에 실리는 런타임 값은 세션 id 하나뿐이다.
//   - cwd는 레포·game/ 밖의 per-runtime 빈 tmp 디렉터리, env는 `HOME`/`PATH`/`USER`
//     allowlist다(`PWD`·`OLDPWD`·워크스페이스/프로젝트 포인터는 상속하지 않는다).
//     grok은 `HOME`을 스토어별 격리 홈으로 바꾸고 자격 경로만 `GROK_AUTH_PATH`로 준다.
//   - argv 상수는 Task 0 실측 프로브(`docs/sidecar-probe-notes.md`)의 핀 값이다.
//     grok은 격리 홈·`GROK_TAIL`·세션 감사로 적격 판정한다. 정적 `eligible`·버전
//     allowlist는 없다 — 매 기동의 inspect·세션 기록이 그 버전에 대한 증명이다.
//   - `decide`의 타임아웃은 자식을 스스로 죽인다. `oneshotStart().done`은 절대 죽이지
//     않는다 — 호출자가 identity 검증된 `terminate()`를 부른다(스펙 §5 코치 5).
//   - 실패 notice·에러 메시지에 모델 출력이나 카나리 센티널을 다시 싣지 않는다
//     (notice는 loop-state를 거쳐 사용자에게 그대로 보이는 문자열이다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { childSpawnOptions } from '../shared/child-spawn-options.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { processStartTime as defaultProcessStartTime } from '../engine/state.js';
import { personaGuidance } from './persona-guidance.js';
import {
  grokSessionDir,
  provisionRuntimeHome,
  verifyRuntimeHome,
} from './runtime-home.js';

export { provisionRuntimeHome, verifyRuntimeHome } from './runtime-home.js';

export const RUNTIME_TABLE = {
  claude: { player: 'haiku', upper: 'opus', watchdog: { t1Ms: 25_000, t2Ms: 15_000 } },
  codex: { player: 'gpt-5.6-luna', upper: 'gpt-5.6-sol', watchdog: { t1Ms: 25_000, t2Ms: 15_000 } },
  // Task 0: low effort 핀이 실패했다(기본 effort 유지) → 스펙 D8의 60s/30s를 그대로 쓴다.
  grok: { player: 'grok-4.6', upper: 'grok-4.6', watchdog: { t1Ms: 60_000, t2Ms: 30_000 } },
};

export const SESSION_ID_MAX_LENGTH = 128;
export const isArgvSafeSessionId = (id) => (
  typeof id === 'string'
  && id.length >= 1
  && id.length <= SESSION_ID_MAX_LENGTH
  && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
);

const LADDER = ['claude', 'codex', 'grok'];
// `USER`는 자격이 아니라 계정 이름이고, claude CLI는 그것 없이는 자기 credential
// 저장소를 열지 못한다 — `env -i HOME PATH`에서 claude는 매번 0.74s 만에
// "OAuth session expired and could not be refreshed"로 떨어져 사다리에서 통째로
// 탈락했다(2026-09-11 실측, docs/sidecar-probe-notes.md의 2026-09-11 추가 기록).
// 그 결과 모든 게임 시작이 codex 하나에 의존했다. 키를 넓힌 게 아니라 이름 하나를
// 돌려준 것이며, 카나리 부정 검증은 추가 뒤에도 그대로 통과한다.
const ENV_ALLOWLIST = ['HOME', 'PATH', 'USER'];
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
const CLAUDE_STREAM = ['--output-format', 'stream-json', '--verbose', '--include-hook-events'];
export const GROK_DISALLOWED_TOOLS = [
  'run_terminal_cmd', 'run_terminal_command', 'search_replace', 'list_dir', 'grep', 'write',
  'kill_command_or_subagent', 'todo_write', 'get_command_or_subagent_output', 'spawn_subagent',
  'scheduler_create', 'scheduler_delete', 'scheduler_list', 'monitor', 'search_tool', 'use_tool',
  'workflow', 'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'send_feedback',
  'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'web_search', 'web_fetch',
  'Agent',
].join(',');
export const GROK_TAIL = (model) => [
  '-m', model, '--tools', '', '--disallowed-tools', GROK_DISALLOWED_TOOLS,
  '--deny', 'Read', '--deny', 'Bash', '--deny', 'Grep', '--deny', 'Edit',
  '--deny', 'Write', '--deny', 'WebFetch', '--deny', 'MCPTool',
  '--disable-web-search', '--sandbox', 'read-only', '--no-subagents',
];
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
const grokCreateArgs = (model, sessionId) => ([
  '--no-auto-update', '--prompt-file', '/dev/stdin', ...GROK_TAIL(model), '--session-id', sessionId,
]);
const grokResumeArgs = (model, sessionId) => ([
  '--no-auto-update', '--prompt-file', '/dev/stdin', '--resume', sessionId, ...GROK_TAIL(model),
]);

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
        case 'probe-upper':
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
        case 'probe-upper':
          // 컨테인먼트 probe도 생성과 같은 --json JSONL fail-closed다. Task 0의 기록된
          // 통과형은 plain이었지만(산문과 argv의 불일치가 deferred로 남았다), fix round
          // 1에서 명시 불변식 — 파싱 가능한 **최종** `agent_message.text`가 있어야 정상
          // 응답 — 쪽으로 의도적으로 해소했다. plain 통과형 재검증은 실기 스모크로.
          return {
            args: [...CODEX_NO_TOOL_PREFIX, 'exec', '--ignore-user-config', '-m', model, ...CODEX_SANDBOX, '--skip-git-repo-check', '--json', '-'],
            format: 'codex-jsonl',
          };
        case 'resume':
          // 0.150.1 실측 순서: 전역 옵션 → `exec resume` → resume parser 옵션 → id → `-`.
          return {
            args: [...CODEX_NO_TOOL_PREFIX, '-m', model, ...CODEX_SANDBOX,
              'exec', 'resume', '--ignore-user-config', '--json', '--skip-git-repo-check', sessionId, '-'],
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
      switch (purpose) {
        case 'inspect':
          return { args: ['--no-auto-update', 'inspect', '--json'], format: 'text' };
        case 'create':
        case 'oneshot':
        case 'probe':
        case 'probe-upper': {
          const id = sessionId || randomUUID();
          return { args: grokCreateArgs(model, id), format: 'text', audit: { sessionId: id } };
        }
        case 'resume':
          return { args: grokResumeArgs(model, sessionId), format: 'text', audit: { sessionId } };
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
function codexFinalMessage(stdout, { allowEmpty = false } = {}) {
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
  return text === '' && !allowEmpty ? null : text;
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
    && Array.isArray(init.plugins) && init.plugins.length === 0
    && !toolUse && !hooked;
  return { clean, text: claudeStreamText(events) };
}

const GROK_EMPTY_ARRAY_KEYS = ['hooks', 'plugins', 'mcpServers', 'projectInstructions', 'marketplaces', 'lspServers'];
const GROK_UPDATE_ALLOWED = new Set([
  'user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk',
  'turn_completed', 'retry_state', 'tool_call', 'tool_call_update',
]);
const GROK_EVENT_ALLOWED = new Set([
  'turn_started', 'loop_started', 'phase_changed', 'first_token', 'turn_ended',
  'tool_started', 'permission_requested', 'permission_resolved',
]);
const GROK_EVENT_TOOL_RELATED = new Set(['tool_completed', 'tool_started', 'permission_requested', 'permission_resolved']);

function pathUnderHome(candidate, home) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  let resolved = path.resolve(candidate);
  try {
    if (fs.existsSync(resolved)) resolved = fs.realpathSync(resolved);
  } catch { /* 없는 경로는 resolve 결과로 비교 */ }
  const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  return resolved === home || resolved.startsWith(prefix);
}

export function grokInspectAudit(stdout, { home } = {}) {
  let data;
  try {
    data = JSON.parse(String(stdout));
  } catch {
    return { ok: false, code: 'GROK_INSPECT_INVALID' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'GROK_INSPECT_INVALID' };
  }
  if (typeof data.grokVersion !== 'string' || data.grokVersion === '') {
    return { ok: false, code: 'GROK_INSPECT_INVALID' };
  }
  for (const key of GROK_EMPTY_ARRAY_KEYS) {
    if (!Array.isArray(data[key])) return { ok: false, code: 'GROK_INSPECT_INVALID' };
    if (data[key].length !== 0) return { ok: false, code: `GROK_HOME_NOT_ISOLATED (${key})` };
  }
  if (!data.permissions || typeof data.permissions !== 'object' || Array.isArray(data.permissions)) {
    return { ok: false, code: 'GROK_INSPECT_INVALID' };
  }
  if (data.permissions.loaded !== 0) return { ok: false, code: 'GROK_HOME_NOT_ISOLATED (permissions.loaded)' };
  if (!data.externalCompat || typeof data.externalCompat !== 'object' || Array.isArray(data.externalCompat)) {
    return { ok: false, code: 'GROK_INSPECT_INVALID' };
  }
  if (data.externalCompat.remoteSettingsLoaded !== false) {
    return { ok: false, code: 'GROK_HOME_NOT_ISOLATED (remoteSettingsLoaded)' };
  }
  if (data.projectRoot !== null) return { ok: false, code: 'GROK_CWD_IN_PROJECT' };
  const layers = data.configSources?.layers;
  if (!Array.isArray(layers)) return { ok: false, code: 'GROK_INSPECT_INVALID' };
  let homeReal;
  try {
    homeReal = fs.realpathSync(home);
  } catch {
    return { ok: false, code: 'GROK_INSPECT_INVALID' };
  }
  const expectedUser = path.join(homeReal, '.grok', 'config.toml');
  let userCount = 0;
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object' || typeof layer.path !== 'string') {
      return { ok: false, code: 'GROK_INSPECT_INVALID' };
    }
    if (!pathUnderHome(layer.path, homeReal)) {
      return { ok: false, code: 'GROK_HOME_NOT_ISOLATED (configSources)' };
    }
    if (layer.role === 'user') {
      userCount += 1;
      let userPath = path.resolve(layer.path);
      try {
        if (fs.existsSync(userPath)) userPath = fs.realpathSync(userPath);
      } catch { /* resolve 결과로 비교 */ }
      if (userPath !== expectedUser) {
        return { ok: false, code: 'GROK_HOME_NOT_ISOLATED (config)' };
      }
    }
  }
  if (userCount !== 1) return { ok: false, code: 'GROK_HOME_NOT_ISOLATED (config)' };
  return { ok: true, grokVersion: data.grokVersion };
}

function toolDefinitionName(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.function?.name === 'string') return entry.function.name;
  if (typeof entry.name === 'string') return entry.name;
  return null;
}

function readJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return { missing: true };
  const text = fs.readFileSync(filePath, 'utf8');
  if (text.trim() === '') return { empty: true };
  const events = parseJsonLines(text);
  if (events === null) return { malformed: true };
  return { events };
}

export function grokSessionAudit({ home, cwd, sessionId, turns = 1 }) {
  const dir = grokSessionDir(home, cwd, sessionId);
  const updatesFile = path.join(dir, 'updates.jsonl');
  const eventsFile = path.join(dir, 'events.jsonl');
  const toolsFile = path.join(dir, 'tool_definitions.json');
  const updates = readJsonlFile(updatesFile);
  const events = readJsonlFile(eventsFile);
  let toolsRaw = null;
  let toolsMissing = false;
  if (!fs.existsSync(toolsFile)) toolsMissing = true;
  else {
    const text = fs.readFileSync(toolsFile, 'utf8');
    if (text.trim() === '') toolsMissing = true;
    else {
      try { toolsRaw = JSON.parse(text); } catch { return { ok: false, code: 'GROK_SESSION_RECORD_MISSING' }; }
    }
  }
  if (toolsMissing || updates.missing || updates.empty || updates.malformed
    || events.missing || events.empty || events.malformed) {
    return { ok: false, code: 'GROK_SESSION_RECORD_MISSING' };
  }

  let hook = false;
  let surface = false;
  let tool = false;
  let unknown = false;
  let incomplete = false;

  if (!Array.isArray(toolsRaw) || toolsRaw.length !== 1 || toolDefinitionName(toolsRaw[0]) !== 'read_file') {
    surface = true;
  }

  let eventToolGroups = 0;
  let turnStarted = 0;
  let turnEnded = 0;
  const eventToolRows = [];
  for (const row of events.events) {
    if (row?.session_id !== sessionId) incomplete = true;
    const type = row?.type;
    if (type === 'turn_started') turnStarted += 1;
    if (type === 'turn_ended') turnEnded += 1;
    if (type === 'tool_started' || type === 'permission_requested' || type === 'permission_resolved') {
      eventToolRows.push(row);
    }
    if (type === 'hook_execution') hook = true;
    else if (!GROK_EVENT_ALLOWED.has(type)) {
      if (GROK_EVENT_TOOL_RELATED.has(type) || type === 'tool_completed') tool = true;
      else unknown = true;
    }
  }
  if (eventToolRows.length % 3 !== 0) tool = true;
  else {
    for (let i = 0; i < eventToolRows.length; i += 3) {
      const started = eventToolRows[i];
      const requested = eventToolRows[i + 1];
      const resolved = eventToolRows[i + 2];
      const ok = started?.type === 'tool_started' && started.tool_name === 'read_file'
        && requested?.type === 'permission_requested' && requested.tool_name === 'read_file'
        && resolved?.type === 'permission_resolved' && resolved.tool_name === 'read_file'
        && resolved.decision === 'deny';
      if (!ok) tool = true;
      else eventToolGroups += 1;
    }
  }
  if (turnStarted !== turns || turnEnded !== turns) incomplete = true;

  let agentChunks = 0;
  let turnCompleted = 0;
  const calls = new Map();
  const terminals = new Map();
  for (const row of updates.events) {
    if (row?.params?.sessionId !== sessionId) incomplete = true;
    const update = row?.params?.update?.sessionUpdate;
    if (update === 'hook_execution') hook = true;
    else if (!GROK_UPDATE_ALLOWED.has(update)) unknown = true;
    if (update === 'agent_message_chunk') agentChunks += 1;
    if (update === 'turn_completed') turnCompleted += 1;
    if (update === 'tool_call') {
      const id = row?.params?.update?.toolCallId;
      const title = row?.params?.update?.title;
      const backend = row?.params?.update?._meta?.backend === true;
      if (typeof id !== 'string' || id === '' || calls.has(id)) tool = true;
      else calls.set(id, { title, backend });
      if (title !== 'read_file' || backend) tool = true;
    }
    if (update === 'tool_call_update') {
      const id = row?.params?.update?.toolCallId;
      const status = row?.params?.update?.status;
      if (status !== undefined) {
        if (typeof id !== 'string' || id === '') tool = true;
        else if (terminals.has(id)) tool = true;
        else terminals.set(id, status);
        if (status !== 'failed') tool = true;
      }
    }
  }
  for (const [id, meta] of calls) {
    if (!terminals.has(id)) tool = true;
    void meta;
  }
  for (const id of terminals.keys()) {
    if (!calls.has(id)) tool = true;
  }
  if (calls.size !== eventToolGroups) tool = true;
  if (agentChunks < 1 || turnCompleted !== turns) incomplete = true;

  if (hook) return { ok: false, code: 'GROK_SESSION_HOOK' };
  if (surface) return { ok: false, code: 'GROK_TOOL_SURFACE' };
  if (tool) return { ok: false, code: 'GROK_SESSION_TOOL' };
  if (unknown) return { ok: false, code: 'GROK_SESSION_UNKNOWN_EVENT' };
  if (incomplete) return { ok: false, code: 'GROK_SESSION_INCOMPLETE' };
  return { ok: true };
}

function grokContainmentNotice(kind, model, code) {
  if (code === 'GROK_TOOL_SURFACE') {
    return `컨테인먼트 실패(${kind}/${model}): 도구 표면이 read_file 하나가 아닙니다.`;
  }
  if (code === 'GROK_SESSION_TOOL') {
    return `컨테인먼트 실패(${kind}/${model}): 거부되지 않은 도구 호출이 있습니다.`;
  }
  if (code === 'GROK_SESSION_HOOK') {
    return `컨테인먼트 실패(${kind}/${model}): 세션 기록에 hook 실행이 있습니다.`;
  }
  if (code === 'GROK_SESSION_RECORD_MISSING') {
    return `컨테인먼트 실패(${kind}/${model}): 세션 기록이 없습니다.`;
  }
  if (code === 'GROK_SESSION_INCOMPLETE') {
    return `컨테인먼트 실패(${kind}/${model}): 세션 기록이 불완전합니다.`;
  }
  if (code === 'GROK_SESSION_UNKNOWN_EVENT') {
    return `컨테인먼트 실패(${kind}/${model}): 세션 기록에 알 수 없는 이벤트가 있습니다.`;
  }
  return `컨테인먼트 실패(${kind}/${model}): ${code}`;
}

function grokIsolationNotice(kind, model, code) {
  return `grok 격리 검증 실패(${kind}/${model}): ${code}`;
}

function isRegularFile(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

function defaultResolveCommandPath(commandName) {
  if (path.isAbsolute(commandName) && fs.existsSync(commandName)) return fs.realpathSync(commandName);
  const dirs = String(process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, commandName);
    try {
      if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    } catch { /* 다음 후보 */ }
  }
  return null;
}

function statIdentity(filePath) {
  const real = fs.realpathSync(filePath);
  const st = fs.statSync(real);
  return { real, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
}

function parseResponse(format, stdout, { allowEmpty = false } = {}) {
  if (format === 'codex-jsonl') return codexFinalMessage(stdout, { allowEmpty });
  if (format === 'claude-stream') return claudeStreamAudit(stdout).text;
  const trimmed = String(stdout).trim();
  return trimmed === '' && !allowEmpty ? null : trimmed;
}

// ── 플레이어 프롬프트 정본 ───────────────────────────────────────────────────

const PERSONA_FIELDS = ['name', 'speech', 'personality', 'archetype'];
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
    behaviorGuidance: personaGuidance(String(persona.archetype)),
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
  const child = spawn(command, args, childSpawnOptions({ cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }));
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
  const closed = new Promise((resolve) => child.once('close', () => resolve()));
  return { pid: child.pid ?? null, kill: (signal) => child.kill(signal), done, closed };
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
  const platform = opts.platform ?? process.platform;
  const resolveCommandPath = opts.resolveCommandPath
    ?? (() => defaultResolveCommandPath(command));
  const grokAuthPath = opts.grokAuthPath ?? path.join(os.homedir(), '.grok', 'auth.json');
  const runtimeHomeAnchor = opts.runtimeHomeAnchor
    ?? path.join(os.homedir(), '.ai-holdem', 'runtime-home');
  const activeHandles = new Set();
  let cwd = null;
  let disposePromise = null;
  let disposed = false;
  let grokHome = null;
  let grokHomeId = null;
  let grokLockRoot = null;
  let grokBinary = null;
  const verification = { inspect: false, player: null, upper: null };

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
    const merged = { ...env, ...envExtra };
    if (kind === 'grok') {
      if (grokHome) merged.HOME = grokHome;
      merged.GROK_AUTH_PATH = grokAuthPath;
    }
    return merged;
  }

  function grokFail(code) {
    throw runtimeError(code, grokIsolationNotice(kind, table.player, code));
  }

  function grokPrecheck() {
    if (kind !== 'grok') return;
    if (platform === 'win32') grokFail('RUNTIME_HOME_UNSUPPORTED_PLATFORM');
    const lockRoot = opts.runtimeHome?.lockRoot;
    if (typeof lockRoot !== 'string' || lockRoot === '') grokFail('RUNTIME_HOME_REQUIRED');
    if (!isRegularFile(grokAuthPath)) grokFail('RUNTIME_AUTH_MISSING');
  }

  function ensureGrokHome() {
    if (kind !== 'grok') return;
    grokPrecheck();
    if (grokHome) {
      try {
        verifyRuntimeHome({ home: grokHome, lockRoot: grokLockRoot, kind: 'grok', homeId: grokHomeId });
      } catch (error) {
        grokFail(error.code ?? 'RUNTIME_HOME_INVALID');
      }
      return;
    }
    const provisioned = provisionRuntimeHome({
      anchorRoot: runtimeHomeAnchor,
      lockRoot: opts.runtimeHome.lockRoot,
      kind: 'grok',
    });
    grokHome = provisioned.home;
    grokHomeId = provisioned.homeId;
    grokLockRoot = provisioned.lockRoot;
  }

  function verifyGrokBinary() {
    if (kind !== 'grok' || !grokBinary) return;
    const resolved = resolveCommandPath();
    if (!resolved) grokFail('GROK_BINARY_CHANGED');
    let current;
    try { current = statIdentity(resolved); } catch { grokFail('GROK_BINARY_CHANGED'); }
    if (
      current.real !== grokBinary.real
      || current.dev !== grokBinary.dev
      || current.ino !== grokBinary.ino
      || current.size !== grokBinary.size
      || current.mtimeMs !== grokBinary.mtimeMs
    ) {
      grokFail('GROK_BINARY_CHANGED');
    }
  }

  function assertGrokVerified(tier) {
    if (kind !== 'grok') return;
    grokPrecheck();
    if (!verification.inspect || verification[tier] !== true) grokFail('RUNTIME_NOT_VERIFIED');
  }

  function start({ purpose, model, sessionId = null, input }) {
    if (disposed) {
      throw runtimeError('RUNTIME_CLOSED', `RUNTIME_CLOSED: ${kind} runtime은 이미 영구 종료됐습니다.`);
    }
    if (disposePromise) {
      throw runtimeError('RUNTIME_DISPOSING', `RUNTIME_DISPOSING: ${kind} runtime을 정리 중입니다.`);
    }
    if (kind === 'grok' && purpose !== 'inspect') {
      if (!grokHome) grokFail('RUNTIME_HOME_REQUIRED');
      try {
        verifyRuntimeHome({ home: grokHome, lockRoot: grokLockRoot, kind: 'grok', homeId: grokHomeId });
      } catch (error) {
        throw runtimeError(error.code ?? 'RUNTIME_HOME_INVALID', grokIsolationNotice(kind, table.player, error.code ?? 'RUNTIME_HOME_INVALID'));
      }
      verifyGrokBinary();
    } else if (kind === 'grok' && purpose === 'inspect') {
      try {
        verifyRuntimeHome({ home: grokHome, lockRoot: grokLockRoot, kind: 'grok', homeId: grokHomeId });
      } catch (error) {
        throw runtimeError(error.code ?? 'RUNTIME_HOME_INVALID', grokIsolationNotice(kind, table.player, error.code ?? 'RUNTIME_HOME_INVALID'));
      }
    }
    const spec = argvBuilder(purpose, model, sessionId);
    const { args, format } = spec;
    const auditSessionId = spec.audit?.sessionId ?? sessionId;
    if (kind === 'grok' && grokHome && auditSessionId && purpose !== 'inspect') {
      const dir = grokSessionDir(grokHome, ensureCwd(), auditSessionId);
      const createForm = purpose === 'create' || purpose === 'oneshot' || purpose === 'probe' || purpose === 'probe-upper';
      if (createForm && fs.existsSync(dir)) grokFail('GROK_SESSION_ID_REUSED');
      if (purpose === 'resume' && !fs.existsSync(dir)) grokFail('GROK_SESSION_RECORD_MISSING');
    }
    const spawned = exec({ command, args, cwd: ensureCwd(), env: buildEnv(), input });
    const entry = { handle: null, closed: false, error: null, purpose, model, termination: null };
    const done = Promise.resolve(spawned.done).then(
      (result) => {
        entry.closed = true;
        activeHandles.delete(entry);
        return result;
      },
      (error) => {
        // done 거부는 close 증거가 아니다. dispose/terminate가 해당 pid의
        // lifecycle을 따로 확인할 수 있게 registry에 남겨 둔다.
        entry.error = error;
        throw error;
      },
    );
    const handle = { ...spawned, done };
    entry.handle = handle;
    activeHandles.add(entry);
    if (spawned.closed) {
      Promise.resolve(spawned.closed).then(() => {
        entry.closed = true;
        activeHandles.delete(entry);
      }, () => {}).catch(() => {});
    }
    // 경합에서 진 쪽의 거부가 unhandled rejection이 되지 않도록 관찰자를 하나 붙인다.
    handle.done.catch(() => {});
    return { handle, format, args, entry };
  }

  async function killAndConfirmClose(entry, signal = 'SIGKILL') {
    if (entry.closed) return;
    // Watchdog and shutdown can reach the same child concurrently. Share one
    // signal/close observation; a second kill is not additional exit evidence.
    if (entry.termination) return entry.termination;
    entry.termination = confirmChildClose(entry, signal);
    return entry.termination;
  }

  async function confirmChildClose(entry, signal) {
    await Promise.resolve();
    if (entry.closed) return;
    const started = Date.now();
    const details = () => ({ runtime: kind, pid: entry.handle.pid ?? null,
      purpose: entry.purpose, model: entry.model, signal,
      waitBudgetMs: killWaitMs, waitedMs: Date.now() - started,
      closeConfirmed: entry.closed });
    let delivered;
    try {
      delivered = entry.handle.pid === null && entry.handle.closed ? true : entry.handle.kill(signal);
    } catch (error) {
      throw runtimeError('CHILD_SIGNAL_FAILED', `CHILD_SIGNAL_FAILED: ${kind} 자식에 ${signal}을 보내지 못했습니다.`, { cause: error, details: details() });
    }
    if (delivered === false) {
      // A close queued just before kill may settle on the next microtask.
      await Promise.resolve();
      if (entry.closed) return;
      throw runtimeError('CHILD_SIGNAL_FAILED', `CHILD_SIGNAL_FAILED: ${kind} 자식에 ${signal}이 전달되지 않았습니다.`, { details: details() });
    }
    const outcome = await Promise.race([
      (entry.handle.closed ?? entry.handle.done).then(
        () => ({ closed: true }),
        (error) => ({ closed: false, error }),
      ),
      sleep(killWaitMs).then(() => ({ closed: false, timeout: true })),
    ]);
    if (entry.closed) return;
    throw runtimeError(
      'CHILD_CLOSE_UNCONFIRMED',
      `CHILD_CLOSE_UNCONFIRMED: ${kind} 자식의 close를 확인하지 못했습니다.`,
      { cause: outcome.error, details: details() },
    );
  }

  // decide/warmup/probe의 공통 실행: 타임아웃이 이기면 **여기서** 자식을 죽인다.
  async function runOnce({ purpose, model, sessionId = null, input, timeoutMs }) {
    const started = Date.now();
    const { handle, format, args, entry } = start({ purpose, model, sessionId, input });
    const timer = timeoutIn(timeoutMs);
    try {
      const result = await Promise.race([handle.done, timer.promise]);
      return { ...result, format, args, elapsedMs: Date.now() - started };
    } catch (error) {
      if (!entry.closed) {
        // T2가 같은 세션에 오버랩되지 않도록 SIGKILL 전송만이 아니라
        // child `close`(전 stdio 종료)까지 확인한 뒤에만 TIMEOUT을 반환한다.
        await killAndConfirmClose(entry, 'SIGKILL');
      }
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

  async function ensureGrokInspect(timeoutMs) {
    if (verification.inspect) return { ok: true };
    let result;
    try {
      result = await runOnce({ purpose: 'inspect', model: table.player, input: '', timeoutMs: Math.min(timeoutMs, 30_000) });
    } catch (error) {
      return { ok: false, code: error.code === 'TIMEOUT' ? 'GROK_INSPECT_INVALID' : (error.code ?? 'GROK_INSPECT_INVALID') };
    }
    if (result.code !== 0) return { ok: false, code: 'GROK_INSPECT_INVALID' };
    const audit = grokInspectAudit(result.stdout, { home: grokHome });
    if (!audit.ok) return audit;
    const resolved = resolveCommandPath();
    if (!resolved) return { ok: false, code: 'GROK_BINARY_CHANGED' };
    try {
      grokBinary = statIdentity(resolved);
    } catch {
      return { ok: false, code: 'GROK_BINARY_CHANGED' };
    }
    verification.inspect = true;
    return { ok: true, grokVersion: audit.grokVersion };
  }

  function auditGrokSession(sessionId, turns) {
    return grokSessionAudit({ home: grokHome, cwd: ensureCwd(), sessionId, turns });
  }

  function grokSessionFail(kindName, model, audit, { ok = true, upper = false, started, extra = {} } = {}) {
    return {
      ok, containment: false, upper, elapsedMs: Date.now() - started,
      notice: grokContainmentNotice(kindName, model, audit.code),
      ...extra,
    };
  }

  // 상위 적격(②)도 왕복만으로는 부족하다: 정확한 상위 probe-upper argv에서 fresh 카나리
  // 부정 검증까지 통과해야 한다 — 유출 CLI가 상위로 선택되면 코치·리뷰 프롬프트가 그
  // CLI의 도구 표면에 노출되기 때문이다. 확인 불가는 통과가 아니다.
  async function probeUpper(canaryAbsPath, timeoutMs, started) {
    const model = table.upper;
    if (kind === 'grok') {
      const inspected = await ensureGrokInspect(timeoutMs);
      if (!inspected.ok) {
        verification.upper = false;
        return {
          ok: false, containment: false, upper: false, elapsedMs: Date.now() - started,
          notice: grokIsolationNotice(kind, model, inspected.code),
        };
      }
    }
    const canary = freshUpperCanary(canaryAbsPath);
    try {
      let round;
      try {
        round = await runOnce({ purpose: 'probe-upper', model, input: UPPER_PROBE_PROMPT, timeoutMs });
      } catch (error) {
        verification.upper = false;
        return {
          ok: false, containment: false, upper: false, elapsedMs: Date.now() - started,
          notice: `상위 모델 probe 실패(${kind}/${model}): ${error.code}`,
        };
      }
      if (round.format === 'claude-stream') {
        const stream = claudeStreamAudit(round.stdout);
        if (!stream.clean || round.code !== 0 || !stream.text) {
          verification.upper = false;
          const notice = !stream.clean
            ? `컨테인먼트 실패(${kind}/${model}): 도구·MCP 표면이 비어 있지 않습니다.`
            : `상위 모델 probe 실패(${kind}/${model}): 정상 응답 없음`;
          return { ok: Boolean(stream.text) && round.code === 0, containment: false, upper: false, elapsedMs: Date.now() - started, notice };
        }
      } else if (round.code !== 0 || !parseResponse(round.format, round.stdout)) {
        verification.upper = false;
        return {
          ok: false, containment: false, upper: false, elapsedMs: Date.now() - started,
          notice: `상위 모델 probe 실패(${kind}/${model}): 정상 응답 없음`,
        };
      }
      if (kind === 'grok') {
        const sessionId = argvBuilder('probe-upper', model, null).audit?.sessionId;
        // session id is generated inside spec; recover from the actual argv.
        const spawnedId = flagFromArgs(round, '--session-id');
        const audit = auditGrokSession(spawnedId, 1);
        if (!audit.ok) {
          verification.upper = false;
          return grokSessionFail(kind, model, audit, { ok: true, upper: false, started });
        }
      }
      let result;
      try {
        result = await runOnce({ purpose: 'probe-upper', model, input: canaryPrompt(canary.file), timeoutMs });
      } catch (error) {
        verification.upper = false;
        return {
          ok: true, containment: false, upper: false, elapsedMs: Date.now() - started,
          notice: `상위 컨테인먼트 probe 실패(${kind}/${model}): ${error.code}`,
        };
      }
      if (result.format === 'claude-stream') {
        const stream = claudeStreamAudit(result.stdout);
        if (!stream.clean) {
          verification.upper = false;
          return {
            ok: true, containment: false, upper: false, elapsedMs: Date.now() - started,
            notice: `컨테인먼트 실패(${kind}/${model}): 도구·MCP 표면이 비어 있지 않습니다.`,
          };
        }
      }
      if (kind === 'grok') {
        const spawnedId = flagFromArgs(result, '--session-id');
        const audit = auditGrokSession(spawnedId, 1);
        if (!audit.ok) {
          verification.upper = false;
          return grokSessionFail(kind, model, audit, { ok: true, upper: false, started });
        }
      }
      const answered = result.code === 0 && Boolean(parseResponse(result.format, result.stdout));
      const leaked = String(result.stdout).includes(canary.sentinel) || String(result.stderr).includes(canary.sentinel);
      const containment = answered && !leaked;
      verification.upper = containment;
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

  function flagFromArgs(result, flag) {
    const args = result.args;
    if (Array.isArray(args)) {
      const index = args.indexOf(flag);
      if (index !== -1) return args[index + 1];
    }
    return null;
  }

  async function probePlayer(canaryAbsPath, timeoutMs, started) {
    const model = table.player;
    const sentinel = readSentinel(canaryAbsPath);
    if (kind === 'grok') {
      const inspected = await ensureGrokInspect(timeoutMs);
      if (!inspected.ok) {
        verification.player = false;
        return {
          ok: false, containment: false, upper: null, elapsedMs: Date.now() - started,
          notice: grokIsolationNotice(kind, model, inspected.code),
        };
      }
    }
    let result;
    try {
      result = await runOnce({ purpose: 'probe', model, input: canaryPrompt(canaryAbsPath), timeoutMs });
    } catch (error) {
      verification.player = false;
      return {
        ok: false, containment: false, upper: null, elapsedMs: Date.now() - started,
        notice: error.code && String(error.code).startsWith('GROK_')
          ? grokIsolationNotice(kind, model, error.code)
          : `플레이어 probe 실패(${kind}/${model}): ${error.code}`,
      };
    }
    const audit = result.format === 'claude-stream' ? claudeStreamAudit(result.stdout) : null;
    const text = audit ? audit.text : parseResponse(result.format, result.stdout);
    const ok = result.code === 0 && Boolean(text);
    const leaked = String(result.stdout).includes(sentinel) || String(result.stderr).includes(sentinel);
    if (kind === 'grok') {
      const spawnedId = flagFromArgs(result, '--session-id');
      const sessionAudit = auditGrokSession(spawnedId, 1);
      if (!sessionAudit.ok) {
        verification.player = false;
        return grokSessionFail(kind, model, sessionAudit, { ok, upper: null, started });
      }
      if (!ok) {
        verification.player = false;
        return {
          ok: false, containment: false, upper: null, elapsedMs: Date.now() - started,
          notice: `플레이어 probe 실패(${kind}/${model}): 정상 응답 없음`,
        };
      }
      if (leaked) {
        verification.player = false;
        return {
          ok: true, containment: false, upper: null, elapsedMs: Date.now() - started,
          notice: `컨테인먼트 실패(${kind}/${model}): 카나리 파일 내용이 응답에 실렸습니다.`,
        };
      }
      let resume;
      try {
        resume = await runOnce({ purpose: 'resume', model, sessionId: spawnedId, input: canaryPrompt(canaryAbsPath), timeoutMs });
      } catch (error) {
        verification.player = false;
        return {
          ok: true, containment: false, upper: null, elapsedMs: Date.now() - started,
          notice: error.code && String(error.code).startsWith('GROK_')
            ? grokIsolationNotice(kind, model, error.code)
            : `플레이어 probe 실패(${kind}/${model}): ${error.code}`,
        };
      }
      const resumeOk = resume.code === 0 && Boolean(parseResponse(resume.format, resume.stdout));
      if (!resumeOk) {
        verification.player = false;
        return {
          ok: false, containment: false, upper: null, elapsedMs: Date.now() - started,
          notice: `플레이어 probe 실패(${kind}/${model}): 정상 응답 없음`,
        };
      }
      const resumeAudit = auditGrokSession(spawnedId, 2);
      if (!resumeAudit.ok) {
        verification.player = false;
        return grokSessionFail(kind, model, resumeAudit, { ok: true, upper: null, started });
      }
      const resumeLeaked = String(resume.stdout).includes(sentinel) || String(resume.stderr).includes(sentinel);
      if (resumeLeaked) {
        verification.player = false;
        return {
          ok: true, containment: false, upper: null, elapsedMs: Date.now() - started,
          notice: `컨테인먼트 실패(${kind}/${model}): 카나리 파일 내용이 응답에 실렸습니다.`,
        };
      }
      verification.player = true;
      return { ok: true, containment: true, upper: null, elapsedMs: Date.now() - started };
    }
    const surfaceClean = audit ? audit.clean : true;
    const containment = ok && !leaked && surfaceClean;
    verification.player = containment;
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
    // #192 sJ4: `dispose()` below kills every pending registry child
    // (`killAndConfirmClose(entry, 'SIGKILL')`) and rejects with `CHILD_CLOSE_UNCONFIRMED`
    // unless `activeHandles` is empty afterward — it genuinely confirms every child this
    // adapter ever spawned is closed, never just that a `dispose` method happened to exist.
    // game-loop.js's owner-runtime-closure receipt (§3 E1) trusts this flag for that proof.
    disposeConfirmsChildren: true,

    get runtimeHomeId() {
      return kind === 'grok' ? grokHomeId : null;
    },

    /**
     * `upper: true`면 상위 티어 왕복(②)과 fresh 카나리 컨테인먼트를 돈다. 그 외에는
     * 플레이어 티어 왕복(①)과 카나리 부정 검증(③)을 한 번의 호출로 판정한다 —
     * 살아 있는 `game/state.json`이나 홀카드 경로는 어떤 프롬프트·argv에도 넣지
     * 않는다(스펙 §4). 두 경로 모두 카나리 없이는 fail-closed로 던진다.
     */
    async probe({ canaryAbsPath = null, upper = false, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
      const started = Date.now();
      try {
        if (kind === 'grok') ensureGrokHome();
        return upper ? probeUpper(canaryAbsPath, timeoutMs, started) : probePlayer(canaryAbsPath, timeoutMs, started);
      } catch (error) {
        if (kind === 'grok' && error.code) {
          return {
            ok: false,
            containment: false,
            upper: upper ? false : null,
            elapsedMs: Date.now() - started,
            notice: grokIsolationNotice(kind, upper ? table.upper : table.player, error.code),
          };
        }
        throw error;
      }
    },

    // 세션 생성 + 페르소나 카드 1회. 첫 결정에서 세션 생성 비용을 뺀다.
    // 최종 응답이 trim 뒤 정확히 `ready`일 때만 세션을 돌려준다 — 거부·빈 출력·
    // thread.started뿐인 스트림·비-ready 산문은 준비 완료가 아니고, 그 세션으로
    // 결정을 돌리면 안 된다(스펙 §5 워밍업 문면).
    async warmup({ playerId, prompt, timeoutMs = WARMUP_TIMEOUT_MS }) {
      if (kind === 'grok') {
        ensureGrokHome();
        assertGrokVerified('player');
      }
      const sessionId = runtime.newSessionId();
      const result = await runOnce({ purpose: 'create', model: table.player, sessionId, input: prompt, timeoutMs });
      if (result.code !== 0) {
        throw runtimeError('CLI_FAILED', `CLI_FAILED: ${kind} 세션 생성이 실패했습니다.`, { playerId, exitCode: result.code, signal: result.signal });
      }
      const captured = runtime.captureSession ? runtime.captureSession(result.stdout) : sessionId;
      if (!captured) {
        throw runtimeError('NO_SESSION', `NO_SESSION: ${kind} 세션 id를 캡처하지 못했습니다.`, { playerId });
      }
      if (!isArgvSafeSessionId(captured)) {
        throw runtimeError('INVALID_SESSION_ID', `INVALID_SESSION_ID: ${kind} 세션 id 형식이 안전하지 않습니다.`, { playerId });
      }
      const raw = parseResponse(result.format, result.stdout);
      if (raw !== 'ready') {
        throw runtimeError('NOT_READY', `NOT_READY: ${kind} 워밍업 응답이 정확한 ready가 아닙니다.`, { playerId });
      }
      return { sessionId: captured, raw, runtimeHomeId: kind === 'grok' ? grokHomeId : null };
    },

    // 결정 1회. 요약은 stdin으로만 가고, 타임아웃은 자식을 죽인 뒤 TIMEOUT을 던진다.
    async decide({ playerId, sessionId, message, timeoutMs = table.watchdog.t1Ms }) {
      if (kind === 'grok') {
        ensureGrokHome();
        assertGrokVerified('player');
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw runtimeError('NO_SESSION', 'NO_SESSION: 세션 id 없이 결정을 요청할 수 없습니다.', { playerId });
      }
      if (!isArgvSafeSessionId(sessionId)) {
        throw runtimeError('INVALID_SESSION_ID', 'INVALID_SESSION_ID: 안전하지 않은 세션 id로 결정을 요청할 수 없습니다.', { playerId });
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
      if (kind === 'grok') {
        ensureGrokHome();
        assertGrokVerified(tier);
      }
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
        const raw = parseResponse(format, result.stdout, { allowEmpty: true });
        if (result.code !== 0 || !raw) {
          throw runtimeError('CLI_FAILED', `CLI_FAILED: ${kind} 1회성 호출이 실패했습니다.`, {
            exitCode: result.code, signal: result.signal,
            ...(result.code === 0 && raw === '' ? { outputKind: 'empty', raw: '' } : {}),
          });
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

    // 게임 종료 시 probe/warmup/decide/oneshot 전체를 종료·settle한 뒤 cwd를 정리한다.
    // requestStop은 이 Promise를 await하므로 runtime child가 남은 채 loop lock을 풀 수 없다.
    async dispose() {
      if (disposePromise) return disposePromise;
      // 성공 여부와 무관하게 첫 disposal 시도가 lifecycle의 영구 닫힘 경계다.
      // 실패 뒤 재사용하면 아직 살아 있는 handle과 새 child가 겹칠 수 있다.
      disposed = true;
      disposePromise = (async () => {
        const pending = [...activeHandles];
        const results = await Promise.allSettled(
          pending.map((entry) => killAndConfirmClose(entry, 'SIGKILL')),
        );
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
        if (activeHandles.size !== 0) {
          throw runtimeError('CHILD_CLOSE_UNCONFIRMED', `CHILD_CLOSE_UNCONFIRMED: ${kind} runtime 자식이 registry에 남았습니다.`);
        }
        if (!cwd) return;
        try { fs.rmdirSync(cwd); } catch { /* 비어 있지 않거나 이미 없다 */ }
        cwd = null;
      })();
      return disposePromise;
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
export function createProductionResolver({ preferred = null, resolve = resolveRuntimes } = {}) {
  return ({ need, canaryAbsPath, registerAdapter, lockRoot }) => resolve({
    need,
    canaryAbsPath,
    lockRoot,
    preferred,
    onAdapterCreated: registerAdapter,
  });
}

export async function resolveRuntimes({
  preferred = null,
  canaryAbsPath = null,
  need = 'player+upper',
  createRuntime = createPlayerRuntime,
  onAdapterCreated = null,
  runtimeOpts = {},
  lockRoot = null,
  probeTimeoutMs,
} = {}) {
  const order = ladderFrom(preferred);
  const notices = [];
  const made = new Map();
  const resolvedOpts = (
    typeof lockRoot === 'string' && lockRoot !== '' && runtimeOpts.runtimeHome == null
  ) ? { ...runtimeOpts, runtimeHome: { lockRoot } } : runtimeOpts;
  const adapterFor = (kind) => {
    if (!made.has(kind)) {
      const adapter = createRuntime(kind, resolvedOpts);
      made.set(kind, adapter);
      onAdapterCreated?.(adapter);
    }
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
    notices.push('상위 모델 런타임이 없습니다 — LLM 코치·리뷰 피드백을 제공할 수 없습니다.');
  }

  return { player, upper, notices };
}
