// 학습 효과 평가(#298)를 위한 덧붙이기 전용 원장 두 개와 그 읽기 전용 판독기.
//
//   - 노출 원장 `.training/grid-exposure-log.json`: 차트 열람마다 `{ at, sourceIdentity, spotKey }` 한 행. 기존
//     `grid-exposures.json`(source·spot마다 최근 7일 최신 열람 하나)은 문항 생성 규칙을 위해 그대로 둔다.
//   - 실행 원장 `.training/study-run-log.json`: assessment·retest 시작 **의도**마다 `{ type: 'start', startId, runId, mode,
//     total, startedAt, assessmentId?, sourceIdentity }` 한 행, 그리고 어떤 시작이든 미완료 assessment·retest 세션을
//     교체하면 `{ type: 'replace', startId, at, mode, replacedRunId }` 한 행. 응답 0건 실행·빈 큐·교체된 실행이 이력에서
//     사라지지 않게 한다. 행은 세션 쓰기 직전에 남기므로 시작 의도다 — 평가기는 응답 이벤트·현재 세션·뒤 교체 행 중
//     하나로 확인된 시작만 센다.
//
// 원장은 `coverageFrom`부터의 기록이 완전하다고 주장한다.
//   - 처음 만들 때: 노출 원장은 기존 `grid-exposures.json`의 행으로 씨앗을 넣는다. 그 파일은 최근 7일 안에 연 모든
//     spot의 최신 열람을 담으므로 `coverageFrom = createdAt − 7일`부터 "이 차트를 열었는가"를 정확히 답한다.
//     실행 원장은 씨앗이 없고 `coverageFrom = createdAt`이다.
//   - 상한(행·바이트)을 넘으면 오래된 행부터(같은 시각의 행은 함께) 버리고 `coverageFrom`을 버린 가장 새 행의 시각
//     + 1ms로 올린다 — 경계에 있던 버린 사건까지 완전하다고 주장하지 않는다.
//   - 읽을 수 없거나 형식이 틀리면 원본을 `<이름>.corrupt-<시각>.json`으로 보존하고 새로 시작한다(`resets`에 기록).
// 쓰기는 drill 락 안에서 호출자가 한다. 판독기(`readLedger`)는 락·디렉터리 생성·권한 변경 없이 읽기만 한다.
import { openContained, writeContained } from './training-store.js';

export const LEDGERS = Object.freeze({
  exposure: Object.freeze({ file: 'grid-exposure-log.json', seeded: true }),
  run: Object.freeze({ file: 'study-run-log.json', seeded: false }),
});
export const LEDGER_LIMITS = Object.freeze({ rows: 4_000, bytes: 2 * 1024 * 1024 });
export const SEED_WINDOW_MS = 7 * 86_400_000;
const MEASUREMENT_MODES = new Set(['assessment', 'retest']);
const STUDY_MODES = new Set(['free', 'leak', 'daily', 'mistake-review', 'assessment', 'retest', 'transfer']);

function ledgerError(code, message) {
  return Object.assign(new Error(message), { code });
}

const validIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const sourceOk = (value) => plain(value) && typeof value.id === 'string' && typeof value.version === 'string'
  && (value.contentSha256 === undefined || /^[0-9a-f]{64}$/.test(value.contentSha256));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rowOk(kind, row) {
  if (!plain(row)) return false;
  if (kind === 'exposure') {
    return validIso(row.at) && sourceOk(row.sourceIdentity) && typeof row.spotKey === 'string' && /^[a-z0-9-]{1,100}$/.test(row.spotKey);
  }
  if (row.type === 'replace') {
    return UUID_RE.test(row.startId ?? '') && validIso(row.at) && STUDY_MODES.has(row.mode) && UUID_RE.test(row.replacedRunId ?? '');
  }
  return row.type === 'start' && UUID_RE.test(row.startId ?? '')
    && (row.runId === null || UUID_RE.test(row.runId ?? '')) && MEASUREMENT_MODES.has(row.mode)
    && Number.isSafeInteger(row.total) && row.total >= 0 && row.total <= 100 && validIso(row.startedAt)
    && sourceOk(row.sourceIdentity) && (row.assessmentId === undefined || UUID_RE.test(row.assessmentId))
    && (row.runId === null) === (row.total === 0);
}

/** 원장 행의 시각(노출: at, 실행 시작: startedAt, 교체: at). */
export function rowTime(kind, row) {
  return kind === 'run' && row.type === 'start' ? row.startedAt : row.at;
}

/** 원장 형식 검증. 맞으면 원장, 아니면 null. */
export function validateLedger(kind, value) {
  if (!plain(value) || value.schemaVersion !== 1 || value.kind !== kind || !validIso(value.createdAt)
    || !validIso(value.coverageFrom) || !Array.isArray(value.rows) || !Number.isSafeInteger(value.dropped) || value.dropped < 0
    || (value.droppedThrough !== null && !validIso(value.droppedThrough)) || !Array.isArray(value.resets)
    || value.resets.some((reset) => !plain(reset) || !validIso(reset.at) || typeof reset.preservedAs !== 'string')) return null;
  if (!value.rows.every((row) => rowOk(kind, row))) return null;
  return value;
}

