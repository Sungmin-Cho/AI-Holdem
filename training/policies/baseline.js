import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handClassOf } from '../cards.js';
import { normalizePreflopSpot } from '../preflop-spot.js';
import { loadPreflopJson, lookup } from '../providers/preflop-json.js';
import { fallbackLegal, legalizeEntries } from './contracts.js';
import { ruleBasedDistribution } from './rule-based.js';

const DATASET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/preflop-baseline-v1.json');

let cached = null;

export function loadBaselineDataset(filePath = DATASET) {
  if (cached && filePath === DATASET) return cached;
  const loaded = loadPreflopJson(filePath);
  if (filePath === DATASET) cached = loaded;
  return loaded;
}

export function baselineDistribution(snapshot, legal, { dataset, config } = {}) {
  const bb = snapshot?.blinds?.[1];
  const spot = snapshot ? normalizePreflopSpot(snapshot) : { ok: false };
  if (spot.ok) {
    const source = dataset ?? loadBaselineDataset();
    const strategy = lookup(source, {
      spotKey: spot.spotKey,
      handClass: handClassOf(snapshot.holeCards),
    });
    if (strategy.status === 'supported') {
      const next = legalizeEntries(
        strategy.actions.map((action) => ({ ...action, reasonCode: 'baseline' })),
        legal,
        { bb },
      );
      if (next.length) return next;
    }
  }
  const fallback = ruleBasedDistribution(legal, config ?? {}, { bb });
  return fallback.length ? fallback.map((row) => ({ ...row, reasonCode: row.reasonCode ?? 'fallback' })) : fallbackLegal(legal);
}
