// Clockwise from the button over seats still in the game (busted seats carry out:true).
export function seatedFromButton(state) {
  const n = state.seats.length;
  const order = [];
  for (let step = 0; step < n; step += 1) {
    const seat = state.seats[(state.button + step) % n];
    if (!seat.out) order.push(seat);
  }
  return order;
}

export function positionsOf(state) {
  const order = seatedFromButton(state);
  const labels = {};
  if (order.length === 2) {
    labels[order[0].playerId] = 'BTN/SB';
    labels[order[1].playerId] = 'BB';
    return labels;
  }
  const head = ['BTN', 'SB', 'BB'];
  order.forEach((seat, i) => {
    labels[seat.playerId] = i < 3 ? head[i] : `UTG${i === 3 ? '' : `+${i - 3}`}`;
  });
  if (order.length >= 5) labels[order[order.length - 1].playerId] = 'CO';
  return labels;
}
