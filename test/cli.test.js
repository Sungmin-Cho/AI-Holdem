import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newDeck } from '../engine/cards.js';
import { acquireOwnedLock, processStartTime, releaseOwnedLock } from '../engine/state.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine/cli.js');
const STATE_MODULE_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine/state.js'),
).href;
const FULL_DECK = newDeck().join(',');
const REAL_PS = fs.existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';

function stackedDeck(front) {
  const used = new Set(front);
  return [...front, ...newDeck().filter((card) => !used.has(card))].join(',');
}

// HU: SB 7h2c, BB AsAh, dry board — no split, always a bust.
const HU_DECK = stackedDeck(['7h', 'As', '2c', 'Ah', 'Ks', 'Qd', '9c', '8s', '3d']);

function tmpGame() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-cli-'));
}

function cli(gameDir, args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args, '--game-dir', gameDir], {
      encoding: 'utf8',
      timeout: 20000,
      env: options.env ?? process.env,
    });
    return { status: 0, json: JSON.parse(stdout.trim()), stdout };
  } catch (error) {
    const stdout = String(error.stdout ?? '');
    let json = null;
    try { json = JSON.parse(stdout.trim()); } catch { /* non-JSON */ }
    return { status: error.status ?? 1, json, stdout, stderr: String(error.stderr ?? '') };
  }
}

function assertOk(result) {
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.equal(result.json?.ok, true);
  assert.equal(typeof result.json.stateVersion, 'number');
  assert.ok(Array.isArray(result.json.events));
  return result.json;
}

function initGame(dir, extra = ['--ai', '2']) {
  return assertOk(cli(dir, ['init', ...extra]));
}

function playUntilOver(dir, { deck = FULL_DECK, preferFold = false } = {}) {
  const started = assertOk(cli(dir, ['new-hand', '--deck', deck]));
  let last = started;
  for (let i = 0; i < 200; i += 1) {
    const legal = assertOk(cli(dir, ['legal']));
    if (legal.handOver) return { started, last, legal };
    const action = preferFold ? 'fold' : (legal.canCheck ? 'check' : 'call');
    last = assertOk(cli(dir, ['apply', legal.toAct, action]));
  }
  throw new Error('핸드가 종료되지 않았습니다');
}

function advanceToAi(dir) {
  for (let i = 0; i < 10; i += 1) {
    const legal = assertOk(cli(dir, ['legal']));
    if (legal.handOver) throw new Error('핸드가 이미 종료되었습니다');
    if (legal.toAct !== 'user') return legal;
    assertOk(cli(dir, ['apply', 'user', legal.canCheck ? 'check' : 'call']));
  }
  throw new Error('AI 차례에 도달하지 못했습니다');
}

function spawnDummy() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
}

// Detached like nohup server.js: SIGTERM then init reaps, so the CLI does not see a zombie of this test.
function spawnDaemon() {
  const wrapper = `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {
      detached: true,
      stdio: 'ignore',
    });
    process.stdout.write(String(child.pid));
    child.unref();
    process.exit(0);
  `;
  const pid = Number(execFileSync(process.execPath, ['--input-type=module', '-e', wrapper], { encoding: 'utf8' }).trim());
  return { pid };
}

function writeLock(dir, pid, sessionToken = 'tok') {
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: pid,
    port: 8877,
    sessionToken,
    startedAt: new Date().toISOString(),
    serverStartTime: processStartTime(pid),
  }));
}

// 이 테스트 프로세스와 무관한 pid+startTime identity를 실제로 세우기 위해
// 자식 프로세스 안에서 engine/state.js의 acquireOwnedLock을 직접 호출한다
// (identity 판정을 목으로 우회하지 않는다).
function spawnLockHolder(dir) {
  const script = `
    import { acquireOwnedLock } from ${JSON.stringify(STATE_MODULE_URL)};
    acquireOwnedLock(${JSON.stringify(dir)}, 'loop.lock.d');
    setInterval(() => {}, 1e6);
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
}

function killPid(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');
}

async function waitForPath(filePath, child, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`lock holder exited early: ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(filePath), true, `${filePath}가 제때 생기지 않았다`);
}

function fakePsEnv(pid) {
  const binDir = tmpGame();
  const psPath = path.join(binDir, 'ps');
  fs.writeFileSync(psPath, `#!/bin/sh\nif [ "$2" = "${pid}" ]; then exit 1; fi\nexec ${REAL_PS} "$@"\n`);
  fs.chmodSync(psPath, 0o755);
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
}

function assertInitRejected(result, code, message) {
  const expected = { ok: false, code, message };
  assert.equal(result.status, 1);
  assert.deepEqual(result.json, expected);
  assert.deepEqual(JSON.parse(result.stderr.trim()), expected);
}

function snapshotGame(dir) {
  const state = fs.readFileSync(path.join(dir, 'state.json'));
  return {
    state,
    parsed: JSON.parse(state.toString('utf8')),
    players: fs.readFileSync(path.join(dir, 'players.json')),
  };
}

function assertGameUnchanged(dir, before) {
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), before.state);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'players.json')), before.players);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(after.sessionToken, before.parsed.sessionToken);
  assert.equal(after.stateVersion, before.parsed.stateVersion);
  assert.equal(fs.existsSync(path.join(dir, 'archive')), false);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

test('스크립트된 3인 핸드 통합', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  const { started, last } = playUntilOver(dir);
  assert.ok(started.events.some((event) => event.type === 'hand_start'));
  assert.equal(last.handOver, true);
  const archive = path.join(dir, 'hands', 'hand-0001.json');
  assert.ok(fs.existsSync(archive));
  const record = JSON.parse(fs.readFileSync(archive, 'utf8'));
  assert.equal(record.handNo, 1);
  assert.ok(record.holes.user);
});

