// Exercise real user turns without creating an illegal full raise when only a
// short all-in is available. A rejected/failed POST must remain retryable.
export async function submitLearningAction(legal, sent, post) {
  if (sent.has(legal.decisionId)) return null;
  const action = legal.canRaise
    ? { decisionId: legal.decisionId, action: 'raise', amount: Math.min(legal.minRaiseTo, legal.maxRaiseTo) }
    : { decisionId: legal.decisionId, action: legal.canCheck ? 'check' : 'fold' };
  const result = await post(action);
  if (result?.ok === true) sent.add(legal.decisionId);
  return result;
}
