import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { answerQuestion, nextQuestion, readSpotChart, startDrill } from '../tools/drill-cli.js';
import { readStudySummary } from '../tools/study-summary.js';
import { V3_REFERENCE_SOURCE } from '../shared/reference.js';
import { checkPotOdds, potOddsQuestion, readPotOddsStats, recordPotOdds } from '../server/drill-public/pot-odds-drill.js';
import { formatTrends } from '../server/drill-public/study-format.js';
import { chartClassAt, createChartPanel, renderSpotChart } from '../server/drill-public/spot-chart.js';
import { createMiniDocument } from './helpers/mini-dom.js';

const source = { id: V3_REFERENCE_SOURCE.id, version: V3_REFERENCE_SOURCE.version, contentSha256: V3_REFERENCE_SOURCE.contentSha256 };

async function answerAll(storeDir, pick = (q) => q.prompt.legalActions[0]) {
  for (let guard = 0; guard < 20; guard += 1) {
    const current = await nextQuestion(storeDir);
    const q = current.question;
    if (!q) return current;
    const [action, size] = pick(q).split(':');
    await answerQuestion(storeDir, { sessionId: current.sessionId, questionId: q.questionId, attemptNo: current.index,
      action, ...(size ? { sizeBb: Number(size) } : {}) });
  }
  throw new Error('run did not finish');
}

test('v3 practice: a free run grades, the summary reads v3 events, and a free run draws no trend line', { timeout: 120_000 }, async () => {
  const storeDir = createOwnedTempDir('study-v3');
  await startDrill(storeDir, { mode: 'free', source, seed: 'v3-free', spotKey: '6max-100bb-btn-rfi-v3' });
  await answerAll(storeDir);
  const summary = await readStudySummary(storeDir);
  assert.equal(summary.source.version, '3.0.0', 'the practice source becomes the active segment');
  assert.ok(summary.practice.overall.evaluatedDecisions >= 1);
  assert.ok(Array.isArray(summary.trends.practice) && Array.isArray(summary.trends.game));
  // A free run depends on what was chosen: it forms no trend line.
  assert.deepEqual(summary.trends.practice, []);
  assert.deepEqual(formatTrends(summary.trends).series, []);
});

test('trend lines join only runs drawn the same way, and game sessions by their source', async () => {
  const { trendsOf } = await import('../training/study-history.js');
  const v2 = { id: 'local-preflop-baseline', version: '2.0.0', contentSha256: 'b'.repeat(64) };
  const run = (id, mode, startedAt, rate, extra = {}) => ({ id, mode, startedAt, complete: true, sourceIdentity: source, total: 10,
    result: { allowedActionRate: rate, foldBaselineRate: 0.4 }, ...extra });
  const runs = [
    run('a1', 'assessment', '2026-10-01T00:00:00.000Z', 0.5),
    run('f1', 'free', '2026-10-02T00:00:00.000Z', 1),
    run('f2', 'free', '2026-10-03T00:00:00.000Z', 0),
    run('a2', 'assessment', '2026-10-04T00:00:00.000Z', 0.6),
    run('r1', 'retest', '2026-10-05T00:00:00.000Z', 0.7, { assessmentId: 'a1' }),
    run('x1', 'assessment', '2026-10-06T00:00:00.000Z', 0.9, { sourceIdentity: v2 }),
  ];
  const trends = trendsOf(runs, [], '2026-10-07T00:00:00.000Z');
  assert.equal(trends.practice.some((row) => row.mode === 'free'), false);
  const shown = formatTrends({ ...trends, game: [
    { session: 1, startedAt: '2026-10-01T00:00:00.000Z', source: 'local-preflop-baseline@2.0.0', graded: 4, allowedActionRate: 0.5 },
    { session: 2, startedAt: '2026-10-02T00:00:00.000Z', source: 'local-preflop-baseline@3.0.0', graded: 6, allowedActionRate: 0.75 },
  ] });
  assert.deepEqual(shown.series.map((s) => [s.label.replace(/\d{4}\. ?\d{1,2}\. ?\d{1,2}\.?/, 'D'), s.rows.length]), [
    ['새 문제 평가 · 기준표 3.0.0', 2],
    ['지연 재평가 · D 평가와 같은 문항 · 기준표 3.0.0', 2],
    ['새 문제 평가 · 기준표 2.0.0', 1],
  ]);
  assert.deepEqual(shown.game.map((g) => [g.label, g.rows.length]), [['게임 기록 · 기준표 2.0.0', 1], ['게임 기록 · 기준표 3.0.0', 1]]);
});

