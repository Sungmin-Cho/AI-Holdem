import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDeck } from '../engine/cards.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine/cli.js');
const FULL_DECK = newDeck().join(',');

function stackedDeck(front) {
  const used = new Set(front);
  return [...front, ...newDeck().filter((card) => !used.has(card))].join(',');
}

// HU: SB 7h2c, BB AsAh, dry board — no split, always a bust.
const HU_DECK = stackedDeck(['7h', 'As', '2c', 'Ah', 'Ks', 'Qd', '9c', '8s', '3d']);

function tmpGame() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-cli-'));
}

function cli(gameDir, args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args, '--game-dir', gameDir], {
      encoding: 'utf8',
      timeout: 20000,
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
  }));
}

function killPid(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
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
  } finally {
    killPid(dummy.pid);
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
  assert.ok('bluffFreq' in players[1]);
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
