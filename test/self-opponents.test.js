import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { readGeneratedRecord } from './helpers/gen-hh-fixtures.js';
import { simulateTable } from './helpers/policy-table-sim.js';
import { referenceClaimAllowed } from '../shared/reference.js';
import {
  TENDENCY_MIN_HANDS,
  TENDENCY_MIN_N,
  emptyTendency,
  medianOf,
  rateOf,
} from '../training/tendency/contracts.js';
import { tendencyFromRecords } from '../training/tendency/extract.js';
import {
  SIMILARITY_MIN_COMPONENTS,
  tendencyComponents,
  tendencySimilarity,
  eligibleComponentCount,
} from '../training/tendency/compare.js';
import {
  VERSION_V2,
  assignmentFor,
  buildExploiterConfig,
  buildMirrorConfig,
} from '../training/policies/catalog.js';
import { gameEpochOf } from '../publish-contract.js';
import { applyModeDefaults, createGameLoop, parseGameLoopArgs, validateSelfOpponentArgs, exitCodeFor } from '../tools/game-loop.js';
import { stampPlayerPolicies } from '../tools/policy-player.js';
import {
  assignSelfOpponents,
  assertSelfOpponentsConsistent,
  buildSelfOpponentSection,
  buildSelfOpponentsRaw,
  collectStoreTendency,
  readSelfOpponentsMarker,
  requireStoreTendency,
  selfOpponentNotices,
  writeSelfOpponentsMarker,
} from '../tools/self-opponents.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine/cli.js');
const GAME_LOOP = path.join(ROOT, 'tools/game-loop.js');
const PRIVACY_RE = /SelfMirror|SelfExploiter|self-mirror-v1|self-exploiter-v1|strategy-mirror-v1|mirror-[a-z0-9]|observed-tendency/;

function tmp(prefix = 'holdem-self-op') {
  return createOwnedTempDir(prefix);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeSession(storeDir, gameId, {
  gameOver = true,
  seats = 6,
  mode = 'cash-training',
  opponentRuntime = 'policy',
  records = [],
} = {}) {
  const sessionDir = path.join(storeDir, '.session-store', 'sessions', gameId);
  fs.mkdirSync(path.join(sessionDir, 'hands'), { recursive: true });
  const seatList = [{ playerId: 'user', stack: 5000, out: false }];
  for (let i = 1; i < seats; i += 1) seatList.push({ playerId: `p${i}`, stack: 5000, out: false });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    gameOver,
    seats: seatList,
    config: { mode, aiCount: seats - 1 },
    ...(opponentRuntime === 'policy' ? { policySeed: 'ab'.repeat(32) } : {}),
  }));
  fs.writeFileSync(path.join(sessionDir, 'loop-state.json'), JSON.stringify({ opponentRuntime }));
  records.forEach((record, index) => {
    const name = `hand-${String(index + 1).padStart(4, '0')}.json`;
    fs.writeFileSync(path.join(sessionDir, 'hands', name), `${JSON.stringify(record)}\n`);
  });
  return sessionDir;
}

function storeWithHands(n, prefix = 'holdem-self-store') {
  const storeDir = tmp(prefix);
  const record = readGeneratedRecord('uncalled');
  writeSession(storeDir, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
    records: Array.from({ length: n }, () => record),
  });
  return storeDir;
}

function parsed(argv) {
  return applyModeDefaults(parseGameLoopArgs(argv));
}

function sourceOf(tendency, sessions = 1) {
  return {
    hands: tendency.hands,
    decisions: tendency.decisions,
    sessions,
    extractedAt: '2026-09-07T00:00:00.000Z',
  };
}

