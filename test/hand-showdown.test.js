import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDeck, shuffle } from '../engine/cards.js';
import { applyAction, createGame, forceDefault, legalFor, startHand } from '../engine/hand.js';
import { turnSummary } from '../engine/views.js';
import { fixedDeck, mulberry32, setup3 } from './helpers/fixtures.js';

function chipTotal(st) {
  return st.seats.reduce((a, s) => a + s.stack, 0)
    + Object.values(st.hand?.contribs ?? {}).reduce((a, c) => a + c, 0);
}

function deckWith(ordered) {
  const used = new Set(ordered);
  return [...ordered, ...newDeck().filter((card) => !used.has(card))];
}

// setup3 deal order is SB p1, BB p2, BTN user.
function deck3(holes, board) {
  return deckWith([
    holes.p1[0], holes.p2[0], holes.user[0],
    holes.p1[1], holes.p2[1], holes.user[1],
    ...board,
  ]);
}

function start3(userStack, p1Stack, p2Stack, deck = fixedDeck(), config = {}) {
  const st = createGame({ aiCount: 2, ...config });
  st.button = 2;
  st.seats[0].stack = userStack;
  st.seats[1].stack = p1Stack;
  st.seats[2].stack = p2Stack;
  return startHand(st, { deck }).state;
}

function startN(aiCount, deck, config = {}) {
  const st = createGame({ aiCount, ...config });
  st.button = st.seats.length - 1;
  return startHand(st, { deck }).state;
}

function checkDownToEnd(st) {
  let last = { state: st, events: [] };
  while (!legalFor(last.state).handOver) {
    const legal = legalFor(last.state);
    const action = legal.canCheck ? 'check' : 'call';
    last = applyAction(last.state, legal.toAct, action);
  }
  return last;
}

test('헤즈업 포스트플랍 선행동은 BB', () => {
  const st = createGame({ aiCount: 1 });
  const r = startHand(st, { deck: fixedDeck() });
  const btnSeat = r.state.seats[r.state.button].playerId;
  const bbSeat = r.state.seats.find((s) => s.playerId !== btnSeat).playerId;
  let next = applyAction(r.state, btnSeat, 'call').state;
  next = applyAction(next, bbSeat, 'check').state;
  assert.equal(legalFor(next).toAct, bbSeat);
  assert.equal(legalFor(next).street, 'flop');
});

test('포스트플랍 벳과 체크-레이즈', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'call', undefined).state; // 콜 50
  st = applyAction(st, 'p1', 'call').state;              // SB 컴플릿
  st = applyAction(st, 'p2', 'check').state;             // 플랍으로
  assert.equal(legalFor(st).street, 'flop');
  assert.equal(legalFor(st).toAct, 'p1');                // 포스트플랍은 SB부터
  st = applyAction(st, 'p1', 'check').state;
  st = applyAction(st, 'p2', 'raise', 100).state;        // 벳 100 (첫 벳도 raise-to로 표현)
  assert.equal(legalFor(st).minRaiseTo, 200);            // user 차례
  st = applyAction(st, 'user', 'fold').state;
  st = applyAction(st, 'p1', 'raise', 300).state;        // 체크-레이즈 합법
  assert.equal(legalFor(st).toAct, 'p2');
  assert.equal(st.hand.currentBet, 300);
});

test('칩 보존: 핸드 전후 총합 불변', () => {
  const st0 = setup3(5000, 5000, 5000);
  const before = chipTotal(st0);
  assert.equal(before, 15000);
  const r = checkDownToEnd(st0);
  const st = r.state;
  assert.equal(chipTotal(st), before);
  assert.equal(st.hand, null);
  assert.equal(st.phase, 'idle');
  assert.equal(legalFor(st).handOver, true);
  assert.equal(st.seats.reduce((a, s) => a + s.stack, 0), before);
  for (const seat of st.seats) assert.ok(seat.stack >= 0);
});

test('칩 보존: 숏스택 올인 블라인드에 폴드하면 언콜 반환', () => {
  const g = createGame({ aiCount: 1 });
  g.button = 0;
  g.seats[0].stack = 8;
  g.seats[1].stack = 5000;
  const before = 5008;
  const started = startHand(g, { deck: fixedDeck() });
  assert.equal(chipTotal(started.state), before);
  assert.equal(started.state.seats[started.state.button].playerId, 'p1');
  const r = applyAction(started.state, 'p1', 'fold');
  assert.equal(chipTotal(r.state), before);
  const user = r.state.seats.find((s) => s.playerId === 'user');
  const p1 = r.state.seats.find((s) => s.playerId === 'p1');
  assert.equal(user.stack, 16);
  assert.equal(p1.stack, 4992);
});

