const ENGINE_TO_TRAINING_6MAX = Object.freeze({
  UTG: 'UTG',
  'UTG+1': 'HJ',
  HJ: 'HJ',
  CO: 'CO',
  BTN: 'BTN',
  SB: 'SB',
  BB: 'BB',
});

const SIZE_TOLERANCE_BB = 0.05;

export function trainingPosition(engineLabel, { seated = 6 } = {}) {
  if (seated === 2) {
    if (engineLabel === 'BTN/SB' || engineLabel === 'BTN') return 'BTN';
    if (engineLabel === 'BB') return 'BB';
  }
  return ENGINE_TO_TRAINING_6MAX[engineLabel] ?? null;
}

function bbOf(snapshot) {
  const blinds = snapshot.blinds;
  if (!Array.isArray(blinds) || blinds.length < 2) return null;
  return blinds[1];
}

function sizeBb(snapshot) {
  const bb = bbOf(snapshot);
  if (!bb) return null;
  const amount = snapshot.chosenAction?.amount ?? 0;
  if (snapshot.chosenAction?.action !== 'raise') return null;
  return amount / bb;
}

function liveSeats(snapshot) {
  return (snapshot.publicSeats ?? []).filter((seat) => !seat.out);
}

function priorRaises(snapshot) {
  return (snapshot.priorActions ?? []).filter((action) => action.action === 'raise');
}

export function normalizePreflopSpot(snapshot) {
  if (snapshot.street !== 'preflop') {
    return { ok: false, code: 'UNSUPPORTED_SPOT', reason: 'preflop only' };
  }
  const live = liveSeats(snapshot);
  if (live.length !== 6) {
    return { ok: false, code: 'UNSUPPORTED_SPOT', reason: '6-max only' };
  }
  const bb = bbOf(snapshot);
  if (!bb) return { ok: false, code: 'UNSUPPORTED_STACK', reason: 'blinds missing' };
  const stackBb = snapshot.effectiveStack / bb;
  if (Math.abs(stackBb - 100) > 1) {
    return { ok: false, code: 'UNSUPPORTED_STACK', reason: '100bb only' };
  }
  const pos = trainingPosition(snapshot.position, { seated: 6 });
  if (!pos) return { ok: false, code: 'UNSUPPORTED_SPOT', reason: 'unknown position' };

  const raises = priorRaises(snapshot);
  const chosen = snapshot.chosenAction?.action;
  let context;
  if (raises.length === 0) {
    context = 'rfi-unopened';
    if (chosen === 'raise') {
      const size = sizeBb(snapshot);
      if (size == null || Math.abs(size - 2.5) > SIZE_TOLERANCE_BB) {
        return { ok: false, code: 'UNSUPPORTED_SIZE', reason: 'RFI size must be 2.5bb' };
      }
    }
  } else if (raises.length === 1) {
    context = 'vs-single-raise';
    if (chosen === 'raise') {
      const size = sizeBb(snapshot);
      if (size == null || Math.abs(size - 8.5) > SIZE_TOLERANCE_BB) {
        return { ok: false, code: 'UNSUPPORTED_SIZE', reason: '3bet size must be 8.5bb' };
      }
    }
  } else {
    return { ok: false, code: 'UNSUPPORTED_SPOT', reason: 'multiway / 4bet tree unsupported' };
  }

  return {
    ok: true,
    spotKey: `6max-100bb-${pos.toLowerCase()}-${context}`,
    position: pos,
    context,
  };
}
