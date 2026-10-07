import { evaluatePreflopReference } from './preflop-reference.js';
import { evaluatePreflopReferenceV3 } from './preflop-reference-v3.js';

/** The resolver for the dataset's schema: v3 for schema 3, the v2 resolver otherwise. */
export function evaluateReference(snapshot, dataset, options) {
  return dataset?.data?.schemaVersion === 3
    ? evaluatePreflopReferenceV3(snapshot, dataset, options)
    : evaluatePreflopReference(snapshot, dataset, options);
}
