import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createProjector, createFactsProvider, OWN_BANNER, POLICY_LEGEND } from '../server/public/replay-perspective.js';
import { createReplayController, ownCap } from '../server/public/replay-controller.js';
import { cardLabel, parseCard } from '../server/public/card-render.js';
import { formatReplay } from '../server/public/replay-format.js';
import { playHand, prepare, passive, shove } from './helpers/replay-p3-fixtures.js';

const fmt = { amount: (value) => `${value}칩`, short: (value) => `${value}` };
const NAMES = { user: '나', p1: '철수', p2: '영희' };

function projectors(prepared, { names = NAMES, facts } = {}) {
  const common = { ...prepared, viewer: 'user', name: (playerId) => names[playerId] ?? playerId, facts };
  return { own: createProjector({ perspective: 'own', ...common }), full: createProjector({ perspective: 'full', ...common }) };
}

// The frame schema: every key a renderer may receive, at every depth.
const FRAME_KEYS = ['controls', 'cursor', 'details', 'headline', 'holes', 'kind', 'pot', 'seats', 'summary', 'timeline', 'board', 'street'];
const SEAT_KEYS = ['actor', 'allIn', 'bet', 'folded', 'stack', 'tag', 'winner'];
const ITEM_KEYS = ['cards', 'key', 'kind', 'parts', 'study'];
const CONTROL_KEYS = ['last', 'limit', 'progress', 'streets'];
const STREET_KEYS = ['current', 'index', 'key', 'label'];
const DETAIL_KEYS = ['className', 'study', 'text'];
const closed = (object, allowed, where) => {
  for (const key of Object.keys(object)) assert.ok(allowed.includes(key), `${where}: unexpected key ${key}`);
};
function assertClosedFrame(frame, where) {
  closed(frame, FRAME_KEYS, where);
  for (const seat of Object.values(frame.seats)) closed(seat, SEAT_KEYS, `${where} seat`);
  for (const item of frame.timeline) closed(item, ITEM_KEYS, `${where} item`);
  closed(frame.controls, CONTROL_KEYS, `${where} controls`);
  for (const street of frame.controls.streets) closed(street, STREET_KEYS, `${where} street`);
  for (const detail of frame.details) closed(detail, DETAIL_KEYS, `${where} detail`);
}
const labels = (codes) => codes.map((code) => cardLabel(parseCard(code)));

const HANDS = () => ({
  checkedDown: playHand({ aiCount: 2, button: 0 }),
  fold: playHand({ aiCount: 2, pick: (legal, turn) => (turn < 2 ? ['fold'] : passive(legal)) }),
  allIn: playHand({ aiCount: 2, pick: shove }),
  sidePot: playHand({ aiCount: 2, stacks: [300, 600, 1000], pick: shove }),
  blindsAllIn: playHand({ aiCount: 1, stacks: [20, 20], pick: () => { throw new Error('no decision expected'); } }),
});