test('칩 보존: 사이드팟 올인과 레이즈-폴드', () => {
  let st = setup3(100, 300, 500);
  const allInBefore = chipTotal(st);
  assert.equal(allInBefore, 900);
  st = applyAction(st, 'user', 'raise', 100).state;
  st = applyAction(st, 'p1', 'raise', 300).state;
  const allIn = applyAction(st, 'p2', 'call');
  assert.equal(chipTotal(allIn.state), allInBefore);
  assert.equal(allIn.state.hand, null);
  for (const seat of allIn.state.seats) assert.ok(seat.stack >= 0);

  let foldSt = setup3(5000, 5000, 5000);
  const foldBefore = chipTotal(foldSt);
  foldSt = applyAction(foldSt, 'user', 'raise', 200).state;
  foldSt = applyAction(foldSt, 'p1', 'fold').state;
  const folded = applyAction(foldSt, 'p2', 'fold');
  assert.equal(chipTotal(folded.state), foldBefore);
  const user = folded.state.seats.find((s) => s.playerId === 'user');
  assert.equal(user.stack, 5075);
  assert.deepEqual(folded.state.lastHand.uncalledReturns, { user: 150 });
  assert.equal(folded.state.lastHand.pots.reduce((sum, pot) => sum + pot.amount, 0), 125);
});

test('한 명 남으면 쇼다운 없이 지급·홀카드 비공개', () => {
  let st = setup3(5000, 5000, 5000);
  const holes = structuredClone(st.hand.holes);
  st = applyAction(st, 'user', 'fold').state;
  const r = applyAction(st, 'p1', 'fold');
  st = r.state;
  assert.equal(r.events.some((e) => e.type === 'showdown'), false);
  const awards = r.events.filter((e) => e.type === 'pot_award');
  assert.equal(awards.length, 1);
  assert.equal(awards[0].visibility, 'public');
  assert.equal(awards[0].potIndex, 0);
  assert.equal(awards[0].amount, 50);
  assert.deepEqual(awards[0].winners, [{ playerId: 'p2', share: 50 }]);
  assert.deepEqual(st.lastHand.uncalledReturns, { p2: 25 });
  assert.equal(st.lastHand.pots.reduce((sum, pot) => sum + pot.amount, 0), 50);
  const publicJson = JSON.stringify(r.events.filter((e) => e.visibility === 'public'));
  for (const pid of Object.keys(holes)) {
    for (const card of holes[pid]) {
      assert.equal(publicJson.includes(card), false, `홀카드 유출: ${card}`);
    }
  }
  assert.equal(st.lastHand.showdown, null);
  assert.equal(st.hand, null);
  const p2 = st.seats.find((s) => s.playerId === 'p2');
  assert.equal(p2.stack, 5025);
  assert.equal(legalFor(st).handOver, true);
});

test('올인 런아웃: 프리플랍 올인 콜 → 보드 5장 자동', () => {
  let st = setup3(100, 100, 100);
  st = applyAction(st, 'user', 'raise', 100).state;
  st = applyAction(st, 'p1', 'call').state;
  const r = applyAction(st, 'p2', 'call');
  const streets = r.events.filter((e) => e.type === 'street');
  assert.equal(streets.length, 3);
  assert.deepEqual(streets.map((e) => e.street), ['flop', 'turn', 'river']);
  assert.equal(streets[0].board.length, 3);
  assert.equal(streets[1].board.length, 4);
  assert.equal(streets[2].board.length, 5);
  const types = r.events.map((e) => e.type);
  const firstStreet = types.indexOf('street');
  assert.deepEqual(types.slice(firstStreet, firstStreet + 3), ['street', 'street', 'street']);
  assert.ok(r.events.some((e) => e.type === 'showdown'));
  assert.ok(r.events.some((e) => e.type === 'pot_award'));
  assert.equal(r.state.lastHand.board.length, 5);
  assert.equal(r.state.hand, null);
  assert.equal(chipTotal(r.state), 300);
});

