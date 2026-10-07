import test from 'node:test';
import assert from 'node:assert/strict';
import { G5_BANDS, NUT_RAISE_MIN_OPPORTUNITIES, gateFailures, measureExploits, measureTendencies } from '../tools/simulate-policies.js';

// Reduced, deterministic versions of the slow gates (design G5/G6). The full
// gate is `node tools/simulate-policies.js --tendencies --exploit-sim --assert`
// (20,000 hands per degenerate strategy).
test('G5 reduced: v3 personas play inside their VPIP bands', { timeout: 300_000 }, () => {
  const tendencies = measureTendencies({ hands: 1500, seed: 'g5-reduced' });
  for (const name of Object.keys(G5_BANDS)) assert.ok(tendencies.personas[name].sample > 1000, name);
  assert.deepEqual(gateFailures({ tendencies }), []);
});

test('G5 nut raise is judged only on a sample that can carry an 80% rate', () => {
  const base = { personas: Object.fromEntries(Object.entries(G5_BANDS).map(([name, [low, high]]) => [name, { vpip: (low + high) / 2, pfr: 5 }])),
    tagCbet: { rate: 60 } };
  const few = { opportunities: NUT_RAISE_MIN_OPPORTUNITIES - 1, raises: 1 };
  assert.deepEqual(gateFailures({ tendencies: { ...base, nutRaise: { ...few, rate: 100 * few.raises / few.opportunities } } }), []);
  const enough = { opportunities: NUT_RAISE_MIN_OPPORTUNITIES, raises: NUT_RAISE_MIN_OPPORTUNITIES / 2 };
  assert.deepEqual(gateFailures({ tendencies: { ...base, nutRaise: { ...enough, rate: 50 } } }), ['G5 nut raise 50.0 below 80']);
});

test('G6 reduced: degenerate strategies do not beat the lobby tables', { timeout: 600_000 }, () => {
  // 1,000 hands bound the mean; the gate's 95% upper bound needs the full run
  // (20,000 hands per strategy, design §9) except where the margin is decisive.
  const exploits = measureExploits({ hands: 1000, seed: 'g6-reduced' });
  for (const [name, row] of Object.entries(exploits)) assert.ok(row.bbPer100 <= 30, `${name} ${row.bbPer100.toFixed(1)}bb/100`);
  for (const name of ['always-min-raise', 'always-call']) assert.ok(exploits[name].high <= 30, `${name} upper ${exploits[name].high.toFixed(1)}`);
});
