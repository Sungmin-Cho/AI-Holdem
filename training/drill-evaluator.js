import { referenceQuality } from '../shared/reference.js';

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
  const quality = referenceQuality(source);
  if (quality.quality !== 'heuristic-reference') {
    return {
      questionId: question.questionId,
      status: 'unverified',
      grade: null,
      frequency: null,
      recommended: [],
      feedback: '출처 식별값이 확인되지 않아 기준표 채점에서 제외했습니다.',
      providerVersion: source.version,
    };
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
    status: 'reference-adherence',
    grade,
    frequency,
    recommended: [...actions].sort((a, b) => b.frequency - a.frequency),
    feedback: grade === 'off-policy'
      ? '기준표와 다른 선택입니다. 이 스팟을 연습 후보로 기록할 수 있습니다.'
      : '기준표 빈도에 포함된 허용 선택입니다. 한 번의 액션은 분포 일치도를 뜻하지 않습니다.',
    providerVersion: source.version,
  };
}
