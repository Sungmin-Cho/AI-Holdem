import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplaySteps } from '../server/public/replay-model.js';
import {
  createReplayController, ownCap, ownDecisionCursors, REPLAY_TICK_MS, NO_MORE_DECISIONS,
} from '../server/public/replay-controller.js';
import { playHand, prepare, passive, shove, createFakeClock, userActionIndexes } from './helpers/replay-p3-fixtures.js';

// Heads-up with the button on the user: the user posts the small blind and
// acts first preflop, so the very first cursor (0) is already a decision cursor.
const userFirst = () => prepare(playHand({ aiCount: 1, button: 1 }));
// Three-handed passive hand: the user acts on every street.
const checkedDown = () => prepare(playHand({ aiCount: 2, button: 0 }));

function setup({ prepared = checkedDown(), ...options } = {}) {
  const clock = createFakeClock();
  const changes = [];
  const controller = createReplayController({
    steps: prepared.model.steps, viewer: 'user', clock, onChange: (state) => changes.push(state), ...options,
  });
  return { controller, clock, changes, steps: prepared.model.steps, prepared };
}
const decisionCursors = (steps) => userActionIndexes(steps).map((index) => index - 1);

test('own cap is the step before the first showdown/result and decision cursors sit one step before each user action', () => {
  const { model } = checkedDown();
  const steps = model.steps;
  const firstHidden = steps.findIndex((step) => step.kind === 'showdown' || step.kind === 'result');
  assert.ok(firstHidden > 0);
  assert.equal(ownCap(steps), firstHidden - 1);
  assert.deepEqual(ownDecisionCursors(steps, 'user'), decisionCursors(steps));
  assert.ok(ownDecisionCursors(steps, 'user').length >= 4, 'the user acts on every street');
});

test('timer: exactly one timer exists while playing, speed change replaces it, pause and dispose clear it', () => {
  const { controller, clock } = setup({ perspective: 'full' });
  assert.equal(clock.pending, 0);
  controller.play();
  assert.equal(clock.pending, 1);
  assert.deepEqual(clock.delays(), [REPLAY_TICK_MS]);
  controller.setSpeed(2);
  assert.equal(clock.pending, 1, 'a speed change reschedules, never adds a second timer');
  assert.deepEqual(clock.delays(), [REPLAY_TICK_MS / 2]);
  controller.setSpeed(0.5);
  assert.deepEqual(clock.delays(), [REPLAY_TICK_MS / 0.5]);
  clock.tick(REPLAY_TICK_MS / 0.5 - 1);
  assert.equal(controller.state().step, 0, 'no tick before the delay');
  clock.tick(1);
  assert.equal(controller.state().step, 1);
  assert.equal(clock.pending, 1, 'each tick schedules the next one');
  controller.pause();
  assert.equal(clock.pending, 0);
  assert.equal(controller.state().playing, false);
  controller.play();
  controller.dispose();
  assert.equal(clock.pending, 0);
  assert.ok(clock.maxPending <= 1, `never more than one pending timer (saw ${clock.maxPending})`);
});

test('speed change keeps the cursor and the playing flag', () => {
  const { controller } = setup({ perspective: 'full' });
  controller.setStep(3);
  controller.play();
  controller.setSpeed(2);
  assert.equal(controller.state().step, 3);
  assert.equal(controller.state().playing, true);
  assert.equal(controller.state().speed, 2);
  controller.pause();
  controller.setSpeed(1);
  assert.equal(controller.state().step, 3);
  assert.equal(controller.state().playing, false);
});

test('full perspective keeps the live defaults: no decision pause, stops at the last step, replay from the end restarts at 0', () => {
  const { controller, clock, steps } = setup({ perspective: 'full' });
  controller.play();
  const seen = [];
  for (let i = 0; i < steps.length + 3 && controller.state().playing; i += 1) {
    clock.tick(REPLAY_TICK_MS);
    seen.push(controller.state().step);
  }
  assert.deepEqual(seen, steps.map((step) => step.index).slice(1), 'every step in turn, user decisions included');
  assert.equal(controller.state().playing, false, 'reaching the last step stops playback');
  assert.equal(clock.pending, 0);
  assert.equal(controller.controls().canPlay, true, 'Play stays available at the end: it starts over');
  controller.play();
  assert.equal(controller.state().step, 0, 'play at the end starts over from the first step');
  assert.equal(controller.state().playing, true);
});

