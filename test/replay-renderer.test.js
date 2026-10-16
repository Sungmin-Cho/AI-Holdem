import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountReplayer } from '../server/public/replayer.js';
import { createProjector, createFactsProvider } from '../server/public/replay-perspective.js';
import { createReplayController, ownCap, NO_MORE_DECISIONS } from '../server/public/replay-controller.js';
import { cardLabel, parseCard } from '../server/public/card-render.js';
import { createMiniDocument, exposedText } from './helpers/mini-dom.js';
import { formatReplay } from '../server/public/replay-format.js';
import { playHand, prepare, passive, shove, createFakeClock } from './helpers/replay-p3-fixtures.js';

const NAMES = { user: '나', p1: '철수', p2: '영희' };
const labels = (codes) => codes.map((code) => cardLabel(parseCard(code)));

/** A structural dump of a subtree: tags, classes, attributes, flags and text. */
function dump(node) {
  if (node.isText) return JSON.stringify(node.text);
  const attributes = [...node.attributes.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `<${node.localName} class="${node.className}" ${JSON.stringify(attributes)} d=${node.disabled} h=${node.hidden} f=${node.dataset?.focusKey ?? ''}>${node.children.map(dump).join('')}</>`;
}

function harness(record, { perspective = 'own', names = NAMES, reveal = 'all', feedback = 'omit', humanIds, unit = (v) => `${v}칩` } = {}) {
  const doc = createMiniDocument();
  const container = doc.createElement('div');
  doc.body.append(container);
  const fallbackButton = doc.createElement('button');
  fallbackButton.dataset.focusKey = 'persp-full';
  doc.body.append(fallbackButton);
  const prepared = prepare(record, { reveal, names, feedback, humanIds });
  assert.equal(prepared.model.ok, true, prepared.model.reason);
  const facts = createFactsProvider(prepared.model, prepared.replay, 'user');
  const common = { ...prepared, viewer: 'user', name: (id) => names[id] ?? id, facts };
  const projectors = { own: createProjector({ perspective: 'own', ...common }), full: createProjector({ perspective: 'full', ...common }) };
  const clock = createFakeClock();
  let handle;
  const controller = createReplayController({
    steps: prepared.model.steps, viewer: 'user', perspective, clock, autoPause: 'own-decision', onChange: () => handle.paint(),
  });
  const format = { amount: unit };
  const raw = {
    projector: projectors[perspective],
    amount: (value) => format.amount(value),
    short: (value) => `${value}`,
    state: () => ({ ...controller.state(), controls: controller.controls(), notice: controller.state().notice === NO_MORE_DECISIONS ? '더 이동할 내 결정이 없습니다' : null }),
    onStep: (index) => controller.setStep(index),
    onPlay: () => controller.togglePlay(),
    onSpeed: (rate) => controller.setSpeed(rate),
    onPrevDecision: () => controller.prevDecision(),
    onNextDecision: () => controller.nextDecision(),
    onStudy() {},
    focusFallback: () => fallbackButton,
  };
  handle = mountReplayer(container, raw);
  return { doc, container, handle, controller, prepared, projectors, clock, format, fallbackButton, ctx: raw };
}
const find = (container, selector) => container.querySelector(selector);
const q = find;
const buttonsOf = (container) => [...container.querySelectorAll('button')];
const keyed = (container) => new Map(buttonsOf(container).map((node) => [node.dataset.focusKey, node]));

test('own perspective DOM: no jump-to-end, no denominator, no future rows, no unreached street buttons — at every cursor', () => {
  const h = harness(playHand({ aiCount: 2, button: 0 }));
  const cap = ownCap(h.prepared.model.steps);
  for (let cursor = 0; cursor <= cap; cursor += 1) {
    h.controller.setStep(cursor);
    assert.equal(find(h.container, '.replayer-last'), null, `last @${cursor}`);
    assert.equal(find(h.container, '.replayer-progress').textContent, `단계 ${cursor + 1}`);
    assert.equal(h.container.querySelectorAll('.replayer-item').length, cursor + 1, `rows @${cursor}`);
    const reached = h.prepared.model.steps.filter((step) => step.index <= cursor).map((step) => (step.kind === 'result' || step.kind === 'showdown' ? 'result' : step.street));
    const streets = [...h.container.querySelectorAll('.replayer-street')].map((node) => node.dataset.step);
    assert.equal(streets.every((index) => Number(index) <= cursor), true, `street buttons @${cursor}`);
    assert.ok(streets.length >= 1 && streets.length <= new Set(reached).size);
    const text = exposedText(h.container);
    assert.equal(text.includes('/ '), false);
    assert.equal(/결과|쇼다운|승리|획득/.test(text), false, `result words @${cursor}`);
  }
});

test('own perspective DOM never exposes opponent cards, the final board or hand names; opponents sit face down', () => {
  const hands = [
    playHand({ aiCount: 2, button: 0 }),
    playHand({ aiCount: 2, pick: shove }),
    playHand({ aiCount: 2, stacks: [300, 600, 1000], pick: shove }),
    playHand({ aiCount: 1, stacks: [20, 20], pick: () => { throw new Error('none'); } }),
  ];
  for (const [at, record] of hands.entries()) {
    for (const reveal of record.showdown?.reveals ?? []) reveal.handName = `CANARY_HAND_${reveal.playerId}`;
    const h = harness(record);
    const { replay } = h.prepared;
    const opponents = Object.entries(replay.holes).filter(([playerId]) => playerId !== 'user');
    const cap = ownCap(h.prepared.model.steps);
    for (let cursor = 0; cursor <= cap; cursor += 1) {
      h.controller.setStep(cursor);
      const text = exposedText(h.container);
      const dom = dump(h.container);
      const reached = h.prepared.model.steps[cursor].board;
      for (const [playerId, cards] of opponents) {
        for (const label of labels(cards)) assert.equal(text.includes(label), false, `hand ${at} @${cursor}: ${playerId} ${label}`);
      }
      for (const label of labels(replay.board.slice(reached.length))) assert.equal(text.includes(label), false, `hand ${at} @${cursor}: future board ${label}`);
      assert.equal(dom.includes('CANARY_HAND_'), false);
      for (const [playerId] of opponents) {
        const seat = [...h.container.querySelectorAll('.replayer-seat')].find((node) => node.dataset.playerId === playerId);
        assert.equal(seat.querySelectorAll('.card--back').length, 2, `hand ${at} @${cursor}: ${playerId} face down`);
      }
      const mine = [...h.container.querySelectorAll('.replayer-seat')].find((node) => node.dataset.playerId === 'user');
      assert.equal(mine.querySelectorAll('.card--back').length, 0, 'the viewer sees their own cards');
      for (const label of labels(replay.holes.user)) assert.ok(text.includes(label), `own card ${label} shown`);
    }
  }
});

test('same public prefix, different future: the own DOM is identical node for node, including disabled states', () => {
  const pick = (finish) => (legal, turn, state) => (state.hand.street === 'flop' && legal.toAct === 'user' ? finish(legal) : passive(legal));
  const a = harness(playHand({ aiCount: 2, button: 0, seed: 21, pick: pick(() => ['check']) }));
  const b = harness(playHand({
    aiCount: 2, button: 0, seed: 21,
    pick: (legal, turn, state) => (state.hand.street === 'flop' && legal.toAct === 'user' ? ['fold'] : passive(legal)),
  }));
  const stepsA = a.prepared.model.steps;
  const stepsB = b.prepared.model.steps;
  const diverge = stepsA.findIndex((step, at) => JSON.stringify(step) !== JSON.stringify(stepsB[at]));
  assert.ok(diverge > 3);
  assert.notEqual(stepsA.length, stepsB.length);
  for (let cursor = 0; cursor < diverge; cursor += 1) {
    a.controller.setStep(cursor);
    b.controller.setStep(cursor);
    assert.equal(dump(a.container), dump(b.container), `DOM @${cursor}`);
    assert.equal(exposedText(a.container), exposedText(b.container), `a11y text @${cursor}`);
  }
});

test('one mounted table: stepping never remounts the felt, seats, timeline or controls, and rows are keyed by step', () => {
  const h = harness(playHand({ aiCount: 2, button: 0 }));
  const root = h.handle.root;
  const felt = find(h.container, '.replayer-felt');
  const seats = [...h.container.querySelectorAll('.replayer-seat')];
  const timeline = find(h.container, '.replayer-timeline');
  const controls = find(h.container, '.replayer-controls');
  const firstRow = find(h.container, '.replayer-item');
  const cap = ownCap(h.prepared.model.steps);
  const rowsByStep = new Map();
  for (let cursor = 0; cursor <= cap; cursor += 1) {
    h.controller.setStep(cursor);
    assert.equal(find(h.container, '.replayer'), root);
    assert.equal(find(h.container, '.replayer-felt'), felt);
    assert.equal(find(h.container, '.replayer-timeline'), timeline);
    assert.equal(find(h.container, '.replayer-controls'), controls);
    assert.equal(find(h.container, '.replayer-item'), firstRow);
    [...h.container.querySelectorAll('.replayer-seat')].forEach((node, at) => assert.equal(node, seats[at]));
    for (const jump of h.container.querySelectorAll('.replayer-jump')) {
      const known = rowsByStep.get(jump.dataset.step);
      if (known) assert.equal(jump, known, `row ${jump.dataset.step} is reused`);
      rowsByStep.set(jump.dataset.step, jump);
    }
  }
  // Going back drops the rows after the cursor; coming forward gets the same row nodes back? No: new ones.
  h.controller.setStep(2);
  assert.equal(h.container.querySelectorAll('.replayer-item').length, 3);
  assert.equal(find(h.container, '.replayer-item'), firstRow);
});

test('a unit change repaints text in place without rebuilding anything', () => {
  const h = harness(playHand({ aiCount: 2, button: 0 }));
  h.controller.setStep(4);
  const before = dump(h.container);
  const bet = [...h.container.querySelectorAll('.replay-amount')][0];
  const rowNode = find(h.container, '.replayer-item');
  h.format.amount = (value) => `${value / 100}BB`;
  h.handle.paint();
  assert.notEqual(dump(h.container), before);
  assert.match([...h.container.querySelectorAll('.replay-amount')][0].textContent, /BB$/);
  assert.equal(find(h.container, '.replayer-item'), rowNode);
  assert.ok(bet, 'fixture: a row with an amount exists');
});

test('focus: a removed timeline row hands focus to Play; when Play is disabled at the cap, to the supplied fallback', () => {
  const h = harness(playHand({ aiCount: 2, button: 0 }));
  h.controller.setStep(6);
  const row = keyed(h.container).get('jump-6');
  row.focus();
  h.controller.setStep(2);
  assert.equal(keyed(h.container).get('jump-6'), undefined, 'the row is gone');
  assert.ok(h.container.contains(h.doc.activeElement));
  assert.ok(h.doc.activeElement.classList.contains('replayer-play'), 'focus moved to Play');
  // At the cap: focus on Next, which becomes disabled, and Play is disabled too.
  const cap = ownCap(h.prepared.model.steps);
  h.controller.setStep(cap - 1);
  keyed(h.container).get('ctl-next').focus();
  h.controller.setStep(cap);
  assert.equal(find(h.container, '.replayer-play').disabled, true);
  assert.equal(h.doc.activeElement, h.fallbackButton, 'the full-replay button takes focus');
});

test('timeline scroll position survives repaints', () => {
  const h = harness(playHand({ aiCount: 2, button: 0 }));
  const timeline = find(h.container, '.replayer-timeline');
  h.controller.setStep(3);
  timeline.scrollTop = 37;
  h.controller.setStep(4);
  h.handle.paint();
  assert.equal(timeline.scrollTop, 37);
});

test('own-decision buttons follow the controller; the cap notice is a polite status line', () => {
  const h = harness(playHand({ aiCount: 2, button: 0 }));
  const prev = find(h.container, '.replayer-prev-decision');
  const next = find(h.container, '.replayer-next-decision');
  assert.ok(prev && next);
  assert.equal(prev.disabled, true);
  assert.equal(next.disabled, false);
  next.click();
  const firstDecision = h.controller.state().step;
  assert.ok(firstDecision > 0);
  assert.equal(prev.disabled, true, 'nothing earlier than the first decision');
  next.click();
  assert.ok(h.controller.state().step > firstDecision);
  assert.equal(prev.disabled, false);
  prev.click();
  assert.equal(h.controller.state().step, firstDecision);
  const notice = find(h.container, '.replayer-notice');
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.textContent, '');
  const cap = ownCap(h.prepared.model.steps);
  h.controller.setStep(cap - 1);
  // Jump past the last decision.
  const last = h.prepared.model.steps.filter((step) => step.actor === 'user').at(-1).index - 1;
  h.controller.setStep(last);
  next.click();
  assert.equal(h.controller.state().step, cap);
  assert.equal(notice.textContent, '더 이동할 내 결정이 없습니다');
  assert.equal(next.disabled, true);
});

