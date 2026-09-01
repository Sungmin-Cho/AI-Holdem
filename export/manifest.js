import { listHands, normalizeHand, assertNoSecrets } from './hand-normalizer.js';
import { renderPokerStars } from './pokerstars.js';

export function buildCanonical(gameDir, { exportedAt = '2026-09-01T00:00:00.000Z', evaluationsByHand = {} } = {}) {
  const { state, records } = listHands(gameDir);
  const hands = records.map((record) => normalizeHand(record, {
    evaluations: evaluationsByHand[record.handNo] ?? [],
  }));
  const payload = {
    schemaVersion: 1,
    exportedAt,
    source: {
      application: 'AI-Holdem',
      repositorySchema: 1,
      gameEpoch: state?.gameEpoch ?? null,
      mode: state?.config?.mode ?? 'tournament',
    },
    session: {
      blinds: records[0]?.blinds ?? state?.config?.blinds0 ?? [25, 50],
      currency: 'PLAY',
      tableSize: Object.keys(records[0]?.startStacks ?? {}).length || (state?.seats?.length ?? 0),
    },
    hands,
    warnings: [],
  };
  assertNoSecrets(payload);
  return payload;
}

export function buildText(canonical, opts) {
  return renderPokerStars(canonical, opts);
}
