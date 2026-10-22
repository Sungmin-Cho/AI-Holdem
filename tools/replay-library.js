import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalHandReplayJson, HAND_REPLAY_SCHEMA_VERSION, replayRecord } from '../shared/hand-replay.js';
import { openContained } from './training-store.js';
import { lstatExact } from '../shared/exact-stat.js';

// Bounded, read-only view of the finished hands in .session-store/sessions/<gameId>
// (design §5/§6). It never prepares, commits, resumes or rebuilds a session, never
// follows loop-state or processes, and answers only with closed DTOs built field by
// field: nothing from state.json or a hand record is spread into a response.

const CATALOG = '.session-store';
const SESSIONS = 'sessions';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEAT_ID_RE = /^(user|h[1-8]|p[1-8])$/;
const CARD_RE = /^[2-9TJQKA][shdc]$/;

const MAX_ENTRIES = 10_000;
const MAX_SESSIONS = 1000;
const MAX_HAND_NO = 10_000;
const STATE_BYTES = 2 * 1024 * 1024;
const HAND_BYTES = 256 * 1024;
const RESPONSE_BYTES = 1024 * 1024;
const GAMES_READ_BYTES = 16 * 1024 * 1024;
const HANDS_READ_BYTES = 32 * 1024 * 1024;
const TEXT_BYTES = 4096;
const YIELD_EVERY = 25;
const MAX_CONCURRENT = 2;
const GAME_PAGE = { fallback: 25, max: 50, maxOffset: MAX_SESSIONS };
const HAND_PAGE = { fallback: 50, max: 100, maxOffset: MAX_HAND_NO };

const STREETS = new Set(['preflop', 'flop', 'turn', 'river']);
const ACTIONS = new Set(['fold', 'check', 'call', 'raise']);
const REASON_KINDS = new Set(['forced', 'policy', 'model', 'none', 'human', 'hidden']);
const ACTION_CHIPS = ['potTotal', 'callAmount', 'minRaiseTo', 'maxRaiseTo', 'currentBet'];
const BOARD_SIZES = [0, 3, 4, 5];

// Only these codes ever leave the module; the message is the code, never a path or
// a raw exception. A `fatal` error ends the whole request instead of one list row.
function fail(code, fatal = false) {
  const error = new Error(code);
  error.code = code;
  if (fatal) error.fatal = true;
  return error;
}
const badRequest = () => fail('REPLAY_BAD_REQUEST');
const notFound = () => fail('REPLAY_NOT_FOUND');
const unavailable = () => fail('REPLAY_UNAVAILABLE');
const unsupported = () => fail('REPLAY_UNSUPPORTED');
const busy = () => fail('REPLAY_BUSY');
const overLimit = (fatal = false) => fail('REPLAY_LIMIT_EXCEEDED', fatal);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isChips = (value) => Number.isSafeInteger(value) && value >= 0;
const isText = (value) => typeof value === 'string' && Buffer.byteLength(value) <= TEXT_BYTES;
const isId = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 128;
const handFileName = (handNo) => `hand-${String(handNo).padStart(4, '0')}.json`;

function normalizeError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('REPLAY_') ? error : unavailable();
}

// lstat is injectable for tests only; everything else goes through these two helpers.
function inspectors(lstat) {
  function lstatOrNull(file) {
    try { return lstat(file); } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw unavailable();
    }
  }

  // Every component must be a real directory. Returned identities let the caller prove
  // afterwards that none of them was swapped while the leaf was being read.
  function inspectChain(root, names) {
    const ids = [];
    let current = root;
    for (let index = -1; index < names.length; index += 1) {
      if (index >= 0) current = path.join(current, names[index]);
      const stat = lstatOrNull(current);
      if (!stat) return { missing: true };
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unavailable();
      ids.push(`${stat.dev}:${stat.ino}`);
    }
    return { ids };
  }
  return { lstatOrNull, inspectChain };
}

