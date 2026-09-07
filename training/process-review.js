const STREETS = new Set(['preflop', 'flop', 'turn', 'river']);
const ACTIONS = new Set(['fold', 'check', 'call', 'bet', 'raise']);
const CHIP_KEYS = ['potBefore', 'currentBet', 'actorBet', 'toCall', 'minRaiseTo', 'maxRaiseTo', 'effectiveStack'];
const PRIOR_CHIP_KEYS = ['amount', 'potTotal', 'callAmount', 'minRaiseTo', 'maxRaiseTo', 'currentBet'];
const LEGAL_KEYS = ['decisionId', 'canCheck', 'canRaise', 'callAmount', 'minRaiseTo', 'maxRaiseTo'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const chips = (value) => Number.isSafeInteger(value) && value >= 0;
const handNumber = (value) => Number.isSafeInteger(value) && value > 0;
const decisionId = (value) => typeof value === 'string' && value.length <= 96
  && /^d-[1-9][0-9]*-(?:preflop|flop|turn|river)-[0-9]+$/.test(value);
const playerId = (value) => typeof value === 'string' && /^(?:user|p[1-9][0-9]?)$/.test(value);
const position = (value) => value === null || (typeof value === 'string'
  && /^(?:BTN(?:\/SB)?|SB|BB|CO|HJ|UTG(?:\+[1-9])?)$/.test(value));

function requireValue(condition) {
  if (!condition) throw new Error('PROCESS_SNAPSHOT_INVALID');
}

function cards(value, size) {
  requireValue(Array.isArray(value) && (size === undefined ? [0, 3, 4, 5].includes(value.length) : value.length === size)
    && value.every((card) => typeof card === 'string' && /^[2-9TJQKA][cdhs]$/.test(card))
    && new Set(value).size === value.length);
  return [...value];
}

function legalEvidence(snapshot) {
  const legal = snapshot?.legal;
  if (snapshot?.schemaVersion !== 2 || !object(legal)) {
    return { ok: false, code: 'LEGAL_EVIDENCE_MISSING' };
  }
  if (!decisionId(snapshot.decisionId) || legal.decisionId !== snapshot.decisionId
    || typeof legal.canCheck !== 'boolean' || typeof legal.canRaise !== 'boolean'
    || !['callAmount', 'minRaiseTo', 'maxRaiseTo'].every((key) => chips(legal[key]))
    || legal.canCheck !== (legal.callAmount === 0)
    || snapshot.toCall !== legal.callAmount || snapshot.minRaiseTo !== legal.minRaiseTo
    || snapshot.maxRaiseTo !== legal.maxRaiseTo) {
    return { ok: false, code: 'LEGAL_EVIDENCE_INVALID' };
  }
  return { ok: true, value: Object.fromEntries(LEGAL_KEYS.map((key) => [key, legal[key]])) };
}

function unavailable(snapshot, code) {
  // Even a malformed snapshot may contain outcome/private objects in normally public slots.
  // Only constrained identities and a fixed reason survive an unavailable decision.
  return {
    decisionId: decisionId(snapshot?.decisionId) ? snapshot.decisionId : null,
    handNo: handNumber(snapshot?.handNo) ? snapshot.handNo : null,
    processStatus: 'unavailable', unavailableReason: code,
  };
}

function projectDecision(snapshot) {
  const legal = legalEvidence(snapshot);
  if (!legal.ok) return unavailable(snapshot, legal.code);
  try {
    requireValue(handNumber(snapshot.handNo) && playerId(snapshot.actorId)
      && STREETS.has(snapshot.street) && position(snapshot.position)
      && ['tournament', 'cash-training'].includes(snapshot.gameMode)
      && typeof snapshot.forced === 'boolean'
      && snapshot.decisionId.startsWith(`d-${snapshot.handNo}-${snapshot.street}-`)
      && CHIP_KEYS.every((key) => chips(snapshot[key])));
    const holeCards = cards(snapshot.holeCards, 2);
    const board = cards(snapshot.board, { preflop: 0, flop: 3, turn: 4, river: 5 }[snapshot.street]);
    requireValue(new Set([...holeCards, ...board]).size === holeCards.length + board.length);
    requireValue(Array.isArray(snapshot.blinds) && snapshot.blinds.length === 2
      && snapshot.blinds.every((value) => chips(value) && value > 0));
    requireValue(object(snapshot.chosenAction) && ACTIONS.has(snapshot.chosenAction.action)
      && chips(snapshot.chosenAction.amount));
    requireValue(Array.isArray(snapshot.publicSeats) && snapshot.publicSeats.length >= 2
      && snapshot.publicSeats.length <= 10);
    const publicSeats = snapshot.publicSeats.map((seat) => {
      requireValue(object(seat) && playerId(seat.playerId) && position(seat.position)
        && ['stack', 'bet', 'contribution'].every((key) => chips(seat[key]))
        && ['folded', 'allIn', 'out'].every((key) => typeof seat[key] === 'boolean'));
      return {
        playerId: seat.playerId, position: seat.position, stack: seat.stack, bet: seat.bet,
        contribution: seat.contribution, folded: seat.folded, allIn: seat.allIn, out: seat.out,
      };
    });
    const ids = new Set(publicSeats.map((seat) => seat.playerId));
    requireValue(ids.size === publicSeats.length && ids.has(snapshot.actorId));
    requireValue(Array.isArray(snapshot.priorActions) && snapshot.priorActions.length <= 1024);
    const currentIndex = Number(snapshot.decisionId.split('-').at(-1));
    requireValue(snapshot.priorActions.length === currentIndex);
    const streetOrder = ['preflop', 'flop', 'turn', 'river'];
    let priorStreet = 0;
    const priorActions = snapshot.priorActions.map((action, index) => {
      requireValue(object(action) && decisionId(action.decisionId) && ids.has(action.playerId)
        && ACTIONS.has(action.action) && STREETS.has(action.street)
        && PRIOR_CHIP_KEYS.every((key) => chips(action[key])) && object(action.stacks));
      const actionStreet = streetOrder.indexOf(action.street);
      requireValue(action.decisionId === `d-${snapshot.handNo}-${action.street}-${index}`
        && actionStreet >= priorStreet && actionStreet <= streetOrder.indexOf(snapshot.street));
      priorStreet = actionStreet;
      const actionBoard = cards(action.board, { preflop: 0, flop: 3, turn: 4, river: 5 }[action.street]);
      requireValue(actionBoard.every((card, cardIndex) => card === board[cardIndex]));
      const stacks = {};
      for (const id of ids) {
        requireValue(chips(action.stacks[id]));
        stacks[id] = action.stacks[id];
      }
      return {
        decisionId: action.decisionId, playerId: action.playerId, action: action.action,
        ...Object.fromEntries(PRIOR_CHIP_KEYS.map((key) => [key, action[key]])),
        street: action.street, board: actionBoard, stacks,
      };
    });
    return {
      schemaVersion: 2, decisionId: snapshot.decisionId, gameMode: snapshot.gameMode,
      handNo: snapshot.handNo, actorId: snapshot.actorId, street: snapshot.street,
      position: snapshot.position, holeCards, board, blinds: [...snapshot.blinds],
      ...Object.fromEntries(CHIP_KEYS.map((key) => [key, snapshot[key]])),
      forced: snapshot.forced,
      chosenAction: { action: snapshot.chosenAction.action, amount: snapshot.chosenAction.amount },
      publicSeats, priorActions, legal: legal.value, processStatus: 'available',
    };
  } catch {
    return unavailable(snapshot, 'PROCESS_SNAPSHOT_INVALID');
  }
}

export function toProcessReview(record, { viewerId = 'user' } = {}) {
  const snapshots = Array.isArray(record?.decisions)
    ? record.decisions.filter((snapshot) => snapshot?.actorId === viewerId)
    : [];
  const decisions = snapshots.map(projectDecision);
  const unavailableReasons = decisions
    .filter((decision) => decision.processStatus === 'unavailable')
    .map((decision) => ({
      decisionId: decision.decisionId ?? null,
      code: decision.unavailableReason,
    }));
  if (decisions.length === 0) {
    unavailableReasons.push({ decisionId: null, code: 'DECISION_SNAPSHOT_MISSING' });
  }
  return {
    schemaVersion: 1,
    handNo: Number.isInteger(record?.handNo)
      ? record.handNo
      : (Number.isInteger(decisions[0]?.handNo) ? decisions[0].handNo : null),
    decisions,
    unavailableReasons,
  };
}

export function buildProcessInput(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const hands = list.map((record) => toProcessReview(record, options));
  return {
    schemaVersion: 1,
    hands,
    unavailableReasons: hands.flatMap((hand) => hand.unavailableReasons.map((reason) => ({
      handNo: hand.handNo,
      ...reason,
    }))),
  };
}
