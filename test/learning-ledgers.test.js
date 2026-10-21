// #298: 학습 효과 평가용 덧붙이기 전용 원장 — 차트 열람(노출)과 측정 실행 시작.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { readSpotChart, startDrill, nextQuestion, answerQuestion } from '../tools/drill-cli.js';
import { appendLedgerRow, ledgerCovers, LEDGERS, readLedger, SEED_WINDOW_MS } from '../tools/learning-ledgers.js';
import { V3_REFERENCE_SOURCE } from '../shared/reference.js';

const source = { id: V3_REFERENCE_SOURCE.id, version: V3_REFERENCE_SOURCE.version, contentSha256: V3_REFERENCE_SOURCE.contentSha256 };
const training = (storeDir) => path.join(storeDir, '.training');
const START = '22222222-2222-4222-8222-222222222222';
const RUN = '11111111-1111-4111-8111-111111111111';
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function treeState(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    out[name] = stat.isFile() ? { mode: stat.mode, mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(file).toString('base64') } : { mode: stat.mode, dir: true };
  }
  return out;
}

test('a chart view appends to the exposure ledger first; the first ledger is seeded from the recent-view file', { timeout: 60_000 }, async () => {
  const storeDir = createOwnedTempDir('ledger-exposure');
  fs.mkdirSync(training(storeDir), { recursive: true });
  const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const stale = new Date(Date.now() - 9 * 86_400_000).toISOString();
  fs.writeFileSync(path.join(training(storeDir), 'grid-exposures.json'), JSON.stringify([
    { sourceIdentity: source, spotKey: '6max-100bb-hj-rfi-v3', at: stale },
    { sourceIdentity: source, spotKey: '6max-100bb-co-rfi-v3', at: recent },
  ]));
  await readSpotChart(storeDir, { spotKey: '6max-100bb-btn-rfi-v3', source });
  await readSpotChart(storeDir, { spotKey: '6max-100bb-btn-rfi-v3', source });
  const read = readLedger(training(storeDir), 'exposure');
  assert.equal(read.status, 'ok');
  const { ledger } = read;
  assert.deepEqual(ledger.rows.map((row) => row.spotKey), ['6max-100bb-co-rfi-v3', '6max-100bb-btn-rfi-v3', '6max-100bb-btn-rfi-v3'],
    'the seed keeps only rows inside the seven-day window, then every view is appended');
  assert.equal(Date.parse(ledger.createdAt) - Date.parse(ledger.coverageFrom), SEED_WINDOW_MS);
  assert.equal(ledgerCovers(read, ledger.coverageFrom), true);
  assert.equal(ledgerCovers(read, new Date(Date.parse(ledger.coverageFrom) - 1).toISOString()), false);
  // 기존 파일의 규칙(source·spot마다 최근 7일 최신 하나)은 그대로다.
  const recentFile = readJson(path.join(training(storeDir), 'grid-exposures.json'));
  assert.deepEqual(recentFile.map((row) => row.spotKey).sort(), ['6max-100bb-btn-rfi-v3', '6max-100bb-co-rfi-v3']);
});

test('a failed ledger write refuses the chart: nothing is shown and the recent-view file is unchanged', { timeout: 60_000 }, async () => {
  const storeDir = createOwnedTempDir('ledger-exposure-fail');
  fs.mkdirSync(path.join(training(storeDir), LEDGERS.exposure.file), { recursive: true });
  fs.writeFileSync(path.join(training(storeDir), LEDGERS.exposure.file, 'x'), 'occupied');
  await assert.rejects(readSpotChart(storeDir, { spotKey: '6max-100bb-btn-rfi-v3', source }));
  assert.equal(fs.existsSync(path.join(training(storeDir), 'grid-exposures.json')), false);
});

