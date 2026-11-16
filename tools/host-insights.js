// Host-only learning aids for the app server (learning calibration D13). Each
// reads committed session files and projects a closed set of public fields:
// - hud: the engine's cumulative public-observation counts, the same numbers
//   the AI players receive, so the host plays with no less information;
// - report: deterministic process checks over the host's completed hands;
// - reveal: each AI's configured style, only once the final review is out.
// Participant and spectator routes never call these.
import { aggressionFactor, preflopRates } from '../engine/views.js';
import { isHumanSeat, seatLabel } from '../shared/seat-roles.js';
import { replayRecord } from '../shared/hand-replay.js';
import { gameCheckLinesKo, mergeGameSummaries, summarizeGame } from '../training/play-report.js';
import { toProcessReview } from '../training/process-review.js';
import { decisionFacts, detectorLinesKo, processDetectors } from './review-facts.js';
import { openContained } from './training-store.js';

const STATE_MAX = 2 * 1024 * 1024;
const HAND_MAX = 2 * 1024 * 1024;
const MAX_HANDS = 1000;
export const REVEAL_PHASES = Object.freeze(new Set(['review_published', 'done']));

const finite = (value) => (Number.isFinite(value) ? value : 0);
const nameOf = (seat) => (isHumanSeat(seat) ? seatLabel(seat) : seat.name ?? seat.playerId);

export function hudFromState(state) {
  const seats = Array.isArray(state?.seats) ? state.seats : [];
  return {
    schemaVersion: 1,
    handNo: Number.isSafeInteger(state?.handNo) ? state.handNo : 0,
    players: seats.map((seat) => {
      const raw = state.stats?.[seat.playerId] ?? {};
      const rates = preflopRates(raw);
      return {
        playerId: seat.playerId,
        name: nameOf(seat),
        sample: Number.isSafeInteger(raw.hands) ? raw.hands : 0,
        vpip: finite(rates.vpip),
        pfr: finite(rates.pfr),
        af: finite(aggressionFactor(raw)),
      };
    }),
  };
}

// One game's play-report checks (short-stack entries, open limps, closed-decision
// price comparisons), kept per completed hand: a finished hand never changes, so a
// new hand costs one hand's work however long the game is. The reducer sees only
// the host's own view of each hand (the replay projection and the host's snapshots).
const handChecks = { key: null, byHand: new Map() };

export function gameChecksOf(records, { seats = [], reveal = 'showdown', key = '' } = {}) {
  if (handChecks.key !== key) { handChecks.key = key; handChecks.byHand = new Map(); }
  const humanIds = seats.filter((seat) => isHumanSeat(seat)).map((seat) => seat.playerId);
  if (!humanIds.includes('user')) humanIds.push('user');
  const summaries = [];
  for (const record of records) {
    const handNo = record?.handNo;
    if (!Number.isSafeInteger(handNo)) continue;
    let summary = handChecks.byHand.get(handNo);
    if (!summary) {
      try {
        summary = summarizeGame({}, [{ replay: replayRecord(record, { reveal, humanIds }), decisions: toProcessReview(record).decisions }],
          { dataset: null, factsOf: decisionFacts, checksOnly: true });
      } catch {
        continue;
      }
      handChecks.byHand.set(handNo, summary);
    }
    summaries.push(summary);
  }
  return mergeGameSummaries(summaries);
}

export function reportFromRecords(records, context) {
  const found = processDetectors(records);
  let extra = [];
  if (context) {
    try { extra = gameCheckLinesKo(gameChecksOf(records, context)); } catch { extra = []; }
  }
  return {
    schemaVersion: 1,
    hands: records.length,
    decisions: found.decisions,
    checks: [...detectorLinesKo(found), ...extra],
    biggestLosses: found.biggestLosses.map(({ handNo, lost }) => ({ handNo, lost })),
  };
}

export function revealFromPlayers(players) {
  return {
    schemaVersion: 1,
    players: (Array.isArray(players) ? players : [])
      .filter((player) => player && !isHumanSeat(player))
      .map((player) => ({
        playerId: player.playerId,
        name: player.name ?? player.playerId,
        archetype: typeof player.archetype === 'string' ? player.archetype : null,
      })),
  };
}

const readJson = (sessionDir, segments, maxBytes) => JSON.parse(openContained(sessionDir, segments, { maxBytes }).toString('utf8'));

export function readHud(sessionDir) {
  return hudFromState(readJson(sessionDir, ['state.json'], STATE_MAX));
}

// Completed hands only: the archive files, plus the last hand while its archive
// is still pending. A missing or unreadable hand is skipped and counted.
export function readReport(sessionDir) {
  const state = readJson(sessionDir, ['state.json'], STATE_MAX);
  const completed = state.lastHand?.handNo ?? Math.max(0, (state.handNo ?? 0) - 1);
  const records = [];
  let unreadable = 0;
  for (let handNo = 1; handNo <= Math.min(completed, MAX_HANDS); handNo += 1) {
    const name = `hand-${String(handNo).padStart(4, '0')}.json`;
    try {
      records.push(readJson(sessionDir, ['hands', name], HAND_MAX));
    } catch {
      if (state.lastHand?.handNo === handNo) records.push(state.lastHand);
      else unreadable += 1;
    }
  }
  return { ...reportFromRecords(records, {
    seats: Array.isArray(state?.seats) ? state.seats : [],
    reveal: state?.config?.replayReveal === 'all' ? 'all' : 'showdown',
    key: `${sessionDir}\u0000${typeof state?.sessionToken === 'string' ? state.sessionToken : ''}`,
  }), unreadable };
}

export function readReveal(sessionDir, phase) {
  if (!REVEAL_PHASES.has(phase)) {
    const error = new Error('the final review is not published yet');
    error.code = 'REVEAL_NOT_READY';
    throw error;
  }
  return revealFromPlayers(readJson(sessionDir, ['players.json'], STATE_MAX));
}
