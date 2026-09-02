import { handClassOf } from '../cards.js';
import { normalizePreflopSpot } from '../preflop-spot.js';
import { lookup } from '../providers/preflop-json.js';
import { fallbackLegal, legalizeEntries } from './contracts.js';
import { ruleBasedDistribution } from './rule-based.js';

export function createBaselinePolicy({ dataset } = {}) {
  if (!dataset) {
    const error = new Error('baseline dataset is required');
    error.code = 'DATASET_INVALID';
    throw error;
  }
  return {
    distribution(snapshot, legal, { config } = {}) {
      return baselineDistribution(snapshot, legal, { dataset, config });
    },
  };
}

export function baselineDistribution(snapshot, legal, { dataset, config } = {}) {
  if (!dataset) {
    const error = new Error('baseline dataset is required');
    error.code = 'DATASET_INVALID';
    throw error;
  }
  const bb = snapshot?.blinds?.[1];
  const spot = snapshot ? normalizePreflopSpot(snapshot) : { ok: false };
  if (spot.ok) {
    const source = dataset;
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
