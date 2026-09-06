const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set(['free', 'leak', 'daily', 'mistake-review', 'assessment', 'retest']);

function coded(message) {
  const error = new Error(message);
  error.code = 'STUDY_RUN_INVALID';
  return error;
}

export function validateStudyRun(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !UUID_RE.test(value.id ?? '')
    || !MODES.has(value.mode)
    || !Number.isInteger(value.total) || value.total < 1 || value.total > 100
    || !Number.isInteger(value.index) || value.index < 0 || value.index >= value.total
    || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
    || (value.assessmentId != null && !UUID_RE.test(value.assessmentId))) {
    throw coded('study run is invalid');
  }
  return {
    id: value.id,
    mode: value.mode,
    total: value.total,
    index: value.index,
    startedAt: new Date(value.startedAt).toISOString(),
    ...(value.assessmentId != null ? { assessmentId: value.assessmentId } : {}),
  };
}
