const SMALL_SAMPLE = 8;

export function detectLeaks(skills = {}) {
  const candidates = [];
  const coverageGaps = [];
  for (const [id, skill] of Object.entries(skills)) {
    const opportunities = skill.opportunities ?? 0;
    const supported = skill.supported ?? 0;
    if (supported === 0) {
      coverageGaps.push({ id, opportunities, supported: 0, recommendedDrill: id });
      continue;
    }
    const modalActionRate = skill.modalActionRate ?? skill.preferredActionRate ?? 0;
    const evidence = Number.isFinite(skill.offPolicy)
      ? Math.max(0, skill.offPolicy)
      : Math.max(0, supported * (1 - modalActionRate));
    if (evidence === 0) continue;
    const confidence = skill.sampleWeight ?? skill.confidence ?? Math.min(1, opportunities / 20);
    const small = opportunities < SMALL_SAMPLE;
    const severity = evidence * confidence * (small ? 0.3 : 1);
    if (severity <= 0) continue;
    candidates.push({
      id,
      severity,
      confidence,
      opportunities,
      evidence,
      evLossBb: null,
      allowedActionRate: skill.allowedActionRate ?? null,
      modalActionRate,
      preferredActionRate: modalActionRate,
      recommendedDrill: id,
      reason: 'reference-deviation',
      ...(small ? { note: 'small-sample' } : {}),
    });
  }
  candidates.sort((left, right) => right.severity - left.severity || left.id.localeCompare(right.id));
  coverageGaps.sort((left, right) => left.id.localeCompare(right.id));
  return { leaks: candidates, candidates, coverageGaps };
}
