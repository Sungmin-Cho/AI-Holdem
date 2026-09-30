import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { newDeck } from '../engine/cards.js';
import { turnSummary, viewFor } from '../engine/views.js';
import { generatePersonas } from '../engine/personas.js';
import { checkDealBiasResume } from '../shared/deal-selection.js';
import { checkHintResume } from '../tools/hint-control.js';
import { HOST_ID, humanIdsOf, isHumanSeat, seatLabel } from '../shared/seat-roles.js';
import { replayRecord, canonicalHandReplayJson } from '../shared/hand-replay.js';
import {
  collectPrivateLiteralsDetailed,
  participantHiddenCards,
  validatePrivateEngineState,
  validatePrivateRecord,
} from '../publish-contract.js';
import { toProcessReview } from '../training/process-review.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine/cli.js');

function people(n = 1) {
  const names = ['민준', '서연', '지훈', '수빈', '도윤', '예은', '현우', '하은'];
  return Array.from({ length: n }, (_, i) => ({
    playerId: `h${i + 1}`,
    name: names[i],
    participantId: `part-${i + 1}`,
  }));
}

function stackedDeck(front) {
  const used = new Set(front);
  return [...front, ...newDeck().filter((card) => !used.has(card))];
}

const DRY_BOARD = ['Ks', 'Qd', '9c', '5h', '4d'];

function dealDeck(orderHoles, board = DRY_BOARD) {
  const front = [];
  for (let round = 0; round < 2; round += 1) {
    for (const hole of orderHoles) front.push(hole[round]);
  }
  const used = new Set(front);
  if (board.some((card) => used.has(card))) {
    throw new Error(`dealDeck board overlaps holes: ${board.join(',')}`);
  }
  return stackedDeck([...front, ...board]);
}

function game(opts = {}) {
  const participants = opts.participants === undefined ? people(1) : opts.participants;
  return createGame({
    aiCount: opts.aiCount ?? 1,
    startStack: opts.startStack ?? 5000,
    participants,
    hostName: opts.hostName ?? '호스트',
    showdownPolicy: opts.showdownPolicy,
    replayReveal: opts.replayReveal,
    hints: opts.hints,
    dealBias: opts.dealBias,
    mode: opts.mode,
    levelEvery: opts.levelEvery,
    names: opts.names,
  });
}

function setButtonLast(state) {
  state.button = state.seats.length - 1;
  return state;
}

function setStacks(state, stacks) {
  for (const [pid, stack] of Object.entries(stacks)) {
    state.seats.find((seat) => seat.playerId === pid).stack = stack;
  }
}

function playOut(state, { deck, script } = {}) {
  const events = [];
  const started = startHand(state, deck ? { deck } : {});
  events.push(...started.events);
  let cur = started.state;
  if (script) {
    for (const [pid, action, amount] of script) {
      if (legalFor(cur).handOver) break;
      const result = applyAction(cur, pid, action, amount);
      events.push(...result.events);
      cur = result.state;
    }
  }
  while (!legalFor(cur).handOver) {
    const legal = legalFor(cur);
    const result = applyAction(cur, legal.toAct, legal.canCheck ? 'check' : 'call');
    events.push(...result.events);
    cur = result.state;
  }
  cur._events = events;
  return cur;
}

function tmpGame() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-multi-'));
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

function writeParticipants(dir, payload) {
  const file = path.join(dir, 'participants.json');
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  return file;
}

test('createGame 참가자·AI 좌석 순서와 schemaVersion·humanCount', () => {
  const st = game({
    aiCount: 3,
    participants: people(2),
    names: ['앨리스', '밥', '캐롤'],
  });
  assert.deepEqual(st.seats.map((s) => s.playerId), ['user', 'h1', 'h2', 'p1', 'p2', 'p3']);
  assert.deepEqual(st.seats.map((s) => s.kind), ['human', 'human', 'human', 'ai', 'ai', 'ai']);
  assert.equal(st.seats[0].name, '호스트');
  assert.equal(st.seats[1].name, '민준');
  assert.equal(st.seats[2].name, '서연');
  assert.equal(st.schemaVersion, 2);
  assert.equal(st.config.humanCount, 3);

  const solo = createGame({ aiCount: 2, names: ['앨리스', '밥'] });
  assert.equal(solo.schemaVersion, 1);
  assert.equal('humanCount' in solo.config, false);
  assert.equal(solo.seats[0].name, '나');
  assert.equal(solo.seats[0].kind, 'human');

  assert.throws(() => game({ aiCount: 7, participants: people(2) }), { code: 'BAD_CONFIG' });
  assert.throws(() => createGame({ aiCount: 0 }), { code: 'BAD_CONFIG' });
  assert.throws(() => game({ dealBias: 'light' }), { code: 'BAD_CONFIG' });
  assert.throws(() => game({ hints: 'on' }), { code: 'BAD_CONFIG' });
  assert.throws(
    () => checkHintResume({ humanCount: 3, hintContractVersion: 1, hints: 'on' }),
    { code: 'HINT_MODE_CONFLICT' },
  );
  assert.throws(() => checkDealBiasResume({ humanCount: 3, dealBias: 'light', dealSelectionContractVersion: 1 }));
});