test('불법 액션 → ok:false, exit 1, 상태 무변경', () => {
  const dir = tmpGame();
  initGame(dir);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  const before = assertOk(cli(dir, ['legal']));
  const other = before.toAct === 'user' ? 'p1' : 'user';
  const result = cli(dir, ['apply', other, 'fold']);
  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, 'ILLEGAL_ACTION');
  assert.ok(result.json.message);
  const after = assertOk(cli(dir, ['legal']));
  assert.equal(after.stateVersion, before.stateVersion);
  assert.equal(after.toAct, before.toAct);
  assert.equal(after.decisionId, before.decisionId);
});

test('--expect-version 불일치 → 거부', () => {
  const dir = tmpGame();
  initGame(dir);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  const legal = assertOk(cli(dir, ['legal']));
  const result = cli(dir, [
    'apply', legal.toAct, legal.canCheck ? 'check' : 'fold',
    '--expect-version', String(legal.stateVersion + 1),
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, 'VERSION_MISMATCH');
  const after = assertOk(cli(dir, ['legal']));
  assert.equal(after.stateVersion, legal.stateVersion);
  assert.equal(after.decisionId, legal.decisionId);
});

test('init은 활성 게임에서 ACTIVE_GAME 거부', () => {
  const dir = tmpGame();
  const first = initGame(dir);
  const dummy = spawnDummy();
  try {
    writeLock(dir, dummy.pid, first.sessionToken);
    assert.equal(isAlive(dummy.pid), true);
    const result = cli(dir, ['init', '--ai', '2']);
    assert.equal(result.status, 1);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.code, 'ACTIVE_GAME');
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.sessionToken, first.sessionToken);
    assert.equal(fs.existsSync(path.join(dir, 'archive')), false);
  } finally {
    killPid(dummy.pid);
  }
});

test('init CLI: 살아 있는 남의 loop가 서버보다 먼저 이겨 exact envelope로 inert 거부한다', async () => {
  const dir = tmpGame();
  initGame(dir);
  const before = snapshotGame(dir);
  const holder = spawnLockHolder(dir);
  const server = spawnDummy();
  try {
    await waitForPath(path.join(dir, 'loop.lock.d', 'pid'), holder);
    writeLock(dir, server.pid, before.parsed.sessionToken);

    assertInitRejected(
      cli(dir, ['init', '--ai', '2']),
      'ACTIVE_GAME',
      '이미 진행 중인 게임이 있습니다.',
    );
    assertGameUnchanged(dir, before);
    assert.equal(isAlive(server.pid), true, 'non-force가 서버를 종료했다');
    assert.equal(isAlive(holder.pid), true, '엔진이 loop pid를 종료했다');

    assertInitRejected(
      cli(dir, ['init', '--ai', '2', '--force']),
      'LOOP_ALIVE',
      '게임 루프가 아직 실행 중입니다. 사이드카를 먼저 정지하세요.',
    );
    assertGameUnchanged(dir, before);
    assert.equal(isAlive(server.pid), true, 'loop보다 먼저 서버를 종료했다');
    assert.equal(isAlive(holder.pid), true, '엔진이 loop pid를 종료했다');
  } finally {
    await terminateChild(holder);
    await terminateChild(server);
  }
});

test('init CLI: live loop identity unknown이면 force 여부와 무관하게 게임을 보존한다', async () => {
  const dir = tmpGame();
  initGame(dir);
  const before = snapshotGame(dir);
  const holder = spawnLockHolder(dir);
  try {
    await waitForPath(path.join(dir, 'loop.lock.d', 'pid'), holder);
    const env = fakePsEnv(holder.pid);
    assertInitRejected(
      cli(dir, ['init', '--ai', '2'], { env }),
      'ACTIVE_GAME',
      '이미 진행 중인 게임이 있습니다.',
    );
    assertGameUnchanged(dir, before);
    assert.equal(isAlive(holder.pid), true);

    assertInitRejected(
      cli(dir, ['init', '--ai', '2', '--force'], { env }),
      'LOOP_ALIVE',
      '게임 루프가 아직 실행 중입니다. 사이드카를 먼저 정지하세요.',
    );
    assertGameUnchanged(dir, before);
    assert.equal(isAlive(holder.pid), true);
  } finally {
    await terminateChild(holder);
  }
});

test('init CLI: partial/malformed/unreadable loop.lock.d는 부재가 아니라 unknown이다', async (t) => {
  const cases = [
    ['empty-dir', () => {}],
    ['partial', (lockDir) => fs.writeFileSync(path.join(lockDir, 'pid'), '')],
    ['malformed', (lockDir) => fs.writeFileSync(path.join(lockDir, 'pid'), '1\nstart\nextra')],
    ['unreadable', (lockDir) => fs.mkdirSync(path.join(lockDir, 'pid'))],
  ];
  for (const [label, seed] of cases) {
    await t.test(label, () => {
      const dir = tmpGame();
      initGame(dir);
      const before = snapshotGame(dir);
      const lockDir = path.join(dir, 'loop.lock.d');
      fs.mkdirSync(lockDir);
      seed(lockDir);
      assertInitRejected(
        cli(dir, ['init', '--ai', '2']),
        'ACTIVE_GAME',
        '이미 진행 중인 게임이 있습니다.',
      );
      assertGameUnchanged(dir, before);
      assertInitRejected(
        cli(dir, ['init', '--ai', '2', '--force']),
        'LOOP_ALIVE',
        '게임 루프가 아직 실행 중입니다. 사이드카를 먼저 정지하세요.',
      );
      assertGameUnchanged(dir, before);
    });
  }
});

test('init --level-every 0은 USAGE로 거부하고 게임을 만들지 않는다', () => {
  const dir = tmpGame();
  for (const n of ['0', '-1']) {
    const result = cli(dir, ['init', '--ai', '2', '--level-every', n]);
    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.code, 'USAGE');
  }
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'players.json')), false);
});

