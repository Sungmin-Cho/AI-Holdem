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
// 손상 원본을 보존할 때 읽을 수 있는 크기 상한. 이보다 크면 보존할 수 없으므로 원본을 두고 쓰기를 거부한다.
const PRESERVE_MAX_BYTES = 64 * 1024 * 1024;
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
    || value.resets.some((reset) => !plain(reset) || !validIso(reset.at) || typeof reset.preservedAs !== 'string')
    || (value.seed !== undefined && !['recent-view-file', 'unavailable'].includes(value.seed))) return null;
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
  return parseLedger(kind, bytes);
}

/** 이미 읽은 바이트(없으면 null)를 판독한다 — 여러 파일을 한 번에 읽은 snapshot이 같은 바이트를 쓰게 한다. */
export function parseLedger(kind, bytes) {
  if (!LEDGERS[kind]) throw ledgerError('BAD_LEDGER', `unknown ledger: ${kind}`);
  if (bytes === null) return { status: 'absent' };
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return { status: 'invalid', code: 'UNPARSABLE' }; }
  const ledger = validateLedger(kind, parsed);
  return ledger ? { status: 'ok', ledger } : { status: 'invalid', code: 'SHAPE' };
}

/**
 * 새 원장. 노출 원장의 씨앗 `seed = { ok, rows }`: ok는 최근 열람 파일이 없거나 정상으로 읽혔다는 뜻이다. 읽지 못했으면
 * (손상·권한·상한) 그 7일을 안다고 주장하지 않는다 — coverage는 지금부터다.
 */
function freshLedger(kind, at, seed) {
  const seededOk = LEDGERS[kind].seeded && seed?.ok === true;
  // 읽을 수 있는 양성 노출은 씨앗이 불완전해도 남긴다(알려진 노출). coverage만 씨앗이 온전할 때 7일 앞으로 간다.
  const rows = LEDGERS[kind].seeded ? (seed?.rows ?? []).filter((row) => rowOk(kind, row) && Date.parse(row.at) <= Date.parse(at)
    && Date.parse(at) - Date.parse(row.at) <= SEED_WINDOW_MS)
    .sort((a, b) => a.at.localeCompare(b.at)) : [];
  return {
    schemaVersion: 1, kind, createdAt: at,
    coverageFrom: seededOk ? new Date(Date.parse(at) - SEED_WINDOW_MS).toISOString() : at,
    rows, dropped: 0, droppedThrough: null, resets: [],
    ...(LEDGERS[kind].seeded ? { seed: seededOk ? 'recent-view-file' : 'unavailable' } : {}),
  };
}

const callSeed = (seedRows) => {
  try {
    const seed = seedRows();
    return { ok: seed?.ok === true, rows: Array.isArray(seed?.rows) ? seed.rows : [] };
  } catch {
    return { ok: false, rows: [] };
  }
};

/**
 * 최근 열람 파일(`grid-exposures.json`)을 씨앗으로 엄격하게 읽는다. 파일이 없으면 온전한 빈 씨앗이다. 읽을 수 없거나,
 * 배열이 아니거나, 행 하나라도 형식이 틀리면 온전하지 않다(`ok: false`) — 그 7일을 안다고 주장하지 않는다. 형식이 맞는
 * 행은 알려진 노출로 함께 돌려준다. 등록과 차트 열람이 같은 판독기를 쓴다.
 */
export function readRecentViewSeed(trainingRoot) {
  let parsed;
  try {
    const bytes = readBytes(trainingRoot, 'grid-exposures.json');
    if (bytes === null) return { ok: true, rows: [] };
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, rows: [] };
  }
  if (!Array.isArray(parsed)) return { ok: false, rows: [] };
  const rows = parsed.filter((row) => plain(row)).map((row) => ({ at: row.at, sourceIdentity: row.sourceIdentity, spotKey: row.spotKey }));
  const valid = rows.filter((row) => rowOk('exposure', row));
  return { ok: valid.length === parsed.length, rows: valid };
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
  else if (current.status === 'absent') ledger = freshLedger(kind, at, spec.seeded ? callSeed(seedRows) : null);
  else {
    // 손상 원본은 지우지 않는다 — 다른 이름으로 먼저 보존하고, 그 이전 구간은 알 수 없다고 기록한다. 보존하지 못하면
    // 원본을 그대로 두고 쓰기를 거부한다(차트 열람·측정 시작이 실패로 드러난다).
    const preservedAs = `${spec.file.replace(/\.json$/, '')}.corrupt-${at.replace(/[:.]/g, '-')}.json`;
    let bytes;
    try {
      bytes = openContained(trainingRoot, [spec.file], { maxBytes: PRESERVE_MAX_BYTES });
      writeContained(trainingRoot, [preservedAs], bytes, { mode: 'create' });
    } catch (error) {
      throw Object.assign(ledgerError('LEDGER_PRESERVE_FAILED', `${kind} ledger is invalid and could not be preserved`), { cause: error });
    }
    ledger = freshLedger(kind, at, spec.seeded ? callSeed(seedRows) : null);
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