test('full perspective can opt in to pausing before the user decisions', () => {
  const { controller, clock, steps } = setup({ perspective: 'full', autoPause: 'own-decision' });
  const cursors = decisionCursors(steps);
  controller.play();
  clock.tick(REPLAY_TICK_MS * steps.length);
  assert.equal(controller.state().step, cursors[0] === 0 ? cursors[1] : cursors[0]);
  assert.equal(controller.state().playing, false);
});

test('own perspective: autoplay stops before each user action, passes the one it starts on, and stops at the cap', () => {
  const { controller, clock, steps } = setup({ perspective: 'own' });
  const cursors = decisionCursors(steps);
  const cap = ownCap(steps);
  const stops = [];
  for (let round = 0; round < cursors.length + 2; round += 1) {
    if (controller.state().step >= cap) break;
    controller.play();
    assert.equal(controller.state().playing, true, `round ${round} starts`);
    clock.tick(REPLAY_TICK_MS * steps.length);
    assert.equal(controller.state().playing, false, `round ${round} stopped`);
    stops.push(controller.state().step);
  }
  assert.deepEqual(stops, [...cursors.filter((cursor) => cursor > 0), cap].filter((value, at, list) => list.indexOf(value) === at));
  assert.equal(controller.state().step, cap);
  controller.play();
  assert.equal(controller.state().playing, false, 'play is refused at the cap');
  assert.equal(controller.state().step, cap, 'and the cap does not restart');
  assert.equal(clock.pending, 0);
});

test('a first cursor that is already a user decision is passed once, not stuck on', () => {
  const prepared = userFirst();
  const cursors = decisionCursors(prepared.model.steps);
  assert.equal(cursors[0], 0, 'fixture: the user acts first');
  const { controller, clock } = setup({ prepared, perspective: 'own' });
  controller.play();
  clock.tick(REPLAY_TICK_MS);
  assert.equal(controller.state().step, 1, 'the first tick performs the user action');
  assert.equal(controller.state().playing, true, 'and playback keeps going');
  clock.tick(REPLAY_TICK_MS * prepared.model.steps.length);
  assert.equal(controller.state().step, cursors[1], 'it stops before the next decision');
  assert.equal(controller.state().playing, false);
});

test('manual next advances exactly one action, even onto a decision cursor, and stops playback', () => {
  const { controller, clock, steps } = setup({ perspective: 'own' });
  controller.play();
  controller.setStep(controller.state().step + 1);
  assert.equal(controller.state().playing, false);
  assert.equal(clock.pending, 0);
  const at = controller.state().step;
  controller.setStep(at + 1);
  assert.equal(controller.state().step, at + 1);
  assert.ok(steps.length > at + 1);
});

test('previous/next user decision: strictly earlier / strictly later, and the current decision cursor is skipped', () => {
  const { controller, steps } = setup({ perspective: 'own' });
  const cursors = decisionCursors(steps);
  controller.nextDecision();
  assert.equal(controller.state().step, cursors[0] === 0 ? cursors[1] : cursors[0]);
  const first = controller.state().step;
  controller.nextDecision();
  assert.ok(controller.state().step > first, 'already at a decision cursor, next goes past it');
  assert.equal(controller.state().step, cursors[cursors.indexOf(first) + 1]);
  controller.prevDecision();
  assert.equal(controller.state().step, first, 'previous is strictly earlier');
  // Mid-way between two decisions: previous is the one behind, next the one ahead.
  controller.setStep(cursors[1] + 1);
  controller.prevDecision();
  assert.equal(controller.state().step, cursors[1]);
  controller.setStep(cursors[1] + 1);
  controller.nextDecision();
  assert.equal(controller.state().step, cursors[2]);
});

