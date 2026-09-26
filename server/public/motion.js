/** Table motion is decoration over a DOM that already shows the final state.
 * diffViews decides what changed between two painted frames; the player only
 * animates transform/opacity (individual `translate`/`scale`/`rotate`) for a
 * fixed ≤300ms, so it never delays state, input, or the staged runout. */

export const MOTION_MS = Object.freeze({ deal: 160, dealStagger: 20, bet: 150, collect: 250, board: 200, boardStagger: 60, reveal: 200, award: 300 });

const betsOf = (view) => new Map((view?.seats ?? []).map((seat) => [seat.playerId, Number.isSafeInteger(seat.bet) ? seat.bet : 0]));

/** frame = {view, revealed: [playerId]}. Snapshot or non-contiguous updates
 * (initial load, reconnect, terminal record, skipped revisions) never animate:
 * a jump is not a deal, a bet, or an award. */
export function diffViews(prev, next, { source = 'live', contiguous = true } = {}) {
  const before = prev?.view, after = next?.view;
  if (source !== 'live' || contiguous !== true || !before || !after) return [];
  const events = [];
  if (after.handNo !== before.handNo) {
    if (after.handInProgress === true) events.push({ type: 'deal', playerIds: (after.seats ?? []).filter((seat) => seat.out !== true).map((seat) => seat.playerId) });
    return events;
  }
  const was = betsOf(before), now = betsOf(after);
  const streetEnded = after.street !== before.street || (before.handInProgress === true && after.handInProgress !== true);
  if (streetEnded) {
    const collected = [...was].filter(([, bet]) => bet > 0).map(([playerId]) => playerId);
    if (collected.length) events.push({ type: 'collect', playerIds: collected });
  } else {
    for (const [playerId, bet] of now) if (bet > (was.get(playerId) ?? 0)) events.push({ type: 'bet', playerId });
  }
  const fromBoard = before.board?.length ?? 0, toBoard = after.board?.length ?? 0;
  // A runout at hand end is revealed in stages by the result frame; leave it alone.
  if (after.handInProgress === true && toBoard > fromBoard) events.push({ type: 'board', from: fromBoard, to: toBoard });
  const shown = new Set(prev.revealed ?? []);
  const revealed = (next.revealed ?? []).filter((playerId) => !shown.has(playerId));
  if (revealed.length) events.push({ type: 'reveal', playerIds: revealed });
  return events;
}

const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
const seatNode = (table, playerId) => [...table.querySelectorAll('.seat')].find((node) => node.dataset.playerId === playerId) ?? null;

export function createMotionPlayer({ doc = globalThis.document, enabled = () => true } = {}) {
  let running = [];
  let ghosts = [];

  function cancel() {
    for (const animation of running) animation.cancel();
    for (const ghost of ghosts) ghost.remove();
    running = []; ghosts = [];
  }

  function animate(node, keyframes, options) {
    if (typeof node?.animate !== 'function') return null;
    const animation = node.animate(keyframes, { easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'none', ...options });
    running.push(animation);
    animation.finished?.then(() => { running = running.filter((item) => item !== animation); }, () => {});
    return animation;
  }

  // A chip that exists only for the flight; the real pot/marker is already painted.
  function flyChip(table, from, to, duration, delay = 0) {
    const box = table.getBoundingClientRect();
    const ghost = doc.createElement('span');
    ghost.className = 'motion-chip';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.left = `${from.x - box.left}px`;
    ghost.style.top = `${from.y - box.top}px`;
    table.append(ghost);
    ghosts.push(ghost);
    const flight = animate(ghost, [
      { translate: '-50% -50%', opacity: 1 },
      { translate: `calc(-50% + ${to.x - from.x}px) calc(-50% + ${to.y - from.y}px)`, opacity: 0.2 },
    ], { duration, delay, fill: 'forwards' });
    const done = () => { ghost.remove(); ghosts = ghosts.filter((item) => item !== ghost); };
    if (flight?.finished) flight.finished.then(done, done); else done();
  }

  function play(events, { table }) {
    cancel();
    if (!table || !events.length || !enabled()) return;
    const potCenter = () => center((table.querySelector('#pots') ?? table).getBoundingClientRect());
    for (const event of events) {
      if (event.type === 'deal') {
        const origin = potCenter();
        event.playerIds.forEach((playerId, index) => {
          for (const card of seatNode(table, playerId)?.querySelectorAll('.seat-cards .card') ?? []) {
            const at = center(card.getBoundingClientRect());
            animate(card, [
              { translate: `${origin.x - at.x}px ${origin.y - at.y}px`, scale: 0.6, opacity: 0 },
              { translate: '0 0', scale: 1, opacity: 1 },
            ], { duration: MOTION_MS.deal, delay: Math.min(index * MOTION_MS.dealStagger, 140) });
          }
        });
      } else if (event.type === 'bet') {
        const marker = [...table.querySelectorAll('.bet-marker')].find((node) => node.dataset.playerId === event.playerId);
        animate(marker, [{ scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1 }], { duration: MOTION_MS.bet });
      } else if (event.type === 'collect') {
        const to = potCenter();
        for (const playerId of event.playerIds) {
          const plate = seatNode(table, playerId)?.querySelector('.plate');
          if (plate) flyChip(table, center(plate.getBoundingClientRect()), to, MOTION_MS.collect);
        }
      } else if (event.type === 'board') {
        const cards = [...table.querySelectorAll('#board .card')];
        for (let index = event.from; index < event.to; index += 1) {
          animate(cards[index], [{ rotate: 'y 90deg', opacity: 0.4 }, { rotate: 'y 0deg', opacity: 1 }],
            { duration: MOTION_MS.board, delay: (index - event.from) * MOTION_MS.boardStagger });
        }
      } else if (event.type === 'reveal') {
        for (const playerId of event.playerIds) {
          for (const card of seatNode(table, playerId)?.querySelectorAll('.seat-cards .card') ?? []) {
            animate(card, [{ rotate: 'y 90deg' }, { rotate: 'y 0deg' }], { duration: MOTION_MS.reveal });
          }
        }
      }
    }
  }

  /** Pot → winners, once, when the result frame first becomes visible live. */
  function playAward(playerIds, { table }) {
    if (!table || !playerIds.length || !enabled()) return;
    const from = center((table.querySelector('#pots') ?? table).getBoundingClientRect());
    for (const playerId of playerIds) {
      const plate = seatNode(table, playerId)?.querySelector('.plate');
      if (!plate) continue;
      flyChip(table, from, center(plate.getBoundingClientRect()), MOTION_MS.award);
      animate(plate, [{ scale: 1 }, { scale: 1.06 }, { scale: 1 }], { duration: MOTION_MS.award });
    }
  }

  return { play, playAward, cancel, get active() { return running.length + ghosts.length; } };
}
