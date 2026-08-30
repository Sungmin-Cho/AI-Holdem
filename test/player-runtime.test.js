import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUNTIME_TABLE,
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

// resolveRuntimes 사다리 테스트용 스텁 — probe 호출 순서·종류를 그대로 기록한다.
function stubRuntime(kind, plan = {}) {
  const seen = [];
  return {
    kind,
    seen,
    watchdog: RUNTIME_TABLE[kind].watchdog,
    async probe({ upper = false } = {}) {
      seen.push(upper ? 'upper' : 'player');
      const p = (upper ? plan.upper : plan.player) ?? {};
      return {
        ok: p.ok ?? false,
        containment: upper ? null : (p.containment ?? false),
        upper: upper ? (p.ok ?? false) : null,
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
    const fromPlatform = new Set(['__CF_USER_TEXT_ENCODING']);
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

test('probe: 카나리 센티널이 응답에 나오면 containment false, 프롬프트에는 카나리 경로만 실린다', async () => {
  const { file, sentinel } = canary();
  const leaky = fakeRuntime('codex', { default: { reply: `파일 내용: ${sentinel}` } });
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
    assert.equal(call.argv.includes('--json'), false, '컨테인먼트 probe는 핀된 plain argv다');
  } finally {
    leaky.cleanup();
  }

  const clean = fakeRuntime('codex', { default: { reply: '접근할 수 없어 거부합니다.' } });
  try {
    const res = await clean.rt.probe({ canaryAbsPath: file });
    assert.equal(res.ok, true);
    assert.equal(res.containment, true);
  } finally {
    clean.cleanup();
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

test('probe(upper): 상위 모델 왕복만 돌고 카나리·세션을 쓰지 않는다', async () => {
  const f = fakeRuntime('claude', {
    default: { reply: jsonl({ type: 'result', subtype: 'success', result: 'ok' }) },
  });
  try {
    const res = await f.rt.probe({ upper: true });
    assert.equal(res.ok, true);
    assert.equal(res.upper, true);
    assert.equal(res.containment, null);
    const call = f.last();
    assert.ok(call.argv.includes('opus'));
    assert.equal(call.argv.includes('--session-id'), false);
    assert.equal(call.argv.includes('canary'), false);
  } finally {
    f.cleanup();
  }

  const dead = fakeRuntime('claude', { default: { reply: '', exitCode: 1, stderr: 'auth failed' } });
  try {
    const res = await dead.rt.probe({ upper: true });
    assert.equal(res.ok, false);
    assert.equal(res.upper, false);
    assert.ok(res.notice);
  } finally {
    dead.cleanup();
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

test('resolveRuntimes: upper-only는 플레이어 probe를 아예 돌지 않는다', async () => {
  const stubs = {
    claude: stubRuntime('claude', { player: { ok: true, containment: true }, upper: { ok: false } }),
    codex: stubRuntime('codex', { player: { ok: true, containment: true }, upper: { ok: true } }),
    grok: stubRuntime('grok', { player: { ok: true, containment: true }, upper: { ok: true } }),
  };
  const res = await resolveRuntimes({
    preferred: 'claude', need: 'upper-only', createRuntime: (kind) => stubs[kind],
  });
  assert.equal(res.player, null);
  assert.equal(res.upper.kind, 'codex');
  assert.deepEqual(stubs.claude.seen, ['upper']);
  assert.deepEqual(stubs.codex.seen, ['upper']);
  assert.deepEqual(stubs.grok.seen, []);
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
  assert.ok(res.notices.some((n) => n.includes('미지정')));
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

test('oneshotStart: done 타임아웃은 자식을 죽이지 않고, terminate가 TERM→KILL로 종료를 확인한다', async () => {
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
