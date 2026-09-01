const SMALL_SAMPLE = 8;

export function detectLeaks(skills = {}) {
  const leaks = [];
  for (const [id, skill] of Object.entries(skills)) {
    const opportunities = skill.opportunities ?? 0;
    const preferred = skill.preferredActionRate ?? 0;
    const deviation = 1 - preferred;
    const impact = skill.evLossBb != null ? skill.evLossBb : deviation * opportunities;
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
  return leaks.sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
}