test('perspective switch repaints the same table: opponent cards and the rest of the hand appear, and back again', () => {
  const h = harness(playHand({ aiCount: 2, button: 0 }));
  const seats = [...h.container.querySelectorAll('.replayer-seat')];
  const timeline = find(h.container, '.replayer-timeline');
  const cap = ownCap(h.prepared.model.steps);
  h.controller.setStep(cap);
  h.controller.setPerspective('full');
  h.handle.setProjector(h.projectors.full);
  assert.equal(find(h.container, '.replayer-timeline'), timeline);
  [...h.container.querySelectorAll('.replayer-seat')].forEach((node, at) => assert.equal(node, seats[at]));
  assert.equal(h.controller.state().step, cap);
  assert.ok(find(h.container, '.replayer-last'));
  assert.equal(h.container.querySelectorAll('.replayer-item').length, h.prepared.model.steps.length);
  const opponent = [...h.container.querySelectorAll('.replayer-seat')].find((node) => node.dataset.playerId === 'p1');
  assert.equal(opponent.querySelectorAll('.card--back').length, 0, 'revealed in the full replay');
  keyed(h.container).get(`jump-${h.prepared.model.steps.length - 1}`).focus();
  h.controller.setPerspective('own');
  h.handle.setProjector(h.projectors.own);
  assert.equal(find(h.container, '.replayer-last'), null);
  assert.equal(h.container.querySelectorAll('.replayer-item').length, 1);
  assert.ok(h.doc.activeElement.classList.contains('replayer-play'));
  const again = [...h.container.querySelectorAll('.replayer-seat')].find((node) => node.dataset.playerId === 'p1');
  assert.equal(again.querySelectorAll('.card--back').length, 2, 'face down again');
});

