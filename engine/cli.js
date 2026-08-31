#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDeck } from './cards.js';
import { initGameDir, isAlive, readLock } from './game-archive.js';
import { applyAction, forceDefault, legalFor, startHand } from './hand.js';
import {
  loadState, readHand, readOwnedLock, withMutation, writeHandArchive,
} from './state.js';
import { redactRecord, statsReport, turnSummary, viewFor } from './views.js';

const BOOL_FLAGS = new Set(['force', 'force-default', 'redacted', 'new-hand']);
const VALUE_FLAGS = new Set([
  'game-dir', 'lock-dir', 'ai', 'stack', 'blinds', 'level-every',
  'expect-version', 'for', 'result', 'deck',
]);

const FAIL_MESSAGES = {
  ILLEGAL_ACTION: '허용되지 않는 액션입니다.',
  GAME_OVER: '게임이 종료되었습니다.',
  LOCKED: '다른 명령이 상태를 사용 중입니다.',
  VERSION_MISMATCH: 'stateVersion이 일치하지 않습니다.',
  NO_GAME: '게임 상태가 없습니다.',
  ACTIVE_GAME: '이미 진행 중인 게임이 있습니다.',
  ARCHIVE_FAILED: '직전 게임을 보관하지 못했습니다.',
  SERVER_ALIVE: '게임 서버가 아직 종료되지 않았습니다.',
  HAND_NOT_FOUND: '핸드를 찾을 수 없습니다.',
  LOOP_ALIVE: '게임 루프가 아직 실행 중입니다. 사이드카를 먼저 정지하세요.',
};

function reply(envelope, exitCode) {
  fs.writeSync(1, `${JSON.stringify(envelope)}\n`);
  process.exit(exitCode);
}

function succeed(fields) {
  const events = Array.isArray(fields.events) ? fields.events : [];
  reply({ ...fields, ok: true, events }, 0);
}

function fail(code, message, exitCode = 1) {
  // The turn command redirects stdout to a file, so stderr is the dealer's only view of a refusal.
  try { fs.writeSync(2, `${JSON.stringify({ ok: false, code, message })}\n`); } catch { /* closed */ }
  reply({ ok: false, code, message }, exitCode);
}

function usage(message) {
  fail('USAGE', message, 2);
}

function throwCoded(code, message) {
  const error = new Error(message || FAIL_MESSAGES[code] || code);
  error.code = code;
  throw error;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) usage(`옵션 --${name}의 값이 필요합니다.`);
      flags[name] = value;
      i += 1;
      continue;
    }
    usage(`알 수 없는 옵션: --${name}`);
  }
  return { flags, positional };
}

function parseIntArg(value, label) {
  if (!/^-?\d+$/.test(String(value))) usage(`${label}는 정수여야 합니다.`);
  return Number(value);
}

function parseAi(value) {
  const n = parseIntArg(value, '--ai');
  if (n < 1 || n > 8) usage('--ai는 1에서 8 사이여야 합니다.');
  return n;
}

function parseBlinds(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) usage('--blinds는 SB/BB 형식이어야 합니다.');
  const blinds = [Number(match[1]), Number(match[2])];
  if (blinds[0] < 1 || blinds[1] < 1) usage('--blinds 값이 올바르지 않습니다.');
  return blinds;
}

function parseDeck(value) {
  const cards = String(value).split(',').map((card) => card.trim()).filter(Boolean);
  const valid = new Set(newDeck());
  if (cards.length !== 52 || new Set(cards).size !== 52 || cards.some((card) => !valid.has(card))) {
    usage('--deck은 중복 없는 52장이어야 합니다.');
  }
  return cards;
}

function requireState(state) {
  if (!state) throwCoded('NO_GAME');
  return state;
}

function applyEnvelope(state, events) {
  const legal = legalFor(state);
  const response = {
    events,
    handOver: legal.handOver,
    gameOver: legal.gameOver,
  };
  if (legal.gameOver) {
    if (legal.result != null) response.result = legal.result;
    if (legal.bustedPlayerIds) response.bustedPlayerIds = legal.bustedPlayerIds;
  }
  return response;
}

function mutate(gameDir, fn) {
  const result = withMutation(gameDir, (state) => {
    const beforeHandNo = state?.lastHand?.handNo ?? null;
    const inner = fn(state);
    return { state: inner.state, response: inner.response, beforeHandNo };
  });
  const envelope = result.response ?? {};
  envelope.stateVersion = result.state.stateVersion;
  // The response is built inside the mutation, before saveState bumps the version;
  // leaving the nested copy behind would hand out a version that is already stale.
  if (envelope.view?.legal?.stateVersion !== undefined) {
    envelope.view.legal.stateVersion = envelope.stateVersion;
  }
  const lastHand = result.state.lastHand;
  if (lastHand && lastHand.handNo !== result.beforeHandNo) {
    try {
      writeHandArchive(gameDir, lastHand);
    } catch {
      envelope.archivePending = true;
    }
  }
  return envelope;
}

