import { resolvePreflopReference } from './preflop-reference.js';
import { projectReferenceCoverage } from '../shared/reference-coverage.js';
import { projectHint } from '../shared/hint-contract.js';
import { hashCanonical, observationHash, exposureIdentity } from '../shared/decision-observation.js';

export function recommendationHash({ decisionId, source, coverage, actions }) {
  const order = ['fold','check','call','raise'];
  return hashCanonical({ schemaVersion: 1, decisionId, source, coverage: projectReferenceCoverage(coverage),
    actions: [...actions].sort((a,b) => order.indexOf(a.action)-order.indexOf(b.action)) });
}
export function buildPreActionHint(snapshot, dataset, { gameEpoch, stateVersion }) {
  const identity = { schemaVersion: 1, gameEpoch, decisionId: snapshot.decisionId, handNo: snapshot.handNo, stateVersion };
  const source = { id: dataset.data.id, version: dataset.data.version, contentSha256: dataset.contentSha256 };
  if (source.version !== '2.0.0') return projectHint({ ...identity, status: 'unsupported', source, code: 'HINT_SOURCE_UNSUPPORTED' });
  if (snapshot.street !== 'preflop') return projectHint({ ...identity, status: 'unsupported', source, code: 'HINT_STREET_UNSUPPORTED' });
  const observationSha256 = observationHash(snapshot);
  const reference = resolvePreflopReference(snapshot, dataset);
  if (reference.status !== 'supported') return projectHint({ ...identity, status: 'unsupported', source, code: reference.code });
  const coverage = projectReferenceCoverage(reference.coverage);
  const actions = reference.actions.filter(row => row.frequency > 0).map(row => ({ action: row.action, frequency: row.frequency,
    ...(row.action === 'raise' ? { raiseToChips: coverage.reference.sizing.raiseToChips } : {}) }));
  const recommendation = { decisionId: snapshot.decisionId, source, coverage, actions };
  const recommendationSha256 = recommendationHash(recommendation);
  const exposureId = exposureIdentity({ gameEpoch, decisionId: snapshot.decisionId, source, observationSha256, recommendationSha256 });
  return projectHint({ ...identity, status: 'supported', source, coverage, actions, exposureId });
}
