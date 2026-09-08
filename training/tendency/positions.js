export function positionsFromRecord(record) {
  const startStacks = record?.startStacks;
  if (!startStacks || typeof startStacks !== 'object' || Array.isArray(startStacks)) {
    return { seated: 0 };
  }
  const deal = Object.keys(startStacks);
  const button = record.button;
  const btnIndex = deal.indexOf(button);
  const order = btnIndex < 0
    ? deal
    : [...deal.slice(btnIndex), ...deal.slice(0, btnIndex)];
  const labels = {};
  if (order.length === 2) {
    labels[order[0]] = 'BTN/SB';
    labels[order[1]] = 'BB';
  } else {
    const head = ['BTN', 'SB', 'BB'];
    order.forEach((playerId, i) => {
      labels[playerId] = i < 3 ? head[i] : `UTG${i === 3 ? '' : `+${i - 3}`}`;
    });
    if (order.length >= 5) labels[order[order.length - 1]] = 'CO';
  }
  return { ...labels, seated: order.length };
}
