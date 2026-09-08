import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, forceDefault, legalFor, startHand } from '../engine/hand.js';
import { newDeck } from '../engine/cards.js';
import { replayRecord, canonicalHandReplayJson, HAND_REPLAY_SCHEMA_VERSION } from '../shared/hand-replay.js';

function deckWith(ordered) {
  const used = new Set(ordered);
  return [...ordered, ...newDeck().filter((card) => !used.has(card))];
}

function deck3(holes, board) {
  return deckWith([
    holes.p1[0], holes.p2[0], holes.user[0],
    holes.p1[1], holes.p2[1], holes.user[1],
    ...board,
  ]);
}

function start3(config = {}) {
  const st = createGame({ aiCount: 2, ...config });
  st.button = 2;
  return startHand(st, {
    deck: deck3(
      { p1: ['As', 'Ah'], p2: ['2c', '3d'], user: ['7s', '8s'] },
      ['Ks', 'Kd', 'Kh', '9c', '6d'],
    ),
  }).state;
}

function finish(st, script) {
  let cur = st;
  for (const [pid, action, amount, opts] of script) {
    cur = applyAction(cur, pid, action, amount, opts ?? {}).state;
  }
  while (!legalFor(cur).handOver) {
    const legal = legalFor(cur);
    cur = applyAction(cur, legal.toAct, legal.canCheck ? 'check' : 'call').state;
  }
  return cur.lastHand;
}

function playRecord(config, extras = {}) {
  let st = start3(config);
  const script = [
    ['user', 'call', undefined, extras.user],
    ['p1', 'call', undefined, extras.p1],
    ['p2', 'check', undefined, extras.p2],
  ];
  return finish(st, script);
}

test('replayRecord all: 전원 holes·reasonKind 5종·note·stacks 부재·decisions 9필드·정책 키 부재', () => {
  const record = playRecord({ replayReveal: 'all' }, {
    p1: { meta: { reason: 'model-reason' } },
    p2: { policyMeta: { policyId: 'tag-v2', policyVersion: '2', sampledProbability: 0.2, reasonCode: 'open' } },
    user: { meta: { note: 'my-note' } },
  });
  let st = start3();
  st = applyAction(st, 'user', 'call').state;
  st = forceDefault(st, 'p1').state;
  while (!legalFor(st).handOver) {
    const legal = legalFor(st);
    st = applyAction(st, legal.toAct, legal.canCheck ? 'check' : 'call').state;
  }
  const forcedRecord = st.lastHand;

  const all = replayRecord(record, { reveal: 'all' });
  assert.equal(all.schemaVersion, HAND_REPLAY_SCHEMA_VERSION);
  assert.equal(all.reveal, 'all');
  assert.deepEqual(Object.keys(all.holes).sort(), ['p1', 'p2', 'user']);
  assert.equal(all.holes.p2.length, 2);
  assert.equal('stacks' in all.actions[0], false);
  assert.equal(all.actions.some((row) => 'policyId' in row), false);
  assert.equal(all.actions.some((row) => 'policyVersion' in row), false);
  assert.equal(all.actions.some((row) => 'sampledProbability' in row), false);
  assert.equal(all.actions.some((row) => 'reasonCode' in row), false);
  const userAct = all.actions.find((row) => row.playerId === 'user');
  assert.equal(userAct.note, 'my-note');
  assert.equal('reasonKind' in userAct, false);
  const p1 = all.actions.find((row) => row.playerId === 'p1');
  assert.equal(p1.reasonKind, 'model');
  assert.equal(p1.reason, 'model-reason');
  const p2 = all.actions.find((row) => row.playerId === 'p2');
  assert.equal(p2.reasonKind, 'policy');
  assert.equal('reason' in p2, false);

  const noneRow = replayRecord({
    ...record,
    actions: record.actions.map((row) => (
      row.playerId === 'p1' ? { ...row, reason: undefined } : row
    )),
  }, { reveal: 'all' }).actions.find((row) => row.playerId === 'p1');
  assert.equal(noneRow.reasonKind, 'none');

  const forced = replayRecord(forcedRecord, { reveal: 'all' });
  const forcedAct = forced.actions.find((row) => row.playerId === 'p1');
  assert.equal(forcedAct.forced, true);
  assert.equal(forcedAct.reasonKind, 'forced');

  assert.ok(Array.isArray(all.decisions));
  assert.ok(all.decisions.length >= 1);
  for (const snap of all.decisions) {
    assert.deepEqual(Object.keys(snap).sort(), [
      'chosenAction', 'decisionId', 'effectiveStack', 'forced', 'holeCards',
      'position', 'potBefore', 'street', 'toCall',
    ].sort());
  }
  assert.ok(all.positions);
});

test('replayRecord showdown: holes ⊆ user∪reveals, 비공개 reason 제거, hidden', () => {
  const record = playRecord({ showdownPolicy: 'standard', replayReveal: 'showdown' }, {
    p2: { meta: { reason: 'secret-cards' } },
  });
  const shown = replayRecord(record, { reveal: 'showdown' });
  const allowed = new Set(['user', ...(record.showdown?.reveals ?? []).map((row) => row.playerId)]);
  for (const pid of Object.keys(shown.holes)) assert.ok(allowed.has(pid), pid);
  assert.equal(shown.holes.p2, undefined);
  const hidden = shown.actions.find((row) => row.playerId === 'p2');
  assert.equal(hidden.reasonKind, 'hidden');
  assert.equal('reason' in hidden, false);
  assert.equal(JSON.stringify(shown).includes('secret-cards'), false);
});

test('replayRecord open+showdown 조합과 legacy positions 부재', () => {
  const record = playRecord({ showdownPolicy: 'open', replayReveal: 'showdown' });
  const shown = replayRecord(record, { reveal: 'showdown' });
  assert.ok(shown.holes.p1);
  assert.ok(shown.holes.p2);
  const { positions, ...legacy } = record;
  assert.ok(positions);
  const replayed = replayRecord(legacy, { reveal: 'all' });
  assert.equal('positions' in replayed, false);
  assert.deepEqual(Object.keys(replayed.holes).sort(), ['p1', 'p2', 'user']);
});

test('canonicalHandReplayJson 키 순서 무관 동일성', () => {
  const record = playRecord({ replayReveal: 'all' });
  const a = replayRecord(record, { reveal: 'all' });
  const b = { reveal: a.reveal, schemaVersion: a.schemaVersion, handNo: a.handNo };
  for (const key of Object.keys(a)) {
    if (!(key in b)) b[key] = a[key];
  }
  assert.equal(canonicalHandReplayJson(a), canonicalHandReplayJson(b));
});