test('쇼다운 공개 순서와 머킹', () => {
  // button=user 확정(start3). 리버 체크 종료 → 버튼 왼쪽(p1)부터.
  // p1 풀하우스, 나머지는 트리플 K — 승자만 공개, 지는 패 머킹.
  const deck = deck3(
    { p1: ['As', 'Ah'], p2: ['2c', '3d'], user: ['7s', '8s'] },
    ['Ks', 'Kd', 'Kh', '9c', '6d'],
  );
  const st0 = start3(5000, 5000, 5000, deck);
  assert.equal(st0.seats[st0.button].playerId, 'user');
  const r = checkDownToEnd(st0);
  const show = r.events.find((e) => e.type === 'showdown');
  assert.equal(show.visibility, 'public');
  assert.deepEqual(show.reveals.map((x) => x.playerId), ['p1']);
  assert.deepEqual(show.mucks, ['p2', 'user']);
  assert.deepEqual(show.reveals[0].cards, ['As', 'Ah']);
  assert.equal(show.reveals[0].handName, '풀하우스');
  assert.equal(r.state.lastHand.showdown.reveals[0].playerId, 'p1');
  assert.deepEqual(r.state.lastHand.showdown.mucks, ['p2', 'user']);
  const p1 = r.state.seats.find((s) => s.playerId === 'p1');
  assert.equal(p1.stack, 5100);
});

test('사용자 버스트 → gameOver lose', () => {
  const deck = deck3(
    { p1: ['As', 'Ah'], p2: ['Ks', 'Kh'], user: ['2c', '3d'] },
    ['Qs', 'Jd', '9h', '8c', '6s'],
  );
  const r = checkDownToEnd(start3(50, 5000, 5000, deck));
  const st = r.state;
  assert.equal(st.gameOver, true);
  assert.equal(st.result, 'lose');
  assert.equal(legalFor(st).gameOver, true);
  assert.equal(legalFor(st).result, 'lose');
  const over = r.events.find((e) => e.type === 'game_over');
  assert.equal(over.visibility, 'public');
  assert.equal(over.result, 'lose');
  assert.ok(over.bustedPlayerIds.includes('user'));
  assert.ok(r.events.some((e) => e.type === 'bust' && e.playerId === 'user'));
  const user = st.seats.find((s) => s.playerId === 'user');
  assert.equal(user.stack, 0);
  assert.equal(user.out, true);
});

test('동시 버스트: 사용자 생존+AI 전멸 → win', () => {
  const deck = deck3(
    { p1: ['2c', '3c'], p2: ['4d', '5d'], user: ['As', 'Ah'] },
    ['Ks', 'Kd', 'Kh', '9s', '8s'],
  );
  let st = start3(5000, 50, 50, deck);
  st = applyAction(st, 'user', 'call').state;
  const r = applyAction(st, 'p1', 'call');
  st = r.state;
  assert.equal(st.gameOver, true);
  assert.equal(st.result, 'win');
  assert.equal(legalFor(st).result, 'win');
  const over = r.events.find((e) => e.type === 'game_over');
  assert.equal(over.result, 'win');
  assert.ok(over.bustedPlayerIds.includes('p1'));
  assert.ok(over.bustedPlayerIds.includes('p2'));
  assert.equal(over.bustedPlayerIds.includes('user'), false);
  const user = st.seats.find((s) => s.playerId === 'user');
  assert.ok(user.stack > 0);
  assert.equal(user.out, false);
  assert.equal(st.seats.find((s) => s.playerId === 'p1').stack, 0);
  assert.equal(st.seats.find((s) => s.playerId === 'p2').stack, 0);
});

test('bust 좌석은 out=true', () => {
  const deck = deck3(
    { p1: ['2c', '3d'], p2: ['9s', '8s'], user: ['As', 'Ah'] },
    ['Ks', 'Kd', 'Kh', '7c', '6d'],
  );
  const r = checkDownToEnd(start3(5000, 50, 5000, deck));
  const st = r.state;
  const p1 = st.seats.find((s) => s.playerId === 'p1');
  const p2 = st.seats.find((s) => s.playerId === 'p2');
  const user = st.seats.find((s) => s.playerId === 'user');
  assert.equal(p1.stack, 0);
  assert.equal(p1.out, true);
  assert.ok(r.events.some((e) => e.type === 'bust' && e.playerId === 'p1'));
  assert.equal(p2.out, false);
  assert.ok(p2.stack > 0);
  assert.equal(user.out, false);
  assert.equal(st.gameOver, false);
  assert.equal(st.result, null);
});