test('the chart of a spot is shown outside measuring runs and every view is recorded', { timeout: 120_000 }, async () => {
  const storeDir = createOwnedTempDir('study-chart');
  const chart = await readSpotChart(storeDir, { spotKey: '6max-100bb-btn-rfi-v3', source });
  assert.equal(Object.keys(chart.cells).length, 169);
  assert.equal(chart.cells.AA.raise, 1);
  assert.equal(chart.cells['72o'].fold, 1);
  const doc = createMiniDocument();
  const table = renderSpotChart(doc, chart, { highlight: 'AA' });
  assert.equal(table.tagName.toLowerCase(), 'table');
  assert.equal(chartClassAt(0, 1), 'AKs');
  assert.equal(chartClassAt(1, 0), 'AKo');
  await assert.rejects(readSpotChart(storeDir, { spotKey: 'not-a-spot', source }), { code: 'UNSUPPORTED_SPOT' });
  const exposures = JSON.parse(fs.readFileSync(path.join(storeDir, '.training', 'grid-exposures.json'), 'utf8'));
  assert.deepEqual(exposures.map((row) => [row.spotKey, row.sourceIdentity.version]), [['6max-100bb-btn-rfi-v3', '3.0.0']]);
  await startDrill(storeDir, { mode: 'assessment', source, seed: 'locked' });
  await assert.rejects(readSpotChart(storeDir, { spotKey: '6max-100bb-btn-rfi-v3', source }), { code: 'GRID_LOCKED' });
});

test('repeated views of one chart keep every other spot seen within the week', { timeout: 120_000 }, async () => {
  const storeDir = createOwnedTempDir('study-chart-repeat');
  await readSpotChart(storeDir, { spotKey: '6max-100bb-btn-rfi-v3', source });
  for (let i = 0; i < 520; i += 1) await readSpotChart(storeDir, { spotKey: '6max-100bb-co-rfi-v3', source });
  const exposures = JSON.parse(fs.readFileSync(path.join(storeDir, '.training', 'grid-exposures.json'), 'utf8'));
  assert.deepEqual(exposures.map((row) => row.spotKey).sort(), ['6max-100bb-btn-rfi-v3', '6max-100bb-co-rfi-v3']);
  // A row past the seven-day window expires on the next write.
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  fs.writeFileSync(path.join(storeDir, '.training', 'grid-exposures.json'), JSON.stringify([{ ...exposures[0], spotKey: '6max-100bb-hj-rfi-v3', at: old }, ...exposures]));
  await readSpotChart(storeDir, { spotKey: '6max-100bb-co-rfi-v3', source });
  const after = JSON.parse(fs.readFileSync(path.join(storeDir, '.training', 'grid-exposures.json'), 'utf8'));
  assert.equal(after.some((row) => row.spotKey === '6max-100bb-hj-rfi-v3'), false);
  assert.equal(after.length, 2);
});

test('pot-odds practice asks call ÷ (pot + call) and keeps its statistics in the browser', () => {
  let x = 0.1;
  const random = () => { x = (x * 9301 + 0.49297) % 1; return x; };
  for (let i = 0; i < 30; i += 1) {
    const q = potOddsQuestion(random);
    assert.equal(q.answer, Math.round((100 * q.callBb) / (q.potBb + q.callBb)));
    assert.ok(q.options.includes(q.answer) && new Set(q.options).size === q.options.length);
    assert.equal(checkPotOdds(q, q.answer).correct, true);
  }
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  recordPotOdds(storage, true);
  recordPotOdds(storage, false);
  assert.deepEqual(readPotOddsStats(storage), { answered: 2, correct: 1, streak: 0 });
  assert.deepEqual(readPotOddsStats({ getItem() { throw new Error('denied'); } }), { answered: 0, correct: 0, streak: 0 });
});

