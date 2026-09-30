#!/usr/bin/env node
// 테스트 전용 가짜 LLM CLI. 실제 모델·네트워크를 절대 부르지 않는다.
//
// 동작: stdin 전문을 읽고 `FAKE_CLI_SCRIPT`(JSON)의 매처에서 응답을 골라 stdout에 쓴다.
//   { matchers: [{ includes?, argvIncludes?, reply, delayMs?, exitCode?, stderr?,
//                  ignoreTerm?, echoCanary?, orphanMs?, inspectJson?, inspectExit?,
//                  grokSession?, grokSessionRaw?, preexistingSession? }],
//     default: { reply, … },
//     logEnvValues?: ['HOME','GROK_AUTH_PATH'] }
//   - `includes`는 stdin 전문에서, `argvIncludes`는 argv 원소에서 찾는다(둘 다 있으면 AND).
//   - 첫 매치가 이긴다. 매치가 없으면 `default`.
//   - `ignoreTerm`이면 SIGTERM을 삼킨다 — 단계적 종료(TERM→KILL) 계약 테스트용.
//   - `echoCanary`면 stdin에서 절대 경로를 찾아 그 파일 내용을 reply 뒤에 붙인다 —
//     어댑터가 스스로 만든 fresh 센티널을 테스트가 몰라도 유출 CLI를 흉내 낼 수 있다.
//   - `orphanMs`면 stdout/stderr를 상속한 detached 후손을 그 시간만큼 살려 두고 즉시
//     exit 0 한다 — 직계 exit 뒤에도 stdio close가 열려 있는 경우의 계약 테스트용.
//     후손 pid는 `{orphanPid}` 한 줄로 로그에 남긴다(테스트가 정리한다).
//   - `inspectJson`이 있고 argv에 `inspect`가 있으면 그 JSON을 stdout에 쓰고 종료.
//     문자열 `$HOME`은 실제 HOME 값으로 치환한다.
//   - `grokSession`/`grokSessionRaw`는 `$HOME/.ai-holdem-home.json`이 있을 때만
//     세션 기록을 쓴다. 없으면 stderr `FAKE_CLI_REFUSES_USER_HOME` + exit 3.
// 기록: 매 호출을 `FAKE_CLI_LOG`(JSONL)에 append한다 — argv·stdin·cwd·env **키 목록**·pid.
//   env는 값이 아니라 키만 남긴다(자격 값은 로그에 절대 쓰지 않는다). `logEnvValues`로
//   명시한 키만 값을 남긴다. 세션 플래그(`--session-id`/`--resume`)도 argv에 받은 그대로.
// 기록은 지연(delayMs)보다 **먼저** 한다 — 타임아웃으로 죽는 호출도 로그에 남아야 한다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// `node --test`는 test/ 아래 모든 .js를 테스트 파일로 실행한다. 스크립트 env 없이
// 발견-실행된 경우 stdin EOF를 기다리면 전체 스위트가 멈추므로, stdin을 읽기 전에
// 빈 파일처럼 즉시 끝낸다. 진짜 fake CLI 호출은 항상 FAKE_CLI_SCRIPT를 갖는다.
if (!process.env.FAKE_CLI_SCRIPT) process.exit(0);

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

if (process.env.FAKE_CLI_LOG) {
  const record = {
    argv,
    stdin,
    cwd: process.cwd(),
    envKeys: Object.keys(process.env).sort(),
    pid: process.pid,
  };
  const values = envValuesToLog();
  if (values) record.envValues = values;
  fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(record)}\n`);
}

if (chosen.ignoreTerm) process.on('SIGTERM', () => { /* 종료 사다리가 SIGKILL까지 가야 한다 */ });

if (chosen.orphanMs) {
  const orphan = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${Number(chosen.orphanMs)})`], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
    windowsHide: true,
  });
  orphan.unref();
  if (process.env.FAKE_CLI_LOG) {
    fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ orphanPid: orphan.pid })}\n`);
  }
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

function expandEvent(item, id) {
  if (typeof item === 'string') {
    return { type: item, session_id: id };
  }
  const out = structuredClone(item);
  out.session_id = id;
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
  const events = (spec.events ?? DEFAULT_EVENTS).map((item) => expandEvent(item, id));
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
  if (chosen.reply != null) process.stdout.write(String(chosen.reply));
  if (chosen.echoCanary) process.stdout.write(canaryContent());
  process.exit(chosen.exitCode ?? 0);
}

if (chosen.delayMs) setTimeout(respond, chosen.delayMs);
else respond();
