import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { buildBaselineV3 } from '../tools/build-preflop-baseline-v3.js';
import { parsePreflopJson, lookup, validateDataset } from '../training/providers/preflop-json.js';
import { preflopKeysV3, parsePreflopKeyV3, PREFLOP_ORDERS_V3 } from '../shared/preflop-key.js';
import { HAND_CLASSES, comboCount } from '../shared/poker-eval.js';

const file = new URL('../training/data/preflop-baseline-v3.json', import.meta.url);
const raw = fs.readFileSync(file, 'utf8');
const pinned = fs.readFileSync(new URL('../training/data/preflop-baseline-v3.sha256', import.meta.url), 'utf8').trim();
const dataset = parsePreflopJson(raw, { expectedSha256: pinned });

function freqs(key) {
  return HAND_CLASSES.map(hand => {
    const row = { raise: 0, call: 0, fold: 0 };
    for (const a of lookup(dataset, { spotKey: key, handClass: hand }).actions) row[a.action] = a.frequency;
    return row;
  });
}
const percent = (rows, pick) => (100 * rows.reduce((sum, row, i) => sum + pick(row) * comboCount(HAND_CLASSES[i]), 0)) / 1326;
const continuing = row => row.raise + row.call;
const at = (rows, hand) => rows[HAND_CLASSES.indexOf(hand)];

test('the v3 dataset is the deterministic build, pinned by digest', () => {
  assert.equal(`${JSON.stringify(buildBaselineV3())}\n`, raw);
  assert.equal(createHash('sha256').update(raw).digest('hex'), pinned);
  assert.equal(Object.keys(dataset.data.spots).length, preflopKeysV3().length);
  assert.equal(preflopKeysV3().length, 1680);
});

test('the v3 parser rejects malformed tables', () => {
  const data = JSON.parse(raw);
  const firstId = Object.keys(data.charts)[0];
  const broken = structuredClone(data);
  broken.charts[firstId].fold = `${broken.charts[firstId].fold.slice(0, -3)}zzz`;
  assert.throws(() => validateDataset(broken), /v3 chart/);
  const extraKey = structuredClone(data);
  extraKey.spots['6max-100bb-zz-rfi-v3'] = firstId;
  assert.throws(() => validateDataset(extraKey), /v3 keys/);
  const callInRfi = structuredClone(data);
  const rfiId = callInRfi.spots['6max-100bb-btn-rfi-v3'];
  callInRfi.charts[rfiId].call = '000'.repeat(169).replace(/^000/, '001');
  assert.throws(() => validateDataset(callInRfi), /v3/);
  const version = structuredClone(data);
  version.version = '3.0.1';
  assert.throws(() => validateDataset(version), /v3 identity/);
});

test('G1: opening widths sit inside commonly published bands', () => {
  const rfi = (n, pos) => percent(freqs(`${n}max-100bb-${pos}-rfi-v3`), row => row.raise);
  const bands = { utg: [14, 19], hj: [18, 24], co: [25, 31], btn: [40, 50], sb: [36, 46] };
  for (const [pos, [lo, hi]] of Object.entries(bands)) {
    const value = rfi(6, pos);
    assert.ok(value >= lo && value <= hi, `6max ${pos} ${value}`);
  }
  const utg9 = rfi(9, 'utg');
  assert.ok(utg9 >= 8 && utg9 <= 12, `9max utg ${utg9}`);
  const hu = rfi(2, 'sb');
  assert.ok(hu >= 70 && hu <= 90, `HU sb ${hu}`);
});

test('G1: blind defence widths', () => {
  const bbBtn = percent(freqs('6max-100bb-bb-vs-btn-open-v3'), continuing);
  assert.ok(bbBtn >= 45 && bbBtn <= 62, `BB vs BTN ${bbBtn}`);
  const bbUtg = percent(freqs('6max-100bb-bb-vs-utg-open-v3'), continuing);
  assert.ok(bbUtg >= 22 && bbUtg <= 34, `BB vs UTG ${bbUtg}`);
});

