import { extractJsonLine } from './player-runtime.js';
import { normalizeFreeText, REASON_MAX_CHARS, REASON_MAX_BYTES } from '../shared/free-text.js';

export const REJECTION_DETAILS = Object.freeze(['legal_line_missing', 'no_json', 'decision_id_mismatch',
  'unknown_action', 'bet_unavailable', 'bet_ambiguous', 'check_not_allowed', 'call_not_allowed',
  'raise_not_allowed', 'amount_not_integer', 'amount_out_of_range', 'engine_rejected']);
export const CORRECTABLE_DETAILS = new Set(REJECTION_DETAILS.filter(x => x !== 'legal_line_missing'));
export const DIAGNOSTIC_ACTIONS = Object.freeze(['fold', 'check', 'call', 'raise', 'bet', 'all-in', 'allin']);
export const REJECTION_CODES = Object.freeze(['INVALID_DECISION', 'ILLEGAL_ACTION']);
export const RAW_KINDS = Object.freeze(['not_string', 'no_object', 'unparseable_object']);
export const LENGTH_BUCKETS = Object.freeze(['lt64', 'lt256', 'lt1024', 'ge1024']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keysWithin = (x, keys) => object(x) && Reflect.ownKeys(x).every(k => keys.includes(k));
const exactKeys = (x, keys) => keysWithin(x, keys) && keys.every(k => Object.hasOwn(x, k));
const bad = reason => ({ ok:false, reason });
const callNumber = n => Number.isInteger(n) && n >= 1 && n <= 3;

export function legalFromMessage(message) {
  if (typeof message !== 'string') return null;
  const match = /legal 수치: canCheck=(true|false) callAmount=(\d+) canRaise=(true|false) minRaiseTo=(\d+) maxRaiseTo=(\d+)(?: currentBet=(\d+))?/.exec(message);
  if (!match) return null;
  return { canCheck:match[1] === 'true', callAmount:Number(match[2]), canRaise:match[3] === 'true',
    minRaiseTo:Number(match[4]), maxRaiseTo:Number(match[5]), currentBet:match[6] === undefined ? null : Number(match[6]) };
}

export function safeRejectionProjection(parsed, next) {
  return { action:DIAGNOSTIC_ACTIONS.includes(parsed?.action) ? parsed.action : 'unknown',
    ...(Number.isSafeInteger(parsed?.amount) ? { amount:parsed.amount } : {}),
    decisionIdMatches:typeof next?.decisionId === 'string' && parsed?.decisionId === next.decisionId };
}

export function rawDiagnostics(raw) {
  if (typeof raw !== 'string') return { kind:'not_string', lengthBucket:null, hasObjectCandidate:false };
  let count = 0;
  for (const _ of raw) { if (++count >= 1024) break; }
  const hasObjectCandidate = raw.includes('{');
  return { kind:hasObjectCandidate ? 'unparseable_object' : 'no_object',
    lengthBucket:count < 64 ? 'lt64' : count < 256 ? 'lt256' : count < 1024 ? 'lt1024' : 'ge1024', hasObjectCandidate };
}

export function validateRawDiagnostics(x) {
  if (!exactKeys(x, ['kind', 'lengthBucket', 'hasObjectCandidate'])) return bad('keys');
  if (!RAW_KINDS.includes(x.kind) || typeof x.hasObjectCandidate !== 'boolean') return bad('value');
  if (x.kind === 'not_string') return x.lengthBucket === null && !x.hasObjectCandidate ? {ok:true} : bad('value');
  return LENGTH_BUCKETS.includes(x.lengthBucket) && x.hasObjectCandidate === (x.kind === 'unparseable_object') ? {ok:true} : bad('value');
}

export function classifyDecision(raw, next) {
  const legal = legalFromMessage(next.message);
  const parsed = extractJsonLine(raw);
  const reject = detail => ({ ok:false, rejection:{ code:'INVALID_DECISION', detail,
    projection:safeRejectionProjection(parsed, next), ...(detail === 'no_json' ? { raw:rawDiagnostics(raw) } : {}) } });
  if (!legal) return reject('legal_line_missing');
  if (!parsed) return reject('no_json');
  if (parsed.decisionId !== next.decisionId) return reject('decision_id_mismatch');
  let action;
  switch (parsed.action) {
    case 'fold': action = {action:'fold'}; break;
    case 'check':
      if (!legal.canCheck) return reject('check_not_allowed');
      action = {action:'check'}; break;
    case 'call':
      if (legal.canCheck || legal.callAmount === 0) return reject('call_not_allowed');
      action = {action:'call'}; break;
    case 'raise':
    case 'bet':
      if (!legal.canRaise) return reject('raise_not_allowed');
      if (parsed.action === 'bet') {
        if (legal.currentBet === null) return reject('bet_unavailable');
        if (legal.currentBet > 0) return reject('bet_ambiguous');
      }
      if (!Number.isInteger(parsed.amount)) return reject('amount_not_integer');
      if (legal.minRaiseTo > legal.maxRaiseTo ? parsed.amount !== legal.maxRaiseTo
        : parsed.amount < legal.minRaiseTo || parsed.amount > legal.maxRaiseTo) return reject('amount_out_of_range');
      action = {action:'raise', amount:parsed.amount, ...(parsed.action === 'bet' ? {normalizedFrom:'bet'} : {})}; break;
    default: return reject('unknown_action');
  }
  const reason = normalizeFreeText(parsed.reason, { maxChars:REASON_MAX_CHARS, maxBytes:REASON_MAX_BYTES });
  if (reason) action.reason = reason;
  return {ok:true, action};
}

export function validatedDecision(raw, next) { return classifyDecision(raw, next).action ?? null; }

export function validateRejectionRecord(r, ctx) {
  if (!exactKeys(r, ['v', 'generation', 'callNo', 'code', 'detail', 'decisionId', 'gameEpoch', 'projection', 'at'])) return bad('extra_key');
  if (r.v !== 1) return bad('version');
  if (!Number.isSafeInteger(r.generation) || r.generation < 1 || r.generation > ctx.generation) return bad('generation');
  if (!callNumber(r.callNo)) return bad('callNo');
  if (!REJECTION_CODES.includes(r.code) || !REJECTION_DETAILS.includes(r.detail)
    || (r.detail === 'engine_rejected') !== (r.code === 'ILLEGAL_ACTION')) return bad('code_detail');
  if (typeof r.decisionId !== 'string' || r.decisionId !== ctx.decisionId) return bad('decisionId');
  if (typeof r.gameEpoch !== 'string' || r.gameEpoch !== ctx.gameEpoch) return bad('gameEpoch');
  const p = r.projection;
  if (!keysWithin(p, ['action', 'amount', 'decisionIdMatches']) || !Object.hasOwn(p, 'action')
    || !Object.hasOwn(p, 'decisionIdMatches') || ![...DIAGNOSTIC_ACTIONS, 'unknown'].includes(p.action)
    || typeof p.decisionIdMatches !== 'boolean' || (Object.hasOwn(p, 'amount') && !Number.isSafeInteger(p.amount))) return bad('projection');
  if (typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return bad('at');
  return {ok:true};
}

export function projectRejectionForSink(record, ctx) {
  if (!validateRejectionRecord(record, ctx).ok) return null;
  const {v, generation, callNo, code, detail, decisionId, gameEpoch, at} = record;
  const p = record.projection;
  const projection = Object.freeze({action:p.action, ...(Object.hasOwn(p, 'amount') ? {amount:p.amount} : {}), decisionIdMatches:p.decisionIdMatches});
  return Object.freeze({v, generation, callNo, code, detail, decisionId, gameEpoch, projection, at});
}

export function validateDiagnostics(d, pending) {
  const has = Object.hasOwn(pending, 'diagnostics');
  if (pending.schemaVersion === 1) return has ? bad('legacy_with_diagnostics') : {ok:true};
  if (pending.schemaVersion !== 2) return bad('schemaVersion');
  if (!has) return pending.diagnosticsQuarantined === true ? {ok:true} : bad('missing');
  if (!object(d)) return bad('not_object');
  if (!keysWithin(d, ['v', 'callNo', 'corrections', 'detail', 'lastRejection'])) return bad('extra_key');
  if (d.v !== 1) return bad('version');
  if (!callNumber(d.callNo)) return bad('callNo');
  if (![0, 1].includes(d.corrections)) return bad('corrections');
  if (d.corrections === 1 && (d.callNo < 2 || !d.lastRejection)) return bad('corrections');
  if (Object.hasOwn(d, 'detail') && (!d.lastRejection || d.detail !== d.lastRejection.detail)) return bad('detail');
  if (Object.hasOwn(d, 'lastRejection')) {
    const check = validateRejectionRecord(d.lastRejection, pending);
    if (!check.ok) return check;
    // A settled rejection belongs to the latest actual call. The next running
    // call may refer to an earlier call; a future call is never admissible.
    if (d.lastRejection.generation === pending.generation && d.lastRejection.callNo > d.callNo) return bad('rejection_callNo');
  }
  if (pending.status === 'recovery_required' && Object.hasOwn(d, 'detail') && !REJECTION_CODES.includes(pending.code)) return bad('status_detail');
  return {ok:true};
}

export function retryWillCorrect(pending) {
  return Boolean(pending && ['recovery_required', 'retry_authorized'].includes(pending.status)
    && !pending.diagnosticsQuarantined && validateDiagnostics(pending.diagnostics, pending).ok
    && CORRECTABLE_DETAILS.has(pending.diagnostics?.lastRejection?.detail));
}

export const DETAIL_SENTENCES = Object.freeze({
  legal_line_missing:'요약에 합법 액션 수치가 없다.',
  no_json:'JSON 객체 한 줄을 읽을 수 없다.',
  decision_id_mismatch:'decisionId가 현재 결정과 일치하지 않는다.',
  unknown_action:'이 요약의 action 어휘에 없는 값이다.',
  bet_unavailable:'이 요약에서는 bet의 의미를 확인할 수 없다.',
  bet_ambiguous:'이미 베팅이 있어 bet의 금액 의미가 모호하다.',
  check_not_allowed:'이 차례에는 check가 허용되지 않는다.',
  call_not_allowed:'이 차례에는 call이 허용되지 않는다.',
  raise_not_allowed:'이 차례에는 raise가 허용되지 않는다.',
  amount_not_integer:'amount가 정수가 아니다.',
  amount_out_of_range:'amount가 합법 레이즈 범위를 벗어났다.',
  engine_rejected:'엔진이 그 액션을 거부했다.',
});
export const FORMAT_HINT_DETAILS = new Set(['bet_unavailable', 'bet_ambiguous', 'unknown_action',
  'raise_not_allowed', 'amount_not_integer', 'amount_out_of_range']);

export function correctionMessage(message, rejection, ctx) {
  const safe = projectRejectionForSink(rejection, ctx);
  if (!safe) throw new TypeError('Invalid rejection for correction');
  const p = safe.projection;
  const reply = p.action === 'unknown' ? '' : ` ${JSON.stringify({action:p.action, ...(Object.hasOwn(p, 'amount') ? {amount:p.amount} : {})})}`;
  const lines = [`[교정] 직전 회신${reply}은 거부됐다: ${DETAIL_SENTENCES[safe.detail]}`];
  const choices = /^가능한 액션: (.*)$/m.exec(message);
  if (choices) lines.push(`이 차례의 합법 액션: ${choices[1]}`);
  if (FORMAT_HINT_DETAILS.has(safe.detail)) lines.push('위 요약으로 액션을 다시 고르라. 레이즈(이 스트리트의 첫 베팅 포함)를 원하면 action은 "raise", amount는 raise-to 총액이다.');
  const id = /decisionId: (\S+)/.exec(message)?.[1];
  if (id) lines.push(`decisionId "${id}"을 그대로 에코해 JSON 한 줄만 다시 보내라. 다른 텍스트는 붙이지 마라.`);
  return `${message}\n\n${lines.join('\n')}`;
}