test('init stdout에 archetype/bluffFreq 미노출', () => {
  const dir = tmpGame();
  const result = initGame(dir, ['--ai', '2']);
  assert.equal(result.archivedTo, null);
  assert.match(result.sessionToken, /^[0-9a-f]{32}$/);
  const dumped = JSON.stringify(result);
  assert.equal(dumped.includes('archetype'), false);
  assert.equal(dumped.includes('bluffFreq'), false);
  assert.equal(result.players.length, 3);
  for (const player of result.players) {
    assert.deepEqual(Object.keys(player).sort(), ['name', 'playerId']);
  }
  assert.equal(result.players[0].playerId, 'user');
  assert.equal(result.players[0].name, '나');

  const players = JSON.parse(fs.readFileSync(path.join(dir, 'players.json'), 'utf8'));
  assert.deepEqual(
    { playerId: players[0].playerId, seat: players[0].seat, name: players[0].name },
    { playerId: 'user', seat: 0, name: '나' },
  );
  assert.equal('archetype' in players[0], false);
  assert.equal(players[1].playerId, 'p1');
  assert.equal(players[1].seat, 1);
  assert.ok(players[1].archetype);
  assert.equal('bluffFreq' in players[1], false);
  assert.equal('policy' in players[1], false);
});

test('과거 핸드 조회: 두 핸드 진행 후 hand 1 --redacted', () => {
  const dir = tmpGame();
  initGame(dir);
  playUntilOver(dir, { preferFold: true });
  playUntilOver(dir, { preferFold: true });
  const redacted = assertOk(cli(dir, ['hand', '1', '--redacted']));
  assert.equal(redacted.handNo, 1);
  assert.equal(redacted.holes.user.length, 2);
  assert.equal(redacted.holes.p1, undefined);
  assert.equal(redacted.holes.p2, undefined);
});

test('gameOver 후 new-hand 거부', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '1', '--stack', '50']);
  const { last } = playUntilOver(dir, { deck: HU_DECK });
  assert.equal(last.gameOver, true);
  const result = cli(dir, ['new-hand']);
  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, 'GAME_OVER');
});

test('핸드 1·2 진행 → `hand-0002.json`만 삭제 → `resume-check` → `archiveRepaired:true`, hand-0002 복구, hand-0001은 그대로', () => {
  const dir = tmpGame();
  initGame(dir);
  playUntilOver(dir, { preferFold: true });
  playUntilOver(dir, { preferFold: true });
  const file1 = path.join(dir, 'hands', 'hand-0001.json');
  const file2 = path.join(dir, 'hands', 'hand-0002.json');
  const orig1 = fs.readFileSync(file1, 'utf8');
  assert.ok(fs.existsSync(file2));
  fs.unlinkSync(file2);

  const repaired = assertOk(cli(dir, ['resume-check']));
  assert.equal(repaired.archiveRepaired, true);
  assert.equal(typeof repaired.serverPidAlive, 'boolean');
  assert.equal(repaired.serverPidAlive, false);
  assert.ok('port' in repaired);
  assert.ok(repaired.sessionToken);
  assert.ok('phase' in repaired);
  assert.ok('toAct' in repaired);
  assert.ok(fs.existsSync(file2));
  assert.equal(JSON.parse(fs.readFileSync(file2, 'utf8')).handNo, 2);
  assert.equal(fs.readFileSync(file1, 'utf8'), orig1);

  const again = assertOk(cli(dir, ['resume-check']));
  assert.equal(again.archiveRepaired, false);
});

test('end abort 후 new-hand 거부', () => {
  const dir = tmpGame();
  initGame(dir);
  const ended = assertOk(cli(dir, ['end', '--result', 'abort']));
  assert.equal(ended.gameOver, true);
  assert.equal(ended.result, 'abort');
  assert.deepEqual(ended.events, []);
  const result = cli(dir, ['new-hand']);
  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, 'GAME_OVER');
});

test('init --force: 살아 있는 가짜 서버(spawn된 node 대기 프로세스)를 SIGTERM 후 새 게임 생성', async () => {
  const dir = tmpGame();
  const first = initGame(dir);
  const dummy = spawnDaemon();
  try {
    writeLock(dir, dummy.pid, first.sessionToken);
    assert.equal(isAlive(dummy.pid), true);
    const forced = assertOk(cli(dir, ['init', '--ai', '2', '--force']));
    assert.equal(forced.archivedTo, null);
    assert.notEqual(forced.sessionToken, first.sessionToken);
    assert.equal(fs.existsSync(path.join(dir, 'lock.json')), false);
    const deadline = Date.now() + 2000;
    while (isAlive(dummy.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(isAlive(dummy.pid), false);
  } finally {
    killPid(dummy.pid);
  }
});

test('없는 gameDir 첫 init은 성공한다', () => {
  const dir = path.join(tmpGame(), 'missing');
  assert.equal(fs.existsSync(dir), false);
  const result = initGame(dir, ['--ai', '2']);
  assert.equal(result.archivedTo, null);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), true);
});

test('init는 핸드가 있는 게임을 archive/로 옮긴다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  const forced = assertOk(cli(dir, ['init', '--ai', '2', '--force']));
  assert.match(forced.archivedTo, /^archive\/.+-in-progress/);
  assert.equal(path.isAbsolute(forced.archivedTo), false);
  assert.equal(forced.archivedTo.includes('\\'), false);
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(live.handNo, 0);
  assert.equal(fs.existsSync(path.join(dir, 'archive')), true);
  const dirs = fs.readdirSync(path.join(dir, 'archive')).filter((n) => !n.startsWith('.'));
  assert.equal(dirs.length, 1);
  const archivedState = JSON.parse(fs.readFileSync(path.join(dir, forced.archivedTo, 'state.json'), 'utf8'));
  assert.ok(archivedState.handNo >= 1 || archivedState.hand != null);
});

test('init 두 번의 플레이는 archive 항목 2개', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  const first = assertOk(cli(dir, ['init', '--ai', '2', '--force']));
  const firstStatePath = path.join(dir, first.archivedTo, 'state.json');
  const firstBytes = fs.readFileSync(firstStatePath);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  const second = assertOk(cli(dir, ['init', '--ai', '2', '--force']));
  const dirs = fs.readdirSync(path.join(dir, 'archive')).filter((n) => !n.startsWith('.') && !n.endsWith('.partial'));
  assert.equal(dirs.length, 2);
  assert.match(second.archivedTo, /^archive\//);
  assert.equal(path.isAbsolute(second.archivedTo), false);
  assert.equal(second.archivedTo.includes('\\'), false);
  assert.notEqual(second.archivedTo, first.archivedTo);
  assert.deepEqual(fs.readFileSync(firstStatePath), firstBytes);
});

