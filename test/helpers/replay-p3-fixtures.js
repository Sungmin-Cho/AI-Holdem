// Engine-made hands for the replay perspective / controller / player tests.
// Every record comes from createGame/startHand/applyAction, never from a
// hand-written replay DTO, so the arithmetic the model checks is the engine's.
import { createGame, startHand, applyAction, legalFor } from '../../engine/hand.js';
import { replayRecord } from '../../shared/hand-replay.js';
import { buildReplaySteps, replaySeatOrder } from '../../server/public/replay-model.js';
import { formatReplay } from '../../server/public/replay-format.js';

/** A small seeded generator: the same seed deals the same deck. */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export const passive = (legal) => (legal.canCheck ? ['check'] : ['call']);
export const shove = (legal) => (legal.canRaise ? ['raise', legal.maxRaiseTo] : legal.canCheck ? ['check'] : ['call']);

/** Plays one engine hand. `pick(legal, turn, state)` returns [action, amount]. */
export function playHand({ aiCount = 2, startStack = 1000, seed = 11, button = 0, stacks, participants, hostOut = false, pick = passive } = {}) {
  const game = createGame({ aiCount, startStack, levelEvery: 10, button, ...(participants ? { participants } : {}) });
  if (stacks) game.seats.forEach((seat, at) => { if (stacks[at] != null) seat.stack = stacks[at]; });
  if (hostOut) { game.seats[0].out = true; game.seats[0].stack = 0; }
  let state = startHand(game, { rng: seeded(seed) }).state;
  let turn = 0;
  while (!legalFor(state).handOver) {
    const legal = legalFor(state);
    const [action, amount] = pick(legal, turn, state);
    turn += 1;
    state = applyAction(state, legal.toAct, action, amount).state;
  }
  return state.lastHand;
}

/** Everything the player needs for one record: replay DTO, model, view. */
export function prepare(record, { reveal = 'all', humanIds, names = {}, feedback = 'omit' } = {}) {
  const replay = replayRecord(record, { reveal, humanIds });
  const model = buildReplaySteps(replay, { seatOrder: replaySeatOrder(replay, Object.keys(names)) });
  const view = formatReplay(replay, { names, feedback });
  return { replay, model, view };
}

/** Index of the viewer's action steps. */
export const userActionIndexes = (steps, viewer = 'user') => steps
  .filter((step) => step.kind === 'action' && step.actor === viewer).map((step) => step.index);

/** A fake clock with the same two functions the controller schedules with. */
export function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const clock = {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      clock.maxPending = Math.max(clock.maxPending, timers.size);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    get pending() { return timers.size; },
    delays() { return [...timers.values()].map((timer) => timer.at - now); },
    maxPending: 0,
    /** The callbacks of every timer that is still scheduled (a stale tick keeps its closure). */
    callbacks() { return [...timers.values()].map((timer) => timer.fn); },
    tick(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = until;
    },
  };
  return clock;
}