test('measurement starts and replacements of an unfinished measurement run are recorded; free starts, replays and refusals are not', { timeout: 120_000 }, async () => {
  const storeDir = createOwnedTempDir('ledger-runs');
  await startDrill(storeDir, { mode: 'free', source, seed: 'f', idempotencyKey: 'free-1' });
  assert.equal(readLedger(training(storeDir), 'run').status, 'absent', 'a free start that replaces nothing measured writes no row');
  const first = await startDrill(storeDir, { mode: 'assessment', source, seed: 'a', idempotencyKey: 'a-1' });
  const replay = await startDrill(storeDir, { mode: 'assessment', source, seed: 'a', idempotencyKey: 'a-1' });
  assert.equal(replay.studyRun.id, first.studyRun.id);
  await assert.rejects(startDrill(storeDir, { mode: 'assessment', source, seed: 'c', protectUnfinished: true }), { code: 'UNFINISHED_RUN' });
  // 응답 0건 assessment를 다른 assessment가 교체한다: 교체 행과 새 시작 행이 같은 startId로 남는다.
  const second = await startDrill(storeDir, { mode: 'assessment', source, seed: 'b', idempotencyKey: 'a-2' });
  // 미완료 assessment를 free 연습이 교체해도 교체 시각이 남는다.
  await startDrill(storeDir, { mode: 'free', source, seed: 'g', idempotencyKey: 'free-2' });
  const { ledger } = readLedger(training(storeDir), 'run');
  assert.deepEqual(ledger.rows.map((row) => [row.type, row.runId ?? row.replacedRunId, row.mode]), [
    ['start', first.studyRun.id, 'assessment'],
    ['replace', first.studyRun.id, 'assessment'],
    ['start', second.studyRun.id, 'assessment'],
    ['replace', second.studyRun.id, 'free'],
  ]);
  assert.equal(ledger.rows[1].startId, ledger.rows[2].startId, 'the replacement and the new start share one start id');
  assert.equal(ledger.rows[0].total, first.queue.length);
  assert.equal(ledger.coverageFrom, ledger.createdAt);
  assert.deepEqual(ledger.rows[0].sourceIdentity, source);
});

test('a failed run-ledger write fails the start and leaves the stored session untouched', { timeout: 60_000 }, async () => {
  const storeDir = createOwnedTempDir('ledger-runs-fail');
  await startDrill(storeDir, { mode: 'free', source, seed: 'f' });
  const before = fs.readFileSync(path.join(training(storeDir), 'drill-session.json'));
  fs.mkdirSync(path.join(training(storeDir), LEDGERS.run.file));
  fs.writeFileSync(path.join(training(storeDir), LEDGERS.run.file, 'x'), 'occupied');
  await assert.rejects(startDrill(storeDir, { mode: 'assessment', source, seed: 'a' }));
  assert.deepEqual(fs.readFileSync(path.join(training(storeDir), 'drill-session.json')), before);
});

test('an empty queue start is recorded with no run id and zero questions', async () => {
  const root = createOwnedTempDir('ledger-empty');
  const at = new Date().toISOString();
  appendLedgerRow(root, 'run', { type: 'start', startId: START, runId: null, mode: 'assessment', total: 0, startedAt: at, sourceIdentity: source }, { at });
  const { ledger } = readLedger(root, 'run');
  assert.deepEqual(ledger.rows, [{ type: 'start', startId: START, runId: null, mode: 'assessment', total: 0, startedAt: at, sourceIdentity: source }]);
  for (const bad of [
    { type: 'start', startId: START, runId: null, mode: 'assessment', total: 3, startedAt: at, sourceIdentity: source },
    { type: 'start', startId: START, runId: RUN, mode: 'free', total: 3, startedAt: at, sourceIdentity: source },
    { runId: RUN, mode: 'assessment', total: 3, startedAt: at, sourceIdentity: source },
    { type: 'replace', startId: START, at, mode: 'free', replacedRunId: null },
  ]) assert.throws(() => appendLedgerRow(root, 'run', bad, { at }), { code: 'BAD_LEDGER_ROW' }, JSON.stringify(bad));
});