test('end abort만 하고 핸드 없으면 보관하지 않는다', () => {
  const dir = tmpGame();
  initGame(dir);
  assertOk(cli(dir, ['end', '--result', 'abort']));
  const next = assertOk(cli(dir, ['init', '--ai', '2', '--force']));
  assert.equal(next.archivedTo, null);
});

test('핸드 후 abort 후 init --force는 archivedTo에 -abort', () => {
  const dir = tmpGame();
  initGame(dir);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  assertOk(cli(dir, ['end', '--result', 'abort']));
  const next = assertOk(cli(dir, ['init', '--ai', '2', '--force']));
  assert.match(next.archivedTo, /^archive\/.+-abort/);
  assert.equal(path.isAbsolute(next.archivedTo), false);
  assert.equal(next.archivedTo.includes('\\'), false);
});

test('미리 만든 archive/keep-me는 init --force 뒤에도 있다', () => {
  const dir = tmpGame();
  initGame(dir);
  fs.mkdirSync(path.join(dir, 'archive', 'keep-me'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'archive', 'keep-me', 'marker'), 'ok');
  assertOk(cli(dir, ['init', '--ai', '2', '--force']));
  assert.equal(fs.readFileSync(path.join(dir, 'archive', 'keep-me', 'marker'), 'utf8'), 'ok');
});

test('init 후 옛 lock.json이 라이브에 없다', () => {
  const dir = tmpGame();
  initGame(dir);
  fs.writeFileSync(path.join(dir, 'lock.json'), '{"serverPid":0,"port":8877,"sessionToken":"x","startedAt":"t"}');
  fs.writeFileSync(path.join(dir, '.turn.json'), '{}');
  assertOk(cli(dir, ['init', '--ai', '2', '--force']));
  assert.equal(fs.existsSync(path.join(dir, 'lock.json')), false);
  assert.equal(fs.existsSync(path.join(dir, '.turn.json')), false);
});

test('빈 init 두 번은 archivedTo null이고 archive를 만들지 않는다', () => {
  const dir = tmpGame();
  const first = initGame(dir);
  assert.equal(first.archivedTo, null);
  const second = assertOk(cli(dir, ['init', '--ai', '2', '--force']));
  assert.equal(second.archivedTo, null);
  assert.equal(fs.existsSync(path.join(dir, 'archive')), false);
});

test('기존 게임에 --level-every 0은 USAGE이고 보관하지 않는다', () => {
  const dir = tmpGame();
  const first = initGame(dir);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  const result = cli(dir, ['init', '--ai', '2', '--level-every', '0']);
  assert.equal(result.status, 2);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, 'USAGE');
  assert.equal(fs.existsSync(path.join(dir, 'archive')), false);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.sessionToken, first.sessionToken);
});

test('step: 액션 없이 호출하면 현재 뷰와 다음 행동자를 한 번에 준다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  const legal = assertOk(cli(dir, ['legal']));
  const step = assertOk(cli(dir, ['step']));

  assert.equal(step.stateVersion, legal.stateVersion);
  assert.deepEqual(step.events, []);
  assert.equal(step.view.handNo, 1);
  assert.equal(step.view.myCards.length, 2);
  assert.equal(step.next.toAct, legal.toAct);
  assert.equal(step.next.decisionId, legal.decisionId);
  assert.equal(step.next.kind, legal.toAct === 'user' ? 'user' : 'ai');
});

test('step: AI 차례면 agentHandle과 legal 숫자가 전부 든 자족적 요약을 준다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '3']);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  const legal = advanceToAi(dir);
  const { next } = assertOk(cli(dir, ['step']));

  assert.equal(next.kind, 'ai');
  assert.equal(next.agentHandle, `player-${next.toAct}`);
  assert.equal(typeof next.summary, 'string');

  for (const needle of [
    legal.decisionId,
    String(legal.callAmount),
    String(legal.minRaiseTo),
    String(legal.maxRaiseTo),
    String(legal.potTotal),
  ]) {
    assert.ok(next.summary.includes(needle), `요약에 ${needle} 누락`);
  }
});

test('step: AI 요약에 남의 홀카드가 없다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '3']);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  advanceToAi(dir);
  const { next, view } = assertOk(cli(dir, ['step']));

  const mine = assertOk(cli(dir, ['view', '--for', next.toAct])).myCards;
  assert.equal(mine.length, 2);
  for (const card of mine) {
    assert.ok(next.summary.includes(card), `자기 홀카드 ${card} 누락`);
  }
  for (const seat of view.seats) {
    if (seat.playerId === next.toAct) continue;
    for (const card of assertOk(cli(dir, ['view', '--for', seat.playerId])).myCards) {
      assert.equal(next.summary.includes(card), false, `${seat.playerId} 홀카드 ${card} 유출`);
    }
  }
});

test('step: 올인이 없으면 요약 팟 줄은 총액만 보여준다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '3']);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  advanceToAi(dir);
  const { next } = assertOk(cli(dir, ['step']));
  const potLine = next.summary.split('\n').find((line) => line.startsWith('팟: '));
  assert.equal(potLine.includes('('), false, potLine);
});

test('step: 액션을 적용하고 갱신된 뷰·다음 행동자를 함께 준다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '3']);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  const before = assertOk(cli(dir, ['legal']));
  const stepped = assertOk(cli(dir, [
    'step', before.toAct, before.canCheck ? 'check' : 'call',
    '--expect-version', String(before.stateVersion),
  ]));

  assert.equal(stepped.stateVersion, before.stateVersion + 1);
  assert.ok(stepped.events.some((event) => event.type === 'action'));
  assert.notEqual(stepped.next.decisionId, before.decisionId);
  assert.equal(stepped.view.toAct, stepped.next.toAct);
});

