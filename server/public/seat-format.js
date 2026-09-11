/** No private cards or replay objects are accepted by this state projector. */
export function seatPresentation(view, seat) {
  const out = view?.mode !== 'cash-training' && seat.out === true;
  const playing = view?.handInProgress !== false;
  const active = !out && playing && !view?.gameOver && view?.toAct === seat.playerId;
  const folded = !out && playing && Boolean(seat.folded);
  const allIn = !out && playing && Boolean(seat.allIn);
  const status = out ? '탈락' : allIn ? '올인' : folded ? '폴드' : active ? (seat.playerId === 'user' ? '내 차례' : '행동 중')
    : view?.mode !== 'cash-training' && typeof seat.out !== 'boolean' ? '상태 확인 불가' : '플레이 중';
  return {out, active, folded, allIn, status, showBacks: !out && playing && !folded && Boolean(view?.street),
    showButton: !out && playing && Boolean(seat.isButton),
    showBet: !out && playing && Number.isSafeInteger(seat.bet) && seat.bet > 0};
}
export function participantSummary(view) {
  const seats = view?.seats ?? [];
  if (view?.mode === 'cash-training') return `참가자 ${seats.length}명`;
  if (!seats.every(s => typeof s.out === 'boolean')) return `참가자 ${seats.length}명 · 상태 확인 불가`;
  return `남은 인원 ${seats.filter(s => !s.out).length} / ${seats.length}`;
}
const POINTS = {H:[50,100],L3:[0,78],L2:[0,54],L1:[0,29],T1:[28,4],T2:[72,4],TC:[50,4],R1:[100,29],R2:[100,54],R3:[100,78]};
const SLOTS = {2:['TC'],3:['T1','T2'],4:['L2','TC','R2'],5:['L2','T1','T2','R2'],6:['L3','L1','TC','R1','R3'],7:['L3','L1','T1','T2','R1','R3'],8:['L3','L2','L1','TC','R1','R2','R3'],9:['L3','L2','L1','T1','T2','R1','R2','R3']};
export function mobileSeatSlot(index, count) {
  const [x,y] = POINTS[index === 0 ? 'H' : SLOTS[count]?.[index-1]] ?? POINTS.H;
  return {x,y};
}

// Stadium rail coordinates, clockwise from the hero at the bottom.
export function ovalPoint(index, count, rx, ry) {
  const angle = (Math.PI * 2 * index) / count;
  const bulge = (v) => Math.sign(v) * Math.abs(v) ** (2 / 3);
  return {
    x: 50 - rx * bulge(Math.sin(angle)),
    y: 52 + ry * bulge(Math.cos(angle)),
  };
}

/** Public seat order and the dealer remain stable throughout a hand, even when
 * a blind folds or goes all-in. Never infer blind identity from the bet size. */
export function blindPositions(view) {
  if (view?.handInProgress === false || !view?.street) return {};
  const seats = view.seats ?? [];
  if (!seats.every(seat => typeof seat.out === 'boolean')) return {};
  const live = seats.filter(seat => !seat.out);
  const dealers = live.filter(seat => seat.isButton);
  if (live.length < 2 || dealers.length !== 1) return {};
  const at = live.indexOf(dealers[0]);
  const next = offset => live[(at + offset) % live.length].playerId;
  if (live.length === 2) return {[next(0)]: 'D/SB', [next(1)]: 'BB'};
  return {[next(0)]: 'D', [next(1)]: 'SB', [next(2)]: 'BB'};
}
