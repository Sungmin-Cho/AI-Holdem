import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipOnWin32 } from './helpers/platform.js';
import {
  RUNTIME_TABLE,
  SESSION_ID_MAX_LENGTH,
  isArgvSafeSessionId,
  extractJsonLine,
  buildPlayerPrompt,
  createPlayerRuntime,
  resolveRuntimes,
  spawnCli,
} from '../tools/player-runtime.js';

const FAKE_CLI = fileURLToPath(new URL('./helpers/fake-cli.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const PERSONA = {
  playerId: 'p1',
  name: '권태민',
  speech: '좋은 패만으로 차분하게 압박할게요.',
  personality: '신중하고 공격적인 정석파',
  archetype: 'TAG',
  bluffFreq: 0.22,
  threeBetFreq: 0.3,
  tiltProne: false,
};

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `holdem-rt-${tag}-`));
}

function jsonl(...events) {
  return `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
}

// 가짜 CLI를 띄우는 어댑터. 주입 exec은 모듈의 기본 exec(`spawnCli`)에 command만
// 바꿔 위임한다 — spawn·stdin·수집·kill의 실제 구현이 그대로 테스트를 탄다.
function fakeRuntime(kind = 'claude', script = {}, opts = {}) {
  const dir = tmpDir('fake');
  const scriptPath = path.join(dir, 'script.json');
  const logPath = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(scriptPath, JSON.stringify({ default: { reply: 'ready' }, ...script }));
  const kills = [];
  const handles = [];
  const rt = createPlayerRuntime(kind, {
    env: { FAKE_CLI_SCRIPT: scriptPath, FAKE_CLI_LOG: logPath },
    exec: (spec) => {
      const handle = spawnCli({ ...spec, command: process.execPath, args: [FAKE_CLI, ...spec.args] });
      handles.push(handle);
      return { ...handle, kill: (signal) => { kills.push(signal); return handle.kill(signal); } };
    },
    ...opts,
  });
  const calls = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return {
    rt,
    kills,
    calls,
    last: () => calls().at(-1),
    cleanup: () => { for (const h of handles) { try { h.kill('SIGKILL'); } catch { /* 이미 종료 */ } } },
  };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function waitDead(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

function canary() {
  const dir = tmpDir('canary');
  const sentinel = 'SENTINEL-1f0a7c42-carrot';
  const file = path.join(dir, 'canary-1f0a7c42.txt');
  fs.writeFileSync(file, `${sentinel}\n`);
  return { file, sentinel };
}

// resolveRuntimes 사다리 테스트용 스텁 — probe 호출 순서·종류·카나리 전달 여부를 기록한다.
// 상위 probe도 fresh 카나리 컨테인먼트를 요구하므로 upper 계획에 containment가 없으면
// 왕복 성공을 그대로 따른다(containment: false를 명시해야 유출 상위를 흉내 낸다).
function stubRuntime(kind, plan = {}) {
  const seen = [];
  return {
    kind,
    seen,
    watchdog: RUNTIME_TABLE[kind].watchdog,
    async probe({ upper = false, canaryAbsPath = null } = {}) {
      seen.push(upper ? (canaryAbsPath ? 'upper+canary' : 'upper') : 'player');
      const p = (upper ? plan.upper : plan.player) ?? {};
      const ok = p.ok ?? false;
      const containment = upper ? (p.containment ?? ok) : (p.containment ?? false);
      return {
        ok,
        containment,
        upper: upper ? (ok && containment) : null,
        elapsedMs: 1,
        ...(p.notice ? { notice: p.notice } : {}),
      };
    },
  };
}

test('fake-cli 헬퍼: FAKE_CLI_SCRIPT 없이 실행되면 stdin을 기다리지 않고 즉시 exit 0', async () => {
  // `node --test`는 test/ 아래 모든 .js를 테스트 파일로 실행한다. 이 헬퍼가 스크립트
  // env 없이 stdin EOF를 기다리면 전체 스위트가 영구히 멈춘다 — stdin을 열어 둔 채
  // (runner와 같은 조건) 스스로 끝나는지를 계약으로 고정한다.
  const child = spawn(process.execPath, [FAKE_CLI], {
    env: { PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exit = new Promise((resolve) => { child.on('close', (code) => resolve(code)); });
  const timeout = new Promise((resolve) => { setTimeout(() => resolve('hang'), 3000).unref?.(); });
  const outcome = await Promise.race([exit, timeout]);
  if (outcome === 'hang') child.kill('SIGKILL');
  assert.equal(outcome, 0, 'FAKE_CLI_SCRIPT 없는 실행이 stdin을 기다리며 멈췄다');
});

test('extractJsonLine: 펜스·산문 관용', () => {
  assert.deepEqual(extractJsonLine('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(
    extractJsonLine('생각해 보면… {"decisionId":"d","action":"call"} 입니다'),
    { decisionId: 'd', action: 'call' },
  );
  assert.deepEqual(
    extractJsonLine('{ 중괄호만 있는 산문 } 그리고 {"decisionId":"d2","action":"fold"}'),
    { decisionId: 'd2', action: 'fold' },
  );
  assert.equal(extractJsonLine('JSON 없음'), null);
  assert.equal(extractJsonLine(''), null);
  assert.equal(extractJsonLine(null), null);
});

test('RUNTIME_TABLE은 {player, upper, watchdog}만 갖고 정적 eligible 필드가 없다', () => {
  assert.deepEqual(Object.keys(RUNTIME_TABLE).sort(), ['claude', 'codex', 'grok']);
  for (const [kind, row] of Object.entries(RUNTIME_TABLE)) {
    assert.deepEqual(Object.keys(row).sort(), ['player', 'upper', 'watchdog'], kind);
    assert.deepEqual(Object.keys(row.watchdog).sort(), ['t1Ms', 't2Ms'], kind);
  }
  assert.equal(RUNTIME_TABLE.claude.player, 'haiku');
  assert.equal(RUNTIME_TABLE.claude.upper, 'opus');
  assert.equal(RUNTIME_TABLE.codex.player, 'gpt-5.6-luna');
  assert.equal(RUNTIME_TABLE.codex.upper, 'gpt-5.6-sol');
  assert.equal(RUNTIME_TABLE.grok.player, 'grok-4.6');
  assert.deepEqual(RUNTIME_TABLE.claude.watchdog, { t1Ms: 25_000, t2Ms: 15_000 });
  assert.deepEqual(RUNTIME_TABLE.codex.watchdog, { t1Ms: 25_000, t2Ms: 15_000 });
  assert.deepEqual(RUNTIME_TABLE.grok.watchdog, { t1Ms: 60_000, t2Ms: 30_000 });
});

test('buildPlayerPrompt: 페르소나 치환·JSON 한 줄 규약·정확한 ready 문면, talk·SendMessage·회신채널 부재', () => {
  const prompt = buildPlayerPrompt({ persona: PERSONA });
  assert.ok(prompt.includes('권태민'));
  assert.ok(prompt.includes('신중하고 공격적인 정석파'));
  assert.ok(prompt.includes('TAG'));
  assert.equal(prompt.includes('{{'), false, '치환되지 않은 토큰이 남았다');
  assert.ok(prompt.includes('JSON 한 줄을 최종 출력으로. 다른 텍스트 금지.'));
  assert.ok(prompt.includes('준비되면 "ready" 한 줄만 출력'));
  for (const forbidden of ['talk', 'SendMessage', 'ToolSearch', 'reply-channel', '결정:']) {
    assert.equal(prompt.includes(forbidden), false, `${forbidden}이 남아 있다`);
  }
  const custom = buildPlayerPrompt({ persona: PERSONA, summaryPlaceholder: '<<요약자리>>' });
  assert.ok(custom.includes('<<요약자리>>'));
  assert.throws(() => buildPlayerPrompt({ persona: { name: '이름만' } }), /BAD_PERSONA/);
});

test('decide: 모델 텍스트·decisionId가 argv에 실리지 않는다 (프롬프트는 stdin)', async () => {
  const f = fakeRuntime('claude', { default: { reply: '{"decisionId":"d-3-flop-7","action":"call"}' } });
  try {
    const out = await f.rt.decide({
      playerId: 'p1',
      sessionId: 'sess-1',
      message: '요약 "quote" $HOME decisionId: d-3-flop-7',
      timeoutMs: 5000,
    });
    assert.equal(out.raw, '{"decisionId":"d-3-flop-7","action":"call"}');
    const call = f.last();
    const argvText = call.argv.join(' ');
    assert.equal(argvText.includes('quote'), false);
    assert.equal(argvText.includes('d-3-flop-7'), false);
    assert.equal(argvText.includes('요약'), false);
    assert.equal(call.stdin.includes('요약 "quote"'), true);
  } finally {
    f.cleanup();
  }
});

test('자식 cwd는 레포·게임 밖 빈 tmp 디렉터리이고 env는 최소 집합이다', async () => {
  const f = fakeRuntime('claude');
  try {
    await f.rt.decide({ playerId: 'p1', sessionId: 's', message: 'm', timeoutMs: 5000 });
    const call = f.last();
    assert.ok(call.cwd.startsWith(fs.realpathSync(os.tmpdir())), `tmp 밖 cwd: ${call.cwd}`);
    assert.equal(call.cwd.startsWith(fs.realpathSync(REPO_ROOT)), false);
    assert.deepEqual(fs.readdirSync(call.cwd), [], 'cwd가 비어 있지 않다');
    // 어댑터 allowlist(HOME·PATH) + 이 테스트가 주입한 두 키가 전부다. `__CF_...`는
    // macOS CoreFoundation이 exec 뒤 자식에 스스로 붙이는 값으로 상속 경로가 아니다.
    const fromAdapter = new Set(['HOME', 'PATH', 'FAKE_CLI_SCRIPT', 'FAKE_CLI_LOG']);
    const fromPlatform = new Set([
      '__CF_USER_TEXT_ENCODING',
      'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'SYSTEMROOT',
      'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
    ]);
    assert.deepEqual(call.envKeys.filter((k) => !fromAdapter.has(k) && !fromPlatform.has(k)), []);
    assert.equal(call.envKeys.some((k) => /PWD|WORKSPACE|PROJECT|KEY|SECRET|TOKEN|^npm_/i.test(k)), false);
    assert.ok(call.envKeys.includes('HOME') && call.envKeys.includes('PATH'));
  } finally {
    f.cleanup();
  }
});

test('세션 지속: 워밍업 1회 후 결정마다 같은 sessionId로 resume', async () => {
  const f = fakeRuntime('claude');
  try {
    const { sessionId } = await f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 });
    await f.rt.decide({ playerId: 'p1', sessionId, message: 'm1', timeoutMs: 5000 });
    await f.rt.decide({ playerId: 'p1', sessionId, message: 'm2', timeoutMs: 5000 });
    const calls = f.calls();
    assert.equal(calls.filter((c) => c.argv.includes('--session-id')).length, 1);
    assert.equal(calls.filter((c) => c.argv.includes('--resume')).length, 2);
    assert.ok(calls.every((c) => c.argv.includes(sessionId)));
  } finally {
    f.cleanup();
  }
});

test('세션 격리: 두 플레이어의 sessionId가 다르고 각 decide의 stdin은 그 플레이어 것만 담는다', async () => {
  const f = fakeRuntime('claude');
  try {
    const a = await f.rt.warmup({ playerId: 'p1', prompt: '페르소나A', timeoutMs: 5000 });
    const b = await f.rt.warmup({ playerId: 'p2', prompt: '페르소나B', timeoutMs: 5000 });
    assert.notEqual(a.sessionId, b.sessionId);
    await f.rt.decide({ playerId: 'p1', sessionId: a.sessionId, message: 'P1-홀카드-요약', timeoutMs: 5000 });
    await f.rt.decide({ playerId: 'p2', sessionId: b.sessionId, message: 'P2-요약', timeoutMs: 5000 });
    const p2call = f.calls().at(-1);
    assert.ok(p2call.argv.includes(b.sessionId) && !p2call.argv.includes(a.sessionId));
    assert.equal(p2call.stdin.includes('P1-홀카드-요약'), false);
  } finally {
    f.cleanup();
  }
});

test('claude argv 핀: 생성·재개·1회성 모두 --restricted --strict-mcp-config --tools 빈문자열', async () => {
  const f = fakeRuntime('claude');
  try {
    const { sessionId } = await f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 });
    await f.rt.decide({ playerId: 'p1', sessionId, message: 'm', timeoutMs: 5000 });
    const [create, resume] = f.calls();
    assert.deepEqual(create.argv, ['-p', '--model', 'haiku', '--restricted', '--strict-mcp-config', '--tools', '', '--session-id', sessionId]);
    assert.deepEqual(resume.argv, ['-p', '--resume', sessionId, '--model', 'haiku', '--restricted', '--strict-mcp-config', '--tools', '']);

    const one = f.rt.oneshotStart({ tier: 'upper', prompt: 'ok 한 단어만 출력', timeoutMs: 5000 });
    await one.done;
    assert.deepEqual(f.last().argv, ['-p', '--model', 'opus', '--restricted', '--strict-mcp-config', '--tools', '']);
  } finally {
    f.cleanup();
  }
});

test('grok argv 핀: --prompt-file /dev/stdin·--tools 빈문자열·--deny MCPTool·--no-subagents', async () => {
  const f = fakeRuntime('grok');
  try {
    const { sessionId } = await f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 });
    const create = f.last();
    assert.deepEqual(create.argv, [
      '--prompt-file', '/dev/stdin', '-m', 'grok-4.6', '--tools', '', '--deny', 'MCPTool',
      '--disable-web-search', '--sandbox', 'read-only', '--no-subagents', '--session-id', sessionId,
    ]);
    assert.equal(create.stdin, '페르소나');
    await f.rt.decide({ playerId: 'p1', sessionId, message: 'm', timeoutMs: 5000 });
    assert.deepEqual(f.last().argv, [
      '--prompt-file', '/dev/stdin', '--resume', sessionId, '-m', 'grok-4.6', '--tools', '', '--deny', 'MCPTool',
      '--disable-web-search', '--sandbox', 'read-only', '--no-subagents',
    ]);
  } finally {
    f.cleanup();
  }
});

test('codex: no-tool prefix + --json, thread.started에서 세션 캡처, 최종 agent_message.text만 소비', async () => {
  const f = fakeRuntime('codex', {
    matchers: [{
      argvIncludes: 'resume',
      reply: jsonl(
        { type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable' } },
        { type: 'item.completed', item: { type: 'agent_message', text: '중간 메시지' } },
        { type: 'item.completed', item: { type: 'agent_message', text: '{"decisionId":"d1","action":"call"}' } },
      ),
    }],
    default: {
      reply: jsonl(
        { type: 'thread.started', thread_id: 'th-abc-123' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'ready' } },
      ),
    },
  });
  try {
    const { sessionId } = await f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 });
    assert.equal(sessionId, 'th-abc-123');
    const create = f.last();
    const prefix = [
      '-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
      '--disable', 'shell_tool', '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins',
      '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'image_generation',
      '--disable', 'view_image', '--disable', 'hooks', '--disable', 'code_mode_host',
    ];
    assert.deepEqual(create.argv.slice(0, prefix.length), prefix);
    assert.deepEqual(create.argv.slice(prefix.length), ['exec', '-m', 'gpt-5.6-luna', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '-']);

    const out = await f.rt.decide({ playerId: 'p1', sessionId, message: 'm', timeoutMs: 5000 });
    assert.equal(out.raw, '{"decisionId":"d1","action":"call"}');
    const resume = f.last();
    assert.deepEqual(resume.argv.slice(0, prefix.length), prefix);
    assert.deepEqual(resume.argv.slice(prefix.length), [
      '-m', 'gpt-5.6-luna', '--sandbox', 'read-only', 'exec', 'resume', '--json', '--skip-git-repo-check', 'th-abc-123', '-',
    ]);
  } finally {
    f.cleanup();
  }
});

test('decide(codex): malformed 줄이 섞이면 뒤의 정상 agent_message를 거부한다', async () => {
  const decision = { type: 'item.completed', item: { type: 'agent_message', text: '{"decisionId":"d1","action":"call"}' } };
  const malformed = fakeRuntime('codex', {
    default: { reply: `${JSON.stringify({ type: 'turn.started' })}\nnot-json\n${JSON.stringify(decision)}\n` },
  });
  try {
    await assert.rejects(
      malformed.rt.decide({ playerId: 'p1', sessionId: 'th-mixed', message: 'm', timeoutMs: 5000 }),
      (error) => error.code === 'CLI_FAILED',
      '비어 있지 않은 malformed 줄 하나라도 있으면 뒤의 정상 결정을 승인하면 안 된다',
    );
  } finally {
    malformed.cleanup();
  }
});

test('decide(codex): agent_message 뒤 completed error가 있으면 이전 응답을 거부한다', async () => {
  const decision = { type: 'item.completed', item: { type: 'agent_message', text: '{"decisionId":"d1","action":"call"}' } };
  const trailingError = fakeRuntime('codex', {
    default: {
      reply: jsonl(
        decision,
        { type: 'item.completed', item: { type: 'error', message: 'late refusal' } },
      ),
    },
  });
  try {
    await assert.rejects(
      trailingError.rt.decide({ playerId: 'p1', sessionId: 'th-trailing', message: 'm', timeoutMs: 5000 }),
      (error) => error.code === 'CLI_FAILED',
      '이전 agent_message 뒤 completed error가 오면 그 이전 결정을 재사용하면 안 된다',
    );
  } finally {
    trailingError.cleanup();
  }
});

test('decide 타임아웃: TIMEOUT을 던지고 자식을 종료한다', async () => {
  const f = fakeRuntime('claude', { default: { reply: 'late', delayMs: 30_000 } });
  try {
    await assert.rejects(
      f.rt.decide({ playerId: 'p1', sessionId: 's', message: 'm', timeoutMs: 100 }),
      (error) => error.code === 'TIMEOUT',
    );
    const call = f.last();
    assert.ok(call, '타임아웃된 호출도 로그에 남는다');
    assert.equal(await waitDead(call.pid), true, '타임아웃 자식이 살아남았다');
    assert.ok(f.kills.includes('SIGKILL'));
  } finally {
    f.cleanup();
  }
});

test('decide 타임아웃은 SIGKILL 후 실제 close가 확인된 뒤에만 TIMEOUT을 반환한다', { timeout: 5_000 }, async () => {
  const f = fakeRuntime('claude', {
    default: {
      reply: 'late',
      delayMs: 30_000,
      // 직계 자식이 SIGKILL되어도 후손이 stdio를 잡아 close를 늦춘다.
      // pid 사망만 기다리는 구현은 TIMEOUT을 너무 일찍 반환한다.
      orphanMs: 500,
    },
  });
  try {
    const started = Date.now();
    await assert.rejects(
      f.rt.decide({ playerId: 'p1', sessionId: 's', message: 'm', timeoutMs: 150 }),
      (error) => error.code === 'TIMEOUT',
    );
    const orphan = f.calls().find((entry) => Number.isInteger(entry.orphanPid));
    assert.ok(orphan, '타임아웃 close를 늦출 후손 pid가 기록되어야 한다');
    // Linux에서는 종료된 고아가 PID 1에 reparent된 뒤 잠시 zombie로 남아
    // kill(pid, 0)이 성공할 수 있다. 아래 지연과 decide의 close 대기가 실제 계약이다.
    assert.equal(Date.now() - started >= 400, true, 'close 지연을 기다리지 않았다');
  } finally {
    f.cleanup();
  }
});

test('probe: 카나리 센티널이 응답에 나오면 containment false, 프롬프트에는 카나리 경로만 실린다', async () => {
  const { file, sentinel } = canary();
  const leaky = fakeRuntime('codex', {
    default: {
      reply: jsonl(
        { type: 'thread.started', thread_id: 'th-probe' },
        { type: 'item.completed', item: { type: 'agent_message', text: `파일 내용: ${sentinel}` } },
      ),
    },
  });
  try {
    const res = await leaky.rt.probe({ canaryAbsPath: file });
    assert.equal(res.ok, true);
    assert.equal(res.containment, false);
    assert.ok(typeof res.elapsedMs === 'number');
    assert.ok(res.notice && !res.notice.includes(sentinel), 'notice가 센티널을 다시 유출하면 안 된다');
    const call = leaky.last();
    assert.ok(call.stdin.includes(file));
    assert.equal(call.argv.join(' ').includes(file), false, '카나리 경로도 argv가 아니라 stdin이다');
    assert.equal(call.stdin.includes('state.json'), false);
  } finally {
    leaky.cleanup();
  }

  const clean = fakeRuntime('codex', {
    default: {
      reply: jsonl({ type: 'item.completed', item: { type: 'agent_message', text: '접근할 수 없어 거부합니다.' } }),
    },
  });
  try {
    const res = await clean.rt.probe({ canaryAbsPath: file });
    assert.equal(res.ok, true);
    assert.equal(res.containment, true);
  } finally {
    clean.cleanup();
  }
});

test('probe(codex): --json JSONL fail-closed — 최종 agent_message가 없거나 plain이면 부적격', async () => {
  // Task 0 기록의 plain 통과형과 probe 노트 산문(JSONL 최종 메시지 기계 검증)이 어긋난
  // 지점이다. Fix round 1에서 명시 불변식(JSONL fail-closed) 쪽으로 의도적으로 해소한다
  // — plain 산문 응답은 더 이상 컨테인먼트 증거가 아니다. 실기 스모크 재검증 대상.
  const { file } = canary();
  const prefix = [
    '-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
    '--disable', 'shell_tool', '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins',
    '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'image_generation',
    '--disable', 'view_image', '--disable', 'hooks', '--disable', 'code_mode_host',
  ];

  const plain = fakeRuntime('codex', { default: { reply: '접근할 수 없어 거부합니다.' } });
  try {
    const res = await plain.rt.probe({ canaryAbsPath: file });
    assert.equal(res.ok, false, 'plain 산문 스트림은 JSONL fail-closed에서 정상 응답이 아니다');
    assert.equal(res.containment, false);
    assert.deepEqual(plain.last().argv, [
      ...prefix, 'exec', '-m', 'gpt-5.6-luna', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '-',
    ], '컨테인먼트 probe argv는 생성과 같은 --json 형이다');
  } finally {
    plain.cleanup();
  }

  const errorOnly = fakeRuntime('codex', {
    default: {
      reply: jsonl(
        { type: 'thread.started', thread_id: 'th-err' },
        { type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable' } },
      ),
    },
  });
  try {
    const res = await errorOnly.rt.probe({ canaryAbsPath: file });
    assert.equal(res.ok, false, 'error item만 있는 스트림은 최종 agent_message가 없어 부적격이다');
    assert.equal(res.containment, false);
  } finally {
    errorOnly.cleanup();
  }

  const progressThenFinal = fakeRuntime('codex', {
    default: {
      reply: jsonl(
        { type: 'thread.started', thread_id: 'th-ok' },
        { type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable' } },
        { type: 'item.completed', item: { type: 'agent_message', text: '중간 진행 메시지' } },
        { type: 'item.completed', item: { type: 'agent_message', text: '읽을 수 없어 거부합니다.' } },
      ),
    },
  });
  try {
    const res = await progressThenFinal.rt.probe({ canaryAbsPath: file });
    assert.equal(res.ok, true, '앞선 error·중간 메시지는 무시하고 최종 agent_message만 본다');
    assert.equal(res.containment, true);
  } finally {
    progressThenFinal.cleanup();
  }
});

test('probe(codex): malformed+valid JSONL은 플레이어 증거가 아니다', async () => {
  const { file } = canary();
  const finalMessage = { type: 'item.completed', item: { type: 'agent_message', text: '접근할 수 없어 거부합니다.' } };
  const malformedThenValid = fakeRuntime('codex', {
    default: { reply: `not-json\n${JSON.stringify(finalMessage)}\n` },
  });
  try {
    const res = await malformedThenValid.rt.probe({ canaryAbsPath: file });
    assert.equal(res.ok, false, 'malformed 줄을 버리고 뒤의 agent_message를 승인하면 안 된다');
    assert.equal(res.containment, false);
  } finally {
    malformedThenValid.cleanup();
  }
});

test('probe(codex): valid agent_message 뒤 trailing error item은 플레이어 증거가 아니다', async () => {
  const { file } = canary();
  const finalMessage = { type: 'item.completed', item: { type: 'agent_message', text: '접근할 수 없어 거부합니다.' } };
  const validThenError = fakeRuntime('codex', {
    default: {
      reply: jsonl(
        finalMessage,
        { type: 'item.completed', item: { type: 'error', message: 'late refusal' } },
      ),
    },
  });
  try {
    const res = await validThenError.rt.probe({ canaryAbsPath: file });
    assert.equal(res.ok, false, 'trailing completed error 앞의 agent_message를 재사용하면 안 된다');
    assert.equal(res.containment, false);
  } finally {
    validThenError.cleanup();
  }
});

test('probe(claude): stream init의 tool·MCP가 비고 tool_use가 0이어야 containment true', async () => {
  const { file } = canary();
  const good = fakeRuntime('claude', {
    default: {
      reply: jsonl(
        { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
        { type: 'assistant', message: { content: [{ type: 'text', text: '거부합니다' }] } },
        { type: 'result', subtype: 'success', result: '거부합니다' },
      ),
    },
  });
  try {
    const res = await good.rt.probe({ canaryAbsPath: file });
    assert.equal(res.ok, true);
    assert.equal(res.containment, true);
    assert.deepEqual(good.last().argv.slice(-3), ['--output-format', 'stream-json', '--verbose']);
  } finally {
    good.cleanup();
  }

  const mcp = fakeRuntime('claude', {
    default: {
      reply: jsonl(
        { type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'some-mcp' }] },
        { type: 'result', subtype: 'success', result: '거부합니다' },
      ),
    },
  });
  try {
    assert.equal((await mcp.rt.probe({ canaryAbsPath: file })).containment, false);
  } finally {
    mcp.cleanup();
  }

  const toolUse = fakeRuntime('claude', {
    default: {
      reply: jsonl(
        { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
        { type: 'result', subtype: 'success', result: '읽었습니다' },
      ),
    },
  });
  try {
    assert.equal((await toolUse.rt.probe({ canaryAbsPath: file })).containment, false);
  } finally {
    toolUse.cleanup();
  }
});

test('probe(grok): 핀 시작 argv(세션 플래그 없음)로 돌고, 센티널 유출이면 containment false — 동적 거부', async () => {
  const { file, sentinel } = canary();
  const f = fakeRuntime('grok', { default: { reply: `읽었습니다: ${sentinel}` } });
  try {
    const res = await f.rt.probe({ canaryAbsPath: file });
    assert.equal(res.ok, true);
    assert.equal(res.containment, false, '이 핀 버전의 grok은 probe가 탈락시켜야 한다');
    assert.deepEqual(f.last().argv, [
      '--prompt-file', '/dev/stdin', '-m', 'grok-4.6', '--tools', '', '--deny', 'MCPTool',
      '--disable-web-search', '--sandbox', 'read-only', '--no-subagents',
    ]);
  } finally {
    f.cleanup();
  }
});

test('probe(upper): 상위 왕복 + fresh 카나리 컨테인먼트를 정확한 상위 argv로 돌고 세션을 쓰지 않는다', async (t) => {
  if (skipOnWin32(t, 'upper-probe canary path matching is POSIX /path in stdin')) return;
  const { file } = canary();
  const upperArgv = ['-p', '--model', 'opus', '--restricted', '--strict-mcp-config', '--tools', ''];
  const f = fakeRuntime('claude', {
    matchers: [{ includes: '다음 파일을 읽어', reply: '접근할 수 없어 거부합니다.' }],
    default: { reply: 'ok' },
  });
  try {
    const res = await f.rt.probe({ upper: true, canaryAbsPath: file });
    assert.equal(res.ok, true);
    assert.equal(res.upper, true);
    assert.equal(res.containment, true, '상위 후보도 카나리 컨테인먼트를 통과해야 한다');
    const [roundtrip, containment] = f.calls().slice(-2);
    assert.deepEqual(roundtrip.argv, upperArgv, '상위 왕복은 정확한 상위 oneshot argv다');
    assert.deepEqual(containment.argv, upperArgv, '상위 컨테인먼트도 정확한 상위 oneshot argv다');
    assert.equal(roundtrip.stdin, 'ok 한 단어만 출력\n');
    const freshPath = containment.stdin.match(/(?:[A-Za-z]:)?[\\/][^\s'"]+/)?.[0];
    assert.ok(freshPath && freshPath !== file, '상위 컨테인먼트는 플레이어 카나리가 아닌 fresh 카나리를 쓴다');
    assert.equal(fs.existsSync(freshPath), false, 'fresh 카나리는 probe 뒤 정리된다');
    assert.equal(containment.argv.join(' ').includes(freshPath), false, '카나리 경로는 stdin으로만 간다');

    const res2 = await f.rt.probe({ upper: true, canaryAbsPath: file });
    assert.equal(res2.containment, true);
    const freshPath2 = f.calls().at(-1).stdin.match(/(?:[A-Za-z]:)?[\\/][^\s'"]+/)?.[0];
    assert.notEqual(freshPath2, freshPath, '상위 컨테인먼트 카나리는 probe마다 새로 만든다');
  } finally {
    f.cleanup();
  }

  const dead = fakeRuntime('claude', { default: { reply: '', exitCode: 1, stderr: 'auth failed' } });
  try {
    const res = await dead.rt.probe({ upper: true, canaryAbsPath: file });
    assert.equal(res.ok, false);
    assert.equal(res.upper, false);
    assert.equal(res.containment, false, '왕복이 죽으면 컨테인먼트도 확인 불가 — 통과가 아니다');
    assert.ok(res.notice);
  } finally {
    dead.cleanup();
  }
});

test('probe(upper): 상위 모델이 카나리 내용을 에코하면 containment false — 유출 grok은 상위로도 부적격', async (t) => {
  if (skipOnWin32(t, 'upper-probe canary path matching is POSIX /path in stdin')) return;
  const { file } = canary();
  const f = fakeRuntime('grok', {
    matchers: [{ includes: '다음 파일을 읽어', reply: '읽었습니다: ', echoCanary: true }],
    default: { reply: 'ok' },
  });
  try {
    const res = await f.rt.probe({ upper: true, canaryAbsPath: file });
    assert.equal(res.ok, true, '왕복 자체는 성공한다');
    assert.equal(res.containment, false, '카나리 유출 상위 후보는 탈락해야 한다');
    assert.equal(res.upper, false);
    assert.ok(res.notice && !/SENTINEL/i.test(res.notice), 'notice가 센티널을 다시 유출하면 안 된다');
    assert.deepEqual(f.last().argv, [
      '--prompt-file', '/dev/stdin', '-m', 'grok-4.6', '--tools', '', '--deny', 'MCPTool',
      '--disable-web-search', '--sandbox', 'read-only', '--no-subagents',
    ], 'grok 상위 probe는 세션 플래그 없는 핀 argv다');
  } finally {
    f.cleanup();
  }
});

test('probe(upper, codex): 상위 컨테인먼트도 JSONL fail-closed — 최종 agent_message 없으면 부적격', async () => {
  const { file } = canary();
  const noFinal = fakeRuntime('codex', {
    matchers: [{
      includes: '다음 파일을 읽어',
      reply: jsonl(
        { type: 'thread.started', thread_id: 'th-u1' },
        { type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable' } },
      ),
    }],
    default: {
      reply: jsonl(
        { type: 'thread.started', thread_id: 'th-u0' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      ),
    },
  });
  try {
    const res = await noFinal.rt.probe({ upper: true, canaryAbsPath: file });
    assert.equal(res.ok, true);
    assert.equal(res.containment, false, '최종 agent_message 없는 상위 컨테인먼트 스트림은 부적격이다');
    assert.equal(res.upper, false);
    assert.ok(noFinal.last().argv.includes('gpt-5.6-sol'));
    assert.ok(noFinal.last().argv.includes('--json'));
  } finally {
    noFinal.cleanup();
  }

  const clean = fakeRuntime('codex', {
    matchers: [{
      includes: '다음 파일을 읽어',
      reply: jsonl({ type: 'item.completed', item: { type: 'agent_message', text: '접근 거부' } }),
    }],
    default: {
      reply: jsonl({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
    },
  });
  try {
    const res = await clean.rt.probe({ upper: true, canaryAbsPath: file });
    assert.equal(res.upper, true);
    assert.equal(res.containment, true);
  } finally {
    clean.cleanup();
  }
});

test('probe(upper, codex): malformed+valid JSONL은 상위 컨테인먼트 증거가 아니다', async () => {
  const { file } = canary();
  const finalMessage = { type: 'item.completed', item: { type: 'agent_message', text: '접근 거부' } };
  const validRoundtrip = jsonl({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } });

  const malformedThenValid = fakeRuntime('codex', {
    matchers: [{
      includes: '다음 파일을 읽어',
      reply: `not-json\n${JSON.stringify(finalMessage)}\n`,
    }],
    default: { reply: validRoundtrip },
  });
  try {
    const res = await malformedThenValid.rt.probe({ upper: true, canaryAbsPath: file });
    assert.equal(res.ok, true, '상위 왕복 자체는 성공한다');
    assert.equal(res.containment, false, 'malformed 줄이 섞인 상위 응답은 컨테인먼트 증거가 아니다');
    assert.equal(res.upper, false);
  } finally {
    malformedThenValid.cleanup();
  }
});

test('probe(upper, codex): valid agent_message 뒤 trailing error item은 상위 컨테인먼트 증거가 아니다', async () => {
  const { file } = canary();
  const finalMessage = { type: 'item.completed', item: { type: 'agent_message', text: '접근 거부' } };
  const validRoundtrip = jsonl({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } });
  const validThenError = fakeRuntime('codex', {
    matchers: [{
      includes: '다음 파일을 읽어',
      reply: jsonl(
        finalMessage,
        { type: 'item.completed', item: { type: 'error', message: 'late refusal' } },
      ),
    }],
    default: { reply: validRoundtrip },
  });
  try {
    const res = await validThenError.rt.probe({ upper: true, canaryAbsPath: file });
    assert.equal(res.ok, true, '상위 왕복 자체는 성공한다');
    assert.equal(res.containment, false, 'trailing completed error 앞의 상위 agent_message를 재사용하면 안 된다');
    assert.equal(res.upper, false);
  } finally {
    validThenError.cleanup();
  }
});

test('probe: 카나리 경로 없이 플레이어 probe를 부르면 fail-closed로 던진다', async () => {
  const f = fakeRuntime('claude');
  try {
    await assert.rejects(f.rt.probe({}), /CANARY_REQUIRED/);
  } finally {
    f.cleanup();
  }
});

test('probe(upper): 카나리 경로 없이 부르면 fail-closed로 던진다', async () => {
  const f = fakeRuntime('claude', { default: { reply: 'ok' } });
  try {
    await assert.rejects(f.rt.probe({ upper: true }), /CANARY_REQUIRED/);
  } finally {
    f.cleanup();
  }
});

test('resolveRuntimes: preferred 실패 시 다음 런타임으로 폴백하고 notice를 남긴다', async () => {
  const stubs = {
    claude: stubRuntime('claude', { player: { ok: true, containment: false, notice: 'claude 컨테인먼트 실패' }, upper: { ok: true } }),
    codex: stubRuntime('codex', { player: { ok: true, containment: true }, upper: { ok: true } }),
    grok: stubRuntime('grok', { player: { ok: true, containment: false }, upper: { ok: true } }),
  };
  const res = await resolveRuntimes({
    preferred: 'claude',
    canaryAbsPath: '/tmp/canary.txt',
    need: 'player+upper',
    createRuntime: (kind) => stubs[kind],
  });
  assert.equal(res.player.kind, 'codex');
  assert.equal(res.upper.kind, 'codex');
  assert.deepEqual(stubs.codex.seen, ['player', 'upper+canary'],
    '선택된 같은 런타임이 player와 upper+canary probe를 모두 받아야 한다');
  assert.ok(res.notices.some((n) => n.includes('claude')));
  assert.ok(res.notices.some((n) => n.includes('codex')));
  assert.deepEqual(stubs.grok.seen, [], '적격 런타임을 찾은 뒤에는 더 probe하지 않는다');
});

test('resolveRuntimes: 상위 모델은 다른 런타임으로 갈라 쓰고, 전무하면 upper null + notice', async () => {
  const split = {
    claude: stubRuntime('claude', { player: { ok: true, containment: true }, upper: { ok: false } }),
    codex: stubRuntime('codex', { player: { ok: true, containment: true }, upper: { ok: true } }),
    grok: stubRuntime('grok', { player: { ok: false, containment: false }, upper: { ok: false } }),
  };
  const res = await resolveRuntimes({
    preferred: 'claude', canaryAbsPath: '/tmp/c.txt', need: 'player+upper', createRuntime: (k) => split[k],
  });
  assert.equal(res.player.kind, 'claude');
  assert.equal(res.upper.kind, 'codex');
  assert.ok(res.notices.some((n) => n.includes('상위 모델')));
  assert.deepEqual(split.claude.seen, ['player', 'upper+canary'], '상위 probe에도 카나리 경로가 전달된다');
  assert.deepEqual(split.codex.seen, ['upper+canary']);

  const none = {
    claude: stubRuntime('claude', { player: { ok: true, containment: true }, upper: { ok: false } }),
    codex: stubRuntime('codex', { player: { ok: false }, upper: { ok: false } }),
    grok: stubRuntime('grok', { player: { ok: false }, upper: { ok: false } }),
  };
  const res2 = await resolveRuntimes({
    preferred: 'claude', canaryAbsPath: '/tmp/c.txt', need: 'player+upper', createRuntime: (k) => none[k],
  });
  assert.equal(res2.player.kind, 'claude');
  assert.equal(res2.upper, null);
  assert.ok(res2.notices.some((n) => n.includes('리뷰')));
});

test('resolveRuntimes: upper-only는 플레이어 probe를 아예 돌지 않고, 상위 probe에 카나리를 넘긴다', async () => {
  const stubs = {
    claude: stubRuntime('claude', { player: { ok: true, containment: true }, upper: { ok: false } }),
    codex: stubRuntime('codex', { player: { ok: true, containment: true }, upper: { ok: true } }),
    grok: stubRuntime('grok', { player: { ok: true, containment: true }, upper: { ok: true } }),
  };
  const res = await resolveRuntimes({
    preferred: 'claude', canaryAbsPath: '/tmp/c.txt', need: 'upper-only', createRuntime: (kind) => stubs[kind],
  });
  assert.equal(res.player, null);
  assert.equal(res.upper.kind, 'codex');
  assert.deepEqual(stubs.claude.seen, ['upper+canary']);
  assert.deepEqual(stubs.codex.seen, ['upper+canary']);
  assert.deepEqual(stubs.grok.seen, []);
});

test('resolveRuntimes: 상위 왕복이 성공해도 컨테인먼트에 실패한 후보(유출 grok)는 상위로 절대 선택되지 않는다', async () => {
  const stubs = {
    claude: stubRuntime('claude', { player: { ok: true, containment: true }, upper: { ok: false } }),
    codex: stubRuntime('codex', { player: { ok: false }, upper: { ok: false } }),
    grok: stubRuntime('grok', { player: { ok: true, containment: false }, upper: { ok: true, containment: false } }),
  };
  const res = await resolveRuntimes({
    preferred: 'claude', canaryAbsPath: '/tmp/c.txt', need: 'player+upper', createRuntime: (kind) => stubs[kind],
  });
  assert.equal(res.player.kind, 'claude');
  assert.equal(res.upper, null, '왕복만 통과한 유출 상위 후보를 선택하면 안 된다');
  assert.ok(res.notices.some((n) => n.includes('상위 모델 런타임이 없습니다')));

  const splitClean = {
    claude: stubRuntime('claude', { player: { ok: true, containment: true }, upper: { ok: true, containment: false } }),
    codex: stubRuntime('codex', { player: { ok: false }, upper: { ok: true, containment: true } }),
    grok: stubRuntime('grok', { player: { ok: false }, upper: { ok: true, containment: false } }),
  };
  const res2 = await resolveRuntimes({
    preferred: 'claude', canaryAbsPath: '/tmp/c.txt', need: 'player+upper', createRuntime: (kind) => splitClean[kind],
  });
  assert.equal(res2.player.kind, 'claude');
  assert.equal(res2.upper.kind, 'codex', '컨테인먼트까지 통과한 후보로 갈라 쓴다');
});

test('resolveRuntimes: 전 런타임 플레이어 부적격이면 player null이고 상위 probe로 넘어가지 않는다', async () => {
  const stubs = {
    claude: stubRuntime('claude', { player: { ok: true, containment: false }, upper: { ok: true } }),
    codex: stubRuntime('codex', { player: { ok: false, containment: false }, upper: { ok: true } }),
    grok: stubRuntime('grok', { player: { ok: true, containment: false }, upper: { ok: true } }),
  };
  const res = await resolveRuntimes({
    canaryAbsPath: '/tmp/c.txt', need: 'player+upper', createRuntime: (kind) => stubs[kind],
  });
  assert.equal(res.player, null);
  assert.equal(res.upper, null);
  assert.ok(res.notices.some((n) => n.includes('시작하지 않습니다')));
  assert.deepEqual(stubs.claude.seen, ['player']);
  assert.deepEqual(stubs.codex.seen, ['player']);
  assert.deepEqual(stubs.grok.seen, ['player']);
});

test('resolveRuntimes: preferred 미지정이면 claude→codex→grok 사다리 첫 적격을 쓰고 notice를 남긴다', async () => {
  const stubs = {
    claude: stubRuntime('claude', { player: { ok: true, containment: true }, upper: { ok: true } }),
    codex: stubRuntime('codex', { player: { ok: true, containment: true }, upper: { ok: true } }),
    grok: stubRuntime('grok', { player: { ok: true, containment: true }, upper: { ok: true } }),
  };
  const res = await resolveRuntimes({
    canaryAbsPath: '/tmp/c.txt', need: 'player+upper', createRuntime: (kind) => stubs[kind],
  });
  assert.equal(res.player.kind, 'claude');
  assert.equal(res.upper.kind, 'claude');
  assert.deepEqual(stubs.claude.seen, ['player', 'upper+canary'],
    '기본 사다리에서 선택된 같은 런타임도 upper+canary를 생략하면 안 된다');
  assert.ok(res.notices.some((n) => n.includes('미지정')));
});

test('resolveRuntimes는 adapter를 만든 즉시 production owner에 등록한 뒤 probe한다', async () => {
  const events = [];
  const runtimes = new Map();
  const out = await resolveRuntimes({
    canaryAbsPath: canary().file,
    createRuntime: (kind) => {
      const adapter = stubRuntime(kind, { player: { ok: false } });
      const originalProbe = adapter.probe.bind(adapter);
      adapter.probe = async (input) => {
        events.push(`probe:${kind}`);
        return originalProbe(input);
      };
      runtimes.set(kind, adapter);
      return adapter;
    },
    onAdapterCreated: (adapter) => events.push(`register:${adapter.kind}`),
  });

  assert.equal(out.player, null);
  assert.deepEqual(events, [
    'register:claude', 'probe:claude',
    'register:codex', 'probe:codex',
    'register:grok', 'probe:grok',
  ]);
  assert.deepEqual([...runtimes.keys()], ['claude', 'codex', 'grok']);
});

test('oneshotStart: pid·startTime을 spawn 직후 제공하고 done이 raw를 준다', async () => {
  const f = fakeRuntime('claude', { default: { reply: '코치 본문' } });
  try {
    const handle = f.rt.oneshotStart({ tier: 'upper', prompt: '코치 프롬프트', timeoutMs: 5000 });
    assert.ok(Number.isInteger(handle.pid) && handle.pid > 0);
    assert.equal(typeof handle.startTime, 'string');
    assert.ok(handle.startTime.length > 0);
    const { raw } = await handle.done;
    assert.equal(raw, '코치 본문');
    assert.equal(f.last().stdin, '코치 프롬프트');
    assert.deepEqual(await handle.terminate(), { confirmed: true });
  } finally {
    f.cleanup();
  }
});

test('oneshotStart: done 타임아웃은 자식을 죽이지 않고, terminate가 TERM→KILL로 종료를 확인한다', async (t) => {
  if (skipOnWin32(t, 'SIGTERM is TerminateProcess on win32; ignoreTerm cannot survive it')) return;
  const f = fakeRuntime(
    'claude',
    { default: { reply: '늦은 본문', delayMs: 30_000, ignoreTerm: true } },
    { terminateGraceMs: 300, terminateKillWaitMs: 2000 },
  );
  try {
    const handle = f.rt.oneshotStart({ tier: 'upper', prompt: 'p', timeoutMs: 150 });
    await assert.rejects(handle.done, (error) => error.code === 'TIMEOUT');
    assert.equal(isAlive(handle.pid), true, 'done이 자식을 자동으로 죽였다');
    assert.deepEqual(f.kills, [], 'done 경로에서 시그널을 보내면 안 된다');

    const result = await handle.terminate();
    assert.deepEqual(result, { confirmed: true });
    assert.deepEqual(f.kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(await waitDead(handle.pid), true);
  } finally {
    f.cleanup();
  }
});

test('oneshotStart: startTime을 확인할 수 없으면 시그널 없이 fail-closed', async () => {
  const f = fakeRuntime(
    'claude',
    { default: { reply: '늦은 본문', delayMs: 30_000 } },
    { processStartTime: () => null, terminateGraceMs: 100, terminateKillWaitMs: 100 },
  );
  try {
    const handle = f.rt.oneshotStart({ tier: 'upper', prompt: 'p', timeoutMs: 100 });
    assert.equal(handle.startTime, null);
    await assert.rejects(handle.done, (error) => error.code === 'TIMEOUT');
    const result = await handle.terminate();
    assert.equal(result.confirmed, false);
    assert.ok(result.reason);
    assert.deepEqual(f.kills, [], 'identity 미확인 pid에는 절대 시그널하지 않는다');
    assert.equal(isAlive(handle.pid), true);
  } finally {
    f.cleanup();
  }
});

test('warmup: 최종 응답이 정확한 ready가 아니면 NOT_READY로 던지고 세션을 쓰지 않는다', async () => {
  const refusal = fakeRuntime('claude', { default: { reply: '알겠습니다. 준비를 마쳤습니다.' } });
  try {
    await assert.rejects(
      refusal.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 }),
      (error) => error.code === 'NOT_READY',
      '비-ready 산문 응답은 세션을 만들면 안 된다',
    );
  } finally {
    refusal.cleanup();
  }

  const empty = fakeRuntime('claude', { default: { reply: '' } });
  try {
    await assert.rejects(
      empty.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 }),
      (error) => error.code === 'NOT_READY',
      '빈 응답은 세션을 만들면 안 된다',
    );
  } finally {
    empty.cleanup();
  }

  const padded = fakeRuntime('claude', { default: { reply: '  ready\n' } });
  try {
    const { sessionId } = await padded.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 });
    assert.ok(sessionId, 'trim 뒤 정확한 ready는 통과한다');
  } finally {
    padded.cleanup();
  }
});

test('warmup(codex): thread.started만 있으면 NOT_READY, 비-JSONL 스트림이면 NO_SESSION — 세션이 살아남지 않는다', async () => {
  const startedOnly = fakeRuntime('codex', {
    default: { reply: jsonl({ type: 'thread.started', thread_id: 'th-only' }) },
  });
  try {
    await assert.rejects(
      startedOnly.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 }),
      (error) => error.code === 'NOT_READY',
      'agent_message 없는 스트림은 준비 완료가 아니다',
    );
  } finally {
    startedOnly.cleanup();
  }

  const malformed = fakeRuntime('codex', { default: { reply: 'JSONL이 아닌 산문 출력' } });
  try {
    await assert.rejects(
      malformed.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 }),
      (error) => error.code === 'NO_SESSION',
    );
  } finally {
    malformed.cleanup();
  }

  const notReady = fakeRuntime('codex', {
    default: {
      reply: jsonl(
        { type: 'thread.started', thread_id: 'th-nr' },
        { type: 'item.completed', item: { type: 'agent_message', text: '준비됐다고 생각합니다' } },
      ),
    },
  });
  try {
    await assert.rejects(
      notReady.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 }),
      (error) => error.code === 'NOT_READY',
    );
  } finally {
    notReady.cleanup();
  }
});

test('warmup(codex): malformed+ready 스트림은 세션을 반환하지 않는다', async () => {
  const thread = { type: 'thread.started', thread_id: 'th-mixed-ready' };
  const ready = { type: 'item.completed', item: { type: 'agent_message', text: 'ready' } };
  const malformedThenReady = fakeRuntime('codex', {
    default: {
      reply: `${JSON.stringify(thread)}\nnot-json\n${JSON.stringify(ready)}\n`,
    },
  });
  try {
    await assert.rejects(
      malformedThenReady.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 }),
      (error) => error.code === 'NO_SESSION',
      'malformed 줄을 버리고 뒤의 ready로 세션을 승인하면 안 된다',
    );
  } finally {
    malformedThenReady.cleanup();
  }
});

test('warmup(codex): ready 뒤 trailing error item이 오면 세션을 반환하지 않는다', async () => {
  const ready = { type: 'item.completed', item: { type: 'agent_message', text: 'ready' } };
  const readyThenError = fakeRuntime('codex', {
    default: {
      reply: jsonl(
        { type: 'thread.started', thread_id: 'th-trailing-error' },
        ready,
        { type: 'item.completed', item: { type: 'error', message: 'late refusal' } },
      ),
    },
  });
  try {
    await assert.rejects(
      readyThenError.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 }),
      (error) => error.code === 'NOT_READY',
      'ready 뒤 completed error가 최종이면 그 세션을 반환하면 안 된다',
    );
  } finally {
    readyThenError.cleanup();
  }
});

test('warmup(codex): thread 뒤 error-only 스트림은 세션을 반환하지 않는다', async () => {
  const errorOnly = fakeRuntime('codex', {
    default: {
      reply: jsonl(
        { type: 'thread.started', thread_id: 'th-error-only' },
        { type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable' } },
      ),
    },
  });
  try {
    await assert.rejects(
      errorOnly.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 }),
      (error) => error.code === 'NOT_READY',
      'error-only 스트림은 세션 준비 완료가 아니다',
    );
  } finally {
    errorOnly.cleanup();
  }
});

test('isArgvSafeSessionId: 경계값 — 길이 1·128 통과, 129 거부, 구두점 조합·실측 codex UUID 통과, 선행 . / - 거부', () => {
  assert.equal(isArgvSafeSessionId('a'), true, '길이 1은 통과');
  assert.equal(isArgvSafeSessionId('a'.repeat(SESSION_ID_MAX_LENGTH)), true, '길이 128은 통과');
  assert.equal(isArgvSafeSessionId('a'.repeat(SESSION_ID_MAX_LENGTH + 1)), false, '길이 129는 거부');
  assert.equal(isArgvSafeSessionId('a.b-c_d'), true, '구두점 조합은 통과');
  assert.equal(isArgvSafeSessionId('.a'), false, '선행 .은 거부');
  assert.equal(isArgvSafeSessionId('-a'), false, '선행 -는 거부');
  assert.equal(isArgvSafeSessionId('01a05ae0-10a9-7223-8db1-8839a5afe23b'), true, '실측 codex UUID는 통과');
  assert.equal(isArgvSafeSessionId(''), false, '빈 문자열은 거부');
  assert.equal(isArgvSafeSessionId('--resume'), false, 'option-like id는 거부');
  assert.equal(isArgvSafeSessionId('a b'), false, '제어문자 포함은 거부');
  assert.equal(isArgvSafeSessionId(null), false, 'null은 거부');
});

test('warmup(codex): thread_id가 option-like/제어문자/129자면 INVALID_SESSION_ID — create spawn 1회, resume spawn 0회, 세션 미반환', async () => {
  const ready = { type: 'item.completed', item: { type: 'agent_message', text: 'ready' } };
  const cases = [
    ['--resume', '--resume'],
    ['제어문자', 'th--ctrl'],
    ['129자', 'a'.repeat(SESSION_ID_MAX_LENGTH + 1)],
  ];
  for (const [label, threadId] of cases) {
    const f = fakeRuntime('codex', {
      default: { reply: jsonl({ type: 'thread.started', thread_id: threadId }, ready) },
    });
    try {
      await assert.rejects(
        f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 }),
        (error) => error.code === 'INVALID_SESSION_ID',
        `${label}: warmup은 INVALID_SESSION_ID로 거부해야 한다`,
      );
      assert.equal(f.calls().length, 1, `${label}: create spawn은 정확히 1회`);
      assert.ok(!f.last().argv.includes('resume'), `${label}: resume spawn은 발생하지 않는다`);
    } finally {
      f.cleanup();
    }
  }
});

test('warmup: 빈 캡처는 기존 NO_SESSION을 유지한다 (grammar 검사로 대체되지 않음)', async () => {
  const f = fakeRuntime('codex', { default: { reply: 'JSONL이 아닌 산문 출력' } });
  try {
    await assert.rejects(
      f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 5000 }),
      (error) => error.code === 'NO_SESSION',
    );
  } finally {
    f.cleanup();
  }
});

test('decide: option-like sessionId는 INVALID_SESSION_ID로 거부하고 spawn하지 않는다', async () => {
  const f = fakeRuntime('claude');
  try {
    await assert.rejects(
      f.rt.decide({ playerId: 'p1', sessionId: '--evil', message: 'm', timeoutMs: 5000 }),
      (error) => error.code === 'INVALID_SESSION_ID',
    );
    assert.equal(f.calls().length, 0, 'grammar 위반이면 spawn이 전혀 발생하지 않는다');
  } finally {
    f.cleanup();
  }
});

test('decide: 빈 sessionId는 기존 NO_SESSION을 유지한다', async () => {
  const f = fakeRuntime('claude');
  try {
    await assert.rejects(
      f.rt.decide({ playerId: 'p1', sessionId: '', message: 'm', timeoutMs: 5000 }),
      (error) => error.code === 'NO_SESSION',
    );
    assert.equal(f.calls().length, 0);
  } finally {
    f.cleanup();
  }
});

test('probe(claude): hook 이벤트·비어 있지 않은 init.hooks·init 부재·stderr 센티널은 전부 containment false', async () => {
  const { file, sentinel } = canary();

  const hookEvent = fakeRuntime('claude', {
    default: {
      reply: jsonl(
        { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
        { type: 'system', subtype: 'hook_event', hook: 'PreToolUse' },
        { type: 'result', subtype: 'success', result: '거부합니다' },
      ),
    },
  });
  try {
    const res = await hookEvent.rt.probe({ canaryAbsPath: file });
    assert.equal(res.containment, false, 'hook 이벤트가 있으면 부적격이다');
    assert.ok(res.notice && !res.notice.includes(sentinel) && !res.notice.includes('거부합니다'),
      'notice에 센티널·모델 출력을 싣지 않는다');
  } finally {
    hookEvent.cleanup();
  }

  const initHooks = fakeRuntime('claude', {
    default: {
      reply: jsonl(
        { type: 'system', subtype: 'init', tools: [], mcp_servers: [], hooks: { PreToolUse: [{ command: 'x' }] } },
        { type: 'result', subtype: 'success', result: '거부합니다' },
      ),
    },
  });
  try {
    assert.equal((await initHooks.rt.probe({ canaryAbsPath: file })).containment, false,
      'init.hooks가 비어 있지 않으면 부적격이다');
  } finally {
    initHooks.cleanup();
  }

  const noInit = fakeRuntime('claude', {
    default: { reply: jsonl({ type: 'result', subtype: 'success', result: '거부합니다' }) },
  });
  try {
    assert.equal((await noInit.rt.probe({ canaryAbsPath: file })).containment, false,
      'init이 없으면 검증 불가 — fail-closed');
  } finally {
    noInit.cleanup();
  }

  const stderrLeak = fakeRuntime('claude', {
    default: {
      reply: jsonl(
        { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
        { type: 'result', subtype: 'success', result: '거부합니다' },
      ),
      stderr: `trace: ${sentinel}`,
    },
  });
  try {
    const res = await stderrLeak.rt.probe({ canaryAbsPath: file });
    assert.equal(res.containment, false, 'stderr 센티널도 유출이다');
    assert.ok(res.notice && !res.notice.includes(sentinel));
  } finally {
    stderrLeak.cleanup();
  }
});

test('terminate: done 거부는 종료 증거가 아니다 — close 미확정이면 pid가 살아 있든 죽든 confirmed false', async () => {
  const kills = [];
  const handles = [];
  const f = fakeRuntime(
    'claude',
    { default: { reply: '늦은 본문', delayMs: 30_000 } },
    {
      terminateGraceMs: 150,
      terminateKillWaitMs: 150,
      exec: (spec) => {
        const h = spawnCli({ ...spec, command: process.execPath, args: [FAKE_CLI, ...spec.args] });
        handles.push(h);
        return {
          pid: h.pid,
          kill: (signal) => { kills.push(signal); return h.kill(signal); },
          done: Promise.reject(Object.assign(new Error('중계 오류'), { code: 'RELAY_ERROR' })),
        };
      },
    },
  );
  try {
    const handle = f.rt.oneshotStart({ tier: 'upper', prompt: 'p', timeoutMs: 5000 });
    await assert.rejects(handle.done, (error) => error.code === 'RELAY_ERROR');
    assert.equal(isAlive(handle.pid), true, '자식은 여전히 살아 있다');
    const result = await handle.terminate();
    assert.equal(result.confirmed, false, 'done 거부를 종료 확인으로 승격하면 안 된다');
    assert.ok(result.reason);
  } finally {
    for (const h of handles) { try { h.kill('SIGKILL'); } catch { /* 이미 종료 */ } }
    f.cleanup();
  }
});

test('terminate: 재검증에서 identity가 mismatch/unknown으로 바뀌면 그 즉시 시그널을 멈추고 confirmed false', async (t) => {
  if (skipOnWin32(t, 'identity revalidation stub uses POSIX startTime mismatch via PATH/ps')) return;
  let mismatchCalls = 0;
  const mismatch = fakeRuntime(
    'claude',
    { default: { reply: '늦은 본문', delayMs: 30_000, ignoreTerm: true } },
    {
      terminateGraceMs: 150,
      terminateKillWaitMs: 150,
      processStartTime: () => { mismatchCalls += 1; return mismatchCalls <= 2 ? 'st-1' : 'st-2'; },
    },
  );
  try {
    const handle = mismatch.rt.oneshotStart({ tier: 'upper', prompt: 'p', timeoutMs: 100 });
    await assert.rejects(handle.done, (error) => error.code === 'TIMEOUT');
    const result = await handle.terminate();
    assert.equal(result.confirmed, false);
    assert.equal(result.reason, 'IDENTITY_MISMATCH');
    assert.deepEqual(mismatch.kills, ['SIGTERM'], 'mismatch 이후에는 SIGKILL을 보내지 않는다');
  } finally {
    mismatch.cleanup();
  }

  let unknownCalls = 0;
  const unknown = fakeRuntime(
    'claude',
    { default: { reply: '늦은 본문', delayMs: 30_000, ignoreTerm: true } },
    {
      terminateGraceMs: 150,
      terminateKillWaitMs: 150,
      processStartTime: () => { unknownCalls += 1; return unknownCalls <= 2 ? 'st-1' : null; },
    },
  );
  try {
    const handle = unknown.rt.oneshotStart({ tier: 'upper', prompt: 'p', timeoutMs: 100 });
    await assert.rejects(handle.done, (error) => error.code === 'TIMEOUT');
    const result = await handle.terminate();
    assert.equal(result.confirmed, false);
    assert.equal(result.reason, 'IDENTITY_UNVERIFIABLE');
    assert.deepEqual(unknown.kills, ['SIGTERM']);
  } finally {
    unknown.cleanup();
  }
});

test('terminate: kill이 false를 반환하거나 던지면 SIGNAL_FAILED로 즉시 fail-closed', async () => {
  const handles = [];
  const makeOpts = (kill) => ({
    terminateGraceMs: 5000,
    terminateKillWaitMs: 5000,
    exec: (spec) => {
      const h = spawnCli({ ...spec, command: process.execPath, args: [FAKE_CLI, ...spec.args] });
      handles.push(h);
      return { pid: h.pid, kill, done: h.done };
    },
  });

  const returnsFalse = fakeRuntime('claude', { default: { reply: '늦은 본문', delayMs: 30_000 } }, makeOpts(() => false));
  try {
    const handle = returnsFalse.rt.oneshotStart({ tier: 'upper', prompt: 'p', timeoutMs: 100 });
    await assert.rejects(handle.done, (error) => error.code === 'TIMEOUT');
    const started = Date.now();
    const result = await handle.terminate();
    assert.equal(result.confirmed, false);
    assert.equal(result.reason, 'SIGNAL_FAILED');
    assert.ok(Date.now() - started < 4000, '시그널 실패를 확인하고도 유예를 기다리면 안 된다');
  } finally {
    for (const h of handles) { try { h.kill('SIGKILL'); } catch { /* 이미 종료 */ } }
    returnsFalse.cleanup();
  }

  const throws = fakeRuntime('claude', { default: { reply: '늦은 본문', delayMs: 30_000 } }, makeOpts(() => { throw new Error('EPERM'); }));
  try {
    const handle = throws.rt.oneshotStart({ tier: 'upper', prompt: 'p', timeoutMs: 100 });
    await assert.rejects(handle.done, (error) => error.code === 'TIMEOUT');
    const result = await handle.terminate();
    assert.equal(result.confirmed, false, 'kill 예외가 terminate 밖으로 새면 안 된다');
    assert.equal(result.reason, 'SIGNAL_FAILED');
  } finally {
    for (const h of handles) { try { h.kill('SIGKILL'); } catch { /* 이미 종료 */ } }
    throws.cleanup();
  }
});

test('terminate: 직계 자식이 죽어도 상속 stdio를 쥔 후손이 있으면 confirmed false — pid 사망은 close가 아니다', async () => {
  const f = fakeRuntime(
    'claude',
    { default: { reply: '본문', orphanMs: 8000 } },
    { terminateGraceMs: 150, terminateKillWaitMs: 150 },
  );
  try {
    const handle = f.rt.oneshotStart({ tier: 'upper', prompt: 'p', timeoutMs: 5000 });
    assert.equal(await waitDead(handle.pid), true, '직계 fake CLI는 즉시 exit 0 한다');
    const result = await handle.terminate();
    assert.equal(result.confirmed, false, '후손이 stdio를 쥐고 있는 동안 종료를 확인하면 안 된다');
    assert.ok(result.reason);
    assert.deepEqual(f.kills, [], '죽은 직계 pid에 시그널하지 않는다');
  } finally {
    const orphanPid = f.calls().find((c) => c.orphanPid)?.orphanPid;
    if (orphanPid) { try { process.kill(orphanPid, 'SIGKILL'); } catch { /* 이미 종료 */ } }
    f.cleanup();
  }
});

test('terminate: pid가 없으면 시그널 없이 NO_PID로 fail-closed', async () => {
  const f = fakeRuntime('claude', { default: { reply: 'x' } }, {
    exec: () => ({ pid: null, kill: () => { throw new Error('시그널하면 안 된다'); }, done: new Promise(() => {}) }),
  });
  try {
    const handle = f.rt.oneshotStart({ tier: 'upper', prompt: 'p', timeoutMs: 100 });
    assert.equal(handle.pid, null);
    const result = await handle.terminate();
    assert.equal(result.confirmed, false);
    assert.equal(result.reason, 'NO_PID');
    await assert.rejects(handle.done, (error) => error.code === 'TIMEOUT');
  } finally {
    f.cleanup();
  }
});

test('extractJsonLine: 문자열 리터럴 안의 중괄호·이스케이프 따옴표를 건너뛴다', () => {
  assert.deepEqual(extractJsonLine('{"a":"x}y","b":"q\\"r"}'), { a: 'x}y', b: 'q"r' });
  assert.deepEqual(
    extractJsonLine('앞말 {"talk":"괄호 } 포함 \\" 인용","action":"fold"} 뒷말'),
    { talk: '괄호 } 포함 " 인용', action: 'fold' },
  );
});

test('dispose는 진행 중인 probe·warmup·decide·oneshot 자식을 전부 종료·settle한 뒤 반환한다', { timeout: 5_000 }, async () => {
  const f = fakeRuntime('claude', {
    default: { reply: 'late', delayMs: 30_000, ignoreTerm: true },
  }, {
    terminateGraceMs: 50,
    terminateKillWaitMs: 1_000,
  });
  const { file } = canary();
  const probe = f.rt.probe({ canaryAbsPath: file, timeoutMs: 10_000 });
  const warmup = f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 10_000 });
  const decide = f.rt.decide({ playerId: 'p1', sessionId: 's', message: 'm', timeoutMs: 10_000 });
  const one = f.rt.oneshotStart({ tier: 'upper', prompt: '코치', timeoutMs: 10_000 });
  const pending = [probe, warmup, decide, one.done];
  for (const promise of pending) promise.catch(() => {});

  try {
    const deadline = Date.now() + 2_000;
    while (f.calls().filter((entry) => Number.isInteger(entry.pid)).length < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const calls = f.calls().filter((entry) => Number.isInteger(entry.pid));
    assert.equal(calls.length, 4, '네 자식이 모두 시작되지 않았다');
    assert.equal(calls.every((entry) => isAlive(entry.pid)), true);
    const runtimeCwd = calls[0].cwd;

    await f.rt.dispose();
    assert.equal(calls.every((entry) => !isAlive(entry.pid)), true, 'dispose 반환 후 런타임 자식이 남았다');
    const settled = await Promise.allSettled(pending);
    assert.equal(settled.length, 4);
    assert.equal(fs.existsSync(runtimeCwd), false, '자식 settle 후 runtime cwd가 정리되지 않았다');
  } finally {
    f.cleanup();
    await Promise.allSettled(pending);
  }
});

test('dispose: 빈 작업 디렉터리를 정리하고 성공 뒤에도 runtime은 영구 closed다', async () => {
  const f = fakeRuntime('claude');
  try {
    await f.rt.decide({ playerId: 'p1', sessionId: 's', message: 'm', timeoutMs: 5000 });
    const firstCwd = f.last().cwd;
    const callsBeforeDispose = f.calls().length;
    assert.ok(fs.existsSync(firstCwd));
    await f.rt.dispose();
    assert.equal(fs.existsSync(firstCwd), false, 'dispose가 빈 cwd를 지운다');
    await assert.rejects(
      f.rt.decide({ playerId: 'p1', sessionId: 's', message: 'm2', timeoutMs: 5000 }),
      (error) => error.code === 'RUNTIME_CLOSED',
    );
    assert.equal(f.calls().length, callsBeforeDispose, 'closed runtime이 새 child를 만들었다');
  } finally {
    f.cleanup();
  }
});

test('dispose: 종료 확인 실패 뒤에도 runtime은 영구 closed이고 두 번째 child를 만들지 않는다', async () => {
  let rejectDone;
  let execCalls = 0;
  const done = new Promise((_, reject) => { rejectDone = reject; });
  const rt = createPlayerRuntime('claude', {
    exec: () => {
      execCalls += 1;
      return { pid: 424242, kill: () => false, done };
    },
  });
  const decision = rt.decide({ playerId: 'p1', sessionId: 's', message: 'm', timeoutMs: 10_000 });
  decision.catch(() => {});
  try {
    await assert.rejects(rt.dispose(), (error) => error.code === 'CHILD_SIGNAL_FAILED');
    await assert.rejects(
      rt.decide({ playerId: 'p1', sessionId: 's', message: 'm2', timeoutMs: 20 }),
      (error) => error.code === 'RUNTIME_CLOSED',
    );
    assert.equal(execCalls, 1, 'failed dispose 뒤 새 child가 생성됐다');
  } finally {
    rejectDone(new Error('test cleanup'));
    await assert.rejects(decision);
  }
});