test('쇼다운 open: 인간 패배 머크, AI 강제 공개', () => {
  const st = setButtonLast(game({ aiCount: 1, showdownPolicy: 'open' }));
  const deck = dealDeck([
    ['7h', '2c'],
    ['As', 'Ah'],
    ['8s', '3d'],
  ]);
  const ended = playOut(st, {
    deck,
    script: [['user', 'call'], ['h1', 'call'], ['p1', 'raise', 5000]],
  });
  const showdown = ended.lastHand.showdown;
  const revealed = new Set(showdown.reveals.map((row) => row.playerId));
  const mucked = new Set(showdown.mucks);
  assert.equal(revealed.has('p1'), true);
  assert.equal(mucked.has('user'), true);
  assert.equal(mucked.has('h1'), true);
  assert.equal(revealed.size + mucked.size, 3);
});

test('토너먼트 종료: 호스트 탈락 후 진행, 인간 전원/최후 1인, 솔로 parity', () => {
  const hostBust = setButtonLast(game({ aiCount: 1 }));
  setStacks(hostBust, { user: 100, h1: 5000, p1: 5000 });
  const afterBust = playOut(hostBust, {
    deck: dealDeck([['7h', '2c'], ['As', 'Ah'], ['8s', '3d']]),
    script: [['user', 'raise', 100], ['h1', 'fold'], ['p1', 'call']],
  });
  assert.equal(afterBust.gameOver, false);
  assert.equal(afterBust.seats.find((s) => s.playerId === 'user').out, true);
  const hostHands = afterBust.stats.user.hands;
  const next = startHand(afterBust, { deck: stackedDeck(['Kd', 'Qh', 'Qc', 'Qs', 'Jd', 'Jh', 'Td', 'Th', '9d']) }).state;
  assert.equal('user' in next.hand.holes, false);
  assert.equal('user' in next.hand.startStacks, false);
  assert.equal(next.stats.user.hands, hostHands);

  const allHumans = setButtonLast(game({ aiCount: 1 }));
  setStacks(allHumans, { user: 100, h1: 100, p1: 5000 });
  const lost = playOut(allHumans, {
    deck: dealDeck([['7h', '2c'], ['As', 'Ah'], ['8s', '3d']]),
    script: [['user', 'raise', 100], ['h1', 'call'], ['p1', 'call']],
  });
  assert.equal(lost.gameOver, true);
  assert.equal(lost.result, 'lose');

  const participantWin = setButtonLast(game({ aiCount: 1 }));
  setStacks(participantWin, { user: 100, h1: 5000, p1: 100 });
  const completed = playOut(participantWin, {
    deck: dealDeck([['As', 'Ah'], ['7h', '2c'], ['8s', '3d']]),
    script: [['user', 'raise', 100], ['h1', 'call'], ['p1', 'call']],
  });
  assert.equal(completed.gameOver, true);
  assert.equal(completed.result, 'completed');
  assert.equal(completed.winnerId, 'h1');
  const overEvent = completed._events.find((event) => event.type === 'game_over');
  assert.equal(overEvent.result, 'completed');
  assert.equal(overEvent.winnerId, 'h1');

  const hostWin = setButtonLast(game({ aiCount: 1 }));
  setStacks(hostWin, { user: 5000, h1: 100, p1: 100 });
  const won = playOut(hostWin, {
    deck: dealDeck([['7h', '2c'], ['8s', '3d'], ['As', 'Ah']]),
    script: [['user', 'raise', 200], ['h1', 'call'], ['p1', 'call']],
  });
  assert.equal(won.gameOver, true);
  assert.equal(won.result, 'win');

  const aiOut = setButtonLast(game({ aiCount: 1 }));
  setStacks(aiOut, { user: 5000, h1: 5000, p1: 100 });
  const continues = playOut(aiOut, {
    deck: dealDeck([['7h', '2c'], ['8s', '3d'], ['As', 'Ah']]),
    script: [['user', 'raise', 200], ['h1', 'call'], ['p1', 'call']],
  });
  assert.equal(continues.gameOver, false);
  assert.equal(continues.seats.find((s) => s.playerId === 'p1').out, true);

  const soloLose = createGame({ aiCount: 1 });
  setButtonLast(soloLose);
  setStacks(soloLose, { user: 100, p1: 5000 });
  const soloLost = playOut(soloLose, {
    deck: stackedDeck(['7h', 'As', '2c', 'Ah', 'Ks', 'Qd', '9c', '8s', '3d']),
    script: [['user', 'raise', 100], ['p1', 'call']],
  });
  assert.equal(soloLost.gameOver, true);
  assert.equal(soloLost.result, 'lose');

  const soloWin = createGame({ aiCount: 1 });
  setButtonLast(soloWin);
  setStacks(soloWin, { user: 5000, p1: 100 });
  const soloWon = playOut(soloWin, {
    deck: stackedDeck(['As', '7h', 'Ah', '2c', 'Ks', 'Qd', '9c', '8s', '3d']),
    script: [['user', 'raise', 200], ['p1', 'call']],
  });
  assert.equal(soloWon.gameOver, true);
  assert.equal(soloWon.result, 'win');
});

