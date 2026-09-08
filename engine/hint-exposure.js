import { snapshotDecision } from './decision.js';
import { legalFor, blindsForLevel } from './hand.js';
import { gameEpochOf } from '../publish-contract.js';
import { closed, observationHash, exposureIdentity, hintError } from '../shared/decision-observation.js';
import { HINT_MAX_BYTES } from '../shared/hint-contract.js';

/** Runs only inside the engine mutation lock. No reference or policy dependency. */
export function exposeHint(state, meta, { decisionId, expectVersion, playerId }) {
  if (state.stateVersion !== expectVersion) throw hintError('VERSION_MISMATCH');
  if (state.config.hintContractVersion !== 1 || state.config.hints !== 'on') throw hintError('HINT_CAPABILITY_UNAVAILABLE');
  closed(meta, ['schemaVersion','gameEpoch','decisionId','source','observationSha256','recommendationSha256']);
  closed(meta.source, ['id','version','contentSha256']);
  const hex = /^[a-f0-9]{64}$/;
  if (meta.schemaVersion !== 1 || !hex.test(meta.gameEpoch) || !hex.test(meta.observationSha256)
    || !hex.test(meta.recommendationSha256) || !hex.test(meta.source.contentSha256)
    || typeof meta.source.id !== 'string' || meta.source.id.length > 200 || meta.source.version !== '2.0.0'
    || meta.gameEpoch !== gameEpochOf(state.sessionToken) || meta.decisionId !== decisionId) throw hintError('HINT_PROOF_MISMATCH');
  const legal = legalFor(state);
  if (playerId !== 'user' || legal.toAct !== 'user' || legal.decisionId !== decisionId || !state.hand) throw hintError('HINT_STALE_CONTEXT');
  const observationSnapshot = snapshotDecision(state, 'user', null, { legal, blinds: blindsForLevel(state.level,state.config.blinds0) });
  if (Buffer.byteLength(JSON.stringify(observationSnapshot)) > HINT_MAX_BYTES) throw hintError('HINT_SNAPSHOT_INVALID');
  if (observationHash(observationSnapshot) !== meta.observationSha256) throw hintError('HINT_PROOF_MISMATCH');
  const exposureId = exposureIdentity(meta);
  const existing = state.hand.hintExposures[decisionId];
  if (existing && existing.exposureId !== exposureId) throw hintError('HINT_EXPOSURE_CONFLICT');
  if (!existing) state.hand.hintExposures[decisionId] = { schemaVersion: 1, exposureId, source: structuredClone(meta.source),
    observationSha256: meta.observationSha256, recommendationSha256: meta.recommendationSha256, observationSnapshot };
  return state.hand.hintExposures[decisionId];
}