function richTendency({
  hands = 80,
  vpipK = 40,
  pfrK = 16,
  limpK = 4,
  vsRaise = { n: 20, fold: 10, call: 6, raise: 4 },
  facing = { n: 24, fold: 12, call: 8, raise: 4 },
  cbet = { n: 12, k: 6 },
  wtsd = { n: 10, k: 4 },
  af = { bets: 10, raises: 5, calls: 10 },
  openBuckets = { '2.5': 15 },
  betBuckets = { '0.7': 12 },
  rfi = { UTG: { n: 10, k: 2 }, HJ: { n: 10, k: 3 }, CO: { n: 10, k: 4 }, BTN: { n: 10, k: 5 }, SB: { n: 10, k: 3 }, BB: { n: 0, k: 0 } },
} = {}) {
  const t = emptyTendency('user');
  t.hands = hands;
  t.decisions = hands * 2;
  t.sources = [{ gameId: 'g1', hands, mode: 'cash-training', opponentRuntime: 'policy', seats: 6 }];
  t.seatMix[6] = hands;
  t.preflop.vpip = { n: hands, k: vpipK };
  t.preflop.pfr = { n: hands, k: pfrK };
  t.preflop.limp = { n: hands, k: limpK };
  t.preflop.vsRaise = vsRaise;
  t.preflop.openSizeBb = { n: Object.values(openBuckets).reduce((s, c) => s + c, 0), buckets: openBuckets };
  for (const street of ['flop', 'turn', 'river']) {
    t.postflop.byStreet[street].facingBet = { ...facing, n: facing.n, fold: facing.fold, call: facing.call, raise: facing.raise };
    if (street !== 'flop') {
      t.postflop.byStreet[street].facingBet = { n: 0, fold: 0, call: 0, raise: 0 };
    }
    t.postflop.byStreet[street].betSizePot = street === 'flop'
      ? { n: Object.values(betBuckets).reduce((s, c) => s + c, 0), buckets: betBuckets }
      : { n: 0, buckets: {} };
  }
  t.postflop.cbet = cbet;
  t.postflop.wtsd = wtsd;
  t.postflop.af = af;
  for (const [pos, counter] of Object.entries(rfi)) {
    t.preflop.byPosition[pos].rfi = { ...counter };
    t.preflop.byPosition[pos].dealt = counter.n;
  }
  return t;
}

function fiveComponentTendency() {
  return richTendency({
    vsRaise: { n: 0, fold: 0, call: 0, raise: 0 },
    facing: { n: 0, fold: 0, call: 0, raise: 0 },
    cbet: { n: 10, k: 4 },
    wtsd: { n: 0, k: 0 },
    af: { bets: 0, raises: 0, calls: 0 },
    openBuckets: { '2.5': 10 },
    betBuckets: {},
  });
}

function initPolicyDir(ai = 3) {
  const dir = tmp('holdem-self-init');
  execFileSync(process.execPath, [
    ENGINE, 'init', '--ai', String(ai), '--opponent-runtime', 'policy', '--game-dir', dir,
  ], { encoding: 'utf8', timeout: 10_000 });
  return dir;
}

test('T6: --mirror-self/--exploit-self parse and reject non-policy runtimes', () => {
  assert.equal(parseGameLoopArgs(['--ai', '3', '--mirror-self']).mirrorSelf, true);
  assert.equal(parseGameLoopArgs(['--ai', '3', '--exploit-self']).exploitSelf, true);
  assert.equal(parseGameLoopArgs(['--ai', '3']).mirrorSelf, false);

  const tournament = parsed(['--mode', 'tournament', '--mirror-self', '--ai', '3']);
  assert.throws(() => validateSelfOpponentArgs(tournament), (error) => (
    error.code === 'USAGE' && /policy 상대 런타임/.test(error.message)
  ));

  const stacked = parsed(['--stack', '5000', '--mirror-self', '--ai', '3']);
  assert.throws(() => validateSelfOpponentArgs(stacked), (error) => error.code === 'USAGE');

  const llm = parsed(['--opponent-runtime', 'llm', '--mirror-self', '--store-dir', '/tmp/s', '--ai', '3']);
  assert.throws(() => validateSelfOpponentArgs(llm), (error) => (
    error.code === 'USAGE' && /policy 상대 런타임/.test(error.message)
  ));

  const ok = parsed([
    '--mode', 'tournament', '--opponent-runtime', 'policy', '--mirror-self',
    '--store-dir', '/tmp/s', '--ai', '3',
  ]);
  assert.doesNotThrow(() => validateSelfOpponentArgs(ok));
  assert.equal(ok.opponentRuntime, 'policy');
  assert.equal(ok.mirrorSelf, true);

  assert.throws(
    () => validateSelfOpponentArgs(parsed(['--mirror-self', '--ai', '3'])),
    (error) => error.code === 'USAGE',
  );
  assert.throws(
    () => validateSelfOpponentArgs(parsed([
      '--store-dir', '/tmp/s', '--resume', '--mirror-self',
    ])),
    (error) => error.code === 'USAGE',
  );
  assert.throws(
    () => validateSelfOpponentArgs(parsed([
      '--store-dir', '/tmp/s', '--ai', '1', '--mirror-self', '--exploit-self',
    ])),
    (error) => error.code === 'USAGE',
  );
});

