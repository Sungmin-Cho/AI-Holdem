import test from 'node:test';
import assert from 'node:assert/strict';
import { G5_BANDS, gateFailures, measureExploits, measureTendencies } from '../tools/simulate-policies.js';

// Reduced, deterministic versions of the slow gates (design G5/G6). The full
// gate is `node tools/simulate-policies.js --tendencies --exploit-sim --assert`
// (20,000 hands per degenerate strategy).
test('G5 reduced: v3 personas play inside their VPIP bands', { timeout: 300_000 }, () => {
  const tendencies = measureTendencies({ hands: 1500, seed: 'g5-reduced' });
  for (const name of Object.keys(G5_BANDS)) assert.ok(tendencies.personas[name].sample > 1000, name);
  assert.deepEqual(gateFailures({ tendencies }), []);
});

test('G6 reduced: degenerate strategies do not beat the lobby tables', { timeout: 600_000 }, () => {
  const exploits = measureExploits({ hands: 1000, seed: 'g6-reduced' });
  for (const [name, row] of Object.entries(exploits)) assert.ok(row.bbPer100 <= 30, `${name} ${row.bbPer100.toFixed(1)}bb/100`);
});