test('the renderer draws from the projector alone: raw replay, model and view are never touched', () => {
  const h = harness(playHand({ aiCount: 2, button: 0 }));
  const trap = { ...h.ctx };
  for (const key of ['replay', 'model', 'view']) Object.defineProperty(trap, key, { get() { throw new Error(`renderer read ctx.${key}`); } });
  const doc = createMiniDocument();
  const container = doc.createElement('div');
  doc.body.append(container);
  const handle = mountReplayer(container, trap);
  handle.paint();
  assert.ok(find(container, '.replayer-felt'));
});

test('live defaults stay: a legacy-style mount (replay, view, model) draws the full replay with coach lines, wait copy and study card', () => {
  const record = playHand({ aiCount: 2, button: 0 });
  const prepared = prepare(record, { names: NAMES, feedback: 'live' });
  const decision = prepared.replay.actions.filter((action) => action.playerId === 'user');
  const [ready, other] = decision;
  const view = formatReplay(prepared.replay, {
    names: NAMES,
    coachNote: { handNo: prepared.replay.handNo, text: '요약', decisions: [{ decisionId: ready.decisionId, why: 'WHY', outcome: 'OUT', alternative: 'ALT' }] },
    trainingItems: [{ decisionId: ready.decisionId, evaluationId: 'e-live' }],
  });
  const doc = createMiniDocument();
  const container = doc.createElement('div');
  doc.body.append(container);
  const state = { step: 0, playing: false, speed: 1 };
  const studied = [];
  const handle = mountReplayer(container, {
    replay: prepared.replay, view, model: prepared.model, viewer: 'user', name: (id) => NAMES[id] ?? id, amount: (v) => `${v}칩`,
    state: () => state, onStep: (i) => { state.step = i; handle.paint(); }, onPlay() {}, onSpeed() {}, onStudy: (id) => studied.push(id),
  });
  const indexOf = (action) => prepared.model.steps.find((step) => step.actionIndex === prepared.replay.actions.indexOf(action)).index;
  // Full replay: every seat's cards, 끝 button, a denominator.
  assert.ok(q(container, '.replayer-last'));
  assert.match(q(container, '.replayer-progress').textContent, /^1 \/ \d+$/);
  assert.equal(container.querySelectorAll('.replayer-item').length, prepared.model.steps.length);
  assert.equal(container.querySelectorAll('.card--back').length, 0);
  state.step = indexOf(ready); handle.paint();
  const detail = q(container, '.replayer-now-detail').textContent;
  assert.match(detail, /왜: WHY/);
  assert.match(detail, /결과: OUT/);
  assert.match(detail, /대안: ALT/);
  assert.ok(q(container, '.replayer-now-detail').querySelector('.replay-study'));
  q(container, '.replayer-now-detail').querySelector('.replay-study').click();
  assert.deepEqual(studied, ['e-live']);
  if (other) {
    state.step = indexOf(other); handle.paint();
    assert.equal(q(container, '.replayer-now-detail').textContent.includes('WHY'), false);
  }
  state.step = prepared.model.steps.length - 1; handle.paint();
  assert.match(q(container, '.replayer-now-title').textContent, /결과/);
  assert.equal(q(container, '.replayer-last').disabled, true);
});