test('own projection at every cursor of every hand: closed schema, nothing from the future, the result or the opponents', () => {
  for (const [name, record] of Object.entries(HANDS())) {
    // 'all' reveal: the replay itself carries every hole card and the hand names.
    // The names are unique canaries (a real name like "플러시" is also what a
    // fact card may say about the viewer's own, already public, made hand).
    for (const reveal of record.showdown?.reveals ?? []) reveal.handName = `CANARY_HAND_${reveal.playerId}`;
    const prepared = prepare(record, { reveal: 'all', names: NAMES });
    assert.equal(prepared.model.ok, true, `${name}: ${prepared.model.reason}`);
    const { own } = projectors(prepared);
    const cap = ownCap(prepared.model.steps);
    assert.equal(own.cap, cap, name);
    const opponents = Object.entries(prepared.replay.holes).filter(([playerId]) => playerId !== 'user');
    assert.ok(opponents.length >= 1, `${name}: the replay does carry opponent cards`);
    const handNames = (prepared.replay.showdown?.reveals ?? []).map((row) => row.handName).filter(Boolean);
    assert.equal(handNames.length > 0, record.showdown != null, `${name}: the canary hand names are in the replay`);
    for (let cursor = 0; cursor <= cap; cursor += 1) {
      const frame = own.at(cursor, fmt);
      const where = `${name}@${cursor}`;
      assertClosedFrame(frame, where);
      assert.equal(frame.cursor, cursor);
      const text = JSON.stringify(frame);
      // Opponent hole cards: neither as codes nor as readable labels.
      for (const [playerId, cards] of opponents) {
        for (const code of cards) assert.equal(text.includes(`"${code}"`), false, `${where}: ${playerId} ${code}`);
        for (const label of labels(cards)) assert.equal(text.includes(label), false, `${where}: ${playerId} ${label}`);
      }
      assert.deepEqual(Object.keys(frame.holes).filter((playerId) => playerId !== 'user'), [], `${where}: only the viewer's cards`);
      // The board is the board reached at this step, not the final one.
      const reached = prepared.model.steps[cursor].board;
      assert.deepEqual(frame.board, reached, where);
      for (const code of prepared.replay.board.slice(reached.length)) {
        assert.equal(text.includes(`"${code}"`), false, `${where}: future board ${code}`);
        assert.equal(text.includes(labels([code])[0]), false, `${where}: future board label ${code}`);
      }
      // Result vocabulary: showdown, winners, awards, hand names, pot shares.
      for (const word of ['쇼다운', '승리', '승자', '획득', '메인 팟', '사이드 팟', '결과', ...handNames]) {
        assert.equal(text.includes(word), false, `${where}: "${word}"`);
      }
      assert.equal(frame.timeline.length, cursor + 1, `${where}: the timeline stops at the cursor`);
      assert.equal(frame.timeline.every((item) => item.kind !== 'showdown' && item.kind !== 'result'), true, where);
      assert.equal(frame.controls.streets.every((street) => street.index <= cursor && street.key !== 'result'), true, where);
      assert.equal(frame.controls.last, false, `${where}: no jump-to-end`);
      assert.equal(frame.controls.limit, undefined, `${where}: no length`);
      assert.match(frame.controls.progress, /^단계 \d+$/, where);
      assert.equal(text.includes('/ '), false, `${where}: no denominator`);
    }
    // Asking past the cap never shows more than the cap.
    assert.deepEqual(own.at(cap + 50, fmt), own.at(cap, fmt), `${name}: clamped to the cap`);
    // Positive control: what is already public stays: the viewer's own cards and the current seats.
    const first = own.at(0, fmt);
    assert.deepEqual(first.holes.user, prepared.replay.holes.user, `${name}: own cards are shown`);
    assert.equal(Object.keys(first.seats).length, prepared.model.seats.length);
    assert.ok(first.pot.length > 0);
  }
});

test('full projection keeps the live replay: all steps, results, revealed cards, policy legend', () => {
  const record = playHand({ aiCount: 2, button: 0 });
  const prepared = prepare(record, { reveal: 'all', names: NAMES });
  const { full } = projectors(prepared);
  const last = prepared.model.steps.length - 1;
  const frame = full.at(last, fmt);
  assertClosedFrame(frame, 'full');
  assert.equal(frame.timeline.length, last + 1);
  assert.equal(frame.kind, 'result');
  assert.equal(frame.headline, '결과');
  assert.equal(frame.controls.last, true);
  assert.equal(frame.controls.limit, last);
  assert.equal(frame.controls.progress, `${last + 1} / ${last + 1}`);
  assert.deepEqual(Object.keys(frame.holes).sort(), Object.keys(prepared.replay.holes).sort());
  assert.ok(frame.summary.some((line) => line.includes('승리')));
  assert.ok(frame.details.some((detail) => /획득/.test(detail.text ?? '')));
  assert.equal(frame.controls.streets.at(-1).key, 'result');
});

test('same public prefix, different future: the own frames, controls and accessible text are identical before the divergence', () => {
  // Identical deal and play until the user's flop decision; then the user
  // calls on, or folds (so no later user decision exists in the second hand).
  const lineFor = (finish) => (legal, turn, state) => {
    const street = state.hand.street;
    if (street === 'flop' && legal.toAct === 'user') return finish;
    return passive(legal);
  };
  const a = prepare(playHand({ aiCount: 2, button: 0, seed: 21, pick: lineFor(['check']) }), { names: NAMES });
  const b = prepare(playHand({ aiCount: 2, button: 0, seed: 21, pick: (legal, turn, state) => (state.hand.street === 'flop' && legal.toAct === 'user' ? (legal.canCheck ? ['check'] : ['fold']) : state.hand.street === 'turn' ? (legal.canRaise && legal.toAct !== 'user' ? ['raise', legal.minRaiseTo] : legal.canCheck ? ['check'] : ['fold']) : passive(legal)) }), { names: NAMES });
  const stepsA = a.model.steps;
  const stepsB = b.model.steps;
  const diverge = stepsA.findIndex((step, at) => JSON.stringify(step) !== JSON.stringify(stepsB[at]));
  assert.ok(diverge > 3, `fixture: the hands share a prefix (diverge at ${diverge})`);
  assert.notEqual(stepsA.length, stepsB.length, 'fixture: the futures differ in length');
  const pa = projectors(a).own;
  const pb = projectors(b).own;
  for (let cursor = 0; cursor < diverge; cursor += 1) {
    assert.deepEqual(pa.at(cursor, fmt), pb.at(cursor, fmt), `cursor ${cursor}`);
    const ca = createReplayController({ steps: stepsA, perspective: 'own', step: cursor });
    const cb = createReplayController({ steps: stepsB, perspective: 'own', step: cursor });
    assert.deepEqual(ca.controls(), cb.controls(), `controls at ${cursor}`);
  }
});