function readBytes(trainingRoot, file) {
  try {
    return openContained(trainingRoot, [file], { maxBytes: LEDGER_LIMITS.bytes });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 읽기 전용 판독. 없으면 `{ status: 'absent' }`, 형식이 틀리면 `{ status: 'invalid' }`, 맞으면 `{ status: 'ok', ledger }`.
 * 락·디렉터리 생성·권한 변경을 하지 않는다. 쓰기는 원자 교체라 옛 판 또는 새 판 전체를 읽는다.
 */
export function readLedger(trainingRoot, kind) {
  const spec = LEDGERS[kind];
  if (!spec) throw ledgerError('BAD_LEDGER', `unknown ledger: ${kind}`);
  let bytes;
  try {
    bytes = readBytes(trainingRoot, spec.file);
  } catch (error) {
    if (['TOO_LARGE', 'UNSAFE_PATH'].includes(error.code)) return { status: 'invalid', code: error.code };
    throw error;
  }
  if (bytes === null) return { status: 'absent' };
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return { status: 'invalid', code: 'UNPARSABLE' }; }
  const ledger = validateLedger(kind, parsed);
  return ledger ? { status: 'ok', ledger } : { status: 'invalid', code: 'SHAPE' };
}

function freshLedger(kind, at, seedRows) {
  const seeded = LEDGERS[kind].seeded;
  const seed = seeded ? (seedRows ?? []).filter((row) => rowOk(kind, row) && Date.parse(row.at) <= Date.parse(at)
    && Date.parse(at) - Date.parse(row.at) <= SEED_WINDOW_MS)
    .sort((a, b) => a.at.localeCompare(b.at)) : [];
  return {
    schemaVersion: 1, kind, createdAt: at,
    coverageFrom: seeded ? new Date(Date.parse(at) - SEED_WINDOW_MS).toISOString() : at,
    rows: seed, dropped: 0, droppedThrough: null, resets: [],
  };
}

function serialize(ledger) {
  return `${JSON.stringify(ledger)}\n`;
}

// 상한을 넘기면 오래된 행부터 버리고 coverage 시작을 버린 가장 새 행으로 올린다.
function trim(kind, ledger, limits) {
  while (ledger.rows.length > limits.rows || Buffer.byteLength(serialize(ledger)) > limits.bytes) {
    const first = ledger.rows[0];
    if (!first) break;
    const boundary = rowTime(kind, first);
    // 같은 시각의 행은 함께 버린다 — 경계 시각을 반쯤 남기면 그 시각이 완전하다고 말할 수 없다.
    while (ledger.rows.length && rowTime(kind, ledger.rows[0]) === boundary) {
      ledger.rows.shift();
      ledger.dropped += 1;
    }
    ledger.droppedThrough = boundary;
    const after = new Date(Date.parse(boundary) + 1).toISOString();
    if (Date.parse(after) > Date.parse(ledger.coverageFrom)) ledger.coverageFrom = after;
  }
  return ledger;
}

/**
 * 없으면 만들고(씨앗), 손상이면 원본을 보존하고 새로 시작한 뒤, `rows`를 한 번의 원자 교체로 덧붙인다. drill 락 안에서 부른다.
 * `rows`가 비어 있으면 원장을 만들거나 복구만 한다. `seedRows`는 노출 원장의 씨앗(`grid-exposures.json` 행)을 돌려주는
 * 함수다. 원장을 새로 만들 때만 부른다.
 */
export function appendLedgerRows(trainingRoot, kind, rows, { at, seedRows = () => [], limits = LEDGER_LIMITS } = {}) {
  const spec = LEDGERS[kind];
  if (!spec) throw ledgerError('BAD_LEDGER', `unknown ledger: ${kind}`);
  if (!validIso(at)) throw ledgerError('BAD_LEDGER', 'ledger time must be a canonical ISO string');
  if (!Array.isArray(rows) || rows.some((row) => !rowOk(kind, row))) throw ledgerError('BAD_LEDGER_ROW', `${kind} ledger row is invalid`);
  const current = readLedger(trainingRoot, kind);
  let ledger;
  if (current.status === 'ok') ledger = current.ledger;
  else if (current.status === 'absent') ledger = freshLedger(kind, at, spec.seeded ? seedRows() : []);
  else {
    // 손상 원본은 지우지 않는다 — 다른 이름으로 보존하고, 그 이전 구간은 알 수 없다고 기록한다.
    const preservedAs = `${spec.file.replace(/\.json$/, '')}.corrupt-${at.replace(/[:.]/g, '-')}.json`;
    let bytes = null;
    try { bytes = readBytes(trainingRoot, spec.file); } catch { bytes = null; }
    if (bytes !== null) writeContained(trainingRoot, [preservedAs], bytes, { mode: 'create' });
    ledger = freshLedger(kind, at, spec.seeded ? seedRows() : []);
    ledger.resets = [{ at, preservedAs, code: current.code ?? 'INVALID' }];
  }
  // 시계가 되돌아가도 기록은 막지 않는다. 행은 시각 순으로 유지한다(같은 시각은 들어온 순서). 상한은 가장 오래된 행부터 버린다.
  for (const row of rows) {
    const time = Date.parse(rowTime(kind, row));
    let index = ledger.rows.length;
    while (index > 0 && Date.parse(rowTime(kind, ledger.rows[index - 1])) > time) index -= 1;
    ledger.rows.splice(index, 0, row);
  }
  writeContained(trainingRoot, [spec.file], serialize(trim(kind, ledger, limits)), { mode: 'replace' });
  return ledger;
}

/** 한 행(또는 null = 만들기·복구만)을 덧붙인다. */
export function appendLedgerRow(trainingRoot, kind, row, options) {
  return appendLedgerRows(trainingRoot, kind, row === null ? [] : [row], options);
}

/** 원장이 `[from, ·)` 구간을 빠짐없이 덮는가. 없는 원장·손상 원장은 덮지 않는다. */
export function ledgerCovers(read, from) {
  return read?.status === 'ok' && Date.parse(read.ledger.coverageFrom) <= Date.parse(from);
}

export { MEASUREMENT_MODES };
