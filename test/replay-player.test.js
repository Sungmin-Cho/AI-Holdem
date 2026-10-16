import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountReplayPlayer } from '../server/public/replay-player.js';
import { REPLAY_TICK_MS, ownCap } from '../server/public/replay-controller.js';
import { OWN_BANNER } from '../server/public/replay-perspective.js';
import { cardLabel, parseCard } from '../server/public/card-render.js';
import { createMiniDocument, exposedText } from './helpers/mini-dom.js';
import { playHand, prepare, passive, shove, createFakeClock } from './helpers/replay-p3-fixtures.js';

const NAMES = { user: '나', p1: '철수', p2: '영희' };
const labels = (codes) => codes.map((code) => cardLabel(parseCard(code)));

function mount(record, options = {}) {
  const { reveal = 'all', humanIds, names = NAMES, ...rest } = options;
  const doc = createMiniDocument();
  const container = doc.createElement('div');
  doc.body.append(container);
  const prepared = prepare(record, { reveal, humanIds, names });
  const clock = createFakeClock();
  const studied = [];
  const player = mountReplayPlayer(container, {
    replay: options.replay ?? prepared.replay, names, clock, onStudy: (id) => studied.push(id), ...rest,
  });
  return { doc, container, player, prepared, clock, studied };
}
const q = (container, selector) => container.querySelector(selector);
const qa = (container, selector) => [...container.querySelectorAll(selector)];
const click = (container, selector) => { const node = q(container, selector); assert.ok(node, selector); node.click(); };
const textOf = (container, selector) => q(container, selector)?.textContent ?? null;

test('mounts in the own perspective by default: own-view header, own cards only, the toggle pair, no results', () => {
  const { container, player, prepared } = mount(playHand({ aiCount: 2, button: 0 }));
  assert.equal(player.state().perspective, 'own');
  assert.equal(player.state().step, 0);
  const header = textOf(container, '.replay-player-header');
  assert.ok(header.includes(OWN_BANNER));
  assert.ok(header.includes(`핸드 ${prepared.replay.handNo}`));
  assert.equal(/승자|복기 공개/.test(header), false);
  const own = q(container, '.replay-player-own');
  const full = q(container, '.replay-player-full');
  assert.equal(own.getAttribute('aria-pressed'), 'true');
  assert.equal(full.getAttribute('aria-pressed'), 'false');
  assert.equal(full.textContent, '전체 복기 보기');
  const text = exposedText(container);
  for (const label of labels(prepared.replay.holes.user)) assert.ok(text.includes(label));
  for (const [playerId, cards] of Object.entries(prepared.replay.holes)) {
    if (playerId !== 'user') for (const label of labels(cards)) assert.equal(text.includes(label), false);
  }
  assert.equal(q(container, '.replayer-last'), null);
});

test('autoplay pauses before each own decision and at the cap, where the full replay is offered', () => {
  const { container, player, prepared, clock } = mount(playHand({ aiCount: 2, button: 0 }));
  const steps = prepared.model.steps;
  const decisions = steps.filter((step) => step.actor === 'user').map((step) => step.index - 1);
  const cap = ownCap(steps);
  const stops = [];
  for (let round = 0; round < decisions.length + 3 && player.state().step < cap; round += 1) {
    click(container, '.replayer-play');
    assert.equal(player.state().playing, true);
    assert.equal(clock.pending, 1);
    clock.tick(REPLAY_TICK_MS * steps.length);
    assert.equal(player.state().playing, false);
    stops.push(player.state().step);
  }
  assert.deepEqual(stops, [...new Set([...decisions, cap])]);
  assert.equal(q(container, '.replayer-play').disabled, true);
  assert.match(textOf(container, '.replay-player-hint'), /전체 복기 보기/);
  assert.equal(clock.pending, 0);
  // Back from the cap, the hint goes away.
  click(container, '.replayer-first');
  assert.equal(textOf(container, '.replay-player-hint'), '');
});