test('T6: assignSelfOpponents changes only archetype and policy on chosen AI seats', () => {
  const dir = initPolicyDir(3);
  const before = readJson(path.join(dir, 'players.json'));
  const tendency = richTendency();
  const sources = tendency.sources;
  const result = assignSelfOpponents({
    root: dir,
    players: before,
    tendency,
    sources,
    requested: { mirror: true, exploiter: true },
    chooseSeat: () => 0,
  });
  const after = readJson(path.join(dir, 'players.json'));
  assert.equal(after[0].playerId, 'user');
  assert.deepEqual(after[0], before[0]);
  const mirror = after.find((row) => row.archetype === 'SelfMirror');
  const exploiter = after.find((row) => row.archetype === 'SelfExploiter');
  assert.ok(mirror);
  assert.ok(exploiter);
  assert.notEqual(mirror.playerId, exploiter.playerId);
  const originalMirror = before.find((row) => row.playerId === mirror.playerId);
  for (const key of ['name', 'seat', 'agentHandle', 'speech', 'personality']) {
    assert.equal(mirror[key], originalMirror[key]);
    assert.equal(exploiter[key], before.find((row) => row.playerId === exploiter.playerId)[key]);
  }
  assert.equal(mirror.policy.policyId, 'self-mirror-v1');
  assert.equal(exploiter.policy.policyId, 'self-exploiter-v1');
  assert.match(mirror.policy.configDigest, /^[0-9a-f]{64}$/);
  const configs = readJson(path.join(dir, '.policy-configs.json'));
  assert.equal(configs.schemaVersion, 1);
  assert.equal(Object.keys(configs.configs).length, 2);
  const untouched = after.find((row) => row.playerId !== 'user'
    && row.playerId !== mirror.playerId && row.playerId !== exploiter.playerId);
  const originalUntouched = before.find((row) => row.playerId === untouched.playerId);
  assert.deepEqual(untouched, originalUntouched);
  stampPlayerPolicies(dir);
  const stamped = readJson(path.join(dir, 'players.json'));
  const catalogSeat = stamped.find((row) => row.playerId === untouched.playerId);
  assert.deepEqual(catalogSeat.policy, assignmentFor(catalogSeat.archetype));
  assert.equal(result.assigned.mirror, true);
  assert.equal(result.assigned.exploiter, true);
  const loopProbe = JSON.stringify({
    selfOpponents: {
      requested: { mirror: true, exploiter: true },
      assigned: { mirror: true, exploiter: true },
      sourceHands: tendency.hands,
      sourceSessions: sources.length,
    },
  });
  assert.doesNotMatch(loopProbe, PRIVACY_RE);
  assert.equal(loopProbe.includes(mirror.playerId), false);
});

test('T6: chooseSeat is deterministic when injected and covers every AI seat when omitted', () => {
  const tendency = richTendency();
  const sources = tendency.sources;
  const dir = initPolicyDir(3);
  const original = fs.readFileSync(path.join(dir, 'players.json'));
  assignSelfOpponents({
    root: dir,
    players: JSON.parse(original),
    tendency,
    sources,
    requested: { mirror: true, exploiter: false },
    chooseSeat: () => 1,
  });
  const picked = readJson(path.join(dir, 'players.json')).find((row) => row.archetype === 'SelfMirror');
  const aiIds = JSON.parse(original).filter((row) => row.playerId !== 'user').map((row) => row.playerId);
  assert.equal(picked.playerId, aiIds[1]);

  const seen = new Set();
  const trial = initPolicyDir(3);
  const originalPlayers = fs.readFileSync(path.join(trial, 'players.json'));
  for (let i = 0; i < 100; i += 1) {
    fs.writeFileSync(path.join(trial, 'players.json'), originalPlayers);
    try { fs.unlinkSync(path.join(trial, '.policy-configs.json')); } catch { /* first trial */ }
    assignSelfOpponents({
      root: trial,
      players: JSON.parse(originalPlayers),
      tendency,
      sources,
      requested: { mirror: true, exploiter: false },
    });
    const seat = readJson(path.join(trial, 'players.json')).find((row) => row.archetype === 'SelfMirror');
    seen.add(seat.playerId);
  }
  assert.equal(seen.size, 3);
});

test('T9: marker ENOENT is no-op; corrupt marker fails closed', () => {
  const dir = initPolicyDir(2);
  stampPlayerPolicies(dir);
  const players = readJson(path.join(dir, 'players.json'));
  assert.equal(readSelfOpponentsMarker(dir), null);
  assert.doesNotThrow(() => assertSelfOpponentsConsistent({ root: dir, players }));

  fs.writeFileSync(path.join(dir, '.self-opponents.json'), '{not-json');
  assert.throws(
    () => readSelfOpponentsMarker(dir),
    (error) => error.code === 'SELF_OPPONENT_MARKER_CORRUPT',
  );
});

