// Reads the store's finished hands into the play report (training/play-report.js).
// Read-only: it goes through the replay library's contained reader, which hands
// over only the host's own view of each hand. Game summaries are kept in memory
// per game and reused while the game's state file is the same one; a game that
// is still being played, or one with a hand that could not be read, is read again.
import { CANONICAL_REFERENCE_SOURCE } from '../shared/reference.js';
import { buildPlayReport, playReportView, summarizeGame } from '../training/play-report.js';
import { loadReferenceDataset } from './preflop-dataset.js';
import { createReplayLibrary } from './replay-library.js';
import { decisionFacts } from './review-facts.js';

const MAX_GAMES = 1000;

let pinnedDataset;
/** The v3 reference used as the report's yardstick; null when it cannot be loaded. */
export function reportDataset() {
  if (pinnedDataset === undefined) {
    try { pinnedDataset = loadReferenceDataset(CANONICAL_REFERENCE_SOURCE); } catch { pinnedDataset = null; }
  }
  return pinnedDataset;
}

export function createPlayReportReader(storeDir, options = {}) {
  // Its own library instance: a long first scan must not answer the replay
  // browser's requests with "busy".
  const library = options.library ?? createReplayLibrary(storeDir, options.libraryOptions);
  const dataset = options.dataset === undefined ? reportDataset() : options.dataset;
  const factsOf = options.factsOf ?? decisionFacts;
  const clock = options.now ?? (() => new Date().toISOString());
  const cache = new Map();
  let inflight = null;

  async function scan() {
    const entries = (await library.listReportGames()).slice(0, MAX_GAMES);
    const budget = { used: 0, limit: library.reportReadBytes };
    const summaries = [];
    const unreadable = { games: 0, hands: 0 };
    const seen = new Set();
    let truncated = false;
    for (const entry of entries) {
      seen.add(entry.gameId);
      if (entry.code) { unreadable.games += 1; continue; }
      const cached = cache.get(entry.gameId);
      try {
        const game = await library.readReportGame(entry.gameId, { budget, known: cached?.identity ?? null });
        if (game.reused) { summaries.push(cached.summary); continue; }
        const summary = summarizeGame(game.meta, game.hands, { dataset, factsOf });
        unreadable.hands += game.unreadable;
        // Only a finished game read in full is kept: anything else is read again.
        if (game.final && game.unreadable === 0) cache.set(entry.gameId, { identity: game.identity, summary });
        else cache.delete(entry.gameId);
        summaries.push(summary);
      } catch (error) {
        cache.delete(entry.gameId);
        // A fatal limit (the read budget) ends the scan: what was read so far is a partial report.
        if (error?.fatal) { truncated = true; break; }
        unreadable.games += 1;
      }
    }
    for (const gameId of [...cache.keys()]) if (!seen.has(gameId)) cache.delete(gameId);
    const report = buildPlayReport(summaries, { now: clock(), unreadable, truncated });
    return { report, view: playReportView(report), summaries };
  }

  /** { report, view, summaries }; concurrent callers share one scan. */
  function read() {
    inflight ??= scan().finally(() => { inflight = null; });
    return inflight;
  }

  return { read, cachedGames: () => cache.size };
}

const readers = new Map();
/** One reader per store for this process (the study service, the game loop). */
export function playReportReader(storeDir) {
  let reader = readers.get(storeDir);
  if (!reader) { reader = createPlayReportReader(storeDir); readers.set(storeDir, reader); }
  return reader;
}