const sameChain = (a, b) => a.ids.length === b.ids.length && a.ids.every((id, at) => id === b.ids[at]);
const isSafeFile = (stat) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
// While an atomic replace is in flight lstat can still name the old inode after its last
// link was dropped (nlink 0). That is the replace itself, not a hard link or a special file.
const isUnlinked = (stat) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 0;
const sameLeaf = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => a[key] === b[key]);

// A second atomic replacement can unlink the next regular inode before our
// recheck too. Both observations mean retry; neither is permission to read or
// return those bytes. Missing paths, special files and multiple links still fail.
const replacedLeaf = (current) => (current && (isSafeFile(current) || isUnlinked(current)) ? busy() : unavailable());

function takeBudget(budget, bytes) {
  if (!budget) return;
  if (budget.used + bytes > budget.limit) throw overLimit(true);
  budget.used += bytes;
}

function savedAtOf(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw unavailable(); }
}

function cardList(value, sizes = null) {
  if (!Array.isArray(value) || (sizes && !sizes.includes(value.length))) throw unavailable();
  if (!value.every((card) => typeof card === 'string' && CARD_RE.test(card))) throw unavailable();
  return [...value];
}

function pidList(value, allowed) {
  if (!Array.isArray(value)) throw unavailable();
  const seen = new Set();
  for (const pid of value) {
    if (typeof pid !== 'string' || !allowed.has(pid) || seen.has(pid)) throw unavailable();
    seen.add(pid);
  }
  return [...value];
}

function chipsByPid(value, allowed) {
  if (!isObject(value)) throw unavailable();
  const out = {};
  for (const [pid, chips] of Object.entries(value)) {
    if (!allowed.has(pid) || !isChips(chips)) throw unavailable();
    out[pid] = chips;
  }
  return out;
}

// Seat identities come from the saved state, never from the live room. The host is
// `user`, participants are h1…h8 and must say they are human, AI seats are p1…p8.
// Only the older solo layout (no participants) may leave `kind` out.
function parseSeats(rows) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 9) throw unavailable();
  const hasParticipant = rows.some((row) => typeof row?.playerId === 'string' && /^h[1-8]$/.test(row.playerId));
  const seen = new Set();
  const seats = rows.map((row) => {
    const id = isObject(row) ? row.playerId : null;
    if (typeof id !== 'string' || !SEAT_ID_RE.test(id) || seen.has(id)) throw unavailable();
    seen.add(id);
    const wanted = id[0] === 'p' ? 'ai' : 'human';
    if (row.kind !== wanted && !(row.kind === undefined && !hasParticipant)) throw unavailable();
    if (typeof row.name !== 'string' || row.name.length < 1 || row.name.length > 128) throw unavailable();
    return { playerId: id, name: row.name, kind: wanted };
  });
  if (!seen.has('user')) throw unavailable();
  return seats;
}

// Read-only validation of state.json: what the library needs to list a game and to
// bound its completed hands. Nothing here upgrades or rewrites the file.
function parseState(raw) {
  if (!isObject(raw)) throw unavailable();
  if (raw.schemaVersion === undefined || raw.schemaVersion === null) throw unavailable();
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) throw unsupported();
  const config = raw.config;
  if (!isObject(config)) throw unavailable();
  const mode = config.mode === undefined ? 'tournament' : config.mode;
  if (mode !== 'tournament' && mode !== 'cash-training') throw unsupported();
  const reveal = config.replayReveal === undefined ? 'showdown' : config.replayReveal;
  if (reveal !== 'all' && reveal !== 'showdown') throw unsupported();
  const seats = parseSeats(raw.seats);
  if (!Number.isSafeInteger(raw.handNo) || raw.handNo < 0 || typeof raw.gameOver !== 'boolean') throw unavailable();
  const result = raw.result ?? null;
  let status;
  if (raw.gameOver === false && result === null) status = 'unfinished';
  else if (raw.gameOver === true && (result === 'win' || result === 'lose' || result === 'completed')) status = 'completed';
  else if (raw.gameOver === true && result === 'abort') status = 'aborted';
  else throw unavailable();

  const lastHand = raw.lastHand ?? null;
  let completed;
  if (lastHand === null) {
    // No finished hand: nothing yet, or the first hand is the one in progress or
    // aborted. Any other combination has no evidence for a completed hand.
    if (raw.handNo === 0 || (raw.handNo === 1 && (status === 'unfinished' || status === 'aborted'))) completed = 0;
    else throw unavailable();
  } else {
    if (!isObject(lastHand) || !Number.isSafeInteger(lastHand.handNo) || lastHand.handNo < 1) throw unavailable();
    if (raw.handNo !== lastHand.handNo && raw.handNo !== lastHand.handNo + 1) throw unavailable();
    completed = lastHand.handNo;
  }
  return {
    mode, reveal, status, seats, completed, lastHand, handNo: raw.handNo,
  };
}

