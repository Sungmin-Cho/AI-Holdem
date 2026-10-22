#!/usr/bin/env node
// 테스트 전용 가짜 game-loop(#312 관측 러너 시험용). 실제 엔진·LLM·네트워크를 부르지 않는다.
//
// `tools/game-loop.js`와 같은 인자(`--store-dir S --ai N --hands H ...`)를 받아 store에 세션 파일
// (`.session-store/current.json`, `sessions/<id>/loop-state.json`·`loop.log`·`lock.json`·`ui-snapshot.json`)을 쓰고,
// 127.0.0.1 임시 포트에 relay의 `/api/action`만 흉내 내는 서버를 연다. 다른 요청은 로그에 남기고 404다.
// 동작은 `FAKE_LOOP_SCENARIO`(JSON)가 정한다.
//   kind: 'done' | 'recovery' | 'unsafe' | 'halt' | 'calls' | 'boot-hang' | 'ignore-term' | 'never-state'
//   log: 절대 경로 — 받은 신호·행동을 JSONL로 남긴다
//   release: 절대 경로 — ignore-term·never-state가 이 파일이 생기면 끝난다
//   stateDelayMs: current.json·loop-state를 처음 쓰기 전 대기(SIGTERM 핸들러 설치 전 구간)
//   model·upperRuntime: runtime-models·loop-state에 쓸 값(기본 gpt-6.1-sol·codex)
//   decisionMs: AI 결정마다 쓸 결정 elapsedMs 목록(순환, 기본 3000) · rejected: 거절 이벤트 수
//   badLock: lock.json의 토큰을 loop-state와 다르게 쓴다 · lockPid·lockStartTime: 끝날 때 남길 relay 기록
//   pendingMs: recovery·unsafe의 pendingDecision.elapsedMs
// 준비 통지: playing을 쓴 뒤 로그에 `{ready:true}` 한 줄을 남긴다 — 시험은 이 줄을 본 뒤에 정지를 건다.
// 실제 game-loop처럼 SIGTERM 핸들러는 loop-state를 처음 쓰기 직전에 설치한다(그 전의 SIGTERM은 기본 동작으로 죽는다).
// 비밀 표지: 결정 id·세션 토큰·세션 id·stdout·stderr·학습 URL에 `SECRET-` 문자열을 넣는다 — 러너 JSON에 새면 안 된다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// `node --test`는 test/ 아래 모든 .js·.mjs를 테스트 파일로 실행한다. 시나리오 없이 발견-실행되면 바로 끝낸다.
if (!process.env.FAKE_LOOP_SCENARIO) process.exit(0);

const scenario = JSON.parse(process.env.FAKE_LOOP_SCENARIO);
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const store = arg('--store-dir');
const ai = Number(arg('--ai'));
const hands = Number(arg('--hands'));
const sessionId = 'SECRET-SESSION-1';
const token = 'SECRET-TOKEN-1';
const model = scenario.model ?? 'gpt-6.1-sol';
const sessionDir = path.join(store, '.session-store', 'sessions', sessionId);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 끝나지 않는 대기. 타이머로 이벤트 루프를 붙잡는다 — 핸들 없는 미해결 top-level await는 프로세스를 그냥 끝낸다.
const forever = () => new Promise(() => { setInterval(() => {}, 1000); });
const note = (entry) => { if (scenario.log) fs.appendFileSync(scenario.log, `${JSON.stringify({ ...entry, pid: process.pid })}\n`); };
const waitRelease = async () => { while (!fs.existsSync(scenario.release)) await sleep(20); };
process.stdout.write('SECRET-STDOUT study http://127.0.0.1:1/#token=SECRET-STUDY\n');
process.stderr.write('SECRET-STDERR\n');

if (scenario.kind === 'never-state') {
  // SIGTERM 핸들러를 설치하지 않은 준비 구간에 머문다. 러너는 신호를 보내지 않아야 한다.
  process.on('SIGTERM', () => note({ signal: 'SIGTERM', preHandler: true }));
  await waitRelease();
  process.exit(0);
}
if (scenario.stateDelayMs) await sleep(scenario.stateDelayMs);

let terms = 0;
let server = null;
let port = null;
const finish = (code) => {
  if (scenario.lockPid) fs.writeFileSync(path.join(sessionDir, 'lock.json'), JSON.stringify({ serverPid: scenario.lockPid, serverStartTime: scenario.lockStartTime ?? 'FAKE-START', port, sessionToken: token }));
  server?.close();
  process.exit(code);
};
process.on('SIGTERM', () => {
  terms += 1;
  note({ signal: 'SIGTERM', terms });
  if (scenario.kind === 'ignore-term') return;
  writeState({ stopping: true });
  finish(0);
});

fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(store, '.session-store', 'current.json'), JSON.stringify({ gameId: sessionId, sessionRel: `sessions/${sessionId}` }));
let state = { phase: 'bootstrap', handNo: 0, port: null, sessionToken: token, playerRuntime: 'codex', upperRuntime: scenario.upperRuntime ?? 'codex', metrics: [], metricsDropped: 0 };
function writeState(patch) {
  state = { ...state, ...patch };
  fs.writeFileSync(path.join(sessionDir, 'loop-state.tmp'), JSON.stringify(state));
  fs.renameSync(path.join(sessionDir, 'loop-state.tmp'), path.join(sessionDir, 'loop-state.json'));
}
const log = (event) => fs.appendFileSync(path.join(sessionDir, 'loop.log'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
const call = (purpose, elapsedMs, extra = {}) => log({
  event: 'player-call', purpose, runtime: 'codex', model, elapsedMs, timeoutMs: purpose === 'decision' ? 300000 : 120000,
  code: 'RESPONSE_RECEIVED', category: 'response', censored: false,
  timing: { bootMs: 300, turnMs: elapsedMs - 600, exitToCloseMs: 200, signalMs: null, closeMs: elapsedMs, censored: false }, ...extra,
});
writeState({});
log({ event: 'bootstrap-initialized', sessionToken: token, gameId: sessionId });
if (scenario.kind === 'boot-hang') await forever();

let legal = null;
let onAction = null;
// relay처럼 게시마다 ui-snapshot.json을 원자 교체로 쓴다(현재 결정 + 호스트 view의 합법 행동).
const publish = (next) => {
  const file = path.join(sessionDir, 'ui-snapshot.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ decision: next ? { decisionId: next.decisionId, toAct: next.toAct } : null, view: { legal: next ?? undefined, myCards: ['SECRET-CARD'] } }));
  fs.renameSync(`${file}.tmp`, file);
};
server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.searchParams.get('token') !== token) return send(403, { ok: false });
  if (!(req.method === 'POST' && url.pathname === '/api/action')) {
    note({ request: `${req.method} ${url.pathname}` });
    return send(404, { ok: false });
  }
  if (req.method === 'POST' && url.pathname === '/api/action') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const action = JSON.parse(body);
      note({ action: action.action, decisionId: action.decisionId, requestId: action.requestId });
      if (!legal || action.decisionId !== legal.decisionId) return send(409, { ok: false, code: 'STALE_DECISION' });
      legal = null;
      publish(null);
      send(200, { ok: true });
      onAction?.();
    });
    return undefined;
  }
  return send(404, { ok: false });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
port = server.address().port;
fs.writeFileSync(path.join(sessionDir, 'lock.json'), JSON.stringify({ serverPid: process.pid, serverStartTime: 'FAKE-START', port, sessionToken: scenario.badLock ? 'SECRET-OTHER' : token }));
log({ event: 'runtime-models', player: { runtime: 'codex', model, source: 'catalog' }, upper: { runtime: scenario.upperRuntime ?? 'codex', model: 'gpt-6.1-sol', source: 'catalog' } });
writeState({ phase: 'playing', port });
note({ ready: true });
for (let i = 0; i < ai; i += 1) call('start-warmup', 4000 + i * 100, { batch: { id: 'b1', size: ai, index: i } });
log({ event: 'player-warmup-batch', purpose: 'start-warmup', batchId: 'b1', size: ai, answered: ai, failed: 0, wallMs: 4500 });
for (let i = 0; i < (scenario.rejected ?? 0); i += 1) log({ event: 'player-decision-rejected', decisionId: 'SECRET-DECISION-r' });

if (scenario.kind === 'halt') {
  writeState({ halt: { code: 'FAKE_HALT' } });
  await sleep(50);
  finish(1);
}
if (scenario.kind === 'calls') {
  for (let i = 0; i < 50; i += 1) call('decision', 1000, { decisionId: `SECRET-DECISION-c${i}`, generation: 1, callNo: 1 });
  await forever();
}
const decisionMs = scenario.decisionMs ?? [3000];
let decisionNo = 0;
for (let hand = 1; hand <= hands; hand += 1) {
  writeState({ handNo: hand });
  for (let i = 0; i < 3; i += 1) {
    const id = `SECRET-DECISION-${hand}-${i}`;
    const elapsedMs = decisionMs[decisionNo % decisionMs.length];
    decisionNo += 1;
    call('decision', Math.min(elapsedMs, 20000), { decisionId: id, generation: 1, callNo: 1 });
    writeState({ metrics: [...state.metrics, { playerId: `p${i + 2}`, decisionId: id, runtime: 'codex', outcome: 'accepted', elapsedMs }] });
  }
  if (['recovery', 'unsafe'].includes(scenario.kind) && hand === 1) {
    writeState({ pendingDecision: { status: scenario.kind === 'unsafe' ? 'unsafe' : 'recovery_required', code: 'TIMEOUT', category: 'timeout',
      elapsedMs: scenario.pendingMs ?? 1000, decisionId: 'SECRET-DECISION-pending' } });
    await forever();
  }
  if (scenario.kind === 'ignore-term' && hand === 1) {
    await waitRelease();
    finish(0);
  }
  legal = { toAct: 'user', decisionId: `SECRET-DECISION-user-${hand}`, canCheck: hand % 2 === 0 };
  publish(legal);
  await new Promise((resolve) => { onAction = resolve; });
  onAction = null;
}
writeState({ phase: 'finalizing' });
await sleep(30);
writeState({ phase: 'done', pendingDecision: undefined });
finish(0);