test('the next-decision button does not say whether the user has a decision left', () => {
  const preflopUser = (move) => (legal, turn, state) => (state.hand.street === 'preflop' && legal.toAct === 'user' ? move : passive(legal));
  const withMore = prepare(playHand({ aiCount: 1, button: 1, seed: 5, pick: preflopUser(['call']) }));
  const without = prepare(playHand({ aiCount: 1, button: 1, seed: 5, pick: preflopUser(['fold']) }));
  const userSteps = (model) => model.steps.filter((step) => step.actor === 'user').length;
  assert.ok(userSteps(withMore.model) > userSteps(without.model), 'fixture: only the first hand has later user decisions');
  const cursor = withMore.model.steps.find((step) => step.actor === 'user').index - 1;
  assert.equal(cursor, without.model.steps.find((step) => step.actor === 'user').index - 1);
  const ca = createReplayController({ steps: withMore.model.steps, perspective: 'own', step: cursor });
  const cb = createReplayController({ steps: without.model.steps, perspective: 'own', step: cursor });
  assert.deepEqual(ca.controls(), cb.controls());
  assert.equal(ca.controls().canNextDecision, true);
  assert.deepEqual(projectors(withMore).own.at(cursor, fmt), projectors(without).own.at(cursor, fmt));
  // Pressing it is where the two hands part: one finds a decision, the other the cap.
  cb.nextDecision();
  assert.equal(cb.state().step, ownCap(without.model.steps));
  assert.equal(cb.state().notice, 'no-more-decisions');
  ca.nextDecision();
  assert.ok(ca.state().step > cursor);
  assert.equal(ca.state().notice, null);
});

test('a future policy-AI action changes nothing in the own frames but shows up in the full replay', () => {
  const record = playHand({ aiCount: 2, button: 0, seed: 9 });
  const plain = prepare(record, { names: NAMES });
  const turnAt = plain.replay.actions.findIndex((action) => action.street === 'turn' && action.playerId !== 'user');
  assert.ok(turnAt > 0);
  const stepIndex = plain.model.steps.find((step) => step.actionIndex === turnAt).index;
  const marked = structuredClone(plain.replay);
  marked.actions[turnAt].reasonKind = 'policy';
  const policy = { ...plain, replay: marked, view: formatReplay(marked, { names: NAMES, feedback: 'omit' }) };
  const before = projectors(plain);
  const after = projectors(policy);
  for (let cursor = 0; cursor < stepIndex; cursor += 1) {
    assert.deepEqual(after.own.at(cursor, fmt), before.own.at(cursor, fmt), `own @${cursor}`);
  }
  const cap = ownCap(plain.model.steps);
  for (let cursor = 0; cursor <= cap; cursor += 1) {
    assert.equal(JSON.stringify(after.own.at(cursor, fmt)).includes('정책'), false, `own @${cursor} never names a policy player`);
  }
  assert.equal(before.full.layout.legend, null);
  assert.equal(after.full.layout.legend, POLICY_LEGEND);
  assert.ok(JSON.stringify(after.full.at(stepIndex, fmt)).includes('정책 결정'));
  assert.equal(after.own.layout.legend, null);
});