test('G1: premiums never fold and 72o never opens', () => {
  for (const key of preflopKeysV3()) {
    const rows = freqs(key);
    const { context } = parsePreflopKeyV3(key);
    for (const hand of ['AA', 'KK', 'QQ', 'AKs']) {
      if (context === 'vs-3bet' && at(rows, hand).fold === 1 && at(rows, hand).raise === 0 && at(rows, hand).call === 0) {
        continue; // a 3-bet spot is only reachable through the opener's own range
      }
      assert.equal(at(rows, hand).fold, 0, `${key} ${hand}`);
    }
    if (context === 'rfi-unopened') assert.equal(at(rows, '72o').raise, 0, key);
  }
});

test('G1: pairs and suitedness are monotone within every chart', () => {
  const pairs = ['AA', 'KK', 'QQ', 'JJ', 'TT', '99', '88', '77', '66', '55', '44', '33', '22'];
  for (const key of preflopKeysV3()) {
    const rows = freqs(key);
    const { context } = parsePreflopKeyV3(key);
    if (context === 'vs-3bet') continue; // conditional on the opener's range; checked below
    for (let i = 1; i < pairs.length; i += 1) {
      assert.ok(continuing(at(rows, pairs[i - 1])) >= continuing(at(rows, pairs[i])) - 0.02, `${key} ${pairs[i - 1]} < ${pairs[i]}`);
    }
    for (const cls of HAND_CLASSES.filter(c => c.endsWith('s'))) {
      const off = `${cls.slice(0, 2)}o`;
      assert.ok(continuing(at(rows, cls)) >= continuing(at(rows, off)) - 0.02, `${key} ${cls} < ${off}`);
    }
  }
});

test('G1: a later opener never plays a hand less often than an earlier one', () => {
  for (const [n, order] of Object.entries(PREFLOP_ORDERS_V3)) {
    if (Number(n) < 3) continue;
    const openers = order.slice(0, -2); // SB opens a different spot (only BB behind)
    for (let i = 1; i < openers.length; i += 1) {
      const earlier = freqs(`${n}max-100bb-${openers[i - 1].toLowerCase()}-rfi-v3`);
      const later = freqs(`${n}max-100bb-${openers[i].toLowerCase()}-rfi-v3`);
      HAND_CLASSES.forEach((hand, h) => assert.ok(later[h].raise >= earlier[h].raise - 0.02, `${n}max ${openers[i]} ${hand}`));
    }
  }
});

test('G1: facing a 3-bet, hands outside the opening range fold', () => {
  for (const key of preflopKeysV3().filter(k => k.endsWith('-3bet-v3'))) {
    const { seated, position } = parsePreflopKeyV3(key);
    const open = freqs(`${seated}max-100bb-${position.toLowerCase()}-rfi-v3`);
    const rows = freqs(key);
    HAND_CLASSES.forEach((hand, h) => {
      if (open[h].raise === 0) assert.equal(rows[h].fold, 1, `${key} ${hand}`);
    });
  }
});

test('G2: heads-up push/fold matches published chip-EV Nash widths', () => {
  const push = s => percent(freqs(`2max-${s}bb-sb-push-v3`), row => row.raise);
  const call = s => percent(freqs(`2max-${s}bb-bb-vs-sb-shove-v3`), row => row.call);
  const within = (value, lo, hi, label) => assert.ok(value >= lo && value <= hi, `${label} ${value}`);
  within(push(10), 54, 62, 'push 10bb');
  within(call(10), 33, 41, 'call 10bb');
  within(push(15), 42, 50, 'push 15bb');
  within(push(5), 66, 78, 'push 5bb');
  // Fewer players behind means a wider shove.
  assert.ok(push(10) > percent(freqs('9max-10bb-btn-push-v3'), row => row.raise));
  assert.ok(percent(freqs('9max-10bb-btn-push-v3'), row => row.raise) > percent(freqs('9max-10bb-utg-push-v3'), row => row.raise));
});
