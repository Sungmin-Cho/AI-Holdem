// Deliberately conservative, public-information-only heuristic support.
const STREETS = ['preflop', 'flop', 'turn', 'river'];
const order = (position) => ({SB:0,BB:1,UTG:2,HJ:18,CO:20,BTN:21,'BTN/SB':21})[position]
  ?? (/^UTG\+\d+$/.test(position ?? '') ? 2 + Number(position.slice(4)) : null);

export function publicLine(snapshot) {
  const actor = snapshot.actorId;
  const seats = snapshot.publicSeats;
  const actions = snapshot.priorActions;
  const streetIndex = STREETS.indexOf(snapshot.street);
  const denied = { eligible: false, reason: 'unsupported-line', inPosition: false };
  if (!actor || !Array.isArray(seats) || !Array.isArray(actions) || streetIndex < 1) return denied;
  if (![snapshot.toCall,snapshot.currentBet,snapshot.actorBet].every(Number.isFinite)
    || snapshot.toCall > 0 || snapshot.currentBet > snapshot.actorBet) return denied;
  const opponents = seats.filter(seat => seat.playerId !== actor && !seat.out && !seat.folded);
  if (opponents.length !== 1 || opponents.some(seat => seat.allIn)) return denied;
  const actorOrder = order(snapshot.position), opponentOrder = order(opponents[0].position);
  if (actorOrder === null || opponentOrder === null) return denied;
  if (actions.some(row => !row.playerId || !STREETS.includes(row.street)
    || !['fold','check','call','raise'].includes(row.action))) return denied;
  const inPosition = actorOrder > opponentOrder;
  const current = actions.filter(row => row.street === snapshot.street);
  const previous = actions.filter(row => row.street === STREETS[streetIndex - 1]);
  const ownPrevious = previous.filter(row => row.playerId === actor).at(-1);
  const lastRaise = previous.filter(row => row.action === 'raise').at(-1);
  if (current.some(row => row.action === 'raise' || row.action === 'call' || row.action === 'fold' || row.playerId === actor)) return {...denied,inPosition};
  const checkedTo = current.some(row => row.playerId === opponents[0].playerId && row.action === 'check');
  const initiative = lastRaise?.playerId === actor && ownPrevious?.action === 'raise';
  const checkedThrough = previous.length >= 2 && previous.every(row => row.action === 'check');
  const positionalProbe = inPosition && checkedTo && (streetIndex === 1 || checkedThrough);
  return { eligible: initiative || positionalProbe, inPosition,
    reason: initiative ? 'initiative' : positionalProbe ? 'checked-to-probe' : 'unsupported-line' };
}

export function hasPublicDraw(snapshot) {
  if (!['flop','turn'].includes(snapshot.street)) return false;
  const hole = snapshot.holeCards ?? [], cards = [...hole,...(snapshot.board ?? [])];
  if (hole.length !== 2) return false;
  if ('cdhs'.split('').some(suit => cards.filter(card => card[1] === suit).length === 4 && hole.some(card => card[1] === suit))) return true;
  const ranks = new Set(cards.map(card => '23456789TJQKA'.indexOf(card[0]) + 2));
  if (ranks.has(14)) ranks.add(1);
  for (let low = 1; low <= 10; low++) {
    const run = Array.from({length:5}, (_,i)=>low+i);
    if (run.filter(rank=>ranks.has(rank)).length === 4
      && hole.some(card => run.includes('23456789TJQKA'.indexOf(card[0])+2) || (card[0] === 'A' && run.includes(1)))) return true;
  }
  return false;
}

export function positionSizeMix(position) {
  // Position already changes participation via public strength. Keep sizing
  // independent of hole strength: both value and bluffs share this mixture.
  return ({UTG:0.8,'UTG+1':0.75,'UTG+2':0.7,HJ:0.7,CO:0.65,BTN:0.6,'BTN/SB':0.6,SB:0.75,BB:0.75})[position] ?? 0.7;
}