test('reasons, memos and fact cards: hidden right before the action, shown once it is made; opponents\' reasons never in the own view', () => {
  const record = playHand({ aiCount: 2, button: 0, seed: 3 });
  const base = prepare(record, { names: NAMES });
  const replay = structuredClone(base.replay);
  const mine = replay.actions.findIndex((action) => action.playerId === 'user' && action.street === 'flop');
  const theirs = replay.actions.findIndex((action) => action.playerId !== 'user' && action.street === 'flop');
  assert.ok(mine >= 0 && theirs >= 0);
  replay.actions[mine].note = 'MY_PLAN_CANARY';
  replay.actions[theirs].reasonKind = 'model';
  replay.actions[theirs].reason = 'THEIR_REASON_CANARY';
  const view = formatReplay(replay, { names: NAMES, feedback: 'omit' });
  const prepared = { ...base, replay, view };
  const asked = [];
  const facts = (index) => { asked.push(index); return `FACT-${index}`; };
  const { own, full } = projectors(prepared, { facts });
  const mineStep = base.model.steps.find((step) => step.actionIndex === mine).index;
  const theirStep = base.model.steps.find((step) => step.actionIndex === theirs).index;
  const text = (frame) => JSON.stringify(frame);
  // Right before the action: no memo, no fact line.
  const before = own.at(mineStep - 1, fmt);
  assert.equal(text(before).includes('MY_PLAN_CANARY'), false);
  assert.equal(text(before).includes('FACT-'), false);
  assert.ok(asked.every((index) => index <= mineStep - 1), `facts asked only for the past: ${asked}`);
  // On the action: the memo and the fact card for that decision.
  const at = own.at(mineStep, fmt);
  assert.ok(at.details.some((detail) => detail.text === '내 메모: MY_PLAN_CANARY'));
  assert.ok(at.details.some((detail) => detail.text === `사실 카드(엔진 계산) · FACT-${mineStep}`));
  // Afterwards the current step is another one: the memo is not repeated outside its step.
  assert.equal(text(own.at(mineStep + 1, fmt)).includes('MY_PLAN_CANARY'), false);
  // An opponent's stated reason is for the full replay only.
  for (let cursor = 0; cursor <= ownCap(base.model.steps); cursor += 1) {
    assert.equal(text(own.at(cursor, fmt)).includes('THEIR_REASON_CANARY'), false, `own @${cursor}`);
  }
  assert.ok(full.at(theirStep, fmt).details.some((detail) => (detail.text ?? '').includes('THEIR_REASON_CANARY')));
  // The same decision gets the same fact line in both perspectives.
  const lineOf = (frame) => frame.details.find((detail) => (detail.text ?? '').startsWith('사실 카드'))?.text;
  assert.equal(lineOf(own.at(mineStep, fmt)), lineOf(full.at(mineStep, fmt)));
});

test('feedback omitted: neither perspective shows a coach wait line or a study card', () => {
  const prepared = prepare(playHand({ aiCount: 2, button: 0 }), { names: NAMES, feedback: 'omit' });
  const { own, full } = projectors(prepared);
  for (const [name, projector, upTo] of [['own', own, ownCap(prepared.model.steps)], ['full', full, prepared.model.steps.length - 1]]) {
    for (let cursor = 0; cursor <= upTo; cursor += 1) {
      const text = JSON.stringify(projector.at(cursor, fmt));
      assert.equal(/코치|학습 카드|왜:|대안:/.test(text), false, `${name}@${cursor}`);
    }
  }
});

test('a hand the viewer sat out: no cards, no fact card, the layout starts at the first real seat', () => {
  const record = playHand({
    aiCount: 1, participants: [{ playerId: 'h1', name: '민준', participantId: 'part-1' }], hostOut: true, button: 0,
  });
  const names = { user: '나', h1: '민준', p1: 'p1' };
  const prepared = prepare(record, { humanIds: ['user', 'h1'], names });
  assert.equal(prepared.model.ok, true, prepared.model.reason);
  const { own } = projectors(prepared, { names });
  assert.equal(own.header.absent, true);
  assert.deepEqual(own.layout.seats.map((seat) => seat.playerId), prepared.model.seats);
  for (let cursor = 0; cursor <= own.cap; cursor += 1) {
    const frame = own.at(cursor, fmt);
    assert.deepEqual(frame.holes, {});
    assert.equal(JSON.stringify(frame).includes('사실 카드'), false);
    assert.equal(Object.keys(frame.seats).includes('user'), false, 'no synthetic seat for the host');
  }
});

test('own header carries only the hand number, blinds and the own-view line; the full header adds winners and the disclosure', () => {
  const prepared = prepare(playHand({ aiCount: 2, button: 0 }), { names: NAMES });
  const { own, full } = projectors(prepared);
  closed(own.header, ['absent', 'banner', 'blinds', 'handNo', 'kind'], 'own header');
  assert.equal(own.header.banner, OWN_BANNER);
  assert.match(OWN_BANNER, /내 시점/);
  assert.match(OWN_BANNER, /결과와 상대 패를 가리고/);
  assert.equal(own.header.handNo, prepared.replay.handNo);
  assert.deepEqual(own.header.blinds, prepared.replay.blinds);
  assert.equal(JSON.stringify(own.header).includes('승자'), false);
  assert.equal(full.header.kind, 'full');
  assert.ok(Array.isArray(full.header.winners) && full.header.winners.length >= 1);
  assert.match(full.header.disclaimer, /복기 공개/);
});

