import { listHands, normalizeHand, assertNoSecrets } from './hand-normalizer.js';
import { renderPokerStars } from './pokerstars.js';
import { validateCanonicalHand, warningsFor } from './contracts.js';

export function mergeWarnings(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const row of list ?? []) {
      const key = `${row.handNo}:${row.exportStatus}:${row.reason ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

export function buildCanonical(gameDir, { exportedAt = '2026-09-01T00:00:00.000Z', evaluationsByHand = {} } = {}) {
  const { state, records } = listHands(gameDir);
  const warnings = [];
  const hands = [];
  for (const record of records) {
    const hand = normalizeHand(record, {
      evaluations: evaluationsByHand[record.handNo] ?? [],
    });
    const verdict = validateCanonicalHand(hand);
    if (verdict.exportStatus !== 'ok') {
      warnings.push({
        handNo: hand.handNo,
        exportStatus: verdict.exportStatus,
        reason: verdict.reason,
      });
    }
    if (verdict.exportStatus === 'unsupported') continue;
    hands.push(hand);
    const warning = warningsFor(hand);
    if (warning) warnings.push({ handNo: hand.handNo, ...warning });
  }
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
    warnings,
  };
  assertNoSecrets(payload);
  return payload;
}

export function buildText(canonical, opts) {
  const rendered = renderPokerStars(canonical, opts);
  return {
    text: rendered.text,
    warnings: mergeWarnings(canonical.warnings, rendered.warnings),
  };
}