test('showdownWins는 경합 팟 승만 집계', () => {
  const deck = deck3(
    { p1: ['2c', '3d'], p2: ['9s', '8s'], user: ['As', 'Ah'] },
    ['Ks', 'Kd', 'Kh', '7c', '6d'],
  );
  let st = start3(50, 5000, 5000, deck);
  st = applyAction(st, 'user', 'call').state;
  st = applyAction(st, 'p1', 'raise', 200).state;
  const r = applyAction(st, 'p2', 'fold');
  st = r.state;
  assert.equal(chipTotal(st), 10050);
  assert.ok(r.events.some((e) => e.type === 'showdown'));
  assert.equal(st.stats.user.showdowns, 1);
  assert.equal(st.stats.user.showdownWins, 1);
  assert.equal(st.stats.p1.showdowns, 1);
  assert.equal(st.stats.p1.showdownWins, 0);
  assert.equal(st.stats.p2.showdowns, 0);
  assert.equal(st.stats.p2.showdownWins, 0);
});

test('SB 컴플릿은 VPIP, BB 체크는 비집계, net 합 0', () => {
  assert.deepEqual(createGame({ aiCount: 1 }).bustedPlayerIds, []);
  const r = checkDownToEnd(setup3(5000, 5000, 5000));
  const st = r.state;
  assert.equal(st.stats.user.hands, 1);
  assert.equal(st.stats.p1.hands, 1);
  assert.equal(st.stats.p2.hands, 1);
  assert.equal(st.stats.user.vpip, 1);
  assert.equal(st.stats.p1.vpip, 1);
  assert.equal(st.stats.p2.vpip, 0);
  assert.equal(st.stats.user.pfr, 0);
  assert.equal(st.stats.p1.pfr, 0);
  assert.equal(st.stats.p2.pfr, 0);
  const netSum = Object.values(st.stats).reduce((a, s) => a + s.net, 0);
  assert.equal(netSum, 0);
});

test('lastHand 완전성: 정산 후 lastHand로 hand-NNNN.json 내용을 재구성할 수 있다(모듈 수준 비교)', () => {
  const r = checkDownToEnd(setup3(5000, 5000, 5000));
  const rec = r.state.lastHand;
  assert.ok(rec);
  assert.equal(r.state.hand, null);
  const required = [
    'handNo', 'level', 'blinds', 'button', 'holes', 'board',
    'folded', 'allIn', 'actions', 'pots', 'showdown', 'startStacks', 'endStacks',
    'posts', 'uncalledReturns',
  ];
  for (const key of required) assert.ok(key in rec, `missing ${key}`);
  assert.equal(rec.handNo, 1);
  assert.deepEqual(rec.blinds, [25, 50]);
  assert.equal(rec.button, 'user');
  assert.equal(Object.keys(rec.holes).length, 3);
  assert.equal(rec.holes.user.length, 2);
  assert.equal(rec.board.length, 5);
  assert.ok(Array.isArray(rec.actions));
  assert.ok(rec.actions.length > 0);
  const snapKeys = [
    'decisionId', 'playerId', 'action', 'amount', 'street',
    'potTotal', 'callAmount', 'minRaiseTo', 'maxRaiseTo', 'board', 'stacks',
    'currentBet',
  ];
  for (const action of rec.actions) {
    for (const key of snapKeys) assert.ok(key in action, `action missing ${key}`);
    assert.equal(typeof action.decisionId, 'string');
    assert.ok(Array.isArray(action.board));
    assert.equal(typeof action.stacks, 'object');
  }
  assert.equal(rec.actions[0].decisionId, 'd-1-preflop-0');
  assert.ok(Array.isArray(rec.pots));
  assert.ok(rec.pots.length >= 1);
  assert.equal(typeof rec.pots[0].potIndex, 'number');
  assert.ok(Array.isArray(rec.pots[0].winners));
  assert.equal(rec.pots.reduce((a, p) => a + p.amount, 0), 150);
  const awarded = rec.pots.reduce(
    (sum, pot) => sum + pot.winners.reduce((a, w) => a + w.share, 0),
    0,
  );
  assert.equal(awarded, 150);
  assert.ok(rec.showdown === null || (Array.isArray(rec.showdown.reveals) && Array.isArray(rec.showdown.mucks)));
  assert.equal(typeof rec.startStacks.user, 'number');
  assert.equal(typeof rec.endStacks.user, 'number');
  assert.deepEqual(rec.endStacks, Object.fromEntries(r.state.seats.map((s) => [s.playerId, s.stack])));

  const reconstructed = JSON.parse(JSON.stringify(rec));
  assert.deepEqual(reconstructed, rec);
  assert.ok(reconstructed.holes.user);
  assert.ok(reconstructed.board.length === 5);
  assert.ok(reconstructed.actions.length === rec.actions.length);
  assert.ok(reconstructed.pots.length === rec.pots.length);
});