function gameRow(gameId, savedAtMs, info) {
  const over = info.completed > MAX_HAND_NO;
  return {
    gameId,
    savedAt: savedAtOf(savedAtMs),
    mode: info.mode,
    status: over ? 'unavailable' : info.status,
    seatCount: info.seats.length,
    completedHandCount: over ? null : info.completed,
    unavailableCode: over ? 'REPLAY_LIMIT_EXCEEDED' : null,
  };
}

function unavailableRow(gameId, savedAtMs, code) {
  return {
    gameId,
    savedAt: savedAtOf(savedAtMs),
    mode: null,
    status: 'unavailable',
    seatCount: null,
    completedHandCount: null,
    unavailableCode: code,
  };
}

// The closed v1 replay DTO (design §5.4). `record` is the raw archive row. The
// reveal policy is applied by the shared projector; whatever it returns is then
// re-validated and rebuilt key by key, so an extra key at any depth is dropped.
function projectReplay(record, ctx) {
  if (!isObject(record) || record.handNo !== ctx.handNo) throw unavailable();
  for (const [key, known] of [['rulesVersion', 2], ['hintContractVersion', 1], ['dealSelectionContractVersion', 1]]) {
    if (record[key] !== undefined && record[key] !== known) throw unsupported();
  }
  for (const key of ['actions', 'posts', 'pots', 'folded', 'allIn']) if (!Array.isArray(record[key])) throw unavailable();
  if (record.decisions !== undefined && (!Array.isArray(record.decisions) || !record.decisions.every(isObject))) throw unavailable();
  if (record.positions !== undefined && !isObject(record.positions)) throw unavailable();
  if (!isObject(record.holes)) throw unavailable();
  // Validate the raw structure before replayRecord's legacy defaults can erase
  // an invalid explicit value. Only documented optional omissions are accepted.
  if (record.showdown !== null && (!isObject(record.showdown)
    || !Array.isArray(record.showdown.reveals) || !Array.isArray(record.showdown.mucks))) throw unavailable();
  if (record.uncalledReturns !== undefined && !isObject(record.uncalledReturns)) throw unavailable();
  for (const pot of record.pots) {
    if (!isObject(pot) || !Array.isArray(pot.eligible) || !Array.isArray(pot.winners)) throw unavailable();
  }

  const dealt = chipsByPid(record.startStacks, ctx.seatSet);
  const dealtSet = new Set(Object.keys(dealt));
  if (dealtSet.size < 2) throw unavailable();
  if ([...dealtSet].some(pid => !Object.hasOwn(record.holes, pid))) throw unavailable();
  const board = cardList(record.board, BOARD_SIZES);
  const rawCards = [...board];
  for (const [pid, cards] of Object.entries(record.holes)) {
    if (!dealtSet.has(pid)) throw unavailable();
    rawCards.push(...cardList(cards, [2]));
  }
  if (new Set(rawCards).size !== rawCards.length) throw unavailable();

  let source;
  try {
    source = replayRecord(record, { reveal: ctx.reveal, humanIds: ctx.humanIds });
  } catch (error) {
    throw error?.code === 'DEAL_SELECTION_INVALID' ? unsupported() : unavailable();
  }

  const replay = {
    schemaVersion: HAND_REPLAY_SCHEMA_VERSION,
    reveal: source.reveal,
    handNo: ctx.handNo,
  };
  if (source.level !== undefined) {
    if (!Number.isSafeInteger(source.level) || source.level < 0) throw unavailable();
    replay.level = source.level;
  }
  if (typeof source.button !== 'string' || !ctx.seatSet.has(source.button)) throw unavailable();
  if (!Array.isArray(source.blinds) || source.blinds.length !== 2
    || !source.blinds.every((chips) => isChips(chips) && chips > 0)) throw unavailable();
  replay.button = source.button;
  replay.blinds = [...source.blinds];
  replay.board = board;
  replay.folded = pidList(source.folded, dealtSet);
  replay.allIn = pidList(source.allIn, dealtSet);
  replay.startStacks = dealt;
  const ends = chipsByPid(source.endStacks, ctx.seatSet);
  if (![...dealtSet].every((pid) => Object.hasOwn(ends, pid))) throw unavailable();
  replay.endStacks = ends;
  replay.posts = source.posts.map((post) => {
    if (!isObject(post) || !dealtSet.has(post.playerId) || !isChips(post.amount) || typeof post.allIn !== 'boolean') throw unavailable();
    return { playerId: post.playerId, amount: post.amount, allIn: post.allIn };
  });
  replay.uncalledReturns = chipsByPid(source.uncalledReturns, dealtSet);
  const holes = {};
  for (const [pid, cards] of Object.entries(source.holes)) {
    if (!dealtSet.has(pid)) throw unavailable();
    holes[pid] = cardList(cards, [2]);
  }
  replay.holes = holes;
  if (source.positions !== undefined) {
    if (!isObject(source.positions)) throw unavailable();
    const positions = {};
    for (const [pid, label] of Object.entries(source.positions)) {
      if (!ctx.seatSet.has(pid) || typeof label !== 'string' || label.length < 1 || label.length > 16) throw unavailable();
      positions[pid] = label;
    }
    replay.positions = positions;
  }
  if (record.rulesVersion === 2) replay.rulesVersion = 2;

  if (source.showdown === null) replay.showdown = null;
  else {
    if (!isObject(source.showdown) || !Array.isArray(source.showdown.reveals)) throw unavailable();
    const reveals = source.showdown.reveals.map((reveal) => {
      if (!isObject(reveal) || !dealtSet.has(reveal.playerId)) throw unavailable();
      const cards = cardList(reveal.cards, [2]);
      const saved = record.holes[reveal.playerId];
      if (!saved || new Set(cards).size !== 2 || !cards.every((card) => saved.includes(card))) throw unavailable();
      const row = { playerId: reveal.playerId, cards };
      if (typeof reveal.handName === 'string' && reveal.handName.length >= 1 && reveal.handName.length <= 128) row.handName = reveal.handName;
      return row;
    });
    replay.showdown = { reveals, mucks: pidList(source.showdown.mucks, dealtSet) };
  }

  replay.pots = source.pots.map((pot) => {
    if (!isObject(pot) || !Number.isSafeInteger(pot.potIndex) || pot.potIndex < 0 || !isChips(pot.amount) || !Array.isArray(pot.winners)) throw unavailable();
    return {
      potIndex: pot.potIndex,
      amount: pot.amount,
      eligible: pidList(pot.eligible, dealtSet),
      winners: pot.winners.map((winner) => {
        if (!isObject(winner) || !dealtSet.has(winner.playerId) || !isChips(winner.share)) throw unavailable();
        return { playerId: winner.playerId, share: winner.share };
      }),
    };
  });

  replay.actions = source.actions.map((action) => {
    if (!isObject(action) || !dealtSet.has(action.playerId) || !ACTIONS.has(action.action)) throw unavailable();
    const row = { playerId: action.playerId, action: action.action };
    if (isId(action.decisionId)) row.decisionId = action.decisionId;
    if (action.street !== undefined) {
      if (!STREETS.has(action.street)) throw unavailable();
      row.street = action.street;
    }
    if (action.amount !== undefined || action.action === 'call' || action.action === 'raise') {
      if (!isChips(action.amount)) throw unavailable();
      row.amount = action.amount;
    }
    for (const key of ACTION_CHIPS) {
      if (action[key] === undefined) continue;
      if (!isChips(action[key])) throw unavailable();
      row[key] = action[key];
    }
    if (action.board !== undefined) row.board = cardList(action.board, BOARD_SIZES);
    if (action.forced === true) row.forced = true;
    if (action.reasonKind !== undefined) {
      if (!REASON_KINDS.has(action.reasonKind)) throw unavailable();
      row.reasonKind = action.reasonKind;
    }
    if (isText(action.reason)) row.reason = action.reason;
    if (isText(action.note)) row.note = action.note;
    return row;
  });

  replay.decisions = source.decisions.map((decision) => {
    if (!isObject(decision)) throw unavailable();
    const row = {};
    if (isId(decision.decisionId)) row.decisionId = decision.decisionId;
    if (isChips(decision.potBefore)) row.potBefore = decision.potBefore;
    if (isChips(decision.toCall)) row.toCall = decision.toCall;
    return row;
  });
  return replay;
}

