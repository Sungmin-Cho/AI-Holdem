// Deterministic coaching material built from completed hand records: per-decision
// fact lines for the coach/review prompts, and process detectors plus coach-note
// digests for the machine review. Nothing here is a strategy verdict.
import fs from 'node:fs';
import { chipFacts, equityFacts, factsLineKo, handFacts } from '../shared/decision-facts.js';
import { coachEquityRanges, estimateCoachRanges } from '../training/ranges/coach-estimate.js';
import { buildProcessInput } from '../training/process-review.js';

const HOST = 'user';

function userDecisions(record) {
  return (record?.decisions ?? []).filter((snap) => snap?.actorId === HOST && snap.decisionId);
}

// Coaching facts for one user decision. `equityRange` keeps its old field name but
// now comes from the coaching-only public-action estimate (not the recorded policy
// estimator): only opponents already committed on this street, only when every
// live opponent is fully conditioned. `rangeEstimate` carries method, status, limitations
// and per-player evidence status, never the weights or any hidden information.
export function decisionFacts(snap) {
  // Raw legacy/evaluator records may contain an unreadable decision. Omit its
  // facts without losing the valid decisions in the same hand.
  try { return buildDecisionFacts(snap); }
  catch { return null; }
}

function buildDecisionFacts(snap) {
  const chips = chipFacts(snap);
  if (!chips) return null;
  const equityRandom = equityFacts(snap);
  let equityRange = null;
  let estimate = null;
  let rangeMeta = null;
  try {
    estimate = estimateCoachRanges(snap);
    const { ranges, reason, excluded } = coachEquityRanges(estimate);
    rangeMeta = { acted: estimate.acted.length, excluded, reason };
    if (ranges) {
      try {
        equityRange = equityFacts(snap, { ranges });
      } catch {
        rangeMeta.reason = 'equity-failed';
      }
    }
  } catch {
    rangeMeta = { acted: 0, excluded: 0, reason: 'no-estimate' };
  }
  const rangeEstimate = estimate && {
    method: estimate.method,
    status: estimate.status,
    limitations: estimate.limitations,
    issues: estimate.issues,
    acted: estimate.acted,
    unacted: estimate.unacted,
    players: Object.fromEntries(Object.entries(estimate.players).map(([pid, row]) => [pid,
      { status: row.status, reasons: row.reasons, appliedActions: row.appliedActions, actedThisStreet: row.actedThisStreet }])),
    equityOmitted: equityRange === null ? rangeMeta.reason : null,
  };
  return { chips, hand: handFacts(snap), equityRandom, equityRange, rangeEstimate,
    line: factsLineKo(snap, { equityRandom, equityRange, rangeMeta }) };
}

// "d-3-flop-5: 팟 …" lines for one hand record (the user's own decisions only).
export function decisionFactsLines(record) {
  return userDecisions(record).map((snap) => {
    const facts = decisionFacts(snap);
    return facts ? `${snap.decisionId}: ${facts.line}` : null;
  }).filter(Boolean);
}

const isUnopenedPreflop = (snap) => snap.street === 'preflop'
  && !(snap.priorActions ?? []).some((a) => (a.street ?? 'preflop') === 'preflop' && (a.action === 'raise' || a.action === 'call'));

