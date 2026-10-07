// Deterministic coaching material built from completed hand records: per-decision
// fact lines for the coach/review prompts, and process detectors plus coach-note
// digests for the machine review. Nothing here is a strategy verdict.
import fs from 'node:fs';
import { chipFacts, equityFacts, factsLineKo, handFacts } from '../shared/decision-facts.js';
import { estimateOpponentRanges } from '../training/ranges/estimate-v3.js';

const HOST = 'user';

function userDecisions(record) {
  return (record?.decisions ?? []).filter((snap) => snap?.actorId === HOST && snap.decisionId);
}

function opponentsAt(snap) {
  return (snap.publicSeats ?? []).filter((seat) => seat.playerId !== snap.actorId && !seat.folded && !seat.out);
}

export function decisionFacts(snap) {
  const chips = chipFacts(snap);
  if (!chips) return null;
  const equityRandom = equityFacts(snap);
  let equityRange = null;
  try {
    const estimated = estimateOpponentRanges(snap);
    const ranges = opponentsAt(snap).slice(0, 8).map((seat) => estimated[seat.playerId] ?? null);
    if (ranges.some(Boolean)) equityRange = equityFacts(snap, { ranges });
  } catch {
    equityRange = null;
  }
  return { chips, hand: handFacts(snap), equityRandom, equityRange,
    line: factsLineKo(snap, { equityRandom, equityRange }) };
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
  for (const record of records) {
    const handNo = record.handNo;
    for (const snap of userDecisions(record)) {
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
      const last = userDecisions(record).at(-1);
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

// Published per-hand coach notes (skipping unavailable placeholders), newest last.
export function coachNotesDigest(snapshotPath, { limit = 10, chars = 220 } = {}) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    return [];
  }
  const notes = Array.isArray(snapshot?.coach) ? snapshot.coach : [];
  return notes.filter((note) => note && note.unavailable !== true && Number.isSafeInteger(note.handNo) && typeof note.text === 'string')
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
