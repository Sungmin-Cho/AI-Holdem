#!/usr/bin/env node
// 테스트 전용 가짜 LLM CLI. 실제 모델·네트워크를 절대 부르지 않는다.
//
// 동작: stdin 전문을 읽고 `FAKE_CLI_SCRIPT`(JSON)의 매처에서 응답을 골라 stdout에 쓴다.
//   { matchers: [{ includes?, argvIncludes?, reply, delayMs?, exitCode?, stderr?,
//                  ignoreTerm?, echoCanary?, preface?, prefaceStderr?, prefaceEchoCanary?, orphanMs?, inspectJson?, inspectExit?,
//                  grokSession?, grokSessionRaw?, preexistingSession? }],
//     default: { reply, … },
//     logEnvValues?: ['HOME','GROK_AUTH_PATH'] }
//   - `includes`는 stdin 전문에서, `argvIncludes`는 argv 원소에서 찾는다(둘 다 있으면 AND).
//   - 첫 매치가 이긴다. 매치가 없으면 `default`.
//   - `ignoreTerm`이면 SIGTERM을 삼킨다 — 단계적 종료(TERM→KILL) 계약 테스트용.
//   - `echoCanary`면 stdin에서 절대 경로를 찾아 그 파일 내용을 reply 뒤에 붙인다 —
//     어댑터가 스스로 만든 fresh 센티널을 테스트가 몰라도 유출 CLI를 흉내 낼 수 있다.
//   - `preface`(문자열)는 `delayMs` **전에**, 기동 직후 stdout에 쓴다. `reply`는 그대로 `delayMs` 뒤에 나온다 — 첫 줄(init 등)만
//     내고 멈추는 "무응답" 자식과, 진행 신호는 일찍 내고 최종 응답은 늦은 자식을 같은 스크립트로 흉내 낸다(#333).
//     `prefaceStderr`는 같은 시점에 stderr에 쓰는 문자열, `prefaceEchoCanary`면 stdin의 절대 경로 파일 내용을 stderr에 쓴다.
//   - `orphanMs`면 stdout/stderr를 상속한 detached 후손을 그 시간만큼 살려 두고 즉시
//     exit 0 한다 — 직계 exit 뒤에도 stdio close가 열려 있는 경우의 계약 테스트용.
//     후손 pid는 `{orphanPid}` 한 줄로 로그에 남긴다(테스트가 정리한다).
//   - `orphanUntil`(절대 경로)이면 같은 detached 후손이 시간 대신 그 파일이 생길 때까지(최대 30초) 산다 —
//     후손이 자기 세션으로 프로세스 그룹을 벗어나 그룹 신호가 닿지 않는 잔여 경계를 테스트가 결정적으로 푼다.
//     `orphanSameGroup`이면 그 후손을 detached 없이(같은 프로세스 그룹에) 띄운다 — 직계가 먼저 exit한 뒤에도
//     같은 그룹의 후손이 stdio를 쥔 경우.
//   - `inspectJson`이 있고 argv에 `inspect`가 있으면 그 JSON을 stdout에 쓰고 종료.
//     문자열 `$HOME`은 실제 HOME 값으로 치환한다.
//   - `grokSession`/`grokSessionRaw`는 `$HOME/.ai-holdem-home.json`이 있을 때만
//     세션 기록을 쓴다. 없으면 stderr `FAKE_CLI_REFUSES_USER_HOME` + exit 3.
//     `grokSession.format: '1.0.46'`이면 grok 1.0.46처럼 events.jsonl의 session_id를
//     turn_started 줄에만 싣고, resume은 updates.jsonl에 빈 background_tasks 줄을 먼저 남긴다.
// 기록: 매 호출을 `FAKE_CLI_LOG`(JSONL)에 append한다 — argv·stdin·cwd·env **키 목록**·pid.
//   env는 값이 아니라 키만 남긴다(자격 값은 로그에 절대 쓰지 않는다). `logEnvValues`로
//   명시한 키만 값을 남긴다. 세션 플래그(`--session-id`/`--resume`)도 argv에 받은 그대로.
// 기록은 지연(delayMs)보다 **먼저** 한다 — 타임아웃으로 죽는 호출도 로그에 남아야 한다.
// 기록은 `ignoreTerm` 핸들러 설치와 후손 생성 **뒤**에 한다 — 테스트는 이 줄(`readyAt`)을 "신호를 받을 준비가 됐다"는
// 통지로 쓴다(그 전에 신호가 오면 테스트가 재현하려는 상태가 아니다).
// 래퍼 모드: 스크립트 최상위 `wrapper: true`면 codex npm 런처(`@openai/codex/bin/codex.js` 0.163.0)의 구조를 따른다 —
//   자기 자신을 같은 프로세스 그룹·상속 stdio로 다시 띄우고(응답은 그 손자가 위 규칙대로 쓴다), SIGINT·SIGTERM·
//   SIGHUP을 `child.killed`가 아닐 때만 넘기며 핸들러는 지우지 않고, 손자가 exit하면 그 code로 끝나거나 그 신호를
//   자기에게 다시 보낸다. 직계(래퍼)만 SIGKILL되면 손자가 stdio를 쥔 채 남는 경우의 계약 테스트용(#297). 래퍼는
//   stdin을 읽지 않고(손자가 상속한 fd 0에서 읽는다), 로그에는 `{wrapperPid, childPid}` 한 줄만 남긴다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `node --test`는 test/ 아래 모든 .js를 테스트 파일로 실행한다. 스크립트 env 없이
// 발견-실행된 경우 stdin EOF를 기다리면 전체 스위트가 멈추므로, stdin을 읽기 전에
// 빈 파일처럼 즉시 끝낸다. 진짜 fake CLI 호출은 항상 FAKE_CLI_SCRIPT를 갖는다.
if (!process.env.FAKE_CLI_SCRIPT) process.exit(0);