test('step --new-hand: 핸드를 시작하고 첫 행동자까지 한 번에 준다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  const started = assertOk(cli(dir, ['step', '--new-hand', '--deck', FULL_DECK]));

  assert.ok(started.events.some((event) => event.type === 'hand_start'));
  assert.ok(started.events.some((event) => event.type === 'deal_hole'));
  assert.equal(started.view.handNo, 1);
  assert.ok(started.next.toAct);
});

test('step: --new-hand와 액션을 함께 주면 USAGE로 거부', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  const result = cli(dir, ['step', '--new-hand', 'user', 'check']);
  assert.equal(result.status, 2);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, 'USAGE');
});

test('step: 핸드가 끝나면 next는 null이다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  let cur = assertOk(cli(dir, ['step', '--new-hand', '--deck', FULL_DECK]));
  for (let i = 0; i < 20 && !cur.handOver; i += 1) {
    cur = assertOk(cli(dir, ['step', cur.next.toAct, 'fold']));
  }
  assert.equal(cur.handOver, true);
  assert.equal(cur.next, null);
});

test('step --force-default: 워치독 경로도 같은 envelope를 준다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  const started = assertOk(cli(dir, ['step', '--new-hand', '--deck', FULL_DECK]));
  const forced = assertOk(cli(dir, ['step', started.next.toAct, '--force-default']));

  assert.ok(forced.events.some((event) => event.type === 'action'));
  assert.equal(forced.stateVersion, started.stateVersion + 1);
  assert.ok('next' in forced);
});

test('연속 3핸드 로테이션: 버튼·SB·BB가 매 핸드 시계방향 이동(4인)', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '3']);
  const seats = assertOk(cli(dir, ['view', '--for', 'user'])).seats.map((seat) => seat.playerId);
  assert.equal(seats.length, 4);

  const rounds = [];
  for (let i = 0; i < 3; i += 1) {
    const { started } = playUntilOver(dir, { preferFold: true });
    const start = started.events.find((event) => event.type === 'hand_start');
    const blinds = started.events.find((event) => event.type === 'blinds_posted');
    rounds.push({
      button: start.button,
      sb: blinds.posts[0].playerId,
      bb: blinds.posts[1].playerId,
    });
  }

  const nextOf = (pid) => seats[(seats.indexOf(pid) + 1) % seats.length];
  for (const round of rounds) {
    assert.equal(round.sb, nextOf(round.button));
    assert.equal(round.bb, nextOf(round.sb));
  }
  assert.equal(rounds[1].button, nextOf(rounds[0].button));
  assert.equal(rounds[2].button, nextOf(rounds[1].button));
});

test('step: 에러 코드가 apply·new-hand와 동일하다', () => {
  const dir = tmpGame();
  assert.equal(cli(dir, ['step']).json.code, 'NO_GAME');

  initGame(dir, ['--ai', '2']);
  assertOk(cli(dir, ['step', '--new-hand', '--deck', FULL_DECK]));
  const legal = assertOk(cli(dir, ['legal']));

  const mismatch = cli(dir, ['step', legal.toAct, 'fold', '--expect-version', String(legal.stateVersion + 1)]);
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.json.code, 'VERSION_MISMATCH');

  const running = cli(dir, ['step', '--new-hand']);
  assert.equal(running.status, 1);
  assert.equal(running.json.code, 'ILLEGAL_ACTION');

  const after = assertOk(cli(dir, ['legal']));
  assert.equal(after.stateVersion, legal.stateVersion, '거부된 step이 상태를 바꿨다');
});

test('step: 게임이 끝난 뒤 --new-hand는 GAME_OVER', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '1', '--stack', '50']);
  let cur = assertOk(cli(dir, ['step', '--new-hand', '--deck', HU_DECK]));
  for (let i = 0; i < 20 && !cur.gameOver; i += 1) {
    cur = assertOk(cli(dir, ['step', cur.next.toAct, cur.next.kind === 'user' ? 'call' : 'call']));
  }
  assert.equal(cur.gameOver, true);
  const result = cli(dir, ['step', '--new-hand']);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, 'GAME_OVER');
});

test('step: 실패 envelope는 stderr로도 나온다', () => {
  const dir = tmpGame();
  const result = cli(dir, ['step']);
  assert.equal(result.status, 1);
  assert.equal(result.json.code, 'NO_GAME');
  assert.ok(result.stderr.includes('NO_GAME'), `stderr에 코드가 없다: ${result.stderr}`);
});

test('step: 읽기 전용 호출도 --expect-version 불일치를 거부한다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  assertOk(cli(dir, ['step', '--new-hand', '--deck', FULL_DECK]));
  const legal = assertOk(cli(dir, ['legal']));
  assertOk(cli(dir, ['step', '--expect-version', String(legal.stateVersion)]));
  const stale = cli(dir, ['step', '--expect-version', String(legal.stateVersion + 1)]);
  assert.equal(stale.status, 1);
  assert.equal(stale.json.code, 'VERSION_MISMATCH');
});

test('step: 핸드를 끝내면 apply와 똑같이 아카이브를 남긴다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  let cur = assertOk(cli(dir, ['step', '--new-hand', '--deck', FULL_DECK]));
  for (let i = 0; i < 20 && !cur.handOver; i += 1) {
    cur = assertOk(cli(dir, ['step', cur.next.toAct, 'fold']));
  }
  assert.equal(cur.handOver, true);
  const archive = path.join(dir, 'hands', 'hand-0001.json');
  assert.ok(fs.existsSync(archive), '아카이브가 없다');
  assert.equal(JSON.parse(fs.readFileSync(archive, 'utf8')).handNo, 1);
});

test('step: envelope가 사용자 관점 view임을 표시한다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  const started = assertOk(cli(dir, ['step', '--new-hand', '--deck', FULL_DECK]));
  assert.equal(started.viewFor, 'user');
});