test('T9: marker without derived seats is SELF_OPPONENT_INCOMPLETE and does not stamp catalog over the request', () => {
  const dir = initPolicyDir(2);
  const original = fs.readFileSync(path.join(dir, 'players.json'));
  writeSelfOpponentsMarker(dir, {
    requested: { mirror: true, exploiter: false },
    sourceHands: 80,
    sourceSessions: 1,
  });
  const players = JSON.parse(original);
  assert.throws(
    () => assertSelfOpponentsConsistent({ root: dir, players }),
    (error) => error.code === 'SELF_OPPONENT_INCOMPLETE',
  );
  stampPlayerPolicies(dir);
  const after = readJson(path.join(dir, 'players.json'));
  assert.equal(after.some((row) => row.archetype === 'SelfMirror'), false);
  assert.equal(after.some((row) => row.policy?.policyId === 'self-mirror-v1'), false);
});

test('T9: missing .policy-configs.json after assignment is POLICY_CONFIG_MISMATCH', () => {
  const dir = initPolicyDir(2);
  const tendency = richTendency();
  assignSelfOpponents({
    root: dir,
    players: readJson(path.join(dir, 'players.json')),
    tendency,
    sources: tendency.sources,
    requested: { mirror: true, exploiter: false },
    chooseSeat: () => 0,
  });
  fs.unlinkSync(path.join(dir, '.policy-configs.json'));
  assert.throws(() => stampPlayerPolicies(dir), { code: 'POLICY_CONFIG_MISMATCH' });
});

test('T9: 59-hand store refuses --mirror-self before creating a session', () => {
  const storeDir = storeWithHands(59);
  const currentPath = path.join(storeDir, '.session-store', 'current.json');
  const beforeCurrent = fs.existsSync(currentPath) ? fs.readFileSync(currentPath) : null;
  const sessionsBefore = fs.readdirSync(path.join(storeDir, '.session-store', 'sessions'))
    .filter((name) => !name.startsWith('.'));
  const result = spawnSync(process.execPath, [
    GAME_LOOP,
    '--store-dir', storeDir,
    '--ai', '3',
    '--mirror-self',
    '--port', '0',
  ], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stderr.trim().split('\n').at(-1));
  assert.equal(payload.code, 'TENDENCY_INSUFFICIENT');
  const sessionsAfter = fs.readdirSync(path.join(storeDir, '.session-store', 'sessions'))
    .filter((name) => !name.startsWith('.'));
  assert.deepEqual(sessionsAfter.sort(), sessionsBefore.sort());
  if (beforeCurrent === null) assert.equal(fs.existsSync(currentPath), false);
  else assert.deepEqual(fs.readFileSync(currentPath), beforeCurrent);
});

test('T9: 60-hand store passes the tendency gate; unreadable scan is TENDENCY_SOURCE_UNREADABLE', () => {
  const enough = storeWithHands(TENDENCY_MIN_HANDS);
  const collected = requireStoreTendency(enough);
  assert.equal(collected.tendency.hands, TENDENCY_MIN_HANDS);

  assert.throws(() => requireStoreTendency(storeWithHands(59)), (error) => (
    error.code === 'TENDENCY_INSUFFICIENT'
  ));

  const bad = tmp('holdem-self-unreadable');
  fs.mkdirSync(path.join(bad, '.session-store'));
  fs.writeFileSync(path.join(bad, '.session-store', 'sessions'), 'not-a-directory');
  assert.throws(() => requireStoreTendency(bad), (error) => (
    error.code === 'TENDENCY_SOURCE_UNREADABLE'
  ));

  const result = spawnSync(process.execPath, [
    GAME_LOOP,
    '--store-dir', bad,
    '--ai', '3',
    '--mirror-self',
    '--port', '0',
  ], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stderr.trim().split('\n').at(-1)).code, 'TENDENCY_SOURCE_UNREADABLE');
});

test('T9: exitCodeFor maps tendency failures to 2', () => {
  assert.equal(exitCodeFor({ code: 'TENDENCY_INSUFFICIENT' }), 2);
  assert.equal(exitCodeFor({ code: 'TENDENCY_SOURCE_UNREADABLE' }), 2);
  assert.equal(exitCodeFor({ code: 'USAGE' }), 2);
});

