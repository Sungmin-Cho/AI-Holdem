// Reads the store's finished hands into the play report (training/play-report.js).
// Read-only: it goes through the replay library's contained reader, which hands
// over only the host's own view of each hand. Game summaries are kept in memory
// per game and reused while the game's state file is the same one; a game that
// is still being played, or one with a hand that could not be read, is read again.
import { CANONICAL_REFERENCE_SOURCE } from '../shared/reference.js';
import { addGameSummary, buildPlayReport, emptyGameSummary, playReportView, summarizeGame } from '../training/play-report.js';
import { loadReferenceDataset } from './preflop-dataset.js';
import { createReplayLibrary } from './replay-library.js';
import { decisionFacts } from './review-facts.js';

const MAX_GAMES = 1000;
/** The code of a scan its callers gave up on (the library's own abort code). */
export const PLAY_REPORT_ABORTED = 'REPLAY_ABORTED';

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
  const yieldTurn = options.yieldTurn ?? (() => new Promise((resolve) => { setImmediate(resolve); }));
  const cache = new Map();
  let inflight = null;

  // One hand at a time, giving the event loop back in between: a hand can cost an
  // all-in simulation and a closed-decision equity, and this runs in processes
  // that are also playing a game. An aborted signal ends the scan at the next hand.
  const abortedError = () => Object.assign(new Error(PLAY_REPORT_ABORTED), { code: PLAY_REPORT_ABORTED, fatal: true });
  const stopIfAborted = (signal) => { if (signal.aborted) throw abortedError(); };
  async function reduce(meta, hands, signal) {
    const summary = emptyGameSummary(meta);
    for (const hand of hands) {
      stopIfAborted(signal);
      addGameSummary(summary, summarizeGame(meta, [hand], { dataset, factsOf }));
      await yieldTurn();
    }
    stopIfAborted(signal);
    return summary;
  }

  async function scan(signal) {
    const budget = { used: 0, limit: library.reportReadBytes };
    const summaries = [];
    const unreadable = { games: 0, hands: 0 };
    const seen = new Set();
    let truncated = false;
    let entries = [];
    try {
      entries = (await library.listReportGames()).slice(0, MAX_GAMES);
    } catch (error) {
      // More sessions than the library lists: say the report is partial rather than fail.
      if (!error?.fatal) throw error;
      truncated = true;
    }
    for (const entry of entries) {
      stopIfAborted(signal);
      seen.add(entry.gameId);
      if (entry.code) { unreadable.games += 1; continue; }
      const cached = cache.get(entry.gameId);
      try {
        const game = await library.readReportGame(entry.gameId, { budget, known: cached?.identity ?? null, signal });
        if (game.reused) { summaries.push(cached.summary); continue; }
        const summary = await reduce(game.meta, game.hands, signal);
        unreadable.hands += game.unreadable;
        // Only a finished game read in full is kept: anything else is read again.
        if (game.final && game.unreadable === 0) cache.set(entry.gameId, { identity: game.identity, summary });
        else cache.delete(entry.gameId);
        summaries.push(summary);
      } catch (error) {
        if (error?.code === PLAY_REPORT_ABORTED) throw error;
        // A fatal limit (the read budget) ends the scan: what was read so far is a partial
        // report, and what is already known about this game stays.
        if (error?.fatal) { truncated = true; break; }
        cache.delete(entry.gameId);
        unreadable.games += 1;
      }
    }
    stopIfAborted(signal);
    // A game that is gone from the store leaves the cache; after a cut scan the games it did
    // not reach are simply unknown and stay.
    if (!truncated) for (const gameId of [...cache.keys()]) if (!seen.has(gameId)) cache.delete(gameId);
    const report = buildPlayReport(summaries, { now: clock(), unreadable, truncated });
    return { report, view: playReportView(report), summaries };
  }

  /**
   * { report, view, summaries }. Concurrent callers share one scan, and each waits
   * on its own terms: a caller whose `signal` aborts is rejected at once
   * (PLAY_REPORT_ABORTED) whatever the others do. The scan itself is stopped only
   * when every caller that was waiting has given up — a caller without a signal
   * never gives up — and it then ends at the next hand. Finished games already
   * reduced stay cached, so a later read resumes from there.
   */
  function read({ signal = null } = {}) {
    if (!inflight) {
      const run = { controller: new AbortController(), waiting: 0, promise: null };
      run.promise = scan(run.controller.signal).finally(() => { if (inflight === run) inflight = null; });
      // A scan every caller left is rejected with nobody listening.
      run.promise.catch(() => {});
      inflight = run;
    }
    const run = inflight;
    run.waiting += 1;
    if (!signal) return run.promise;
    return new Promise((resolve, reject) => {
      const leave = () => {
        run.waiting -= 1;
        if (run.waiting > 0) return;
        // Nobody is waiting: stop the scan and let the next read start a new one.
        run.controller.abort();
        if (inflight === run) inflight = null;
      };
      const onAbort = () => { leave(); reject(abortedError()); };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      run.promise.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
    });
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
