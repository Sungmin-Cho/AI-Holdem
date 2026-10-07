// One practice goal for the study room, the practice focus and the coach
// (design D12). Only independent exact decisions count: no pre-action hint, not
// forced, an unbiased deal, and an exact reference comparison. Game and
// practice records are scored separately and a game goal wins. For each skill,
// the latest 30 decisions give an off-policy share weighted by sample
// confidence n/(n+5); a skill is resolved once at least five of them are in
// and 80% or more were allowed. The goal names the latest hand actually missed.
import { independentAssessmentEligibility } from '../shared/assistance.js';
import { matchReferenceActionFor } from '../shared/reference.js';

export const GOAL_WINDOW = 30;
export const RESOLVE_MIN = 5;
export const RESOLVE_ALLOWED = 0.8;

const originOf = (event) => (['practice', 'drill', 'retest'].includes(event.origin) ? 'practice' : 'game');

export function skillStanding(rows) {
  const recent = rows.slice(-GOAL_WINDOW);
  const n = recent.length;
  const off = recent.filter((row) => row.offPolicy).length;
  const allowed = recent.filter((row) => row.allowed).length;
  const resolved = n >= RESOLVE_MIN && allowed / n >= RESOLVE_ALLOWED;
  return { n, off, allowed, resolved, offPolicyRate: n ? off / n : 0, score: n ? (off / n) * (n / (n + 5)) : 0 };
}

export function selectGoal(events) {
  const groups = new Map();
  const ordered = [...(events ?? [])].filter(Boolean)
    .sort((a, b) => String(a.appliedAt ?? '').localeCompare(String(b.appliedAt ?? '')));
  for (const event of ordered) {
    const observation = event.mixObservation;
    if (!observation || typeof event.skillKey !== 'string') continue;
    let eligible = false;
    try { eligible = independentAssessmentEligibility(event).metricEligible; } catch { eligible = false; }
    if (!eligible) continue;
    const key = `${originOf(event)}\u0000${event.skillKey}`;
    const rows = groups.get(key) ?? [];
    rows.push({
      event,
      offPolicy: event.grade === 'off-policy',
      allowed: (matchReferenceActionFor(observation.sourceIdentity, observation.referenceActions, observation.chosenAction)?.frequency ?? 0) > 0,
    });
    groups.set(key, rows);
  }
  const best = { game: null, practice: null };
  for (const [key, rows] of groups) {
    const [origin, skillKey] = key.split('\u0000');
    const standing = skillStanding(rows);
    if (standing.resolved || standing.off === 0) continue;
    const missed = rows.slice(-GOAL_WINDOW).filter((row) => row.offPolicy).at(-1).event;
    const candidate = { origin, skillKey, standing, missed };
    const current = best[origin];
    if (!current || standing.score > current.standing.score
      || (standing.score === current.standing.score && String(missed.appliedAt) > String(current.missed.appliedAt))) best[origin] = candidate;
  }
  const chosen = best.game ?? best.practice;
  if (!chosen) return null;
  const observation = chosen.missed.mixObservation;
  return {
    origin: chosen.origin,
    sourceIdentity: { ...observation.sourceIdentity },
    spotKey: observation.spotKey,
    handClass: observation.handClass,
    skillKey: chosen.skillKey,
    offPolicyRate: chosen.standing.offPolicyRate,
    sample: chosen.standing.n,
    score: chosen.standing.score,
    reason: 'reference-deviation',
  };
}

/** The practice-focus goal (coach and lobby): the same choice in that file's shape. */
export function practiceFocusGoal(events) {
  const goal = selectGoal(events);
  if (!goal) return null;
  return { id: goal.skillKey, recommendedDrill: goal.skillKey, severity: goal.score, confidence: goal.sample / (goal.sample + 5), reason: goal.reason };
}
