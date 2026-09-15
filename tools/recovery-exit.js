// Engine/loop lifecycle only: never inspect the unverifiable pending subtree.
export function abortModeFor(engine, state) {
  if (engine?.gameOver === false && ['bootstrap', 'playing'].includes(state?.phase)) return 'abort';
  if (engine?.gameOver === true && ['playing', 'finalizing', 'review_generated', 'review_published'].includes(state?.phase)) return 'finalize';
  return null;
}