test('toggling to the full replay keeps the cursor and stops; back to own starts over; the table stays mounted', () => {
  const { container, player, prepared, clock } = mount(playHand({ aiCount: 2, button: 0 }));
  const felt = q(container, '.replayer-felt');
  const seats = qa(container, '.replayer-seat');
  const cap = ownCap(prepared.model.steps);
  click(container, '.replayer-next-decision');
  click(container, '.replayer-play');
  assert.equal(player.state().playing, true);
  click(container, '.replay-player-full');
  assert.equal(player.state().perspective, 'full');
  assert.equal(player.state().playing, false);
  assert.equal(clock.pending, 0);
  assert.ok(player.state().step > 0, 'the cursor is kept');
  assert.equal(q(container, '.replay-player-full').getAttribute('aria-pressed'), 'true');
  const header = textOf(container, '.replay-player-header');
  assert.match(header, /승자/);
  assert.match(header, /복기 공개/);
  assert.equal(header.includes(OWN_BANNER), false);
  assert.ok(q(container, '.replayer-last'));
  assert.equal(qa(container, '.replayer-item').length, prepared.model.steps.length);
  for (const [playerId, cards] of Object.entries(prepared.replay.holes)) {
    const seat = qa(container, '.replayer-seat').find((node) => node.dataset.playerId === playerId);
    assert.equal(seat.querySelectorAll('.card--back').length, 0, `${playerId} shown in the full replay`);
    assert.equal(cards.length, 2);
  }
  assert.equal(q(container, '.replayer-felt'), felt);
  qa(container, '.replayer-seat').forEach((node, at) => assert.equal(node, seats[at]));
  // Back to own: the start, paused, results hidden again.
  click(container, '.replay-player-own');
  assert.equal(player.state().perspective, 'own');
  assert.equal(player.state().step, 0);
  assert.equal(player.state().playing, false);
  assert.ok(textOf(container, '.replay-player-header').includes(OWN_BANNER));
  assert.equal(qa(container, '.replayer-item').length, 1);
  assert.equal(q(container, '.replayer-felt'), felt);
  void cap;
});

test('own to full at the cap keeps the cap cursor and lets the replay go on; full ends restart at the first step', () => {
  const { container, player, prepared, clock } = mount(playHand({ aiCount: 2, button: 0 }));
  const steps = prepared.model.steps;
  const cap = ownCap(steps);
  player.setPerspective('own');
  while (player.state().step < cap) click(container, '.replayer-next-decision');
  assert.equal(player.state().step, cap);
  click(container, '.replay-player-full');
  assert.equal(player.state().step, cap);
  assert.equal(q(container, '.replayer-play').disabled, false);
  click(container, '.replayer-last');
  assert.equal(player.state().step, steps.length - 1);
  click(container, '.replayer-play');
  assert.equal(player.state().step, 0, 'play at the end restarts');
  assert.equal(player.state().playing, true);
  assert.equal(clock.pending, 1);
});

test('a unit change keeps perspective and cursor and repaints the amounts', () => {
  const { container, player, clock } = mount(playHand({ aiCount: 2, button: 0 }), { unit: 'chips' });
  click(container, '.replayer-next-decision');
  click(container, '.replayer-next');
  const felt = q(container, '.replayer-felt');
  const before = exposedText(container);
  assert.match(before, /칩/);
  const step = player.state().step;
  player.setUnit('bb');
  const after = exposedText(container);
  assert.match(after, /BB/);
  assert.notEqual(after, before);
  assert.equal(player.state().step, step);
  assert.equal(player.state().perspective, 'own');
  assert.equal(q(container, '.replayer-felt'), felt);
  assert.equal(clock.pending, 0);
});

test('speed change keeps the cursor and runs the one timer at the new rate', () => {
  const { container, player, clock } = mount(playHand({ aiCount: 2, button: 0 }));
  click(container, '.replayer-next-decision');
  const step = player.state().step;
  click(container, '.replayer-play');
  const speed = q(container, 'select');
  speed.value = '2';
  speed.dispatch('change');
  assert.equal(player.state().step, step);
  assert.equal(clock.pending, 1);
  assert.deepEqual(clock.delays(), [REPLAY_TICK_MS / 2]);
});

