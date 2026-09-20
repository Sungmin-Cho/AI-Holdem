// An internal relay audience, never an engine seat or a browser-selected role.
export const SPECTATOR_ID = 'spectator';

export function viewerRole(view, seat) {
  if (!view) return 'unavailable';
  if (view.gameOver) return 'finished';
  if (seat === SPECTATOR_ID || (view.mode !== 'cash-training'
    && view.seats?.some(row => row.playerId === seat && row.out === true))) return 'spectator';
  return 'player';
}

export function spectatorAudience(view, seat) {
  return seat === SPECTATOR_ID || viewerRole(view, seat) === 'spectator';
}