test('step: top-level·view.legal·저장된 stateVersion이 모두 같다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  let cur = assertOk(cli(dir, ['step', '--new-hand', '--deck', FULL_DECK]));
  // view.legal은 사용자 차례에만 실린다 — 버튼이 무작위이므로 거기까지 진행시킨다.
  for (let i = 0; i < 10 && cur.next && cur.next.kind !== 'user'; i += 1) {
    cur = assertOk(cli(dir, ['step', cur.next.toAct, 'call', '--expect-version', String(cur.stateVersion)]));
  }
  assert.equal(cur.next?.kind, 'user', '사용자 차례에 도달하지 못했다');

  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).stateVersion;
  assert.equal(cur.stateVersion, persisted);
  assert.ok(cur.view.legal, '사용자 차례인데 view.legal이 없다');
  assert.equal(cur.view.legal.stateVersion, cur.stateVersion, 'view.legal이 저장 전 버전을 들고 있다');
});

test('resume-check: 아카이브 정상·복구·복구실패를 구분해 보고한다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  playUntilOver(dir, { preferFold: true });

  assert.equal(assertOk(cli(dir, ['resume-check'])).archiveStatus, 'healthy');

  const archive = path.join(dir, 'hands', 'hand-0001.json');
  fs.unlinkSync(archive);
  assert.equal(assertOk(cli(dir, ['resume-check'])).archiveStatus, 'repaired');

  // 복구 쓰기가 실패하는 상황: 아카이브 자리를 디렉터리로 막는다
  fs.unlinkSync(archive);
  fs.mkdirSync(archive);
  const failed = assertOk(cli(dir, ['resume-check']));
  assert.equal(failed.archiveStatus, 'repair_failed', '복구 실패가 정상과 구분되지 않는다');
  assert.equal(failed.archiveRepaired, false);
});

test('resume-check: loopPidAlive는 loop 락 생존을 보고한다', async () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  assert.equal(assertOk(cli(dir, ['resume-check'])).loopPidAlive, false);

  const holder = spawnLockHolder(dir);
  try {
    const pidFile = path.join(dir, 'loop.lock.d', 'pid');
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(fs.existsSync(pidFile), true, 'loop.lock.d/pid가 제때 생기지 않았다');
    assert.equal(assertOk(cli(dir, ['resume-check'])).loopPidAlive, true);
  } finally {
    await terminateChild(holder);
  }
});

test('resume-check: unknown/mismatch/malformed loop identity는 loopPidAlive false다', async (t) => {
  await t.test('unknown', async (st) => {
    if (process.platform === 'win32') {
      st.skip('CLI subprocess identity unavailable is PATH/ps on POSIX; win32 uses PowerShell');
      return;
    }
    const dir = tmpGame();
    initGame(dir, ['--ai', '2']);
    const holder = spawnLockHolder(dir);
    try {
      await waitForPath(path.join(dir, 'loop.lock.d', 'pid'), holder);
      assert.equal(assertOk(cli(dir, ['resume-check'], { env: fakePsEnv(holder.pid) })).loopPidAlive, false);
    } finally {
      await terminateChild(holder);
    }
  });

  await t.test('dead', async () => {
    const dir = tmpGame();
    initGame(dir, ['--ai', '2']);
    const holder = spawnLockHolder(dir);
    try {
      await waitForPath(path.join(dir, 'loop.lock.d', 'pid'), holder);
      await terminateChild(holder);
      assert.equal(assertOk(cli(dir, ['resume-check'])).loopPidAlive, false);
    } finally {
      await terminateChild(holder);
    }
  });

  for (const [label, record] of [
    ['mismatch', `${process.pid}\nnot-the-real-start-time`],
    ['malformed', `${process.pid}\nstart\nextra`],
  ]) {
    await t.test(label, () => {
      const dir = tmpGame();
      initGame(dir, ['--ai', '2']);
      const lockDir = path.join(dir, 'loop.lock.d');
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'pid'), record);
      assert.equal(assertOk(cli(dir, ['resume-check'])).loopPidAlive, false);
    });
  }
});

test('resume-check --lock-dir reports the store-level loop owner', () => {
  const gameDir = tmpGame();
  const storeDir = tmpGame();
  initGame(gameDir, ['--ai', '1']);
  const handle = acquireOwnedLock(storeDir, 'loop.lock.d');
  try {
    const checked = cli(gameDir, ['resume-check', '--lock-dir', storeDir]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(checked.json.loopPidAlive, true);
  } finally {
    releaseOwnedLock(handle);
  }
});

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
}

function lastAction(dir) {
  const state = readState(dir);
  const record = state.hand ?? state.lastHand;
  return record.actions.at(-1);
}

function startCliHand(extraInit = []) {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2', ...extraInit]);
  assertOk(cli(dir, ['new-hand', '--deck', FULL_DECK]));
  return dir;
}

function advanceToPid(dir, pid) {
  for (let i = 0; i < 20; i += 1) {
    const legal = assertOk(cli(dir, ['legal']));
    if (legal.handOver) throw new Error('핸드가 이미 종료되었습니다');
    if (legal.toAct === pid) return legal;
    assertOk(cli(dir, ['apply', legal.toAct, legal.canCheck ? 'check' : 'call']));
  }
  throw new Error(`${pid} 차례에 도달하지 못했습니다`);
}

test('init --showdown-policy open을 config에 기록하고 부재는 standard', () => {
  const openDir = tmpGame();
  initGame(openDir, ['--ai', '2', '--showdown-policy', 'open']);
  assert.equal(readState(openDir).config.showdownPolicy, 'open');

  const defDir = tmpGame();
  initGame(defDir, ['--ai', '2']);
  assert.equal(readState(defDir).config.showdownPolicy, 'standard');
});

test('init --replay-reveal all|showdown과 부재 showdown', () => {
  const allDir = tmpGame();
  initGame(allDir, ['--ai', '2', '--replay-reveal', 'all']);
  assert.equal(readState(allDir).config.replayReveal, 'all');

  const shownDir = tmpGame();
  initGame(shownDir, ['--ai', '2', '--replay-reveal', 'showdown']);
  assert.equal(readState(shownDir).config.replayReveal, 'showdown');

  const defDir = tmpGame();
  initGame(defDir, ['--ai', '2']);
  assert.equal(readState(defDir).config.replayReveal, 'showdown');
});