test('T9: marker write is create-only and resume does not recollect tendency', () => {
  const dir = initPolicyDir(2);
  writeSelfOpponentsMarker(dir, {
    requested: { mirror: true, exploiter: true },
    sourceHands: 80,
    sourceSessions: 2,
  });
  const marker = readSelfOpponentsMarker(dir);
  assert.equal(marker.schemaVersion, 1);
  assert.deepEqual(marker.requested, { mirror: true, exploiter: true });
  assert.equal(marker.sourceHands, 80);
  assert.throws(
    () => writeSelfOpponentsMarker(dir, {
      requested: { mirror: true, exploiter: false },
      sourceHands: 80,
      sourceSessions: 1,
    }),
    (error) => error.code === 'EXISTS',
  );
  const src = fs.readFileSync(path.join(ROOT, 'tools/game-loop.js'), 'utf8');
  const resumeFn = src.slice(src.indexOf('const resume = async'), src.indexOf('const runFinalization'));
  assert.equal(resumeFn.includes('collectStoreTendency'), false);
  assert.equal(resumeFn.includes('requireStoreTendency'), false);
});

test('T8: similarity is 100 on identical vectors and omitted below 6 components', () => {
  assert.equal(SIMILARITY_MIN_COMPONENTS, 6);
  const full = richTendency();
  const same = tendencySimilarity(full, full);
  assert.equal(same.similarity, 100);
  assert.ok(same.used >= 6);

  const short = fiveComponentTendency();
  const omitted = tendencySimilarity(short, short);
  assert.equal(omitted.similarity, null);
  assert.equal(omitted.used, 5);
  assert.ok(omitted.used < SIMILARITY_MIN_COMPONENTS);
});

test('T8: huge open and bet sizes clamp to [0,1] so similarity cannot go negative', () => {
  const base = richTendency();
  const huge = richTendency({
    openBuckets: { 100: 15 },
    betBuckets: { 3.5: 12 },
  });
  const open = tendencyComponents(huge).find((row) => row.id === 'openSizeBb');
  const bet = tendencyComponents(huge).find((row) => row.id === 'betSizePot');
  assert.equal(open.value, 1);
  assert.equal(bet.value, 1);
  const compared = tendencySimilarity(base, huge);
  assert.ok(compared.similarity != null);
  assert.ok(compared.similarity >= 0);
  assert.ok(compared.similarity <= 100);
});

