import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, startHand, blindsForLevel } from '../engine/hand.js';
import { fixedDeck } from './helpers/fixtures.js';

test('createGame은 user+p1..pN, idle, handNo 0', () => {
  const st = createGame({ aiCount: 2, names: ['앨리스', '밥'] });
  assert.equal(st.schemaVersion, 1);
  assert.equal(st.phase, 'idle');
  assert.equal(st.handNo, 0);
  assert.equal(st.level, 0);
  assert.equal(st.gameOver, false);
  assert.deepEqual(st.seats.map((s) => s.playerId), ['user', 'p1', 'p2']);
  assert.equal(st.seats[0].name, '나');
  assert.equal(st.seats[1].name, '앨리스');
  assert.equal(st.seats[2].name, '밥');
  assert.equal(st.seats[0].stack, 5000);
  assert.equal(st.seats.every((s) => s.out === false), true);
  assert.ok(st.button >= 0 && st.button < 3);
  assert.equal(st.config.levelEvery, 8);
  assert.deepEqual(st.config.blinds0, [25, 50]);
});

test('blindsForLevel 기본 스케줄과 ×1.5, blinds0 스케일', () => {
  assert.deepEqual(blindsForLevel(0), [25, 50]);
  assert.deepEqual(blindsForLevel(1), [50, 100]);
  assert.deepEqual(blindsForLevel(2), [75, 150]);
  assert.deepEqual(blindsForLevel(3), [100, 200]);
  assert.deepEqual(blindsForLevel(4), [150, 300]);
  assert.deepEqual(blindsForLevel(5), [200, 400]);
  assert.deepEqual(blindsForLevel(6), [300, 600]);
  assert.deepEqual(blindsForLevel(7), [400, 800]);
  assert.deepEqual(blindsForLevel(8), [500, 1000]);
  assert.deepEqual(blindsForLevel(9), [700, 1400]);
  assert.deepEqual(blindsForLevel(10), [1000, 2000]);
  assert.deepEqual(blindsForLevel(11), [1500, 3000]);
  assert.deepEqual(blindsForLevel(12), [2250, 4500]);
  assert.deepEqual(blindsForLevel(13), [3375, 6750]);
  assert.deepEqual(blindsForLevel(1, [50, 100]), [100, 200]);
});

test('레벨업 경계: levelEvery=8이면 9번째 핸드부터 레벨 1', () => {
  const st = createGame({ aiCount: 2, levelEvery: 8 });
  st.handNo = 8;
  st.phase = 'idle';
  const r = startHand(st, { deck: fixedDeck() });
  assert.equal(r.state.handNo, 9);
  assert.equal(r.state.level, 1);
  const posted = r.events.find((e) => e.type === 'blinds_posted');
  assert.equal(posted.bb, 100);
  const start = r.events.find((e) => e.type === 'hand_start');
  assert.equal(start.handNo, 9);
  assert.equal(start.level, 1);
  assert.deepEqual(start.blinds, [50, 100]);
  const up = r.events.find((e) => e.type === 'level_up');
  assert.equal(up.level, 1);
  assert.equal(up.sb, 50);
  assert.equal(up.bb, 100);
});

test('숏스택 블라인드는 전액 올인 포스팅', () => {
  const st = createGame({ aiCount: 2 });
  // 3인, seats [user,p1,p2], 회전 전 st.button=1 → startHand가 다음 생존 좌석 2(p2)로 이동 → SB=user(0), BB=p1(1)
  st.button = 1;
  st.seats.find((s) => s.playerId === 'p1').stack = 30;
  const r = startHand(st, { deck: fixedDeck() });
  const p1 = r.state.seats.find((s) => s.playerId === 'p1');
  assert.equal(r.state.button, 2);
  assert.equal(p1.stack, 0);
  assert.equal(r.state.hand.contribs.p1, 30);
  assert.ok(r.state.hand.allIn.includes('p1'));
  assert.equal(r.state.hand.contribs.user, 25);
  const posted = r.events.find((e) => e.type === 'blinds_posted');
  const p1Post = posted.posts.find((p) => p.playerId === 'p1');
  assert.equal(p1Post.amount, 30);
  assert.equal(p1Post.allIn, true);
});