test('init 잘못된 showdown-policy·replay-reveal은 USAGE', () => {
  const dir = tmpGame();
  for (const args of [
    ['init', '--ai', '2', '--showdown-policy', 'x'],
    ['init', '--ai', '2', '--replay-reveal', 'hidden'],
  ]) {
    const result = cli(dir, args);
    assert.equal(result.status, 2);
    assert.equal(result.json.code, 'USAGE');
  }
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

function writeMeta(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

const META_DROPS = [
  ['부재', 'META_MISSING', (dir) => path.join(dir, 'missing.json')],
  ['크기', 'META_TOO_LARGE', (dir) => {
    const file = path.join(dir, 'too-large.json');
    fs.writeFileSync(file, 'x'.repeat(8193));
    return file;
  }],
  ['JSON', 'META_PARSE', (dir) => writeMeta(dir, 'parse.json', '{not json')],
  ['객체 아님', 'META_SHAPE', (dir) => writeMeta(dir, 'array.json', '[]')],
  ['미지 키', 'META_SHAPE', (dir, legal) => writeMeta(dir, 'extra.json', {
    decisionId: legal.decisionId, reason: 'x', extra: 1,
  })],
  ['stale', 'META_STALE', (dir) => writeMeta(dir, 'stale.json', {
    decisionId: 'd-nope', reason: 'stale-reason',
  })],
  ['타입', 'META_TYPE', (dir, legal) => writeMeta(dir, 'type.json', {
    decisionId: legal.decisionId, reason: 1,
  })],
];

for (const [label, code, makePath] of META_DROPS) {
  test(`--meta-file drop ${label}은 액션을 적용하고 envelope.meta.dropped=${code}`, () => {
    const dir = startCliHand();
    const legal = assertOk(cli(dir, ['legal']));
    const metaPath = makePath(dir, legal);
    const result = cli(dir, [
      'apply', legal.toAct, legal.canCheck ? 'check' : 'call', '--meta-file', metaPath,
    ]);
    const env = assertOk(result);
    assert.equal(env.meta.dropped, code);
    const rec = lastAction(dir);
    assert.equal(rec.playerId, legal.toAct);
    assert.equal('reason' in rec, false);
    assert.equal('note' in rec, false);
  });
}

function assertMetaDropped(playerId, payload, code) {
  const dir = startCliHand();
  const legal = advanceToPid(dir, playerId);
  const metaPath = writeMeta(dir, `${code}-${playerId}.json`, {
    decisionId: legal.decisionId,
    ...payload,
  });
  const env = assertOk(cli(dir, [
    'apply', legal.toAct, legal.canCheck ? 'check' : 'call', '--meta-file', metaPath,
  ]));
  assert.equal(env.meta.dropped, code);
  const rec = lastAction(dir);
  assert.equal(rec.playerId, playerId);
  assert.equal('reason' in rec, false);
  assert.equal('note' in rec, false);
}

test('--meta-file drop actor은 reason+user와 note+AI 모두 META_ACTOR', () => {
  assertMetaDropped('user', { reason: 'user-reason' }, 'META_ACTOR');
  assertMetaDropped('p1', { note: 'ai-note' }, 'META_ACTOR');
});

test('--meta-file drop 빈 값은 note+user와 reason+AI 모두 META_EMPTY', () => {
  assertMetaDropped('user', { note: '  \n\t  ' }, 'META_EMPTY');
  assertMetaDropped('p1', { reason: '  \n\t  ' }, 'META_EMPTY');
});

test('stale .decision-meta.json은 --meta-file 없이 읽히지 않는다', () => {
  const dir = startCliHand();
  const legal = assertOk(cli(dir, ['legal']));
  fs.writeFileSync(path.join(dir, '.decision-meta.json'), JSON.stringify({
    decisionId: legal.decisionId,
    reason: 'LEFTOVER_REASON',
    note: 'LEFTOVER_NOTE',
  }));
  const stepped = assertOk(cli(dir, [
    'step', legal.toAct, legal.canCheck ? 'check' : 'call',
  ]));
  assert.equal(stepped.meta, undefined);
  const rec = lastAction(dir);
  assert.equal(rec.reason, undefined);
  assert.equal(rec.note, undefined);
});

test('--meta-file 정상: 160자 절단, 4바이트 재절단, 제어문자, user note', () => {
  const dir = startCliHand();
  const aiLegal = advanceToPid(dir, 'p1');
  const longReason = `hello\n\nworld${'R'.repeat(200)}`;
  const aiMeta = writeMeta(dir, 'ai-meta.json', {
    decisionId: aiLegal.decisionId,
    reason: longReason,
  });
  const aiEnv = assertOk(cli(dir, [
    'apply', aiLegal.toAct, aiLegal.canCheck ? 'check' : 'call', '--meta-file', aiMeta,
  ]));
  assert.deepEqual(aiEnv.meta.applied, ['reason']);
  const aiRec = lastAction(dir);
  assert.equal(aiRec.reason.includes('\n'), false);
  assert.ok(aiRec.reason.startsWith('hello world'));
  assert.ok([...aiRec.reason].length <= 160);

  const emojiDir = startCliHand();
  const emojiLegal = advanceToPid(emojiDir, 'p1');
  const emojiMeta = writeMeta(emojiDir, 'emoji.json', {
    decisionId: emojiLegal.decisionId,
    reason: '😀'.repeat(160),
  });
  const emojiEnv = assertOk(cli(emojiDir, [
    'apply', emojiLegal.toAct, emojiLegal.canCheck ? 'check' : 'call', '--meta-file', emojiMeta,
  ]));
  assert.deepEqual(emojiEnv.meta.applied, ['reason']);
  const emojiRec = lastAction(emojiDir);
  assert.ok(Buffer.byteLength(JSON.stringify(emojiRec.reason)) <= 512);
  assert.ok([...emojiRec.reason].length <= 160);

  const userDir = startCliHand();
  const userLegal = advanceToPid(userDir, 'user');
  const userMeta = writeMeta(userDir, 'user-meta.json', {
    decisionId: userLegal.decisionId,
    note: 'user-note-ok',
  });
  const userEnv = assertOk(cli(userDir, [
    'step', userLegal.toAct, userLegal.canCheck ? 'check' : 'call', '--meta-file', userMeta,
  ]));
  assert.deepEqual(userEnv.meta.applied, ['note']);
  const userRec = lastAction(userDir);
  assert.equal(userRec.note, 'user-note-ok');
  assert.equal('reason' in userRec, false);
});

test('--meta-file와 --force-default를 함께 쓰면 USAGE', () => {
  const dir = startCliHand();
  const legal = assertOk(cli(dir, ['legal']));
  const metaPath = writeMeta(dir, 'meta.json', { decisionId: legal.decisionId, note: 'x' });
  for (const args of [
    ['apply', legal.toAct, '--force-default', '--meta-file', metaPath],
    ['step', legal.toAct, '--force-default', '--meta-file', metaPath],
    ['apply', legal.toAct, '--force-default', '--meta-file', ''],
    ['step', legal.toAct, '--force-default', '--meta-file', ''],
  ]) {
    const result = cli(dir, args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.json.code, 'USAGE');
  }
  assert.equal(readState(dir).stateVersion, legal.stateVersion);
});

test('step --new-hand와 --meta-file을 함께 쓰면 USAGE', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  const before = fs.existsSync(path.join(dir, 'state.json'))
    ? readState(dir).stateVersion
    : null;
  const metaPath = writeMeta(dir, 'meta.json', { decisionId: 'd-1-preflop-0', note: 'x' });
  for (const args of [
    ['step', '--new-hand', '--meta-file', metaPath],
    ['step', '--new-hand', '--meta-file', ''],
  ]) {
    const result = cli(dir, args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.json.code, 'USAGE');
  }
  assert.equal(readState(dir).stateVersion, before);
  assert.equal(readState(dir).hand, null);
});

test('--policy-meta와 --meta-file을 동시에 쓰면 AI apply가 둘 다 남긴다', () => {
  const dir = startCliHand();
  const legal = advanceToPid(dir, 'p1');
  const metaPath = writeMeta(dir, 'reason.json', {
    decisionId: legal.decisionId,
    reason: 'policy-reason',
  });
  const env = assertOk(cli(dir, [
    'apply', legal.toAct, legal.canCheck ? 'check' : 'call',
    '--meta-file', metaPath,
    '--policy-meta', JSON.stringify({ policyId: 'tag-v2', reasonCode: 'OPEN' }),
  ]));
  assert.deepEqual(env.meta.applied, ['reason']);
  const rec = lastAction(dir);
  assert.equal(rec.reason, 'policy-reason');
  assert.equal(rec.policyId, 'tag-v2');
  assert.equal(rec.reasonCode, 'OPEN');
});

test('hand N --replay는 config.replayReveal만 따른다', () => {
  const allDir = tmpGame();
  initGame(allDir, ['--ai', '2', '--replay-reveal', 'all']);
  playUntilOver(allDir, { preferFold: true });
  const all = assertOk(cli(allDir, ['hand', '1', '--replay']));
  assert.equal(all.reveal, 'all');
  assert.ok(all.holes.p1 || all.holes.p2);

  const showDir = tmpGame();
  initGame(showDir, ['--ai', '2', '--replay-reveal', 'showdown']);
  playUntilOver(showDir, { preferFold: true });
  const shown = assertOk(cli(showDir, ['hand', '1', '--replay']));
  assert.equal(shown.reveal, 'showdown');

  const defDir = tmpGame();
  initGame(defDir, ['--ai', '2']);
  playUntilOver(defDir, { preferFold: true });
  const def = assertOk(cli(defDir, ['hand', '1', '--replay']));
  assert.equal(def.reveal, 'showdown');
});

test('--replay와 --redacted를 함께 쓰면 USAGE', () => {
  const dir = tmpGame();
  initGame(dir);
  playUntilOver(dir, { preferFold: true });
  const result = cli(dir, ['hand', '1', '--replay', '--redacted']);
  assert.equal(result.status, 2);
  assert.equal(result.json.code, 'USAGE');
});

test('닫는 step에만 handReplay.handNos가 있고 중간 step·legal·열린 new-hand에는 없다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  const started = assertOk(cli(dir, ['step', '--new-hand', '--deck', FULL_DECK]));
  assert.equal('handReplay' in started, false);
  const legal = assertOk(cli(dir, ['legal']));
  assert.equal('handReplay' in legal, false);
  if (!started.handOver) {
    const mid = assertOk(cli(dir, ['step', started.next.toAct, started.next.toAct === 'user' ? 'fold' : (legal.canCheck ? 'check' : 'call')]));
    if (!mid.handOver) assert.equal('handReplay' in mid, false);
  }
  let last = started;
  for (let i = 0; i < 40 && !last.handOver; i += 1) {
    const next = assertOk(cli(dir, ['legal']));
    last = assertOk(cli(dir, ['step', next.toAct, next.canCheck ? 'check' : 'fold']));
  }
  assert.equal(last.handOver, true);
  assert.deepEqual(last.handReplay.handNos, [1]);
});

test('블라인드 올인으로 즉시 닫히는 --new-hand에도 handReplay가 있다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '1', '--stack', '25', '--blinds', '25/50']);
  const started = assertOk(cli(dir, ['step', '--new-hand']));
  assert.equal(started.handOver, true);
  assert.deepEqual(started.handReplay.handNos, [1]);
});

test('archivePending envelope에도 handReplay가 있다', () => {
  const dir = tmpGame();
  initGame(dir, ['--ai', '2']);
  const handsPath = path.join(dir, 'hands');
  if (fs.existsSync(handsPath)) fs.rmSync(handsPath, { recursive: true, force: true });
  fs.writeFileSync(handsPath, 'not-a-directory');
  const { last } = playUntilOver(dir, { preferFold: true });
  assert.equal(last.archivePending, true);
  assert.deepEqual(last.handReplay.handNos, [1]);
});