function rebuildArchive(gameDir, state) {
  if (!state.lastHand) return false;
  if (readHand(gameDir, state.lastHand.handNo)) return false;
  writeHandArchive(gameDir, state.lastHand);
  return true;
}

function cmdInit(gameDir, flags) {
  if (flags.ai == null) usage('--ai가 필요합니다.');
  const aiCount = parseAi(flags.ai);
  const startStack = flags.stack != null ? parseIntArg(flags.stack, '--stack') : 5000;
  const blinds0 = flags.blinds != null ? parseBlinds(flags.blinds) : [25, 50];
  const levelEvery = flags['level-every'] != null
    ? parseIntArg(flags['level-every'], '--level-every')
    : 8;
  if (startStack < 1) usage('--stack은 1 이상이어야 합니다.');
  if (levelEvery < 1) usage('--level-every는 1 이상이어야 합니다.');
  const result = initGameDir(gameDir, { aiCount, startStack, blinds0, levelEvery, force: flags.force });
  succeed({
    stateVersion: result.stateVersion,
    sessionToken: result.sessionToken,
    players: result.players,
    archivedTo: result.archivedTo,
  });
}

function cmdNewHand(gameDir, flags) {
  const deck = flags.deck != null ? parseDeck(flags.deck) : undefined;
  const envelope = mutate(gameDir, (state) => {
    requireState(state);
    if (state.hand) throwCoded('ILLEGAL_ACTION', '진행 중인 핸드가 있습니다.');
    const result = startHand(state, deck ? { deck } : {});
    return { state: result.state, response: applyEnvelope(result.state, result.events) };
  });
  succeed(envelope);
}

function cmdLegal(gameDir) {
  const state = requireState(loadState(gameDir));
  succeed({ ...legalFor(state) });
}

function cmdApply(gameDir, flags, rest) {
  const playerId = rest[0];
  if (!playerId) usage('apply에는 playerId가 필요합니다.');
  const expectVersion = flags['expect-version'] != null
    ? parseIntArg(flags['expect-version'], '--expect-version')
    : null;
  let action;
  let amount;
  if (!flags['force-default']) {
    action = rest[1];
    if (!action) usage('apply에는 action이 필요합니다.');
    amount = rest[2] != null ? parseIntArg(rest[2], 'amount') : undefined;
  }
  const envelope = mutate(gameDir, (state) => {
    requireState(state);
    if (expectVersion != null && state.stateVersion !== expectVersion) {
      throwCoded('VERSION_MISMATCH');
    }
    const result = flags['force-default']
      ? forceDefault(state, playerId)
      : applyAction(state, playerId, action, amount);
    return { state: result.state, response: applyEnvelope(result.state, result.events) };
  });
  succeed(envelope);
}

function cmdView(gameDir, flags) {
  if (flags.for == null) usage('view에는 --for가 필요합니다.');
  const state = requireState(loadState(gameDir));
  succeed({ stateVersion: state.stateVersion, ...viewFor(state, flags.for) });
}

function readPlayers(gameDir) {
  try {
    const players = JSON.parse(fs.readFileSync(path.join(gameDir, 'players.json'), 'utf8'));
    return Array.isArray(players) ? players : [];
  } catch {
    return [];
  }
}

function nextBlock(gameDir, state, legal) {
  if (legal.handOver) return null;
  const next = {
    toAct: legal.toAct,
    decisionId: legal.decisionId,
    kind: legal.toAct === 'user' ? 'user' : 'ai',
  };
  if (next.kind === 'ai') {
    const record = readPlayers(gameDir).find((player) => player.playerId === legal.toAct);
    next.agentHandle = record?.agentHandle ?? `player-${legal.toAct}`;
    next.summary = turnSummary(state, legal.toAct);
  }
  return next;
}

// One dealer round: mutate at most once, then hand back everything the turn needs —
// events to publish, the user view, and the next actor's self-contained summary.
function stepEnvelope(gameDir, state, events) {
  const response = applyEnvelope(state, events);
  response.view = viewFor(state, 'user');
  // Marks whose view this is: publishing any other player's view would expose their hole cards.
  response.viewFor = 'user';
  response.next = nextBlock(gameDir, state, legalFor(state));
  return response;
}