function revisionOf(gameId, game, seats, replay) {
  return createHash('sha256').update(canonicalHandReplayJson({
    gameId,
    handNo: replay.handNo,
    viewerId: 'user',
    mode: game.mode,
    reveal: replay.reveal,
    seats,
    replay,
  })).digest('hex');
}

function pageOptions(raw, spec) {
  const options = raw === undefined ? {} : raw;
  if (!isObject(options) || Object.keys(options).some((key) => key !== 'offset' && key !== 'limit')) throw badRequest();
  const offset = options.offset === undefined ? 0 : options.offset;
  const limit = options.limit === undefined ? spec.fallback : options.limit;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > spec.maxOffset) throw badRequest();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > spec.max) throw badRequest();
  return { offset, limit };
}

export function createReplayLibrary(storeDir, options = {}) {
  const configured = path.resolve(String(storeDir));
  const yieldTurn = options.yieldTurn ?? (() => new Promise((resolve) => { setImmediate(resolve); }));
  const openFile = options.openFile ?? openContained;
  // Test hook: limits can only be tightened, never raised above the contract.
  const tighten = (name, value) => Math.min(value, Number.isSafeInteger(options.limits?.[name]) && options.limits[name] > 0 ? options.limits[name] : value);
  const limits = {
    gamesRead: tighten('gamesReadBytes', GAMES_READ_BYTES),
    handsRead: tighten('handsReadBytes', HANDS_READ_BYTES),
    response: tighten('responseBytes', RESPONSE_BYTES),
  };
  // Exact identities by default (#308): a Number-valued ino past 2^53 (Windows) can match a replacement.
  const { lstatOrNull, inspectChain } = inspectors(options.lstat ?? lstatExact);
  const inflight = new Map();
  let active = 0;

  function rootDir() {
    try { return fs.realpathSync(configured); } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw unavailable();
    }
  }

  function replacementError(root, dirNames, chain, leaf) {
    const current = lstatOrNull(leaf);
    const after = inspectChain(root, dirNames);
    if (after.missing || !sameChain(chain, after)) return unavailable();
    return replacedLeaf(current);
  }

  // Inspect-open-reinspect around openContained. A leaf that was atomically
  // replaced while its ancestors stayed put is a busy retry (the engine's own
  // saveState does exactly that); anything unsafe stays an unavailable refusal and
  // refused bytes are never returned. Absent files answer null.
  function readLeaf(root, dirNames, fileName, { maxBytes, budget }) {
    const chain = inspectChain(root, dirNames);
    if (chain.missing) return null;
    const leaf = path.join(root, ...dirNames, fileName);
    const before = lstatOrNull(leaf);
    if (!before) return null;
    if (isUnlinked(before)) throw replacementError(root, dirNames, chain, leaf);
    if (!isSafeFile(before)) throw unavailable();
    if (before.size > maxBytes) throw overLimit();
    const remaining = budget ? budget.limit - budget.used : maxBytes;
    if (before.size > remaining) throw overLimit(true);
    const readCap = Math.min(maxBytes, remaining);
    let bytes;
    let failure;
    try { bytes = openFile(root, [...dirNames, fileName], { maxBytes: readCap }); } catch (error) { failure = error; }
    // Charge returned bytes even if identity checks will discard them. These
    // errors are raised before reading; unknown I/O failures may have consumed
    // part of the ceiling and are conservatively charged in full.
    const preReadFailure = failure && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'UNSAFE_PATH', 'TOO_LARGE', 'BAD_SEGMENT'].includes(failure.code);
    takeBudget(budget, bytes?.length ?? (preReadFailure ? 0 : readCap));
    if (failure?.code === 'TOO_LARGE' && readCap < maxBytes) throw overLimit(true);
    const after = inspectChain(root, dirNames);
    if (after.missing || !sameChain(chain, after)) throw unavailable();
    const now = lstatOrNull(leaf);
    if (now && isUnlinked(now)) throw replacementError(root, dirNames, chain, leaf);
    if (failure) {
      if (failure.code === 'ENOENT') {
        if (!now) return null;
        throw isSafeFile(now) ? busy() : unavailable();
      }
      // The contained opener can observe an intermediate replacement even when
      // our outer stats match (inode/metadata reuse). It returned no bytes; retry
      // only after the current leaf and its original ancestors passed inspection.
      if (failure.code === 'UNSAFE_PATH' && now && isSafeFile(now)) throw now.size > maxBytes ? overLimit() : busy();
      if (now && isSafeFile(now) && !sameLeaf(before, now)) throw now.size > maxBytes ? overLimit() : busy();
      throw failure.code === 'TOO_LARGE' ? overLimit() : unavailable();
    }
    if (!now || !isSafeFile(now)) throw unavailable();
    if (!sameLeaf(before, now)) throw busy();
    return { bytes, stat: before };
  }

  function gate(key, work) {
    const clone = (value) => structuredClone(value);
    const shared = inflight.get(key);
    if (shared) return shared.then(clone);
    if (active >= MAX_CONCURRENT) return Promise.reject(busy());
    active += 1;
    const run = (async () => {
      try { return await work(); } catch (error) { throw normalizeError(error); } finally {
        active -= 1;
        inflight.delete(key);
      }
    })();
    inflight.set(key, run);
    return run.then(clone);
  }

  function legacyPresent(root) {
    if (!root) return false;
    try {
      const state = fs.lstatSync(path.join(root, 'state.json'));
      if (state.isFile()) return true;
    } catch { /* absent */ }
    try {
      return fs.lstatSync(path.join(root, 'archive')).isDirectory();
    } catch { return false; }
  }

  async function enumerateSessions(root) {
    const sessionsPath = path.join(root, CATALOG, SESSIONS);
    const chain = inspectChain(root, [CATALOG, SESSIONS]);
    if (chain.missing) return [];
    const names = [];
    let seen = 0;
    const dir = await fs.promises.opendir(sessionsPath);
    try {
      for await (const entry of dir) {
        seen += 1;
        if (seen > MAX_ENTRIES) throw overLimit(true);
        if (seen % YIELD_EVERY === 0) await yieldTurn();
        if (UUID_RE.test(entry.name)) {
          names.push(entry.name);
          if (names.length > MAX_SESSIONS) throw overLimit(true);
        }
      }
    } finally {
      await dir.close().catch(() => {});
    }
    const found = [];
    for (const [at, gameId] of names.entries()) {
      if (at > 0 && at % YIELD_EVERY === 0) await yieldTurn();
      try {
        const session = lstatOrNull(path.join(sessionsPath, gameId));
        if (!session) continue;
        if (session.isSymbolicLink() || !session.isDirectory()) {
          found.push({ gameId, savedAtMs: null, code: 'REPLAY_UNAVAILABLE' });
          continue;
        }
        const state = lstatOrNull(path.join(sessionsPath, gameId, 'state.json'));
        if (state && isUnlinked(state)) {
          const names = [CATALOG, SESSIONS, gameId];
          const sessionChain = { ids: [...chain.ids, `${session.dev}:${session.ino}`] };
          found.push({ gameId, savedAtMs: null, code: replacementError(root, names, sessionChain, path.join(sessionsPath, gameId, 'state.json')).code });
        }
        else if (!state || !isSafeFile(state)) found.push({ gameId, savedAtMs: null, code: 'REPLAY_UNAVAILABLE' });
        else if (state.size > STATE_BYTES) found.push({ gameId, savedAtMs: state.mtimeMs, code: 'REPLAY_LIMIT_EXCEEDED' });
        else found.push({ gameId, savedAtMs: state.mtimeMs, code: null });
      } catch (error) {
        // A private/corrupt session costs one row; the catalog chain itself is
        // still rechecked outside this catch and fails the entire request.
        found.push({ gameId, savedAtMs: null, code: normalizeError(error).code });
      }
    }
    const again = inspectChain(root, [CATALOG, SESSIONS]);
    if (again.missing || !sameChain(chain, again)) throw unavailable();
    return found.sort((a, b) => (b.savedAtMs ?? -Infinity) - (a.savedAtMs ?? -Infinity)
      || (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0));
  }

  // One state.json snapshot for one request; the caller owns the byte budget.
  async function loadGame(root, gameId, budget) {
    const chain = inspectChain(root, [CATALOG, SESSIONS, gameId]);
    if (chain.missing) throw notFound();
    await yieldTurn();
    const read = readLeaf(root, [CATALOG, SESSIONS, gameId], 'state.json', { maxBytes: STATE_BYTES, budget });
    if (!read) throw unavailable();
    const info = parseState(parseJson(read.bytes));
    return { gameId, savedAtMs: read.stat.mtimeMs, info };
  }

  async function loadRecord(root, game, handNo, budget) {
    await yieldTurn();
    const read = readLeaf(root, [CATALOG, SESSIONS, game.gameId, 'hands'], handFileName(handNo), { maxBytes: HAND_BYTES, budget });
    if (read) return parseJson(read.bytes);
    // Only a truly absent archive may fall back, and only to the newest hand.
    const latest = game.info.lastHand;
    if (latest && latest.handNo === handNo) {
      if (Buffer.byteLength(JSON.stringify(latest)) > HAND_BYTES) throw overLimit();
      return latest;
    }
    throw unavailable();
  }

  function contextFor(game, handNo) {
    const { seats, reveal } = game.info;
    return {
      handNo,
      reveal,
      seatSet: new Set(seats.map((seat) => seat.playerId)),
      humanIds: seats.filter((seat) => seat.kind === 'human').map((seat) => seat.playerId),
    };
  }

  function sized(response) {
    if (Buffer.byteLength(JSON.stringify(response)) > limits.response) throw overLimit(true);
    return response;
  }

  async function listGames(rawOptions) {
    const { offset, limit } = pageOptions(rawOptions, GAME_PAGE);
    return gate(`games:${offset}:${limit}`, async () => {
      const root = rootDir();
      const legacy = legacyPresent(root);
      const found = root ? await enumerateSessions(root) : [];
      const budget = { used: 0, limit: limits.gamesRead };
      const games = [];
      for (const entry of found.slice(offset, offset + limit)) {
        if (entry.code) { games.push(unavailableRow(entry.gameId, entry.savedAtMs, entry.code)); continue; }
        try {
          await yieldTurn();
          const read = readLeaf(root, [CATALOG, SESSIONS, entry.gameId], 'state.json', { maxBytes: STATE_BYTES, budget });
          if (!read) throw unavailable();
          games.push(gameRow(entry.gameId, entry.savedAtMs, parseState(parseJson(read.bytes))));
        } catch (error) {
          if (error?.fatal) throw error;
          games.push(unavailableRow(entry.gameId, entry.savedAtMs, normalizeError(error).code));
        }
      }
      return sized({
        ok: true,
        schemaVersion: 1,
        games,
        nextOffset: offset + limit < found.length ? offset + limit : null,
        legacyPresent: legacy,
      });
    });
  }

  async function listHands(gameId, rawOptions) {
    if (typeof gameId !== 'string' || !UUID_RE.test(gameId)) throw badRequest();
    const { offset, limit } = pageOptions(rawOptions, HAND_PAGE);
    return gate(`hands:${gameId}:${offset}:${limit}`, async () => {
      const root = rootDir();
      if (!root) throw notFound();
      const budget = { used: 0, limit: limits.handsRead };
      const game = await loadGame(root, gameId, budget);
      if (game.info.completed > MAX_HAND_NO) throw overLimit();
      const last = Math.min(offset + limit, game.info.completed);
      const hands = [];
      for (let handNo = offset + 1; handNo <= last; handNo += 1) {
        try {
          const replay = projectReplay(await loadRecord(root, game, handNo, budget), contextFor(game, handNo));
          hands.push({
            handNo,
            blinds: replay.blinds,
            heroPosition: replay.startStacks.user === undefined ? null : (replay.positions?.user ?? null),
            heroDealt: Object.hasOwn(replay.startStacks, 'user'),
            available: true,
            unavailableCode: null,
          });
        } catch (error) {
          if (error?.fatal) throw error;
          hands.push({
            handNo, blinds: null, heroPosition: null, heroDealt: null, available: false, unavailableCode: normalizeError(error).code,
          });
        }
      }
      return sized({
        ok: true,
        schemaVersion: 1,
        game: gameRow(gameId, game.savedAtMs, game.info),
        hands,
        nextOffset: offset + limit < game.info.completed ? offset + limit : null,
      });
    });
  }

  async function readHand(gameId, handNo) {
    if (typeof gameId !== 'string' || !UUID_RE.test(gameId)) throw badRequest();
    if (!Number.isSafeInteger(handNo) || handNo < 1) throw badRequest();
    if (handNo > MAX_HAND_NO) throw overLimit();
    return gate(`hand:${gameId}:${handNo}`, async () => {
      const root = rootDir();
      if (!root) throw notFound();
      const budget = { used: 0, limit: limits.handsRead };
      const game = await loadGame(root, gameId, budget);
      if (handNo > game.info.completed) throw game.info.handNo >= handNo ? fail('REPLAY_NOT_COMPLETED') : notFound();
      const replay = projectReplay(await loadRecord(root, game, handNo, budget), contextFor(game, handNo));
      const row = gameRow(gameId, game.savedAtMs, game.info);
      const seats = game.info.seats.map((seat) => ({ playerId: seat.playerId, name: seat.name, kind: seat.kind }));
      return sized({
        ok: true,
        schemaVersion: 1,
        game: { ...row, seats, viewerId: 'user' },
        handNo,
        revision: revisionOf(gameId, row, seats, replay),
        replay,
      });
    });
  }

  return { listGames, listHands, readHand };
}