if (process.env.FAKE_CLI_WRAPPED !== '1' && JSON.parse(fs.readFileSync(process.env.FAKE_CLI_SCRIPT, 'utf8')).wrapper === true) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, FAKE_CLI_WRAPPED: '1' },
    windowsHide: true,
  });
  if (process.env.FAKE_CLI_LOG) {
    fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ wrapperPid: process.pid, childPid: child.pid })}\n`);
  }
  const forwardSignal = (signal) => {
    if (child.killed) return;
    try { child.kill(signal); } catch { /* ignore */ }
  };
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => { process.on(signal, () => forwardSignal(signal)); });
  const result = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve(signal ? { type: 'signal', signal } : { type: 'code', exitCode: code ?? 1 }));
  });
  if (result.type === 'signal') process.kill(process.pid, result.signal);
  else process.exit(result.exitCode);
  // 런처는 여기서 모듈이 끝난다. 처리하는 신호를 자기에게 보냈다면 핸들러가 받고 루프가 비는 대로 끝나므로,
  // 같은 결과(정상 종료)를 짧게 기다려 낸다 — 손자 로직으로 흘러가지 않는다.
  setTimeout(() => process.exit(0), 100);
  await new Promise(() => {});
}

const argv = process.argv.slice(2);
const HOME = process.env.HOME;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readScript() {
  return JSON.parse(fs.readFileSync(process.env.FAKE_CLI_SCRIPT, 'utf8'));
}

const stdin = readStdin();
const script = readScript();

function matches(m) {
  if (m.includes != null && !stdin.includes(m.includes)) return false;
  if (m.argvIncludes != null && !argv.includes(m.argvIncludes)) return false;
  return true;
}

const chosen = (script.matchers ?? []).find(matches) ?? script.default ?? { reply: '' };

function envValuesToLog() {
  const keys = script.logEnvValues;
  if (!Array.isArray(keys) || keys.length === 0) return undefined;
  const values = {};
  for (const key of keys) {
    if (typeof process.env[key] === 'string') values[key] = process.env[key];
  }
  return values;
}

if (chosen.ignoreTerm) process.on('SIGTERM', () => { /* 종료 사다리가 SIGKILL까지 가야 한다 */ });

if (chosen.orphanMs || chosen.orphanUntil) {
  const holder = chosen.orphanUntil
    ? ['-e', 'const fs = require("node:fs"); const end = Date.now() + 30000; (function tick() { if (fs.existsSync(process.argv[1]) || Date.now() > end) process.exit(0); setTimeout(tick, 20); })();', String(chosen.orphanUntil)]
    : ['-e', `setTimeout(() => {}, ${Number(chosen.orphanMs)})`];
  const orphan = spawn(process.execPath, holder, {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: chosen.orphanSameGroup !== true,
    windowsHide: true,
  });
  orphan.unref();
  if (process.env.FAKE_CLI_LOG) {
    fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ orphanPid: orphan.pid })}\n`);
  }
}

