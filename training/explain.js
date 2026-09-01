export function validateExplanation(evaluation, explanation) {
  if (typeof explanation !== 'string' || !explanation.trim()) {
    return { ok: false, code: 'EMPTY_EXPLANATION' };
  }
  if (evaluation?.status !== 'supported') {
    if (/(정답|GTO)/i.test(explanation) && !/지원되지/.test(explanation)) {
      return { ok: false, code: 'UNSUPPORTED_AS_ANSWER' };
    }
    return { ok: true };
  }
  const allowed = new Set();
  const add = (value) => {
    if (value == null || value === '') return;
    allowed.add(String(value));
    const num = Number(value);
    if (Number.isFinite(num)) allowed.add(String(num));
  };
  add(evaluation.handNo);
  add(evaluation.handClass);
  add(evaluation.grade);
  for (const action of [evaluation.chosen, ...(evaluation.recommended ?? [])]) {
    if (!action) continue;
    add(action.frequency);
    add(action.sizeBb);
    add(action.evBb);
    add(action.action);
  }
  const tokens = explanation.match(/-?\d+(?:\.\d+)?/g) ?? [];
  for (const token of tokens) {
    const hit = [...allowed].some((item) => item === token || Number(item) === Number(token));
    if (!hit) return { ok: false, code: 'NUMBER_CONTRADICTION' };
  }
  return { ok: true };
}