// Process detectors over the user's decisions. Each finding cites hand numbers.
export function processDetectors(records) {
  const out = { foldWhenCheck: [], minRaises: { count: 0, raises: 0, hands: [] }, openSizesBb: [],
    weakStackOffs: [], biggestLosses: [], decisions: 0 };
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    const handNo = record.handNo;
    const projected = buildProcessInput([record]).hands[0].decisions;
    const decisions = projected.filter((decision) => decision.processStatus === 'available');
    for (const snap of decisions) {
      out.decisions += 1;
      const chosen = snap.chosenAction ?? {};
      const bb = snap.blinds?.[1];
      if (chosen.action === 'fold' && snap.legal?.canCheck === true) out.foldWhenCheck.push(handNo);
      if (chosen.action === 'raise') {
        out.minRaises.raises += 1;
        if (chosen.amount === snap.minRaiseTo && snap.minRaiseTo < snap.maxRaiseTo) {
          out.minRaises.count += 1;
          out.minRaises.hands.push(handNo);
        }
        if (bb && isUnopenedPreflop(snap)) out.openSizesBb.push(Math.round((chosen.amount / bb) * 10) / 10);
      }
      // Putting the rest of the stack in postflop with less than top pair and no strong draw.
      const allInCommit = (chosen.action === 'call' && snap.toCall > 0 && snap.toCall >= (snap.publicSeats ?? []).find((s) => s.playerId === HOST)?.stack)
        || (chosen.action === 'raise' && chosen.amount >= snap.maxRaiseTo);
      if (allInCommit && snap.street !== 'preflop') {
        const hand = handFacts(snap);
        const strong = hand && (hand.madeCategory >= 2 || ['탑페어', '오버페어'].includes(hand.madeDetail));
        if (hand && !strong && (hand.outs ?? 0) < 8) {
          out.weakStackOffs.push({ handNo, line: `${snap.decisionId}: ${factsLineKo(snap) ?? ''}` });
        }
      }
    }
    const start = record.startStacks?.[HOST];
    const end = record.endStacks?.[HOST];
    if (Number.isInteger(start) && Number.isInteger(end) && end < start) {
      const last = projected.at(-1)?.processStatus === 'available' ? projected.at(-1) : null;
      out.biggestLosses.push({ handNo, lost: start - end, line: last ? `${last.decisionId}: ${factsLineKo(last) ?? ''}` : null });
    }
  }
  out.biggestLosses.sort((a, b) => b.lost - a.lost || a.handNo - b.handNo);
  out.biggestLosses = out.biggestLosses.slice(0, 3);
  return out;
}

// Reference ranges for a full-ring/6-max cash game; tournaments run tighter late.
export function vpipBand(seated) {
  if (seated <= 2) return { vpip: [55, 85], pfr: [45, 80] };
  if (seated <= 6) return { vpip: [20, 30], pfr: [15, 24] };
  return { vpip: [15, 24], pfr: [11, 19] };
}

// Published per-hand coach notes (skipping unavailable placeholders), newest last. #290: a
// note the caller withholds (one the host must not see) is left out.
export function coachNotesDigest(snapshotPath, { limit = 10, chars = 220, withhold = () => false } = {}) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    return [];
  }
  const notes = Array.isArray(snapshot?.coach) ? snapshot.coach : [];
  return notes.filter((note) => note && note.unavailable !== true && Number.isSafeInteger(note.handNo) && typeof note.text === 'string')
    .filter((note) => !withhold(note))
    .slice(-limit)
    .map((note) => `핸드 ${note.handNo}: ${note.text.replace(/\s+/g, ' ').trim().slice(0, chars)}`);
}

// Markdown lines for the machine review's process section.
export function detectorLinesKo(found) {
  const lines = [];
  if (found.foldWhenCheck.length) {
    lines.push(`- 체크할 수 있는데 폴드한 결정 ${found.foldWhenCheck.length}회(핸드 ${[...new Set(found.foldWhenCheck)].join(', ')}). 무료로 다음 카드를 볼 기회였습니다.`);
  }
  if (found.minRaises.raises >= 3 && found.minRaises.count / found.minRaises.raises >= 0.5) {
    lines.push(`- 레이즈 ${found.minRaises.raises}회 중 ${found.minRaises.count}회가 최소 크기였습니다(핸드 ${[...new Set(found.minRaises.hands)].slice(0, 8).join(', ')}). 크기마다 목적을 먼저 정해 보세요.`);
  }
  const offSize = found.openSizesBb.filter((size) => size < 2 || size > 3.5);
  if (found.openSizesBb.length && offSize.length) {
    lines.push(`- 미오픈 팟 오픈 ${found.openSizesBb.length}회 중 ${offSize.length}회가 2~3.5BB 밖이었습니다(${offSize.slice(0, 6).join(', ')}BB).`);
  }
  for (const row of found.weakStackOffs.slice(0, 3)) {
    lines.push(`- 핸드 ${row.handNo}: 탑페어 미만·강한 드로 없이 남은 스택을 넣었습니다. ${row.line}`);
  }
  return lines;
}