test('no coach wait line or study card in either perspective by default; a live coach note shows only in the full replay', () => {
  const record = playHand({ aiCount: 2, button: 0 });
  const prepared = prepare(record, { names: NAMES });
  const decision = prepared.replay.actions.find((action) => action.playerId === 'user');
  const plain = mount(record);
  const everyStep = () => {
    for (let at = 0; at < prepared.model.steps.length - 1; at += 1) {
      assert.equal(/코치|학습 카드/.test(exposedText(plain.container)), false, `${plain.player.state().perspective} @${at}`);
      click(plain.container, '.replayer-next');
    }
  };
  everyStep.call(null);
  plain.player.setPerspective('full');
  click(plain.container, '.replayer-first');
  everyStep.call(null);
  const live = mount(record, {
    coachNote: { handNo: prepared.replay.handNo, text: 'COACH_SUMMARY', decisions: [{ decisionId: decision.decisionId, why: 'WHY_CANARY', outcome: 'o', alternative: 'a' }] },
    trainingItems: [{ decisionId: decision.decisionId, evaluationId: 'e-1', handNo: prepared.replay.handNo }],
  });
  const userStep = prepared.model.steps.find((step) => step.actor === 'user').index;
  // Own: right at the user's action nothing of the coach shows.
  for (let at = 0; at <= userStep; at += 1) {
    if (at > 0) click(live.container, '.replayer-next');
    assert.equal(/WHY_CANARY|COACH_SUMMARY|학습 카드/.test(exposedText(live.container)), false, `own @${at}`);
  }
  live.player.setPerspective('full');
  assert.match(exposedText(live.container), /WHY_CANARY/);
  assert.ok(q(live.container, '.replay-study'));
  q(live.container, '.replay-study').click();
  assert.deepEqual(live.studied, ['e-1']);
});

test('dispose clears the timer, removes the DOM and makes every late call inert', () => {
  const { container, player, clock } = mount(playHand({ aiCount: 2, button: 0 }));
  click(container, '.replayer-play');
  const [stale] = clock.callbacks();
  player.dispose();
  assert.equal(clock.pending, 0);
  assert.equal(q(container, '.replay-player'), null);
  stale();
  player.setUnit('bb');
  player.setPerspective('full');
  assert.equal(clock.pending, 0);
  assert.equal(q(container, '.replay-player'), null);
});

test('a model that cannot be rebuilt: the own view shows no list, only a notice and the way to the full replay', () => {
  const record = playHand({ aiCount: 2, button: 0 });
  const prepared = prepare(record, { names: NAMES });
  const broken = structuredClone(prepared.replay);
  broken.actions[1].potTotal += 7;
  const { container, player } = mount(record, { replay: broken });
  assert.equal(player.state().perspective, 'own');
  assert.equal(q(container, '.replayer'), null, 'no drawn table');
  assert.equal(q(container, '.replay-list'), null, 'no text list in the own view');
  const text = exposedText(container);
  assert.match(text, /다시 그릴 수 없/);
  for (const [playerId, cards] of Object.entries(broken.holes)) {
    for (const label of labels(cards)) assert.equal(text.includes(label), false, `${playerId} ${label}`);
  }
  assert.equal(/폴드|콜|체크|레이즈/.test(text), false, 'no action rows');
  assert.ok(q(container, '.replay-player-full'));
  click(container, '.replay-player-full');
  assert.ok(q(container, '.replay-list'), 'the full replay keeps the text fallback');
  assert.match(textOf(container, '.replay-list'), /콜|체크/);
  click(container, '.replay-player-own');
  assert.equal(q(container, '.replay-list'), null);
});

test('an unavailable replay shows the marker copy and nothing to play', () => {
  const doc = createMiniDocument();
  const container = doc.createElement('div');
  doc.body.append(container);
  const player = mountReplayPlayer(container, { replay: { handNo: 4, unavailable: true, reason: 'REPLAY_UNAVAILABLE' } });
  assert.match(container.textContent, /불러올 수 없습니다/);
  assert.equal(q(container, '.replayer'), null);
  player.dispose();
});

test('a hand the viewer sat out plays through without cards or fact cards and says so', () => {
  const record = playHand({
    aiCount: 1, participants: [{ playerId: 'h1', name: '민준', participantId: 'part-1' }], hostOut: true, button: 0,
  });
  const names = { user: '나', h1: '민준', p1: 'p1' };
  const { container, player, clock, prepared } = mount(record, { humanIds: ['user', 'h1'], names });
  assert.match(textOf(container, '.replay-player-header'), /참여하지 않았습니다/);
  assert.equal(qa(container, '.replayer-seat').length, prepared.model.seats.length);
  assert.equal(qa(container, '.replayer-seat').some((node) => node.dataset.playerId === 'user'), false);
  click(container, '.replayer-play');
  clock.tick(REPLAY_TICK_MS * prepared.model.steps.length);
  assert.equal(player.state().step, ownCap(prepared.model.steps));
  assert.equal(/사실 카드/.test(exposedText(container)), false);
  assert.equal(qa(container, '.replayer-seat').every((node) => node.querySelectorAll('.card--back').length === 2), true);
});