function cmdStep(gameDir, flags, rest) {
  const newHand = Boolean(flags['new-hand']);
  const playerId = rest[0];
  if (newHand && (playerId != null || flags['force-default'])) {
    usage('step은 --new-hand와 액션을 동시에 받지 않습니다.');
  }

  const expectVersion = flags['expect-version'] != null
    ? parseIntArg(flags['expect-version'], '--expect-version')
    : null;

  if (!newHand && playerId == null) {
    if (flags['force-default']) usage('--force-default에는 playerId가 필요합니다.');
    const state = requireState(loadState(gameDir));
    if (expectVersion != null && state.stateVersion !== expectVersion) throwCoded('VERSION_MISMATCH');
    succeed({ stateVersion: state.stateVersion, ...stepEnvelope(gameDir, state, []) });
    return;
  }

  const deck = flags.deck != null ? parseDeck(flags.deck) : undefined;
  let action;
  let amount;
  if (!newHand && !flags['force-default']) {
    action = rest[1];
    if (!action) usage('step에는 action이 필요합니다.');
    amount = rest[2] != null ? parseIntArg(rest[2], 'amount') : undefined;
  }

  const envelope = mutate(gameDir, (state) => {
    requireState(state);
    if (expectVersion != null && state.stateVersion !== expectVersion) throwCoded('VERSION_MISMATCH');
    let result;
    if (newHand) {
      if (state.hand) throwCoded('ILLEGAL_ACTION', '진행 중인 핸드가 있습니다.');
      result = startHand(state, deck ? { deck } : {});
    } else if (flags['force-default']) {
      result = forceDefault(state, playerId);
    } else {
      result = applyAction(state, playerId, action, amount);
    }
    return { state: result.state, response: stepEnvelope(gameDir, result.state, result.events) };
  });
  succeed(envelope);
}

function cmdHand(gameDir, flags, rest) {
  if (rest[0] == null) usage('hand에는 핸드 번호가 필요합니다.');
  const n = parseIntArg(rest[0], 'hand');
  const state = requireState(loadState(gameDir));
  let record = state.lastHand?.handNo === n ? state.lastHand : readHand(gameDir, n);
  if (!record) throwCoded('HAND_NOT_FOUND', `핸드 ${n}을 찾을 수 없습니다.`);
  if (flags.redacted) record = redactRecord(record);
  succeed({ stateVersion: state.stateVersion, ...record });
}

function cmdStats(gameDir) {
  const state = requireState(loadState(gameDir));
  succeed({ stateVersion: state.stateVersion, ...statsReport(state) });
}

function cmdEnd(gameDir, flags) {
  if (flags.result !== 'abort') usage('end는 --result abort만 지원합니다.');
  const envelope = mutate(gameDir, (state) => {
    requireState(state);
    const next = structuredClone(state);
    next.gameOver = true;
    next.result = 'abort';
    next.phase = 'idle';
    next.hand = null;
    return {
      state: next,
      response: { gameOver: true, result: 'abort', events: [] },
    };
  });
  succeed(envelope);
}

function cmdResumeCheck(gameDir, lockDir = gameDir) {
  const state = requireState(loadState(gameDir));
  const lock = readLock(gameDir);
  const loop = readOwnedLock(lockDir, 'loop.lock.d');
  let archiveRepaired = false;
  // `false` alone cannot say whether the archive was already fine or the repair failed,
  // and the caller must block the next hand only in the second case.
  let archiveStatus = 'healthy';
  try {
    archiveRepaired = rebuildArchive(gameDir, state);
    if (archiveRepaired) archiveStatus = 'repaired';
  } catch {
    archiveRepaired = false;
    archiveStatus = 'repair_failed';
  }
  succeed({
    stateVersion: state.stateVersion,
    serverPidAlive: Boolean(lock && isAlive(lock.serverPid)),
    loopPidAlive: loop?.status === 'alive',
    port: lock?.port ?? null,
    sessionToken: state.sessionToken,
    phase: state.phase,
    toAct: legalFor(state).toAct,
    archiveRepaired,
    archiveStatus,
  });
}

function main() {
  try {
    const { flags, positional } = parseArgs(process.argv.slice(2));
    const cmd = positional[0];
    if (!cmd) usage('명령이 필요합니다.');
    const rest = positional.slice(1);
    const gameDir = path.resolve(flags['game-dir'] ?? 'game');
    switch (cmd) {
      case 'init':
        cmdInit(gameDir, flags);
        break;
      case 'new-hand':
        cmdNewHand(gameDir, flags);
        break;
      case 'legal':
        cmdLegal(gameDir);
        break;
      case 'apply':
        cmdApply(gameDir, flags, rest);
        break;
      case 'view':
        cmdView(gameDir, flags);
        break;
      case 'step':
        cmdStep(gameDir, flags, rest);
        break;
      case 'hand':
        cmdHand(gameDir, flags, rest);
        break;
      case 'stats':
        cmdStats(gameDir);
        break;
      case 'end':
        cmdEnd(gameDir, flags);
        break;
      case 'resume-check':
        cmdResumeCheck(gameDir, path.resolve(flags['lock-dir'] ?? gameDir));
        break;
      default:
        usage(`알 수 없는 명령: ${cmd}`);
    }
  } catch (error) {
    const inner = error.cause?.code;
    const code = (inner === 'LOCKED' || inner === 'NO_GAME')
      ? inner
      : (error.code || 'ERROR');
    fail(code, FAIL_MESSAGES[code] || error.message || '오류가 발생했습니다.', code === 'USAGE' ? 2 : 1);
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main();
}
