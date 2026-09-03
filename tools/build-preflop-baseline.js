import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allHandClasses } from '../training/cards.js';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const RANK_I = Object.fromEntries(RANKS.map((r, i) => [r, i]));

function pairRank(hand) {
  return hand.length === 2 ? hand[0] : null;
}

function isPair(hand) {
  return hand.length === 2;
}

function suited(hand) {
  return hand.endsWith('s');
}

function high(hand) {
  return isPair(hand) ? hand[0] : hand[0];
}

function low(hand) {
  return isPair(hand) ? hand[1] : hand[1];
}

function rfiMix(position, hand) {
  const p = pairRank(hand);
  const h = RANK_I[high(hand)];
  const l = RANK_I[low(hand)];
  const s = suited(hand);
  const open = {
    utg: 0.12, hj: 0.16, co: 0.22, btn: 0.38, sb: 0.32,
  }[position];
  let raise = 0;
  if (isPair(hand)) {
    if (RANK_I[p] <= RANK_I['7']) raise = 1;
    else if (RANK_I[p] <= RANK_I['4']) raise = position === 'utg' ? 0.35 : 0.8;
    else raise = position === 'utg' ? 0 : (position === 'hj' ? 0.15 : 0.55);
  } else if (s) {
    if (hand.startsWith('AK') || hand.startsWith('AQ') || hand.startsWith('AJ') || hand.startsWith('KQ')) raise = 1;
    else if (h <= RANK_I['J'] && l - h <= 2) raise = open > 0.2 ? 0.7 : 0.15;
    else if (h === 0 && l <= RANK_I['T']) raise = position === 'btn' || position === 'co' ? 0.6 : 0.2;
    else raise = open > 0.3 ? 0.25 : 0;
  } else {
    if (hand.startsWith('AK') || hand.startsWith('AQ')) raise = 1;
    else if (hand.startsWith('AJ') || hand.startsWith('KQ')) raise = position === 'utg' ? 0.2 : 0.85;
    else if (h === 0 && l <= RANK_I['J']) raise = position === 'btn' ? 0.4 : 0;
    else raise = 0;
  }
  raise = Math.min(1, Math.max(0, raise));
  const fold = Number((1 - raise).toFixed(4));
  raise = Number((1 - fold).toFixed(4));
  const actions = [];
  if (raise > 0) actions.push({ action: 'raise', sizeBb: 2.5, frequency: raise });
  if (fold > 0) actions.push({ action: 'fold', frequency: fold });
  return actions;
}

function vsRaiseMix(hand) {
  const p = pairRank(hand);
  let threeBet = 0;
  let call = 0;
  if (isPair(hand) && RANK_I[p] <= RANK_I['J']) threeBet = 1;
  else if (isPair(hand) && RANK_I[p] <= RANK_I['8']) { threeBet = 0.25; call = 0.55; }
  else if (hand === 'AKs' || hand === 'AKo' || hand === 'AQs') threeBet = 0.85;
  else if (hand === 'AQo' || hand === 'AJs' || hand === 'KQs') { threeBet = 0.2; call = 0.5; }
  else if (hand.endsWith('s') && hand[0] === 'A') call = 0.35;
  else threeBet = 0;
  threeBet = Number(threeBet.toFixed(4));
  call = Number(call.toFixed(4));
  let fold = Number((1 - threeBet - call).toFixed(4));
  if (fold < 0) fold = 0;
  const actions = [];
  if (threeBet > 0) actions.push({ action: 'raise', sizeBb: 8.5, frequency: threeBet });
  if (call > 0) actions.push({ action: 'call', frequency: call });
  if (fold > 0) actions.push({ action: 'fold', frequency: fold });
  const sum = actions.reduce((s, a) => s + a.frequency, 0);
  if (actions.length) actions[actions.length - 1].frequency = Number((actions.at(-1).frequency + (1 - sum)).toFixed(4));
  return actions;
}

const classes = allHandClasses();
const spots = {};
for (const pos of ['utg', 'hj', 'co', 'btn', 'sb']) {
  const table = {};
  for (const hand of classes) table[hand] = rfiMix(pos, hand);
  spots[`6max-100bb-${pos}-rfi-unopened`] = table;
}
for (const pos of ['bb', 'sb', 'btn']) {
  const table = {};
  for (const hand of classes) table[hand] = vsRaiseMix(hand);
  spots[`6max-100bb-${pos}-vs-single-raise`] = table;
}

const dataset = {
  schemaVersion: 1,
  id: 'local-preflop-baseline',
  version: '1.0.0',
  license: 'Apache-2.0',
  tree: { rfiBb: 2.5, threeBetBb: 8.5 },
  methodology: 'Original frequency-only sketch from public general-principle ranges. Not copied from a commercial solver dump.',
  spots,
};

const out = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../training/data/preflop-baseline-v1.json',
);
const body = `${JSON.stringify(dataset)}\n`;
fs.writeFileSync(out, body);
const digest = createHash('sha256').update(body).digest('hex');
fs.writeFileSync(`${out.replace(/\.json$/, '.sha256')}`, `${digest}\n`);
process.stdout.write(`${out}\n`);