test('stepping with the table mounted: no remount of the felt, rows or controls across a whole autoplay', () => {
  const { container, player, clock, prepared } = mount(playHand({ aiCount: 2, button: 0 }));
  const felt = q(container, '.replayer-felt');
  const timeline = q(container, '.replayer-timeline');
  const controls = q(container, '.replayer-controls');
  const firstRow = q(container, '.replayer-item');
  const cap = ownCap(prepared.model.steps);
  while (player.state().step < cap) {
    click(container, '.replayer-play');
    clock.tick(REPLAY_TICK_MS * prepared.model.steps.length);
    assert.equal(q(container, '.replayer-felt'), felt);
    assert.equal(q(container, '.replayer-timeline'), timeline);
    assert.equal(q(container, '.replayer-controls'), controls);
    assert.equal(q(container, '.replayer-item'), firstRow);
  }
});

test('a full-perspective mount starts in the full replay with the whole hand', () => {
  const { container, player, prepared } = mount(playHand({ aiCount: 2, button: 0 }), { perspective: 'full' });
  assert.equal(player.state().perspective, 'full');
  assert.equal(qa(container, '.replayer-item').length, prepared.model.steps.length);
  assert.equal(q(container, '.replay-player-full').getAttribute('aria-pressed'), 'true');
});

test('an all-in hand reaches its cap with the board dealt and no result', () => {
  const { container, player, prepared, clock } = mount(playHand({ aiCount: 2, pick: shove }));
  click(container, '.replayer-play');
  clock.tick(REPLAY_TICK_MS * prepared.model.steps.length * 3);
  while (player.state().step < ownCap(prepared.model.steps)) {
    click(container, '.replayer-play');
    clock.tick(REPLAY_TICK_MS * prepared.model.steps.length);
  }
  assert.equal(player.state().step, ownCap(prepared.model.steps));
  const text = exposedText(container);
  assert.equal(/쇼다운|승리|획득/.test(text), false);
  for (const label of labels(prepared.replay.board)) assert.ok(text.includes(label), `${label} was dealt before the cap`);
});

test('pagehide ends the player: the timer is cleared and the listener is released with dispose', () => {
  const listeners = new Map();
  const doc = createMiniDocument();
  doc.defaultView = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const container = doc.createElement('div');
  doc.body.append(container);
  const prepared = prepare(playHand({ aiCount: 2, button: 0 }), { names: NAMES });
  const clock = createFakeClock();
  const player = mountReplayPlayer(container, { replay: prepared.replay, names: NAMES, clock });
  click(container, '.replayer-play');
  assert.equal(clock.pending, 1);
  listeners.get('pagehide')();
  assert.equal(clock.pending, 0);
  assert.equal(listeners.has('pagehide'), false, 'the listener is gone');
  assert.equal(q(container, '.replay-player'), null);
  player.dispose();
});

test('recorded forced user actions show their marker only after action, in both perspectives, without voluntary facts', () => {
  const record=playHand({aiCount:2,button:0});
  const first=record.actions.find(action=>action.playerId==='user');assert.ok(first);first.forced=true;
  const {container,player,prepared}=mount(record);
  const index=prepared.model.steps.find(step=>step.kind==='action' && step.actor==='user').index;
  const next=q(container,'.replayer-next');
  for(let at=0;at<index-1;at++)next.click();
  assert.equal(exposedText(container).includes('강제 액션(기록)'),false);
  next.click();
  assert.ok(exposedText(container).includes('강제 액션(기록)'));
  assert.equal(q(container,'.replay-facts'),null);
  player.setPerspective('full');
  assert.ok(exposedText(container).includes('강제 액션(기록)'));
  assert.equal(q(container,'.replay-facts'),null);
  player.dispose();
});

test('an arithmetic-invalid forced action is identified only in the explicit full text fallback', () => {
  const record=playHand({aiCount:2,button:0}),prepared=prepare(record,{names:NAMES}),broken=structuredClone(prepared.replay);
  const mine=broken.actions.find(row=>row.playerId==='user');assert.ok(mine);mine.forced=true;
  const hidden=broken.actions.find(row=>row.playerId!=='user');assert.ok(hidden);hidden.forced=true;hidden.reasonKind='hidden';
  broken.actions[1].potTotal+=7;
  const {container,player}=mount(record,{replay:broken});
  assert.equal(q(container,'.replay-list'),null);assert.equal(exposedText(container).includes('강제 액션(기록)'),false);
  click(container,'.replay-player-full');
  assert.ok(q(container,'.replay-list'));assert.equal(qa(container,'.replay-forced').length,1);
  assert.match(textOf(container,'.replay-list'),/강제 액션\(기록\)/);
  click(container,'.replay-player-own');assert.equal(q(container,'.replay-list'),null);
  player.dispose();
});
