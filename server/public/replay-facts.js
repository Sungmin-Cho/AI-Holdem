// Fact card for the viewer's own decisions in a replay (learning calibration
// D13): the same deterministic facts the coach and the review read — price,
// stack depth, made hand, draws, equity against random hands — rebuilt from
// the step before the action. Shown after the hand, so equity is fair game.
import { equityFacts, factsLineKo } from '../../shared/decision-facts.js';

/** The engine-shaped decision snapshot for the viewer's action at `index`, or null. */
export function replayDecisionSnapshot(model, replay, viewer, index) {
  const step = model?.steps?.[index];
  const prev = model?.steps?.[index - 1];
  if (!step || !prev || step.kind !== 'action' || step.actor !== viewer) return null;
  const holes = replay?.holes?.[viewer];
  if (!Array.isArray(holes) || holes.length !== 2) return null;
  const start = replay.startStacks ?? {};
  const players = Object.keys(prev.stacks ?? {});
  if (!players.includes(viewer)) return null;
  const blinds = Array.isArray(replay.blinds) ? replay.blinds
    : [0, Math.max(0, ...(replay.posts ?? []).map((post) => post.amount))];
  const currentBet = Math.max(0, ...players.map((playerId) => prev.bets[playerId] ?? 0));
  const actorBet = prev.bets[viewer] ?? 0;
  const wager = step.verb === 'raise' || step.verb === 'bet';
  return {
    decisionId: `replay-${replay.handNo ?? 0}-${index}`,
    actorId: viewer,
    blinds,
    holeCards: holes,
    board: prev.board,
    potBefore: prev.total,
    currentBet,
    actorBet,
    toCall: Math.min(Math.max(0, currentBet - actorBet), prev.stacks[viewer]),
    maxRaiseTo: actorBet + prev.stacks[viewer],
    publicSeats: players.map((playerId) => ({
      playerId,
      stack: prev.stacks[playerId],
      contribution: (start[playerId] ?? 0) - prev.stacks[playerId],
      folded: prev.folded.includes(playerId),
      allIn: prev.allIn.includes(playerId),
      out: false,
    })),
    chosenAction: wager ? { action: step.verb, amount: step.amount } : { action: step.verb },
  };
}

/** One Korean line for the viewer's action at `index`, or null. */
export function replayFactsLine(model, replay, viewer, index, { samples = 800 } = {}) {
  const snapshot = replayDecisionSnapshot(model, replay, viewer, index);
  if (!snapshot) return null;
  let equityRandom = null;
  try { equityRandom = equityFacts(snapshot, { samples }); } catch { /* impossible deal: facts without equity */ }
  try { return factsLineKo(snapshot, { equityRandom }); } catch { return null; }
}
