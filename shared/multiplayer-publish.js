import { HOST_ID, humanIdsOf, isHumanSeat } from './seat-roles.js';

export const NARRATION_CODES = Object.freeze({
  LEVEL_UP: ['sb', 'bb'],
  TIMEOUT_CHECK: ['playerId'],
  TIMEOUT_FOLD: ['playerId'],
  RESYNC: [],
  ILLEGAL_RETRY: [],
});

const SEAT_ID_RE = /^(?:user|h[1-8]|p[1-9]\d?)$/;
const CARD_RE = /^[2-9TJQKA][cdhs]$/;
const STREET = new Set(['preflop', 'flop', 'turn', 'river']);
const ACTION = new Set(['fold', 'check', 'call', 'raise']);
const DECISION_ID_RE = /^d-[1-9]\d*-(?:preflop|flop|turn|river)-\d+$/;
const RESULT = new Set(['win', 'lose', 'completed', 'abort']);
const SUIT_CLASS = { s: '[s♠♤]', h: '[h♥♡]', d: '[d♦♢]', c: '[c♣♧]' };

function coded(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function fail(code, message) {
  throw coded(code, message);
}

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function int(value) {
  return Number.isInteger(value);
}

function seatId(value) {
  return typeof value === 'string' && SEAT_ID_RE.test(value);
}

function cards(value) {
  return Array.isArray(value) && value.every((card) => typeof card === 'string' && CARD_RE.test(card));
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function allowKeys(object, allowed) {
  return Object.keys(object).every((key) => allowed.has(key));
}

const VIEW_KEYS = new Set([
  'handNo', 'handInProgress', 'level', 'levelEvery', 'blinds', 'street', 'board',
  'pots', 'seats', 'toAct', 'myCards', 'gameOver', 'legal', 'result', 'dealBias',
  'mode', 'handLimit', 'sessionNet', 'viewer', 'winnerId',
]);
const SEAT_KEYS = new Set(['playerId', 'name', 'stack', 'out', 'bet', 'folded', 'allIn', 'isButton', 'kind']);
const POT_KEYS = new Set(['potIndex', 'amount', 'eligible', 'winners']);
const WINNER_KEYS = new Set(['playerId', 'share']);
const LEGAL_KEYS = new Set([
  'stateVersion', 'decisionId', 'handNo', 'street', 'toAct', 'canCheck', 'callAmount',
  'canRaise', 'minRaiseTo', 'maxRaiseTo', 'potTotal', 'handOver', 'gameOver',
  'bustedPlayerIds',
]);

function validateViewShape(view, id) {
  if (!isPlain(view) || !allowKeys(view, VIEW_KEYS)) fail('BAD_VIEWS', `view ${id} has unknown keys`);
  if (!int(view.handNo) || typeof view.handInProgress !== 'boolean' || !int(view.level)
    || !(view.levelEvery === null || int(view.levelEvery))
    || !Array.isArray(view.blinds) || view.blinds.length !== 2 || !view.blinds.every(int)
    || !(view.street === null || STREET.has(view.street))
    || !cards(view.board)
    || !Array.isArray(view.pots) || !Array.isArray(view.seats)
    || !(view.toAct === null || seatId(view.toAct))
    || !cards(view.myCards)
    || typeof view.gameOver !== 'boolean'
    || view.viewer !== id) {
    fail('BAD_VIEWS', `view ${id} failed type schema`);
  }
  if (typeof view.result === 'string' && !RESULT.has(view.result)) fail('BAD_VIEWS', 'result');
  if (view.street !== undefined && typeof view.street === 'string' && CARD_RE.test(view.street)) {
    fail('BAD_VIEWS', 'street looks like a card');
  }
  if (typeof view.result === 'string' && /[2-9TJQKA][cdhs]/.test(view.result)) {
    fail('BAD_VIEWS', 'result contains cards');
  }
  for (const pot of view.pots) {
    if (!isPlain(pot) || !allowKeys(pot, POT_KEYS) || !int(pot.potIndex) || !int(pot.amount)
      || !Array.isArray(pot.eligible) || !pot.eligible.every(seatId)
      || (pot.winners !== undefined && !Array.isArray(pot.winners))) fail('BAD_VIEWS', 'pot');
    for (const winner of pot.winners ?? []) {
      if (!isPlain(winner) || !allowKeys(winner, WINNER_KEYS) || !seatId(winner.playerId) || !int(winner.share)) {
        fail('BAD_VIEWS', 'pot winner');
      }
    }
  }
  for (const seat of view.seats) {
    if (!isPlain(seat) || !allowKeys(seat, SEAT_KEYS) || !seatId(seat.playerId)
      || typeof seat.name !== 'string' || !int(seat.stack) || typeof seat.out !== 'boolean'
      || !int(seat.bet) || typeof seat.folded !== 'boolean' || typeof seat.allIn !== 'boolean'
      || typeof seat.isButton !== 'boolean' || !['human', 'ai'].includes(seat.kind)) {
      fail('BAD_VIEWS', 'seat');
    }
  }
  if (view.legal !== undefined) {
    const legal = view.legal;
    if (!isPlain(legal) || !allowKeys(legal, LEGAL_KEYS) || !int(legal.stateVersion)
      || typeof legal.decisionId !== 'string' || !DECISION_ID_RE.test(legal.decisionId)
      || !int(legal.handNo) || !STREET.has(legal.street) || !seatId(legal.toAct)
      || typeof legal.canCheck !== 'boolean' || !int(legal.callAmount)
      || typeof legal.canRaise !== 'boolean' || !int(legal.minRaiseTo) || !int(legal.maxRaiseTo)
      || !int(legal.potTotal) || typeof legal.handOver !== 'boolean' || typeof legal.gameOver !== 'boolean'
      || legal.toAct !== id
      || (legal.bustedPlayerIds !== undefined && (!Array.isArray(legal.bustedPlayerIds) || !legal.bustedPlayerIds.every(seatId)))) {
      fail('BAD_VIEWS', `legal for ${id}`);
    }
  }
}

export function validateViewsAgainstEngine(views, { players, engineState, view } = {}) {
  if (!isPlain(views)) fail('BAD_VIEWS', 'views is not an object');
  const playerHumans = (Array.isArray(players) ? players : [])
    .filter((row) => isHumanSeat(row) || row?.playerId === HOST_ID || /^h[1-8]$/.test(row?.playerId))
    .map((row) => row.playerId)
    .sort();
  const seatHumans = humanIdsOf(engineState?.seats ?? []).slice().sort();
  const viewKeys = Object.keys(views).sort();
  if (viewKeys.join(',') !== playerHumans.join(',') || viewKeys.join(',') !== seatHumans.join(',')) {
    fail('BAD_VIEWS', 'views keys do not bind human seats');
  }
  if (view !== undefined && !deepEqual(views[HOST_ID], view)) fail('BAD_VIEWS', 'views.user !== view');
  const source = engineState.hand ?? engineState.lastHand;
  const legalViews = [];
  for (const id of viewKeys) {
    const row = views[id];
    validateViewShape(row, id);
    const expectedCards = source?.holes?.[id] ?? [];
    if (!deepEqual(row.myCards, expectedCards)) fail('BAD_VIEWS', `myCards for ${id}`);
    if (!deepEqual(row.board, source?.board ?? [])) fail('BAD_VIEWS', 'board');
    if (row.handNo !== engineState.handNo) fail('BAD_VIEWS', 'handNo');
    if (row.toAct !== views[viewKeys[0]].toAct) fail('BAD_VIEWS', 'toAct mismatch');
    for (const seat of row.seats) {
      const engineSeat = engineState.seats.find((entry) => entry.playerId === seat.playerId);
      if (!engineSeat || engineSeat.name !== seat.name || Boolean(engineSeat.out) !== seat.out
        || engineSeat.stack !== seat.stack
        || (isHumanSeat(engineSeat) ? 'human' : 'ai') !== seat.kind) {
        fail('BAD_VIEWS', `seat ${seat.playerId} does not bind engine`);
      }
    }
    if (row.legal) legalViews.push(row);
  }
  const hand = engineState.hand;
  const acting = hand && engineState.seats[hand.toActIdx];
  const expectLegal = Boolean(acting && isHumanSeat(acting));
  if (expectLegal) {
    if (legalViews.length !== 1 || legalViews[0].viewer !== acting.playerId) fail('BAD_VIEWS', 'legal owner');
    const legal = legalViews[0].legal;
    const decisionId = `d-${engineState.handNo}-${hand.street}-${hand.actionIndex}`;
    if (legal.decisionId !== decisionId || legal.stateVersion !== engineState.stateVersion
      || legal.toAct !== acting.playerId) {
      fail('BAD_VIEWS', 'legal identity');
    }
  } else if (legalViews.length !== 0) {
    fail('BAD_VIEWS', 'legal present off-turn');
  }
  return views;
}

export function validateResultHold(hold, view) {
  if (hold === undefined || hold === null) return hold;
  const keys = ['handNo', 'startAt', 'until', 'runoutStepMs', 'runoutStreets'];
  if (!isPlain(hold) || ![Object.prototype, null].includes(Object.getPrototypeOf(hold))
    || Object.keys(hold).length !== keys.length || !keys.every(key => Object.hasOwn(hold, key))
    || !Number.isSafeInteger(hold.handNo) || hold.handNo < 1
    || typeof hold.startAt !== 'string' || typeof hold.until !== 'string'
    || !Number.isFinite(Date.parse(hold.startAt)) || !Number.isFinite(Date.parse(hold.until))
    || Date.parse(hold.until) < Date.parse(hold.startAt)
    || Date.parse(hold.until) - Date.parse(hold.startAt) > 60000
    || !int(hold.runoutStepMs) || hold.runoutStepMs < 0 || hold.runoutStepMs > 5000
    || !int(hold.runoutStreets) || hold.runoutStreets < 0 || hold.runoutStreets > 3
    || view?.handInProgress !== false || view.handNo !== hold.handNo) fail('BAD_RESULT_HOLD');
  return hold;
}

export function validateTurnDeadline(turnDeadline, nextDecision) {
  if (turnDeadline === undefined || turnDeadline === null) return turnDeadline;
  if (!isPlain(turnDeadline) || typeof turnDeadline.decisionId !== 'string'
    || typeof turnDeadline.at !== 'string' || Number.isNaN(Date.parse(turnDeadline.at))
    || Object.keys(turnDeadline).some((key) => key !== 'decisionId' && key !== 'at')) {
    fail('BAD_TURN_DEADLINE', 'turnDeadline shape');
  }
  if (!nextDecision || turnDeadline.decisionId !== nextDecision.decisionId) {
    fail('BAD_TURN_DEADLINE', 'turnDeadline decisionId');
  }
  return turnDeadline;
}

const EVENT_BASE = new Set(['seq', 'visibility', 'type']);
export const EVENT_SCHEMAS = Object.freeze({
  hand_start: { keys: new Set([...EVENT_BASE, 'handNo', 'level', 'blinds', 'button']), payload: ['handNo', 'level', 'blinds', 'button'] },
  level_up: { keys: new Set([...EVENT_BASE, 'level', 'sb', 'bb']) },
  blinds_posted: { keys: new Set([...EVENT_BASE, 'sb', 'bb', 'posts']) },
  street: { keys: new Set([...EVENT_BASE, 'street', 'board']) },
  showdown: { keys: new Set([...EVENT_BASE, 'reveals', 'mucks']) },
  pot_award: { keys: new Set([...EVENT_BASE, 'potIndex', 'amount', 'winners']) },
  bust: { keys: new Set([...EVENT_BASE, 'playerId']) },
  game_over: { keys: new Set([...EVENT_BASE, 'result', 'bustedPlayerIds', 'winnerId']) },
  action: { keys: new Set([...EVENT_BASE, 'playerId', 'action', 'street', 'amount', 'allIn']) },
});

function payloadOf(event) {
  const payload = { ...event };
  delete payload.seq;
  delete payload.visibility;
  delete payload.type;
  return payload;
}

export function validateEventsAgainstEngine(events, engineState) {
  if (events === undefined) return events;
  if (!Array.isArray(events)) fail('BAD_EVENTS', 'events');
  const source = engineState.hand ?? engineState.lastHand;
  for (const event of events) {
    if (!isPlain(event) || event.visibility !== 'public' || !int(event.seq)
      || !EVENT_SCHEMAS[event.type] || !allowKeys(event, EVENT_SCHEMAS[event.type].keys)) {
      fail('BAD_EVENTS', `event ${event?.type ?? '?'}`);
    }
    const type = event.type;
    if (type === 'hand_start') {
      const handNo = engineState.hand ? engineState.handNo : source?.handNo;
      if (!int(event.handNo) || !int(event.level) || !Array.isArray(event.blinds) || !seatId(event.button)
        || event.handNo !== handNo) fail('BAD_EVENTS', 'hand_start');
    } else if (type === 'level_up') {
      if (!int(event.level) || !int(event.sb) || !int(event.bb)) fail('BAD_EVENTS', 'level_up');
    } else if (type === 'blinds_posted') {
      if (!int(event.sb) || !int(event.bb) || !Array.isArray(event.posts)) fail('BAD_EVENTS', 'blinds_posted');
      for (const post of event.posts) {
        if (!isPlain(post) || !seatId(post.playerId) || !int(post.amount) || typeof post.allIn !== 'boolean'
          || !allowKeys(post, new Set(['playerId', 'amount', 'allIn']))) fail('BAD_EVENTS', 'post');
      }
    } else if (type === 'street') {
      if (!STREET.has(event.street) || !cards(event.board)) fail('BAD_EVENTS', 'street');
      const board = source?.board ?? [];
      if (event.board.length > board.length || event.board.some((card, i) => card !== board[i])) {
        fail('BAD_EVENTS', 'street.board prefix');
      }
      const expectedStreet = { 0: 'preflop', 3: 'flop', 4: 'turn', 5: 'river' }[event.board.length];
      if (expectedStreet && event.street !== expectedStreet) fail('BAD_EVENTS', 'street length');
    } else if (type === 'showdown') {
      if (engineState.hand !== null) fail('BAD_EVENTS', 'showdown while hand open');
      if (!deepEqual({ reveals: event.reveals, mucks: event.mucks }, engineState.lastHand?.showdown)) {
        fail('BAD_EVENTS', 'showdown payload');
      }
    } else if (type === 'pot_award') {
      if (engineState.hand !== null) fail('BAD_EVENTS', 'pot_award while hand open');
      const pot = engineState.lastHand?.pots?.[event.potIndex];
      if (!pot || pot.amount !== event.amount || !deepEqual(pot.winners, event.winners)) {
        fail('BAD_EVENTS', 'pot_award');
      }
    } else if (type === 'bust') {
      if (engineState.hand !== null || !seatId(event.playerId)) fail('BAD_EVENTS', 'bust');
    } else if (type === 'game_over') {
      if (engineState.hand !== null) fail('BAD_EVENTS', 'game_over while hand open');
      if (event.result !== engineState.result) fail('BAD_EVENTS', 'game_over result');
      if (event.winnerId !== undefined && event.winnerId !== engineState.winnerId) fail('BAD_EVENTS', 'winnerId');
    } else if (type === 'action') {
      if (!seatId(event.playerId) || !ACTION.has(event.action) || !STREET.has(event.street)) {
        fail('BAD_EVENTS', 'action');
      }
    }
  }
  return events;
}

export function validateMessages(messages, { multi } = {}) {
  if (messages === undefined) return messages;
  if (!Array.isArray(messages)) fail('BAD_MESSAGES', 'messages');
  for (const message of messages) {
    if (!isPlain(message) || message.type !== 'narration') fail('BAD_MESSAGES', 'type');
    if (typeof message.text === 'string') {
      if (multi) fail('BAD_MESSAGES', 'legacy text');
      continue;
    }
    if (typeof message.code !== 'string' || !(message.code in NARRATION_CODES)) fail('BAD_MESSAGES', 'code');
    const allowed = new Set(NARRATION_CODES[message.code]);
    const params = message.params ?? {};
    if (!isPlain(params) || !allowKeys(params, allowed)) fail('BAD_MESSAGES', 'params');
    for (const [key, value] of Object.entries(params)) {
      if (!(int(value) || seatId(value))) fail('BAD_MESSAGES', `param ${key}`);
    }
  }
  return messages;
}

function walkStrings(value, visit) {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach((entry) => walkStrings(entry, visit));
  else if (isPlain(value)) Object.values(value).forEach((entry) => walkStrings(entry, visit));
}

export function hostTextFieldsOf(body) {
  const fields = [];
  for (const note of body.coach ?? []) {
    const handNo = note?.handNo;
    walkStrings(note, (text) => fields.push({ handNo, text }));
  }
  for (const item of body.training ?? []) {
    walkStrings(item, (text) => fields.push({ handNo: item?.handNo, text }));
  }
  const annotations = body.trainingAnnotations;
  const rows = Array.isArray(annotations) ? annotations : Object.values(annotations ?? {}).flatMap((fieldsMap) => Object.values(fieldsMap ?? {}));
  for (const row of rows) {
    const evaluationId = row?.evaluationId;
    const handNo = typeof evaluationId === 'string'
      ? Number(/:d-([1-9]\d*)-/.exec(evaluationId)?.[1])
      : row?.handNo;
    if (typeof row?.value === 'string') fields.push({ handNo, text: row.value });
  }
  return fields;
}

export function cardTokenLeaks(text, cardList) {
  if (typeof text !== 'string' || !text) return false;
  for (const card of cardList) {
    if (typeof card !== 'string' || !CARD_RE.test(card)) continue;
    const rank = card[0];
    const suit = card[1];
    const latin = new RegExp(`(?<![A-Za-z0-9])${rank}${suit}(?![A-Za-z0-9])`);
    const unicode = new RegExp(`(?<![A-Za-z0-9])${rank}${SUIT_CLASS[suit]}(?![A-Za-z0-9])`, 'u');
    if (unicode.test(text) && !latin.test(text) && /[♠♥♦♣♤♡♢♧]/.test(text)) return true;
    if (latin.test(text)) {
      if (card === 'As' && /(?<![A-Za-z0-9])As(?=\s+[a-z])/.test(text)
        && !latin.test(text.replace(/(?<![A-Za-z0-9])As(?=\s+[a-z])/g, 'XX'))) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function hiddenParticipantCards(record, humanIds) {
  const revealed = new Set((record?.showdown?.reveals ?? []).map((row) => row.playerId));
  const ids = humanIds ?? Object.keys(record?.holes ?? {}).filter((id) => /^h[1-8]$/.test(id));
  const cards = [];
  for (const id of ids) {
    if (id === HOST_ID || revealed.has(id)) continue;
    if (Array.isArray(record?.holes?.[id])) cards.push(...record.holes[id]);
  }
  return cards;
}

export function assertHostText(body, lookupRecord) {
  for (const field of hostTextFieldsOf(body)) {
    if (!Number.isInteger(field.handNo)) continue;
    const record = lookupRecord(field.handNo);
    if (!record) fail('FORBIDDEN_LITERAL_UNAVAILABLE', `hand ${field.handNo}`);
    const ids = humanIdsOf(record.seats ?? []).filter((id) => id !== HOST_ID);
    if (cardTokenLeaks(field.text, hiddenParticipantCards(record, ids.length ? ids : undefined))) {
      fail('FORBIDDEN_LITERAL', 'host text');
    }
  }
}

export function projectForSeat(payload, seat) {
  if (!payload || typeof payload !== 'object') return {};
  if (seat === HOST_ID) {
    const out = { ...payload };
    delete out.views;
    return out;
  }
  const projected = {};
  if (payload.views?.[seat] !== undefined) projected.view = payload.views[seat];
  if (payload.events !== undefined) projected.events = payload.events;
  if (payload.messages !== undefined) projected.messages = payload.messages;
  if (payload.turnDeadline !== undefined) projected.turnDeadline = payload.turnDeadline;
  if (payload.resultHold !== undefined) projected.resultHold = payload.resultHold;
  return projected;
}

export function nextDecisionFromViews(views) {
  if (!isPlain(views)) return null;
  for (const view of Object.values(views)) {
    if (view?.legal?.decisionId) {
      return { decisionId: view.legal.decisionId, toAct: view.legal.toAct ?? HOST_ID };
    }
  }
  return null;
}