test('own perspective: next decision is enabled until the cap whether or not a decision lies ahead, and past the last one it moves to the cap with a neutral notice', () => {
  const { controller, steps } = setup({ perspective: 'own' });
  const cursors = decisionCursors(steps);
  const cap = ownCap(steps);
  controller.setStep(cursors.at(-1));
  assert.equal(controller.controls().canNextDecision, true, 'enabled even though no user decision is left');
  assert.equal(controller.state().notice, null);
  controller.nextDecision();
  assert.equal(controller.state().step, cap);
  assert.equal(controller.state().notice, NO_MORE_DECISIONS);
  assert.equal(controller.controls().canNextDecision, false, 'disabled only once the cap is reached');
  assert.equal(controller.controls().canNext, false);
  assert.equal(controller.controls().canPlay, false);
  assert.equal(controller.controls().canPrev, true);
  assert.equal(controller.controls().canFirst, true);
  controller.setStep(cap - 1);
  assert.equal(controller.state().notice, null, 'the notice clears on the next move');
});

test('hero absent: no decision cursors, previous is disabled, next walks to the cap', () => {
  const record = playHand({
    aiCount: 1, participants: [{ playerId: 'h1', name: '민준', participantId: 'part-1' }], hostOut: true, button: 0,
  });
  assert.equal(record.startStacks.user, undefined, 'fixture: the host sits this hand out');
  const prepared = prepare(record, { humanIds: ['user', 'h1'] });
  assert.equal(prepared.model.ok, true, prepared.model.reason);
  const { controller } = setup({ prepared, perspective: 'own' });
  assert.deepEqual(ownDecisionCursors(prepared.model.steps, 'user'), []);
  assert.equal(controller.controls().canPrevDecision, false);
  assert.equal(controller.controls().canNextDecision, true);
  controller.nextDecision();
  assert.equal(controller.state().step, ownCap(prepared.model.steps));
  assert.equal(controller.state().notice, NO_MORE_DECISIONS);
});

test('forced actions and a missing decisions array do not change navigation: cursors come from the steps', () => {
  const record = playHand({ aiCount: 2, button: 0 });
  const prepared = prepare(record);
  const baseline = ownDecisionCursors(prepared.model.steps, 'user');
  const stripped = structuredClone(prepared.replay);
  stripped.decisions = [];
  stripped.actions.filter((action) => action.playerId === 'user').forEach((action) => { action.forced = true; });
  const model = buildReplaySteps(stripped);
  assert.equal(model.ok,true);
  assert.ok(stripped.actions.some(action=>action.playerId==='user' && action.forced===true));
  assert.deepEqual(ownDecisionCursors(model.steps, 'user'), baseline);
});

test('perspective transitions: own to full keeps the cursor and stops; full to own goes to 0 and stops; the other state is kept', () => {
  const { controller, clock, steps } = setup({ perspective: 'own' });
  controller.setSpeed(2);
  controller.setStep(ownCap(steps));
  controller.setPerspective('full');
  assert.equal(controller.state().perspective, 'full');
  assert.equal(controller.state().step, ownCap(steps), 'the cap step is kept');
  assert.equal(controller.state().playing, false);
  assert.equal(controller.state().speed, 2);
  assert.equal(controller.controls().canNext, true, 'the full replay can go on past the old cap');
  controller.play();
  assert.equal(controller.state().playing, true);
  controller.setPerspective('own');
  assert.equal(controller.state().step, 0);
  assert.equal(controller.state().playing, false);
  assert.equal(clock.pending, 0);
  assert.equal(controller.state().speed, 2);
});

test('own cap blocks every way past it: steps, ticks and decision jumps clamp', () => {
  const { controller, clock, steps } = setup({ perspective: 'own' });
  const cap = ownCap(steps);
  controller.setStep(10_000);
  assert.equal(controller.state().step, cap);
  controller.setStep(-5);
  assert.equal(controller.state().step, 0);
  controller.setStep(cap - 1);
  controller.play();
  clock.tick(REPLAY_TICK_MS * 5);
  assert.equal(controller.state().step, cap);
  assert.equal(controller.state().playing, false);
});