test('헤즈업: 버튼이 SB이고 프리플랍 선행동', () => {
  const st = createGame({ aiCount: 1 });
  const r = startHand(st, { deck: fixedDeck() });
  const btnSeat = r.state.seats[r.state.button].playerId;
  assert.equal(r.state.hand.contribs[btnSeat], blindsForLevel(0)[0]);
  assert.equal(r.state.seats[r.state.hand.toActIdx].playerId, btnSeat);
});

test('탈락 좌석 건너뛰고 버튼 이동, out 좌석 미딜링', () => {
  const st = createGame({ aiCount: 2 });
  st.button = 0;
  const p2 = st.seats.find((s) => s.playerId === 'p2');
  p2.out = true;
  p2.stack = 0;
  const r = startHand(st, { deck: fixedDeck() });
  assert.equal(r.state.hand.holes.p2, undefined);
  assert.equal(r.state.hand.holes.user.length, 2);
  assert.equal(r.state.hand.holes.p1.length, 2);
  assert.equal(r.state.seats[r.state.button].playerId, 'p1');
  const [sb, bb] = blindsForLevel(0);
  assert.equal(r.state.hand.contribs.p1, sb);
  assert.equal(r.state.hand.contribs.user, bb);
  assert.equal(r.state.hand.contribs.p2, undefined);
  const posted = r.events.find((e) => e.type === 'blinds_posted');
  assert.equal(posted.posts.some((p) => p.playerId === 'p2'), false);
  const dealt = r.events.filter((e) => e.type === 'deal_hole').map((e) => e.playerId);
  assert.equal(dealt.includes('p2'), false);
  assert.deepEqual([...dealt].sort(), ['p1', 'user']);
  assert.equal(r.state.seats[r.state.hand.toActIdx].playerId, 'p1');
});

test('3인: 버튼 다음이 SB·BB, 프리플랍 선행동은 버튼', () => {
  const st = createGame({ aiCount: 2 });
  st.button = 2;
  const r = startHand(st, { deck: fixedDeck() });
  assert.equal(r.state.seats[r.state.button].playerId, 'user');
  const [sb, bb] = blindsForLevel(0);
  assert.equal(r.state.hand.contribs.p1, sb);
  assert.equal(r.state.hand.contribs.p2, bb);
  assert.equal(r.state.seats[r.state.hand.toActIdx].playerId, 'user');
});

test('gameOver 또는 user 스택 0이면 GAME_OVER', () => {
  const over = createGame({ aiCount: 1 });
  over.gameOver = true;
  const beforeOver = JSON.stringify(over);
  assert.throws(() => startHand(over, { deck: fixedDeck() }), { code: 'GAME_OVER' });
  assert.equal(JSON.stringify(over), beforeOver);

  const busted = createGame({ aiCount: 1 });
  busted.seats.find((s) => s.playerId === 'user').stack = 0;
  const beforeBusted = JSON.stringify(busted);
  assert.throws(() => startHand(busted, { deck: fixedDeck() }), { code: 'GAME_OVER' });
  assert.equal(JSON.stringify(busted), beforeBusted);
});

test('state는 JSON 왕복 가능하고 이벤트는 seq/visibility/type', () => {
  const r = startHand(createGame({ aiCount: 2 }), { deck: fixedDeck() });
  assert.deepEqual(JSON.parse(JSON.stringify(r.state)), r.state);
  assert.equal(r.state.phase, 'in_hand');
  assert.equal(r.state.hand.street, 'preflop');
  let expectedSeq = 0;
  for (const event of r.events) {
    assert.equal(event.seq, expectedSeq);
    expectedSeq += 1;
    assert.equal(typeof event.visibility, 'string');
    assert.equal(typeof event.type, 'string');
  }
  const start = r.events.find((e) => e.type === 'hand_start');
  assert.equal(start.visibility, 'public');
  assert.equal(typeof start.button, 'string');
  const holes = r.events.filter((e) => e.type === 'deal_hole');
  assert.equal(holes.length, 3);
  for (const event of holes) {
    assert.equal(event.visibility, `actor:${event.playerId}`);
    assert.equal(event.cards.length, 2);
  }
});
