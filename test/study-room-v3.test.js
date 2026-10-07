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
import { chartClassAt, renderSpotChart } from '../server/drill-public/spot-chart.js';
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

test('v3 practice: a free run grades, the summary reads v3 events, and trends show the run', { timeout: 120_000 }, async () => {
  const storeDir = createOwnedTempDir('study-v3');
  await startDrill(storeDir, { mode: 'free', source, seed: 'v3-free', spotKey: '6max-100bb-btn-rfi-v3' });
  await answerAll(storeDir);
  const summary = await readStudySummary(storeDir);
  assert.equal(summary.source.version, '3.0.0', 'the practice source becomes the active segment');
  assert.ok(summary.practice.overall.evaluatedDecisions >= 1);
  assert.ok(Array.isArray(summary.trends.practice) && Array.isArray(summary.trends.game));
  assert.ok(formatTrends(summary.trends).series.length <= 1);
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
