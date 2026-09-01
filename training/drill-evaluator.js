function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function gradeFrequency(chosenFreq, actions) {
  const f = chosenFreq ?? 0;
  if (f === 0) return 'off-policy';
  const max = Math.max(...actions.map((action) => action.frequency));
  if (f === max || f >= 0.50) return 'preferred';
  if (f >= 0.10) return 'mixed';
  return 'low-frequency';
}

export function evaluateDrillAnswer(question, answer, strategy) {
  const expected = question.answerPolicy ?? {};
  const source = strategy?.source ?? {};
  if (expected.providerId && source.id && expected.providerId !== source.id) {
    throw coded('PROVIDER_VERSION_MISMATCH', 'provider id mismatch');
  }
  if (expected.providerVersion && source.version && expected.providerVersion !== source.version) {
    throw coded('PROVIDER_VERSION_MISMATCH', 'provider version mismatch');
  }
  const actions = strategy.actions ?? [];
  const chosen = answer?.action;
  const hit = actions.find((action) => {
    if (action.action !== chosen) return false;
    if (chosen === 'raise' && answer.sizeBb != null && action.sizeBb != null) {
      return Math.abs(action.sizeBb - answer.sizeBb) <= 0.05;
    }
    return true;
  });
  const frequency = hit?.frequency ?? 0;
  const grade = gradeFrequency(frequency, actions);
  return {
    questionId: question.questionId,
    grade,
    frequency,
    recommended: [...actions].sort((a, b) => b.frequency - a.frequency),
    feedback: '빈도 기반 피드백입니다. mixed strategy에서 한 액션이 곧 오답은 아닙니다.',
    providerVersion: source.version,
  };
}