if (process.env.FAKE_CLI_LOG) {
  const record = {
    argv,
    stdin,
    cwd: process.cwd(),
    envKeys: Object.keys(process.env).sort(),
    pid: process.pid,
    readyAt: Date.now(),
  };
  const values = envValuesToLog();
  if (values) record.envValues = values;
  fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(record)}\n`);
}

function expandHome(value) {
  let homeValue = HOME ?? '';
  try {
    if (homeValue) homeValue = fs.realpathSync(homeValue);
  } catch { /* HOME이 아직 없으면 원문 */ }
  if (typeof value === 'string') return value.replaceAll('$HOME', homeValue);
  if (Array.isArray(value)) return value.map(expandHome);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandHome(v)]));
  }
  return value;
}

function flagValue(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

function sessionIdFromArgv() {
  return flagValue('--session-id') ?? flagValue('--resume');
}

const DEFAULT_UPDATES = ['user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk', 'turn_completed'];
const DEFAULT_EVENTS = ['turn_started', 'loop_started', 'phase_changed', 'first_token', 'turn_ended'];
const DEFAULT_TOOLS = [{ type: 'function', function: { name: 'read_file' } }];

function expandUpdate(item, id, i) {
  if (typeof item === 'string') {
    return {
      method: i % 2 ? 'session/update' : '_x.ai/session/update',
      params: { sessionId: id, update: { sessionUpdate: item } },
    };
  }
  const out = structuredClone(item);
  if (!out.params) out.params = {};
  out.params.sessionId = id;
  return out;
}

function expandEvent(item, id, format) {
  const out = typeof item === 'string' ? { type: item } : structuredClone(item);
  if (format !== '1.0.46' || out.type === 'turn_started') out.session_id = id;
  return out;
}

function writeGrokSession() {
  const raw = chosen.grokSessionRaw ?? script.grokSessionRaw;
  const spec = chosen.grokSession ?? script.grokSession;
  if (raw == null && spec == null) return;
  if (chosen.preexistingSession || script.preexistingSession) return;

  const identity = path.join(HOME ?? '', '.ai-holdem-home.json');
  if (!HOME || !fs.existsSync(identity)) {
    process.stderr.write('FAKE_CLI_REFUSES_USER_HOME\n');
    process.exit(3);
  }

  const id = spec?.sessionId ?? sessionIdFromArgv();
  if (!id) return;
  const dir = path.join(HOME, '.grok', 'sessions', encodeURIComponent(process.cwd()), id);
  const isResume = argv.includes('--resume');
  if (!isResume) fs.mkdirSync(dir, { recursive: true });
  else if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (raw && typeof raw === 'object') {
    for (const name of ['updates.jsonl', 'events.jsonl', 'tool_definitions.json']) {
      if (!Object.prototype.hasOwnProperty.call(raw, name)) continue;
      const body = raw[name];
      if (body == null) continue;
      fs.writeFileSync(path.join(dir, name), String(body));
    }
    return;
  }

  const updates = (spec.updates ?? DEFAULT_UPDATES).map((item, i) => expandUpdate(item, id, i));
  if (spec.format === '1.0.46' && isResume) {
    updates.unshift(expandUpdate({ method: '_x.ai/session/update', params: { update: { sessionUpdate: 'background_tasks', tasks: [] } } }, id, 0));
  }
  const events = (spec.events ?? DEFAULT_EVENTS).map((item) => expandEvent(item, id, spec.format));
  const tools = spec.tools ?? DEFAULT_TOOLS;
  const updatesPath = path.join(dir, 'updates.jsonl');
  const eventsPath = path.join(dir, 'events.jsonl');
  const toolsPath = path.join(dir, 'tool_definitions.json');
  const updateLines = `${updates.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const eventLines = `${events.map((row) => JSON.stringify(row)).join('\n')}\n`;
  if (isResume && fs.existsSync(updatesPath)) fs.appendFileSync(updatesPath, updateLines);
  else fs.writeFileSync(updatesPath, updateLines);
  if (isResume && fs.existsSync(eventsPath)) fs.appendFileSync(eventsPath, eventLines);
  else fs.writeFileSync(eventsPath, eventLines);
  fs.writeFileSync(toolsPath, `${JSON.stringify(tools)}\n`);
}

function inspectPayload() {
  const payload = chosen.inspectJson ?? script.inspectJson;
  if (payload == null) return null;
  if (typeof payload === 'string') return expandHome(payload);
  return `${JSON.stringify(expandHome(payload))}\n`;
}

function canaryContent() {
  const match = stdin.match(/\/[^\s'"]+/);
  if (!match) return '';
  try {
    return fs.readFileSync(match[0], 'utf8');
  } catch {
    return '';
  }
}

function respond() {
  if (argv.includes('inspect')) {
    const payload = inspectPayload();
    if (payload != null) {
      if (chosen.stderr) process.stderr.write(String(chosen.stderr));
      process.stdout.write(payload);
      process.exit(chosen.inspectExit ?? script.inspectExit ?? 0);
    }
  }
  try {
    writeGrokSession();
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error));
    process.exit(1);
  }
  if (chosen.stderr) process.stderr.write(String(chosen.stderr));
  const out = `${chosen.reply != null ? String(chosen.reply) : ''}${chosen.echoCanary ? canaryContent() : ''}`;
  // 파이프로 가는 stdout 쓰기는 비동기다 — 끝나기 전에 exit하면 64KiB를 넘는 출력이 잘린다.
  process.stdout.write(out, () => process.exit(chosen.exitCode ?? 0));
}

if (chosen.preface) process.stdout.write(String(chosen.preface));
if (chosen.prefaceStderr) process.stderr.write(String(chosen.prefaceStderr));
if (chosen.prefaceEchoCanary) process.stderr.write(canaryContent());

if (chosen.delayMs) setTimeout(respond, chosen.delayMs);
else respond();
