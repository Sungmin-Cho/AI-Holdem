const SMALL_SAMPLE = 8;

export function detectLeaks(skills = {}) {
  const leaks = [];
  const coverageGaps = [];
  for (const [id, skill] of Object.entries(skills)) {
    const opportunities = skill.opportunities ?? 0;
    const supported = skill.supported ?? 0;
    if (supported === 0) {
      coverageGaps.push({
        id,
        opportunities,
        supported: 0,
        recommendedDrill: id,
      });
      continue;
    }
    const preferred = skill.preferredActionRate ?? 0;
    const deviation = 1 - preferred;
    const impact = skill.evLossBb != null ? skill.evLossBb : deviation * supported;
    const confidence = skill.confidence ?? 0;
    const small = opportunities < SMALL_SAMPLE;
    leaks.push({
      id,
      severity: impact * confidence * (small ? 0.3 : 1),
      confidence,
      opportunities,
      evLossBb: skill.evLossBb ?? null,
      preferredActionRate: preferred,
      recommendedDrill: id,
      ...(small ? { note: 'small-sample' } : {}),
    });
  }
  leaks.sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
  coverageGaps.sort((a, b) => a.id.localeCompare(b.id));
  return { leaks, coverageGaps };
}