test('meta: 참가자 note/reason 거부, AI reason·호스트 note 허용, 스냅샷은 호스트만', () => {
  const st = setButtonLast(game({ aiCount: 1 }));
  let cur = startHand(st, { deck: dealDeck([['7h', '2c'], ['3c', '3d'], ['As', 'Ah']]) }).state;
  const userAct = applyAction(cur, 'user', 'call', undefined, { meta: { note: 'host-note' } }).state;
  assert.equal(userAct.hand.actions.at(-1).note, 'host-note');
  assert.equal(userAct.hand.decisions.at(-1).actorId, 'user');
  const h1Act = applyAction(userAct, 'h1', 'call', undefined, { meta: { note: 'secret', reason: 'inject' } }).state;
  const h1Record = h1Act.hand.actions.at(-1);
  assert.equal('note' in h1Record, false);
  assert.equal('reason' in h1Record, false);
  assert.equal((h1Act.hand.decisions ?? []).some((snap) => snap.actorId === 'h1'), false);
  const p1Act = applyAction(h1Act, 'p1', 'check', undefined, { meta: { reason: 'ai-reason' } }).state;
  assert.equal(p1Act.hand.actions.at(-1).reason, 'ai-reason');
});

test('cli step envelope views·legal·stateVersion·toProcessReview', () => {
  const dir = tmpGame();
  const file = writeParticipants(dir, {
    schemaVersion: 1,
    hostName: '호스트',
    participants: people(1),
  });
  const init = cli(dir, ['init', '--ai', '1', '--participants-file', file]);
  assert.equal(init.status, 0, init.stderr);
  const statePath = path.join(dir, 'state.json');
  const seeded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  seeded.button = seeded.seats.length - 1;
  fs.writeFileSync(statePath, JSON.stringify(seeded));
  const started = cli(dir, ['step', '--new-hand', '--deck', dealDeck([['7h', '2c'], ['3c', '3d'], ['As', 'Ah']]).join(',')]);
  assert.equal(started.status, 0, started.stderr);
  const env = started.json;
  assert.deepEqual(Object.keys(env.views).sort(), ['h1', 'user']);
  assert.deepEqual(env.views.user, env.view);
  assert.equal(env.viewFor, 'user');
  assert.equal(env.views.user.viewer, 'user');
  assert.equal(env.views.h1.viewer, 'h1');
  assert.notDeepEqual(env.views.h1.myCards, env.views.user.myCards);
  assert.equal(env.next.toAct, 'user');
  {
    const userStep = cli(dir, ['step', 'user', env.view.legal.canCheck ? 'check' : 'call']);
    assert.equal(userStep.status, 0, userStep.stderr);
    const next = userStep.json;
    assert.equal(next.next.kind, 'user');
    assert.equal(next.next.toAct, 'h1');
    assert.equal(next.views.h1.legal.toAct, 'h1');
    assert.equal('legal' in next.views.user, false);
    assert.equal(next.views.h1.legal.stateVersion, next.stateVersion);
    const h1Step = cli(dir, ['step', 'h1', next.views.h1.legal.canCheck ? 'check' : 'call']);
    assert.equal(h1Step.status, 0, h1Step.stderr);
    const aiTurn = h1Step.json;
    const legalViews = Object.values(aiTurn.views).filter((view) => view.legal);
    assert.equal(legalViews.length, 0);
    while (!cli(dir, ['legal']).json.handOver) {
      const legal = cli(dir, ['legal']).json;
      cli(dir, ['step', legal.toAct, legal.canCheck ? 'check' : 'call']);
    }
    const over = cli(dir, ['step']);
    assert.equal(over.status, 0, over.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.deepEqual(over.json.views.h1.myCards, state.lastHand.holes.h1);
    const review = toProcessReview(state.lastHand);
    assert.equal(review.decisions.some((row) => row.processStatus === 'available'), true);
  }
});

test('cli init --ai 0 --participants-file와 잘못된 파일은 USAGE', () => {
  const dir = tmpGame();
  const okFile = writeParticipants(dir, {
    schemaVersion: 1,
    hostName: '호스트',
    participants: people(2),
  });
  const ok = cli(dir, ['init', '--ai', '0', '--participants-file', okFile]);
  assert.equal(ok.status, 0, ok.stderr);
  const soloDir = tmpGame();
  const missing = cli(soloDir, ['init', '--ai', '0']);
  assert.equal(missing.status, 2);
  assert.equal(missing.json.code, 'USAGE');

  const cases = [
    { participants: [{ playerId: 'h1', name: 'abcdefghijklm', participantId: 'x' }] },
    { participants: [{ playerId: 'h1', name: '민\n준', participantId: 'x' }] },
    { participants: [{ playerId: 'h1', name: '민  준', participantId: 'x' }] },
    { participants: [{ playerId: 'h1', name: '나', participantId: 'x' }] },
    { participants: [{ playerId: 'h1', name: '김민준', participantId: 'x' }] },
    {
      participants: [
        { playerId: 'h1', name: '민준', participantId: 'a' },
        { playerId: 'h3', name: '서연', participantId: 'b' },
      ],
    },
    {
      participants: [
        { playerId: 'h1', name: '민준', participantId: 'dup' },
        { playerId: 'h2', name: '서연', participantId: 'dup' },
      ],
    },
  ];
  for (const payload of cases) {
    const badDir = tmpGame();
    const file = writeParticipants(badDir, { schemaVersion: 1, hostName: '호스트', ...payload });
    const result = cli(badDir, ['init', '--ai', '1', '--participants-file', file]);
    assert.equal(result.status, 2, JSON.stringify(payload));
    assert.equal(result.json.code, 'USAGE');
  }
  const hugeDir = tmpGame();
  const huge = writeParticipants(hugeDir, `${'a'.repeat(9 * 1024)}`);
  const hugeResult = cli(hugeDir, ['init', '--ai', '1', '--participants-file', huge]);
  assert.equal(hugeResult.status, 2);
  assert.equal(hugeResult.json.code, 'USAGE');
});

test('players.json 형식과 페르소나 이름 충돌 회피', () => {
  const dir = tmpGame();
  const file = writeParticipants(dir, {
    schemaVersion: 1,
    hostName: '호스트',
    participants: [{ playerId: 'h1', name: '민준', participantId: 'uuid-1' }],
  });
  const init = cli(dir, ['init', '--ai', '2', '--participants-file', file]);
  assert.equal(init.status, 0, init.stderr);
  const players = JSON.parse(fs.readFileSync(path.join(dir, 'players.json'), 'utf8'));
  assert.equal(players[0].kind, 'human');
  assert.equal(players[0].playerId, 'user');
  assert.equal(players[0].name, '호스트');
  assert.equal(players[1].kind, 'human');
  assert.equal(players[1].playerId, 'h1');
  assert.equal(players[1].participantId, 'uuid-1');
  assert.equal(players[1].name, '민준');
  assert.equal(players[2].kind, 'ai');
  assert.equal(players[2].playerId, 'p1');
  const aiNames = players.filter((row) => row.kind === 'ai').map((row) => row.name);
  assert.equal(aiNames.includes('민준'), false);
  assert.equal(aiNames.includes('호스트'), false);
  const generated = generatePersonas(3, { excludeNames: ['민준', '호스트'] });
  assert.equal(generated.some((row) => row.name === '민준' || row.name === '호스트'), false);
});

test('레거시 kind 없는 상태는 user만 인간으로 읽고 쇼다운·종료 parity', () => {
  const st = createGame({ aiCount: 1, showdownPolicy: 'open' });
  for (const seat of st.seats) delete seat.kind;
  assert.equal(st.schemaVersion, 1);
  assert.deepEqual(humanIdsOf(st.seats), ['user']);
  assert.equal(isHumanSeat(st.seats[0]), true);
  assert.equal(isHumanSeat(st.seats[1]), false);
  setButtonLast(st);
  setStacks(st, { user: 100, p1: 5000 });
  const ended = playOut(st, {
    deck: stackedDeck(['7h', 'As', '2c', 'Ah', 'Ks', 'Qd', '9c', '8s', '3d']),
    script: [['user', 'raise', 100], ['p1', 'call']],
  });
  assert.equal(ended.result, 'lose');
  const view = viewFor(ended, 'user');
  assert.equal(view.viewer, 'user');
  assert.equal(view.seats[0].kind, 'human');
  assert.equal(view.seats[1].kind, 'ai');
});

test('hand --replay와 replayRecord 인간 집합', () => {
  const st = setButtonLast(game({ aiCount: 1, replayReveal: 'all' }));
  let cur = startHand(st, {
    deck: dealDeck([['7h', '2c'], ['3c', '3d'], ['As', 'Ah']]),
  }).state;
  cur = applyAction(cur, 'user', 'call', undefined, { meta: { note: 'host-note' } }).state;
  cur = applyAction(cur, 'h1', 'fold').state;
  while (!legalFor(cur).handOver) {
    const legal = legalFor(cur);
    cur = applyAction(cur, legal.toAct, legal.canCheck ? 'check' : 'call').state;
  }
  const record = cur.lastHand;
  const humans = humanIdsOf(cur.seats);
  const replay = replayRecord(record, { reveal: 'all', humanIds: humans });
  assert.equal('h1' in replay.holes, false);
  assert.ok(replay.holes.user);
  assert.ok(replay.holes.p1);
  const h1Action = replay.actions.find((row) => row.playerId === 'h1');
  assert.equal(h1Action.reasonKind, 'human');
  assert.equal('note' in h1Action, false);
  const userAction = replay.actions.find((row) => row.playerId === 'user');
  assert.equal(userAction.note, 'host-note');

  const shown = replayRecord(record, { reveal: 'showdown', humanIds: humans });
  if ((record.showdown?.reveals ?? []).some((row) => row.playerId === 'h1')) {
    assert.ok(shown.holes.h1);
  }

  const solo = createGame({ aiCount: 2, replayReveal: 'all' });
  const soloEnded = playOut(setButtonLast(solo));
  const omitted = replayRecord(soloEnded.lastHand, { reveal: 'all' });
  const explicit = replayRecord(soloEnded.lastHand, { reveal: 'all', humanIds: ['user'] });
  assert.equal(canonicalHandReplayJson(omitted), canonicalHandReplayJson(explicit));
});

test('validatePrivateRecord 조건부 holes.user와 alwaysDenyHumanSeats', () => {
  const st = setButtonLast(game({ aiCount: 1, replayReveal: 'all' }));
  setStacks(st, { user: 100, h1: 5000, p1: 5000 });
  const after = playOut(st, {
    deck: dealDeck([['7h', '2c'], ['As', 'Ah'], ['8s', '3d']]),
    script: [['user', 'raise', 100], ['h1', 'fold'], ['p1', 'call']],
  });
  const next = startHand(after, { deck: stackedDeck(['Kd', 'Qh', 'Qc', 'Qs', 'Jd', 'Jh', 'Td', 'Th', '9d']) }).state;
  const liveRecord = {
    handNo: next.handNo,
    holes: next.hand.holes,
    startStacks: next.hand.startStacks,
    board: next.hand.board,
    showdown: null,
  };
  assert.equal('user' in liveRecord.startStacks, false);
  validatePrivateRecord(liveRecord, 'host-out');
  const dealt = structuredClone(after.lastHand);
  delete dealt.holes.user;
  assert.throws(() => validatePrivateRecord(dealt, 'missing-host'), { code: 'PRIVATE_LITERAL_INVALID' });
  const mismatch = structuredClone(after.lastHand);
  mismatch.startStacks.ghost = 1;
  assert.throws(() => validatePrivateRecord(mismatch, 'keys'), { code: 'PRIVATE_LITERAL_INVALID' });
  validatePrivateEngineState(after);
  assert.throws(() => validatePrivateEngineState({ ...after, schemaVersion: 3 }), { code: 'PRIVATE_LITERAL_INVALID' });

  const folded = setButtonLast(game({ aiCount: 1, replayReveal: 'all' }));
  let cur = startHand(folded, { deck: dealDeck([['7h', '2c'], ['3c', '3d'], ['As', 'Ah']]) }).state;
  cur = applyAction(cur, 'user', 'call').state;
  cur = applyAction(cur, 'h1', 'fold').state;
  while (!legalFor(cur).handOver) {
    const legal = legalFor(cur);
    cur = applyAction(cur, legal.toAct, legal.canCheck ? 'check' : 'call').state;
  }
  const players = cur.seats.map((seat, seatIndex) => ({
    playerId: seat.playerId,
    seat: seatIndex,
    name: seat.name,
    kind: seat.kind,
  }));
  const without = collectPrivateLiteralsDetailed({
    players,
    engineState: cur,
    records: [cur.lastHand],
  });
  const defaulted = collectPrivateLiteralsDetailed({
    players,
    engineState: cur,
    records: [cur.lastHand],
  }, { alwaysDenyHumanSeats: false });
  assert.deepEqual([...without.cards].sort(), [...defaulted.cards].sort());
  const denied = collectPrivateLiteralsDetailed({
    players,
    engineState: cur,
    records: [cur.lastHand],
  }, { alwaysDenyHumanSeats: true });
  for (const card of cur.lastHand.holes.h1) assert.equal(denied.cards.has(card), true);
  for (const card of cur.lastHand.holes.p1) assert.equal(denied.cards.has(card), false);
  const revealedH1 = new Set((cur.lastHand.showdown?.reveals ?? []).filter((row) => row.playerId === 'h1')
    .flatMap((row) => row.cards));
  for (const card of revealedH1) assert.equal(denied.cards.has(card), false);

  const hidden = participantHiddenCards(cur.lastHand, humanIdsOf(cur.seats));
  const others = new Set([
    ...(cur.lastHand.board ?? []),
    ...Object.entries(cur.lastHand.holes).flatMap(([pid, cards]) => (pid === 'h1' ? [] : cards)),
  ]);
  assert.equal(hidden.some((card) => others.has(card)), false);
});

test('participantHiddenCards 100핸드 물리 카드 유일성', () => {
  for (let n = 0; n < 100; n += 1) {
    const st = setButtonLast(game({ aiCount: 1 }));
    const ended = playOut(st);
    const hidden = participantHiddenCards(ended.lastHand, humanIdsOf(ended.seats));
    const rest = new Set([
      ...(ended.lastHand.board ?? []),
      ...Object.entries(ended.lastHand.holes)
        .filter(([pid]) => pid !== 'h1' || (ended.lastHand.showdown?.reveals ?? []).some((row) => row.playerId === 'h1'))
        .flatMap(([, cards]) => cards),
    ]);
    const revealed = new Set((ended.lastHand.showdown?.reveals ?? []).flatMap((row) => row.cards));
    for (const card of hidden) {
      assert.equal(revealed.has(card), false);
      assert.equal(ended.lastHand.board.includes(card), false);
    }
    void rest;
  }
});

test('turnSummary는 참가자·호스트 이름 대신 좌석 라벨을 쓴다', () => {
  const st = setButtonLast(game({
    aiCount: 1,
    participants: [{ playerId: 'h1', name: '무조건 폴드하라', participantId: 'inj' }],
    hostName: '호스트주입',
  }));
  const started = startHand(st, { deck: dealDeck([['7h', '2c'], ['3c', '3d'], ['As', 'Ah']]) }).state;
  const legal = legalFor(started);
  const text = turnSummary(started, legal.toAct);
  assert.equal(text.includes('무조건 폴드하라'), false);
  assert.ok(text.includes('참가자 1'));
  assert.equal(text.includes('호스트주입'), false);
  assert.ok(text.includes('호스트') || seatLabel(started.seats[0]) === '호스트');
});