test('the row cap drops the oldest rows with their timestamp peers and covers only strictly after them; late clocks stay sorted', () => {
  const root = createOwnedTempDir('ledger-cap');
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  const iso = (minutes) => new Date(base + minutes * 60_000).toISOString();
  const limits = { rows: 3, bytes: 1024 * 1024 };
  for (const minutes of [0, 1, 1, 2]) {
    appendLedgerRow(root, 'exposure', { at: iso(minutes), sourceIdentity: source, spotKey: 'x-v3' }, { at: iso(minutes), limits });
  }
  // 넷째 행에서 상한(3)을 넘어 가장 오래된 행(0분)을 버린다.
  let { ledger } = readLedger(root, 'exposure');
  assert.deepEqual(ledger.rows.map((row) => row.at), [iso(1), iso(1), iso(2)]);
  assert.equal(ledger.coverageFrom, new Date(base + 1).toISOString(), 'coverage starts 1 ms after the dropped row');
  appendLedgerRow(root, 'exposure', { at: iso(1.5), sourceIdentity: source, spotKey: 'late-v3' }, { at: iso(3), limits });
  ({ ledger } = readLedger(root, 'exposure'));
  assert.deepEqual(ledger.rows.map((row) => row.at), [iso(1.5), iso(2)], 'both 1-minute rows go together');
  assert.equal(ledger.dropped, 3);
  assert.equal(ledger.droppedThrough, iso(1));
  assert.equal(ledger.coverageFrom, new Date(base + 60_000 + 1).toISOString());
  assert.equal(ledgerCovers({ status: 'ok', ledger }, iso(1)), false, 'the dropped boundary itself is not covered');
});

test('a corrupt ledger is preserved under another name and a fresh one records the reset', () => {
  const root = createOwnedTempDir('ledger-corrupt');
  fs.writeFileSync(path.join(root, LEDGERS.run.file), '{"schemaVersion":1,"kind":"run"');
  const at = '2026-10-21T03:00:00.000Z';
  appendLedgerRow(root, 'run', { type: 'start', startId: START, runId: RUN, mode: 'assessment', total: 10, startedAt: at, sourceIdentity: source }, { at });
  const { ledger } = readLedger(root, 'run');
  assert.equal(ledger.resets.length, 1);
  assert.equal(ledger.coverageFrom, at);
  const preserved = path.join(root, ledger.resets[0].preservedAs);
  assert.equal(fs.readFileSync(preserved, 'utf8'), '{"schemaVersion":1,"kind":"run"');
});

test('readLedger never writes, locks or changes modes, even for a missing or corrupt ledger', () => {
  const root = createOwnedTempDir('ledger-read');
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, LEDGERS.exposure.file), 'not json');
  const before = treeState(root);
  assert.equal(readLedger(root, 'exposure').status, 'invalid');
  assert.equal(readLedger(root, 'run').status, 'absent');
  assert.deepEqual(treeState(root), before);
});

test('the exposure and run ledgers do not change drill events or the answered session', { timeout: 120_000 }, async () => {
  const storeDir = createOwnedTempDir('ledger-preserve');
  const started = await startDrill(storeDir, { mode: 'assessment', source, seed: 'p' });
  const next = await nextQuestion(storeDir);
  const [action] = next.question.prompt.legalActions[0].split(':');
  await answerQuestion(storeDir, { sessionId: started.sessionId, questionId: next.question.questionId, attemptNo: next.index, action: action === 'raise' ? 'fold' : action });
  const events = fs.readFileSync(path.join(training(storeDir), 'profile-events.jsonl'));
  const session = fs.readFileSync(path.join(training(storeDir), 'drill-session.json'));
  // 측정 실행 중에는 차트가 잠긴다 — 원장도 행을 남기지 않는다.
  await assert.rejects(readSpotChart(storeDir, { spotKey: '6max-100bb-btn-rfi-v3', source }), { code: 'GRID_LOCKED' });
  assert.equal(readLedger(training(storeDir), 'exposure').status, 'absent');
  assert.deepEqual(fs.readFileSync(path.join(training(storeDir), 'profile-events.jsonl')), events);
  assert.deepEqual(fs.readFileSync(path.join(training(storeDir), 'drill-session.json')), session);
  assert.deepEqual(readLedger(training(storeDir), 'run').ledger.rows.map((row) => row.type), ['start']);
});