test('final cap cases: fold, uncalled return then runout, all-in runout, side pot, blinds all-in with no actions', () => {
  const cases = {
    fold: playHand({ aiCount: 2, pick: (legal, turn) => (turn === 0 ? ['fold'] : turn === 1 ? ['fold'] : passive(legal)) }),
    allIn: playHand({ aiCount: 2, pick: shove }),
    sidePot: playHand({ aiCount: 2, stacks: [300, 600, 1000], pick: shove }),
    blindsAllIn: playHand({ aiCount: 1, stacks: [20, 20], pick: () => { throw new Error('no decision expected'); } }),
  };
  const kinds = {};
  for (const [name, record] of Object.entries(cases)) {
    const { model } = prepare(record);
    assert.equal(model.ok, true, `${name}: ${model.reason}`);
    const steps = model.steps;
    kinds[name] = steps.map((step) => step.kind);
    const firstHidden = steps.findIndex((step) => step.kind === 'showdown' || step.kind === 'result');
    assert.equal(ownCap(steps), firstHidden - 1, name);
    // Everything up to the cap is an event that would have been visible at the table.
    for (const step of steps.slice(0, ownCap(steps) + 1)) {
      assert.notEqual(step.kind, 'showdown', name);
      assert.notEqual(step.kind, 'result', name);
    }
    const { controller, clock } = setup({ prepared: { model }, perspective: 'own' });
    controller.setStep(0);
    for (let guard = 0; guard < steps.length + 5 && controller.controls().canPlay; guard += 1) {
      controller.play();
      clock.tick(REPLAY_TICK_MS * steps.length);
    }
    assert.equal(controller.state().step, ownCap(steps), name);
    assert.equal(controller.controls().canNextDecision, false, name);
  }
  // The fixtures really are the cases they are named for.
  assert.equal(kinds.fold.includes('showdown'), false);
  assert.ok(kinds.fold.includes('return'), 'an uncalled bet is returned before the result');
  assert.ok(kinds.sidePot.includes('return') && kinds.sidePot.includes('runout'),'both return and runout exist');
  assert.ok(kinds.sidePot.indexOf('return') < kinds.sidePot.indexOf('runout'), 'return, then the runout');
  assert.deepEqual(kinds.allIn.filter((kind) => kind === 'runout'), ['runout', 'runout', 'runout']);
  assert.equal(kinds.blindsAllIn.includes('action'), false, 'no action at all');
});

test('dispose: a tick that was already queued does nothing, and no callback fires afterwards', () => {
  const { controller, clock, changes } = setup({ perspective: 'full' });
  controller.play();
  const [stale] = clock.callbacks();
  controller.dispose();
  const seen = changes.length;
  stale();
  controller.setStep(4);
  controller.play();
  controller.nextDecision();
  controller.setSpeed(2);
  assert.equal(changes.length, seen, 'no onChange after dispose');
  assert.equal(controller.state().step, 0);
  assert.equal(controller.state().playing, false);
  assert.equal(clock.pending, 0);
});

test('a replaced timer callback from before a pause is also inert', () => {
  const { controller, clock } = setup({ perspective: 'full' });
  controller.play();
  const [stale] = clock.callbacks();
  controller.pause();
  stale();
  assert.equal(controller.state().step, 0);
  assert.equal(clock.pending, 0);
});

test('rebind swaps the steps, clamps the cursor, and keeps playing state sane', () => {
  const { controller, steps } = setup({ perspective: 'full' });
  controller.setStep(steps.length - 1);
  const shorter = steps.slice(0, 4);
  controller.rebind(shorter);
  assert.equal(controller.state().step, 3);
  assert.equal(controller.controls().canNext, false);
});

test('onChange is called once per state change with the new state', () => {
  const { controller, changes } = setup({ perspective: 'full' });
  controller.setStep(2);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].step, 2);
  controller.setSpeed(2);
  assert.equal(changes.length, 2);
  assert.equal(changes[1].speed, 2);
});