test('an open chart closes when a measuring run starts and a late response is dropped', async () => {
  const box = { hidden: true, children: [], replaceChildren(...nodes) { this.children = nodes; } };
  const shown = [];
  let resolve;
  const panel = createChartPanel({ box, load: () => new Promise((r) => { resolve = r; }), show: (state) => { shown.push(state); box.children = [state]; } });
  panel.sync('free-1', false);
  const first = panel.open({ spotKey: '6max-100bb-btn-rfi-v3', handClass: 'AA' });
  assert.equal(box.hidden, false);
  // A retest starts before the chart answers: the box closes and stays empty.
  panel.sync('retest-1', true);
  resolve({ ok: true, cells: {} });
  assert.equal(await first, false);
  assert.equal(box.hidden, true);
  assert.deepEqual(box.children, []);
  assert.equal(shown.filter((state) => state.response).length, 0);
  // Outside measuring runs a chart opens and stays while the run continues.
  panel.sync('free-2', false);
  const second = panel.open({ spotKey: '6max-100bb-btn-rfi-v3', handClass: 'AA' });
  resolve({ ok: true, cells: {} });
  assert.equal(await second, true);
  panel.sync('free-2', false);
  assert.equal(box.hidden, false);
  // An already shown chart closes as soon as a measuring run renders.
  panel.sync('assessment-1', true);
  assert.equal(box.hidden, true);
  assert.deepEqual(box.children, []);
});

test('a named spot keeps its own source after the default moved to v3', { timeout: 120_000 }, async () => {
  for (const [spotKey, version] of [['6max-100bb-btn-rfi-v2', '2.0.0'], ['6max-100bb-btn-rfi-v3', '3.0.0'], ['6max-100bb-btn-rfi-unopened', '1.0.0']]) {
    const storeDir = createOwnedTempDir('study-named-spot');
    const started = await startDrill(storeDir, { mode: 'free', seed: 'named', spotKey, handClass: 'AJo' });
    assert.equal(started.sourceIdentity.version, version, spotKey);
    assert.equal((await nextQuestion(storeDir)).question.prompt.spotKey, spotKey);
  }
});

test('/api/spot refuses without the token, from another origin, for an unknown version or while measuring, and records nothing then', { timeout: 120_000 }, async () => {
  const { startDrillServer } = await import('../tools/drill-server.js');
  const storeDir = createOwnedTempDir('study-chart-api');
  const file = path.join(storeDir, '.training', 'grid-exposures.json');
  const drill = await startDrillServer({ storeDir, port: 0, token: 'spot-tok' });
  try {
    const url = (query) => `http://127.0.0.1:${drill.port}/api/spot?${query}`;
    const ok = await fetch(url('spotKey=6max-100bb-btn-rfi-v3'), { headers: { 'x-drill-token': 'spot-tok' } });
    assert.equal(ok.status, 200);
    const recorded = fs.readFileSync(file, 'utf8');
    const refusals = [
      [url('spotKey=6max-100bb-co-rfi-v3'), {}, 401],
      [url('spotKey=6max-100bb-co-rfi-v3'), { 'x-drill-token': 'spot-tok', origin: 'http://evil.example' }, 403],
      [url('spotKey=6max-100bb-co-rfi-v3&version=9.9.9'), { 'x-drill-token': 'spot-tok' }, 400],
    ];
    for (const [target, headers, status] of refusals) {
      assert.equal((await fetch(target, { headers })).status, status, JSON.stringify(headers));
      assert.equal(fs.readFileSync(file, 'utf8'), recorded);
    }
    await startDrill(storeDir, { mode: 'assessment', source, seed: 'api-locked' });
    const locked = await fetch(url('spotKey=6max-100bb-co-rfi-v3'), { headers: { 'x-drill-token': 'spot-tok' } });
    assert.equal((await locked.json()).code, 'GRID_LOCKED');
    assert.equal(fs.readFileSync(file, 'utf8'), recorded);
  } finally {
    await drill.close();
  }
});
