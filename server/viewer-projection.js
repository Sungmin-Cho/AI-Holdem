import { isDeepStrictEqual } from 'node:util';
import { viewFor, spectatorView } from '../engine/views.js';
import { gameEpochOf, humanIdsOf } from '../publish-contract.js';

export function prepareViewerProjection(engine, view, {publishId, revision} = {}) {
  if (!engine || !isDeepStrictEqual(view, viewFor(engine, 'user'))) return null;
  return {
    projectionAnchor: {gameEpoch:gameEpochOf(engine.sessionToken), stateVersion:engine.stateVersion,
      handNo:engine.handNo, publishId, revision},
    spectatorView:spectatorView(engine),
  };
}

export function restoreViewerProjection(engine, raw) {
  // Restoration is also merged into a running relay during commit recovery.
  // Explicit nulls revoke its old full-card capability on every failed proof.
  const unavailable = {spectatorView:null,projectionAnchor:null};
  const anchor = raw.projectionAnchor;
  if (!engine || !anchor || anchor.gameEpoch !== gameEpochOf(engine.sessionToken)
    || anchor.stateVersion !== engine.stateVersion || anchor.handNo !== engine.handNo
    || !Number.isSafeInteger(anchor.publishId) || anchor.publishId < 1 || anchor.publishId > raw.publishId
    || !Number.isSafeInteger(anchor.revision) || anchor.revision < 1 || anchor.revision > raw.revision) return unavailable;
  const projection = prepareViewerProjection(engine, raw.view, anchor);
  if (!projection) return unavailable;
  const views = Object.fromEntries(humanIdsOf(engine.seats).map(id => [id,viewFor(engine,id)]));
  return {...projection, views};
}
