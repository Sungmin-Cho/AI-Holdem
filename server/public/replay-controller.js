/** Replay playback control (design §7.2): the cursor, the one autoplay timer,
 * speed, the viewer's own decisions and the cap of the own perspective. Pure —
 * no DOM, no network — so the live table and the library drive the same rules.
 *
 * The controller owns the full length of the hand and where the viewer's
 * decisions are. It hands the renderer only `state()` and `controls()`; in the
 * own perspective `controls()` never says how long the hand is or whether a
 * decision lies ahead, until the cursor gets there. */

export const REPLAY_TICK_MS = 1400;
export const NO_MORE_DECISIONS = 'no-more-decisions';

const hidden = (step) => step.kind === 'showdown' || step.kind === 'result';

/** The last step the own perspective may show: the one before the first
 * showdown/result step (an uncalled-bet return or a runout before it is an
 * event the table would have shown). Without such a step, the last one. */
export function ownCap(steps) {
  const at = steps.findIndex(hidden);
  return at < 0 ? Math.max(0, steps.length - 1) : Math.max(0, at - 1);
}

/** Cursors that stand right before each of the viewer's actions (`index - 1`). */
export function ownDecisionCursors(steps, viewer = 'user') {
  return steps
    .filter((step) => step.kind === 'action' && step.actor === viewer && step.index > 0)
    .map((step) => step.index - 1);
}

export function createReplayController({
  steps, viewer = 'user', perspective = 'full', autoPause, speed = 1, step = 0, clock, onChange,
} = {}) {
  let list = Array.isArray(steps) ? steps : [];
  let cursors = ownDecisionCursors(list, viewer);
  let mode = perspective === 'own' ? 'own' : 'full';
  let cursor = 0;
  let rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  let playing = false;
  let notice = null;
  let disposed = false;
  let timer = null;
  let generation = 0;

  const timers = () => ({
    set: clock?.setTimeout ?? globalThis.setTimeout.bind(globalThis),
    clear: clock?.clearTimeout ?? globalThis.clearTimeout.bind(globalThis),
  });
  const lastIndex = () => Math.max(0, list.length - 1);
  const limit = () => (mode === 'own' ? Math.min(ownCap(list), lastIndex()) : lastIndex());
  const pausesAtDecisions = () => mode === 'own' || autoPause === 'own-decision';
  const clamp = (index) => Math.max(0, Math.min(limit(), Number.isFinite(index) ? Math.trunc(index) : 0));
  cursor = clamp(step);

  const snapshot = () => ({ step: cursor, playing, speed: rate, perspective: mode, notice });
  const changed = () => { if (!disposed) onChange?.(snapshot()); };

  function cancel() {
    generation += 1;
    if (timer !== null) { timers().clear(timer); timer = null; }
  }
  function schedule() {
    cancel();
    const mine = generation;
    timer = timers().set(() => {
      if (disposed || !playing || mine !== generation) return;
      timer = null;
      advance();
    }, REPLAY_TICK_MS / rate);
  }
  function stop() {
    cancel();
    playing = false;
  }
  // One autoplay tick: move on, and stop at the limit or right before the
  // viewer's next action. The cursor a playback started on is passed through
  // because the stop test only looks at where the tick lands.
  function advance() {
    cursor = clamp(cursor + 1);
    notice = null;
    if (cursor >= limit() || (pausesAtDecisions() && cursors.includes(cursor))) stop();
    else schedule();
    changed();
  }

  const controller = {
    state: () => snapshot(),
    limit,
    /** What the buttons may do. The own perspective reveals nothing about the
     * rest of the hand: next/play/next-decision stay on until the cap. */
    controls() {
      const at = cursor;
      const room = at < limit();
      const own = mode === 'own';
      return {
        canFirst: at > 0,
        canPrev: at > 0,
        // The full replay starts over from its end; the own view ends at its cap.
        canPlay: own ? room : lastIndex() > 0,
        canNext: room,
        canLast: own ? null : room,
        canPrevDecision: cursors.some((value) => value < at),
        canNextDecision: own ? room : cursors.some((value) => value > at),
      };
    },
    setStep(index) {
      if (disposed) return;
      stop();
      notice = null;
      cursor = clamp(index);
      changed();
    },
    play() {
      if (disposed || playing) return;
      if (cursor >= limit()) {
        // The full replay starts over (as the live replay always did); the own
        // perspective ends at its cap and waits for the full replay.
        if (mode === 'own') return;
        cursor = 0;
      }
      notice = null;
      playing = true;
      schedule();
      changed();
    },
    pause() {
      if (disposed || !playing) return;
      stop();
      changed();
    },
    togglePlay() {
      if (playing) controller.pause();
      else controller.play();
    },
    setSpeed(next) {
      if (disposed || !(Number.isFinite(next) && next > 0)) return;
      rate = next;
      if (playing) schedule();
      changed();
    },
    prevDecision() {
      if (disposed) return;
      const earlier = cursors.filter((value) => value < cursor);
      if (!earlier.length) return;
      stop();
      notice = null;
      cursor = clamp(earlier.at(-1));
      changed();
    },
    nextDecision() {
      if (disposed) return;
      if (cursor >= limit()) return;
      const later = cursors.find((value) => value > cursor);
      stop();
      if (later === undefined) {
        if (mode !== 'own') return changed();
        cursor = limit();
        notice = NO_MORE_DECISIONS;
      } else {
        cursor = clamp(later);
        notice = null;
      }
      changed();
    },
    setPerspective(next) {
      if (disposed) return;
      const target = next === 'own' ? 'own' : 'full';
      if (target === mode) return;
      stop();
      notice = null;
      mode = target;
      // Own → full keeps the cursor (it is within the cap); full → own starts over.
      cursor = mode === 'own' ? 0 : clamp(cursor);
      changed();
    },
    /** A new model for the same hand (a repaint): keep the cursor where it is. */
    rebind(next) {
      if (disposed) return;
      list = Array.isArray(next) ? next : [];
      cursors = ownDecisionCursors(list, viewer);
      const before = cursor;
      cursor = clamp(cursor);
      if (cursor !== before || cursor >= limit()) stop();
    },
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
    },
  };
  return controller;
}