test('facts provider: computed once per step and only for the viewer\'s own actions', () => {
  const prepared = prepare(playHand({ aiCount: 2, button: 0 }), { names: NAMES });
  const facts = createFactsProvider(prepared.model, prepared.replay, 'user');
  const mineStep = prepared.model.steps.find((step) => step.actor === 'user').index;
  const first = facts(mineStep);
  assert.equal(typeof first, 'string');
  assert.equal(facts(mineStep), first);
  const other = prepared.model.steps.find((step) => step.kind === 'action' && step.actor !== 'user').index;
  assert.equal(facts(other), null);
});

test('the renderer cannot reach the raw replay: no replay/model/facts calls in replayer.js, and it draws from a projector alone', async () => {
  const source = fs.readFileSync(new URL('../server/public/replayer.js', import.meta.url), 'utf8');
  for (const forbidden of ['replayFactsLine', 'replay-facts', 'buildReplaySteps', 'ctx.replay', 'ctx.model', 'ctx.view', 'replayDecisionSnapshot']) {
    assert.equal(source.includes(forbidden), false, `replayer.js mentions ${forbidden}`);
  }
});

test('another seat as the viewer: the host\'s memo and fact card stay out of their own view, and only their cards show', () => {
  const record = playHand({ aiCount: 2, button: 0, seed: 3 });
  const base = prepare(record, { names: NAMES });
  const replay = structuredClone(base.replay);
  const mine = replay.actions.findIndex((action) => action.playerId === 'user');
  replay.actions[mine].note = 'HOST_MEMO_CANARY';
  const view = formatReplay(replay, { names: NAMES, feedback: 'omit' });
  const common = { replay, model: base.model, view, viewer: 'p1', name: (id) => NAMES[id] ?? id };
  const own = createProjector({ perspective: 'own', ...common });
  const hostStep = base.model.steps.find((step) => step.actionIndex === mine).index;
  for (let cursor = 0; cursor <= own.cap; cursor += 1) {
    const frame = own.at(cursor, fmt);
    assert.equal(JSON.stringify(frame).includes('HOST_MEMO_CANARY'), false, `@${cursor}`);
    assert.deepEqual(Object.keys(frame.holes), ['p1']);
  }
  assert.ok(own.cap >= hostStep);
});

test('live full replay preserves arithmetic fact cards on recorded forced actions', () => {
  const record=playHand({aiCount:2,button:0});
  const action=record.actions.find(row=>row.playerId==='user');assert.ok(action);action.forced=true;
  const prepared=prepare(record),step=prepared.model.steps.find(row=>row.kind==='action'&&row.actor==='user');
  const fact=createFactsProvider(prepared.model,prepared.replay,'user')(step.index);assert.ok(fact);
  const live=createProjector({...prepared,perspective:'full',viewer:'user'}).at(step.index,fmt);
  assert.ok(live.details.some(row=>row.className==='replay-facts'&&row.text.includes(fact)));
  const library=createProjector({...prepared,perspective:'full',viewer:'user',forcedFacts:false}).at(step.index,fmt);
  assert.equal(library.details.some(row=>row.className==='replay-facts'),false);
});

test('raw forced flags never disclose hidden opponent reasons in full replay', () => {
  const record=playHand({aiCount:2,button:0}),prepared=prepare(record),replay=structuredClone(prepared.replay);
  const opponent=replay.actions.findIndex(row=>row.playerId!=='user');assert.ok(opponent>=0);
  replay.actions[opponent].forced=true;replay.actions[opponent].reasonKind='hidden';
  const view=formatReplay(replay,{names:NAMES}),projector=createProjector({...prepared,replay,view,perspective:'full'});
  const step=prepared.model.steps.find(row=>row.actionIndex===opponent);
  const frame=projector.at(step.index,fmt);
  assert.equal(JSON.stringify(frame).includes('강제 액션(기록)'),false);
  replay.actions[opponent].reasonKind='forced';
  const publicView=formatReplay(replay,{names:NAMES}),publicFrame=createProjector({...prepared,replay,view:publicView,perspective:'full'}).at(step.index,fmt);
  assert.ok(JSON.stringify(publicFrame).includes('강제'));
});