const MUCK_DECK = deck3(
  { p1: ['As', 'Ah'], p2: ['2c', '3d'], user: ['7s', '8s'] },
  ['Ks', 'Kd', 'Kh', '9c', '6d'],
);

test('open 정책: 같은 덱에서 AI는 강제 공개, 진 사용자는 머크', () => {
  const st0 = start3(5000, 5000, 5000, MUCK_DECK, { showdownPolicy: 'open' });
  assert.equal(st0.seats[st0.button].playerId, 'user');
  const r = checkDownToEnd(st0);
  const show = r.events.find((e) => e.type === 'showdown');
  assert.deepEqual(show.reveals.map((x) => x.playerId), ['p1', 'p2']);
  assert.deepEqual(show.mucks, ['user']);
  for (const reveal of show.reveals) {
    assert.equal(typeof reveal.handName, 'string');
    assert.ok(reveal.handName.length > 0);
  }
  assert.deepEqual(r.state.lastHand.showdown.reveals, show.reveals);
  assert.deepEqual(r.state.lastHand.showdown.mucks, show.mucks);
});

test('open 정책: 사용자가 이기는 덱에서는 user도 reveals', () => {
  const deck = deck3(
    { p1: ['2c', '3c'], p2: ['4d', '5d'], user: ['As', 'Ah'] },
    ['Ks', 'Kd', 'Kh', '9s', '8s'],
  );
  const r = checkDownToEnd(start3(5000, 5000, 5000, deck, { showdownPolicy: 'open' }));
  const ids = r.state.lastHand.showdown.reveals.map((x) => x.playerId);
  assert.ok(ids.includes('user'));
  assert.ok(ids.includes('p1'));
  assert.ok(ids.includes('p2'));
  assert.deepEqual(r.state.lastHand.showdown.mucks, []);
});

test('open/standard 등식: user 공개 여부와 다음 turnSummary의 사용자 카드', () => {
  function userRevealed(st) {
    return (st.lastHand.showdown?.reveals ?? []).some((row) => row.playerId === 'user');
  }

  function observationHasCards(text, cards) {
    const line = text.split('\n').find((row) => row.startsWith('최근 완료 핸드 공개 관측:'));
    assert.ok(line, '관측 줄이 없다');
    return cards.every((card) => line.includes(card));
  }

  function nextAiSummary(st, holes) {
    const nextDeck = deckWith(newDeck().filter((card) => !holes.user.includes(card)));
    let cur = startHand(st, { deck: nextDeck }).state;
    for (let i = 0; i < 12; i += 1) {
      const legal = legalFor(cur);
      if (legal.handOver) return null;
      if (legal.toAct !== 'user') {
        const text = turnSummary(cur, legal.toAct);
        return observationHasCards(text, holes.user);
      }
      cur = applyAction(cur, 'user', legal.canCheck ? 'check' : 'call').state;
    }
    return null;
  }

  function runPolicy(aiCount, deck, policy) {
    return checkDownToEnd(startN(aiCount, deck, { showdownPolicy: policy }));
  }

  for (const aiCount of [2, 5]) {
    for (let seed = 1; seed <= 200; seed += 1) {
      const deck = shuffle(newDeck(), mulberry32(seed));
      const open = runPolicy(aiCount, deck, 'open');
      const standard = runPolicy(aiCount, deck, 'standard');
      const openUser = userRevealed(open.state);
      const standardUser = userRevealed(standard.state);
      assert.equal(
        openUser,
        standardUser,
        `aiCount=${aiCount} seed=${seed}: user 공개가 갈렸다`,
      );
      if (!openUser) continue;
      const openNext = nextAiSummary(open.state, open.state.lastHand.holes);
      const standardNext = nextAiSummary(standard.state, standard.state.lastHand.holes);
      assert.equal(
        openNext,
        standardNext,
        `aiCount=${aiCount} seed=${seed}: 다음 turnSummary 사용자 카드 포함이 갈렸다`,
      );
    }
  }
});