test('T8: review section table, advice, zero-target exploiter, empty when no derived seats', () => {
  const dir = initPolicyDir(3);
  const tendency = richTendency();
  assignSelfOpponents({
    root: dir,
    players: readJson(path.join(dir, 'players.json')),
    tendency,
    sources: tendency.sources,
    requested: { mirror: true, exploiter: true },
    chooseSeat: () => 0,
  });
  const players = readJson(path.join(dir, 'players.json'));
  const derived = Object.fromEntries(
    Object.entries(readJson(path.join(dir, '.policy-configs.json')).configs),
  );
  const mirror = players.find((row) => row.archetype === 'SelfMirror');
  const exploiter = players.find((row) => row.archetype === 'SelfExploiter');
  const records = [{
    handNo: 1,
    button: 'user',
    holes: { user: ['Ah', 'Kd'], [mirror.playerId]: ['2c', '3d'], [exploiter.playerId]: ['7s', '8s'] },
    startStacks: { user: 10000, [mirror.playerId]: 10000, [exploiter.playerId]: 10000 },
    actions: [],
    pots: [{ amount: 150, eligible: [mirror.playerId, 'user'] }],
    board: [],
    folded: [],
    decisions: [],
  }];
  const section = buildSelfOpponentSection({ root: dir, players, derived, records });
  assert.match(section, /## 나를 닮은 상대와의 비교/);
  assert.match(section, new RegExp(mirror.name));
  assert.match(section, /자발적 참여\(VPIP\)/);
  assert.match(section, /프리플롭 레이즈\(PFR\)/);
  assert.match(section, /휴리스틱 복제이며 실력·수익의 증명이 아닙니다/);
  assert.match(section, /UTG/);
  assert.match(section, /HJ/);
  assert.match(section, /CO/);
  assert.match(section, /BTN/);
  assert.match(section, /SB/);
  assert.equal(referenceClaimAllowed(section), true);
  assert.doesNotMatch(section, /"vpip"|"playerId"|"kind"/);
  assert.match(section, /## 나를 공략한 상대/);
  assert.match(section, new RegExp(exploiter.name));

  const short = fiveComponentTendency();
  const shortConfig = buildMirrorConfig(short, { source: sourceOf(short) });
  const shortPlayers = players.map((row) => (
    row.archetype === 'SelfMirror'
      ? { ...row, policy: { policyId: shortConfig.policyId, policyVersion: shortConfig.policyVersion, configDigest: shortConfig.configDigest } }
      : row
  ));
  const shortSection = buildSelfOpponentSection({
    root: dir,
    players: shortPlayers,
    derived: { ...derived, [shortConfig.configDigest]: shortConfig },
    records,
  });
  assert.match(shortSection, /자발적 참여\(VPIP\)/);
  assert.doesNotMatch(shortSection, /휴리스틱 유사도:\s*\d+\/100/);
  assert.match(shortSection, /--hands 40/);
  assert.equal(referenceClaimAllowed(shortSection), true);

  const zeroTendency = emptyTendency('user');
  zeroTendency.hands = 80;
  zeroTendency.decisions = 80;
  const zeroConfig = buildExploiterConfig(zeroTendency, { source: sourceOf(zeroTendency) });
  assert.equal(zeroConfig.params.targets.length, 0);
  const zeroPlayers = players.map((row) => (
    row.archetype === 'SelfExploiter'
      ? { ...row, policy: { policyId: zeroConfig.policyId, policyVersion: zeroConfig.policyVersion, configDigest: zeroConfig.configDigest } }
      : row
  ));
  const zeroSection = buildSelfOpponentSection({
    root: dir,
    players: zeroPlayers,
    derived: { ...derived, [zeroConfig.configDigest]: zeroConfig },
    records,
  });
  assert.match(zeroSection, /겨냥할 경향이 없어 정석대로 쳤/);

  const plain = buildSelfOpponentSection({
    root: dir,
    players: [{ playerId: 'user' }, { playerId: 'p1', archetype: 'TAG', policy: assignmentFor('TAG') }],
    derived: {},
    records: [],
  });
  assert.equal(plain, '');
});

test('T8: buildSelfOpponentSection catches injected failures', () => {
  const dir = initPolicyDir(2);
  const tendency = richTendency();
  assignSelfOpponents({
    root: dir,
    players: readJson(path.join(dir, 'players.json')),
    tendency,
    sources: tendency.sources,
    requested: { mirror: true, exploiter: false },
    chooseSeat: () => 0,
  });
  const players = readJson(path.join(dir, 'players.json'));
  const derived = new Proxy(readJson(path.join(dir, '.policy-configs.json')).configs, {
    get() {
      const error = new Error('injected');
      error.code = 'INJECTED';
      throw error;
    },
  });
  const text = buildSelfOpponentSection({ root: dir, players, derived, records: [] });
  assert.match(text, /자기 상대 비교를 만들지 못했습니다 \(INJECTED\)/);
});

test('T8: 20-hand 6-max clones keep the similarity floor at 6', () => {
  const mixed = { p2: 'lag-v2', p3: 'maniac-v2', p4: 'lag-v2', p5: 'maniac-v2' };
  const lagRecords = simulateTable({ seats: { p1: 'lag-v2', ...mixed }, hands: 20, seed: 11, samples: 8 });
  const baseRecords = simulateTable({ seats: { p1: 'baseline-v2', ...mixed }, hands: 20, seed: 5, samples: 8 });
  const nitRecords = simulateTable({ seats: { p1: 'nit-v2' }, hands: 20, seed: 13, samples: 8 });
  const lag = tendencyFromRecords(lagRecords, 'p1');
  const baseline = tendencyFromRecords(baseRecords, 'p1');
  const nit = tendencyFromRecords(nitRecords, 'p1');
  assert.ok(eligibleComponentCount(lag) >= 6, `LAG components ${eligibleComponentCount(lag)}`);
  assert.ok(eligibleComponentCount(baseline) >= 6, `baseline components ${eligibleComponentCount(baseline)}`);
  const nitCount = eligibleComponentCount(nit);
  if (nitCount < 6) {
    const nitConfig = buildMirrorConfig(richTendency(), { source: sourceOf(richTendency()) });
    const players = [
      { playerId: 'user', name: '나' },
      {
        playerId: 'p1',
        name: '타이트',
        archetype: 'SelfMirror',
        policy: {
          policyId: nitConfig.policyId,
          policyVersion: nitConfig.policyVersion,
          configDigest: nitConfig.configDigest,
        },
      },
    ];
    const section = buildSelfOpponentSection({
      root: tmp('holdem-self-nit-rev'),
      players,
      derived: { [nitConfig.configDigest]: { ...nitConfig, params: { ...nitConfig.params, tendency: nit } } },
      records: nitRecords,
    });
    assert.doesNotMatch(section, /휴리스틱 유사도:\s*\d+\/100/);
    assert.match(section, /--hands 40/);
  }
});

test('T8: synthesizer raw uses role not kind; notices omit seat ids', () => {
  const dir = initPolicyDir(3);
  const tendency = richTendency();
  assignSelfOpponents({
    root: dir,
    players: readJson(path.join(dir, 'players.json')),
    tendency,
    sources: tendency.sources,
    requested: { mirror: true, exploiter: true },
    chooseSeat: () => 0,
  });
  const players = readJson(path.join(dir, 'players.json'));
  const derived = readJson(path.join(dir, '.policy-configs.json')).configs;
  const raw = buildSelfOpponentsRaw({ root: dir, players, derived, records: [] });
  const text = JSON.stringify(raw);
  assert.match(text, /"role":"mirror"/);
  assert.match(text, /"role":"exploiter"/);
  assert.doesNotMatch(text, /"kind"/);
  const mirrorSeat = players.find((row) => row.archetype === 'SelfMirror');
  const frozen = derived[mirrorSeat.policy.configDigest].params.tendency;
  assert.equal(raw.cumulative.hands, frozen.hands);
  assert.equal(raw.sessionUser.subject, 'user');
  assert.equal(raw.sessionReplica.subject, mirrorSeat.playerId);
  assert.equal(raw.cumulative.preflop.vpip.n, frozen.preflop.vpip.n);
  const exploiter = Object.values(derived).find((config) => config.policyId === 'self-exploiter-v1');
  const notices = selfOpponentNotices({
    assigned: { mirror: true, exploiter: true },
    sources: tendency.sources,
    targets: exploiter.params.targets,
  });
  assert.equal(notices.length, 2);
  const blob = notices.join('\n');
  assert.match(blob, /자기 복제 좌석 1석/);
  assert.match(blob, /자기 공략 좌석 1석/);
  assert.doesNotMatch(blob, PRIVACY_RE);
  for (const player of players.filter((row) => row.playerId !== 'user')) {
    assert.equal(blob.includes(player.playerId), false);
  }
});

test('T8/T9: game-loop inserts the review section before the trainingOn guard and asserts before resume stamps', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/game-loop.js'), 'utf8');
  const append = src.slice(
    src.indexOf('const appendTrainingPendingToReview'),
    src.indexOf('const generateReview'),
  );
  assert.match(append, /buildSelfOpponentSection/);
  assert.ok(append.indexOf('buildSelfOpponentSection') < append.indexOf('if (!trainingOn)'));

  const stamps = [...src.matchAll(/stampPlayerPolicies\(([^)]*)\)/g)];
  assert.equal(stamps.length, 3);
  const beforeFirstResume = src.slice(src.indexOf('const resolveForPhase'), src.indexOf('const resume = async'));
  const resumeStamps = [...beforeFirstResume.matchAll(/stampPlayerPolicies\(/g)];
  assert.equal(resumeStamps.length, 2);
  const parts = beforeFirstResume.split('stampPlayerPolicies');
  assert.match(parts[0], /assertSelfOpponentsConsistent/);
  assert.match(parts[1], /assertSelfOpponentsConsistent/);
});

test('T8: decisive-hand line uses the replica preflop position, not BTN', () => {
  const dir = initPolicyDir(3);
  const tendency = richTendency({
    rfi: {
      UTG: { n: 10, k: 1 },
      HJ: { n: 10, k: 1 },
      CO: { n: 10, k: 9 },
      BTN: { n: 10, k: 1 },
      SB: { n: 10, k: 8 },
      BB: { n: 0, k: 0 },
    },
  });
  assignSelfOpponents({
    root: dir,
    players: readJson(path.join(dir, 'players.json')),
    tendency,
    sources: tendency.sources,
    requested: { mirror: true, exploiter: false },
    chooseSeat: () => 0,
  });
  const players = readJson(path.join(dir, 'players.json'));
  const derived = readJson(path.join(dir, '.policy-configs.json')).configs;
  const replica = players.find((row) => row.archetype === 'SelfMirror').playerId;
  // 6-max deal order SB→BB→UTG→HJ→CO→BTN. button=user → last before BTN is CO.
  const sixMax = (coOrSb, replicaPos) => {
    const sb = replicaPos === 'SB' ? replica : 'p2';
    const bb = 'p3';
    const utg = 'p4';
    const hj = 'p5';
    const co = replicaPos === 'CO' ? replica : (coOrSb === replica ? 'p2' : coOrSb);
    const stacks = { [sb]: 10000, [bb]: 10000, [utg]: 10000, [hj]: 10000, [co]: 10000, user: 10000 };
    const holes = {
      [sb]: ['2c', '3d'], [bb]: ['4c', '5d'], [utg]: ['6c', '7d'], [hj]: ['8c', '9d'],
      [co]: ['Qs', 'Jh'], user: ['Ah', 'Kd'],
    };
    if (replicaPos === 'SB') holes[sb] = ['Qs', 'Jh'];
    return { stacks, holes, utg, hj };
  };
  const coLayout = sixMax('p2', 'CO');
  const coRecord = {
    handNo: 4,
    button: 'user',
    holes: coLayout.holes,
    startStacks: coLayout.stacks,
    actions: [
      { playerId: coLayout.utg, action: 'fold', street: 'preflop' },
      { playerId: coLayout.hj, action: 'fold', street: 'preflop' },
      { playerId: replica, action: 'raise', amount: 200, street: 'preflop' },
    ],
    pots: [{ amount: 400, eligible: [replica, 'user'] }],
    board: [],
    folded: [],
    decisions: [],
  };
  const section = buildSelfOpponentSection({
    root: dir, players, derived, records: [coRecord],
  });
  assert.match(section, /CO unopened raise/);
  assert.match(section, /90%로 같은 선택을 했습니다/);
  assert.doesNotMatch(section, /10%로 같은 선택을 했습니다/);

  const sbLayout = sixMax('p2', 'SB');
  const sbRecord = {
    handNo: 5,
    button: 'user',
    holes: sbLayout.holes,
    startStacks: sbLayout.stacks,
    actions: [
      { playerId: replica, action: 'call', amount: 50, street: 'preflop' },
    ],
    pots: [{ amount: 500, eligible: [replica, 'user'] }],
    board: [],
    folded: [],
    decisions: [],
  };
  const sbSection = buildSelfOpponentSection({
    root: dir, players, derived, records: [sbRecord],
  });
  assert.match(sbSection, /SB unopened call/);
  assert.match(sbSection, /80%로 같은 선택을 했습니다/);
  assert.doesNotMatch(sbSection, /10%로 같은 선택을 했습니다/);
});

test('T9: resume after assignment keeps the same derived seat and digest', async (t) => {
  // Covers the resume stamp path (assertSelfOpponentsConsistent then stamp).
  // A live SIGKILL of tools/game-loop.js main() is not part of this fixture.
  const dir = initPolicyDir(3);
  const tendency = richTendency();
  assignSelfOpponents({
    root: dir,
    players: readJson(path.join(dir, 'players.json')),
    tendency,
    sources: tendency.sources,
    requested: { mirror: true, exploiter: true },
    chooseSeat: () => 0,
  });
  writeSelfOpponentsMarker(dir, {
    requested: { mirror: true, exploiter: true },
    sourceHands: tendency.hands,
    sourceSessions: tendency.sources.length,
  });
  stampPlayerPolicies(dir);
  const assigned = readJson(path.join(dir, 'players.json'));
  const engine = readJson(path.join(dir, 'state.json'));
  fs.writeFileSync(path.join(dir, 'loop-state.json'), JSON.stringify({
    phase: 'playing',
    handNo: 0,
    port: null,
    sessionToken: engine.sessionToken,
    gameEpoch: gameEpochOf(engine.sessionToken),
    opponentRuntime: 'policy',
    ownerSessionId: '00000000-0000-4000-8000-000000000000',
    startedAt: '2026-09-07T00:00:00.000Z',
    notices: [],
    metrics: [],
    selfOpponents: {
      requested: { mirror: true, exploiter: true },
      assigned: { mirror: true, exploiter: true },
      sourceHands: tendency.hands,
      sourceSessions: tendency.sources.length,
    },
  }));
  const loop = createGameLoop({
    gameDir: dir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: { port: 0, waitMs: 0, opponentRuntime: 'policy' },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  const resumed = await loop.resume();
  assert.equal(resumed.phase, 'playing');
  const after = readJson(path.join(dir, 'players.json'));
  assert.deepEqual(
    after.map((row) => ({ id: row.playerId, archetype: row.archetype, digest: row.policy?.configDigest })),
    assigned.map((row) => ({ id: row.playerId, archetype: row.archetype, digest: row.policy?.configDigest })),
  );
  const loopState = readJson(path.join(dir, 'loop-state.json'));
  assert.doesNotMatch(JSON.stringify(loopState), PRIVACY_RE);
  for (const player of after.filter((row) => row.playerId !== 'user')) {
    assert.equal(JSON.stringify(loopState).includes(player.playerId), false);
  }
});

test('compare.js stays a pure training module', () => {
  const file = fs.readFileSync(path.join(ROOT, 'training/tendency/compare.js'), 'utf8');
  assert.doesNotMatch(file, /from ['"]node:fs|from ['"]\.\.\/\.\.\/tools\//);
  assert.equal(medianOf({ 2.5: 1 }), 2.5);
  assert.equal(rateOf({ n: 10, k: 5 }), 0.5);
  assert.equal(VERSION_V2.length > 0, true);
});