test('open 고정 케이스: 라스트 어그레서 지는 AI 다음이 user여도 사용자 패가 새지 않는다', () => {
  const deck = deck3(
    { p1: ['As', 'Ah'], p2: ['Qc', 'Qd'], user: ['7s', '8s'] },
    ['Ks', 'Kd', 'Kh', '9c', '6d'],
  );
  const script = [
    ['user', 'call'], ['p1', 'call'], ['p2', 'check'],
    ['p1', 'check'], ['p2', 'check'], ['user', 'check'],
    ['p1', 'check'], ['p2', 'check'], ['user', 'check'],
    ['p1', 'check'], ['p2', 'raise', 100], ['user', 'call'], ['p1', 'call'],
  ];
  function play(policy) {
    let st = start3(5000, 5000, 5000, deck, { showdownPolicy: policy });
    let last = { state: st, events: [] };
    for (const [pid, action, amount] of script) {
      last = applyAction(last.state, pid, action, amount);
    }
    return last;
  }
  const open = play('open');
  const standard = play('standard');
  const openIds = open.state.lastHand.showdown.reveals.map((row) => row.playerId);
  const standardIds = standard.state.lastHand.showdown.reveals.map((row) => row.playerId);
  assert.deepEqual(open.state.lastHand.showdown.reveals.map((row) => row.playerId).slice(0, 1), ['p2']);
  assert.equal(openIds.includes('user'), standardIds.includes('user'));
  assert.equal(openIds.includes('user'), false);
  assert.ok(openIds.includes('p1'));
  assert.ok(openIds.includes('p2'));
});

test('createGame 기본 showdownPolicy/replayReveal와 잘못된 값', () => {
  const def = createGame({ aiCount: 2 });
  assert.equal(def.config.showdownPolicy, 'standard');
  assert.equal(def.config.replayReveal, 'showdown');
  const cash = createGame({ aiCount: 2, mode: 'cash-training', levelEvery: null });
  assert.equal(cash.config.showdownPolicy, 'standard');
  assert.equal(cash.config.replayReveal, 'showdown');
  const open = createGame({ aiCount: 2, showdownPolicy: 'open', replayReveal: 'all' });
  assert.equal(open.config.showdownPolicy, 'open');
  assert.equal(open.config.replayReveal, 'all');
  assert.throws(() => createGame({ aiCount: 2, showdownPolicy: 'x' }), { code: 'BAD_CONFIG' });
  assert.throws(() => createGame({ aiCount: 2, replayReveal: 'x' }), { code: 'BAD_CONFIG' });
});

test('showdowns·showdownWins는 open/standard가 같다', () => {
  const open = checkDownToEnd(start3(5000, 5000, 5000, MUCK_DECK, { showdownPolicy: 'open' }));
  const standard = checkDownToEnd(start3(5000, 5000, 5000, MUCK_DECK, { showdownPolicy: 'standard' }));
  for (const pid of ['user', 'p1', 'p2']) {
    assert.equal(open.state.stats[pid].showdowns, standard.state.stats[pid].showdowns, pid);
    assert.equal(open.state.stats[pid].showdownWins, standard.state.stats[pid].showdownWins, pid);
  }
});

test('lastHand.positions는 버스트 좌석을 포함해 전원 라벨을 남긴다', () => {
  const deck = deck3(
    { p1: ['2c', '3d'], p2: ['9s', '8s'], user: ['As', 'Ah'] },
    ['Ks', 'Kd', 'Kh', '7c', '6d'],
  );
  const r = checkDownToEnd(start3(5000, 50, 5000, deck));
  const p1 = r.state.seats.find((seat) => seat.playerId === 'p1');
  assert.equal(p1.stack, 0);
  assert.equal(p1.out, true);
  assert.deepEqual(r.state.lastHand.positions, { user: 'BTN', p1: 'SB', p2: 'BB' });
});

test('forceDefault는 액션 레코드에 forced를 남긴다', () => {
  const userForce = forceDefault(setup3(5000, 5000, 5000), 'user');
  const userState = userForce.state.hand ?? userForce.state.lastHand;
  assert.equal(userState.actions[0].forced, true);
  assert.equal(userState.decisions[0].forced, true);

  let opp = setup3(5000, 5000, 5000);
  opp = applyAction(opp, 'user', 'call').state;
  const forcedOpp = forceDefault(opp, 'p1');
  const oppRec = forcedOpp.state.hand.actions.at(-1);
  assert.equal(oppRec.playerId, 'p1');
  assert.equal(oppRec.forced, true);
});
