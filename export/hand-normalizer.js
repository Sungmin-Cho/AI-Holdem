import fs from 'node:fs';
import path from 'node:path';
import { resolveCurrentSession } from '../engine/session-catalog.js';
import { FORBIDDEN_PATH_LITERALS, FORBIDDEN_PATH_RE } from '../publish-contract.js';
import { openContained } from '../tools/training-store.js';
import { EXPORT_MAX_BYTES } from './contracts.js';

const FORBIDDEN = [
  'archetype', 'personality', 'bluffFreq', 'policySeed', 'sessionToken',
  'policyId', 'configDigest', 'sampledProbability', ...FORBIDDEN_PATH_LITERALS,
];

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readContainedJson(root, segments) {
  try {
    const buf = openContained(root, segments, { maxBytes: EXPORT_MAX_BYTES });
    return JSON.parse(buf.toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function listHands(gameDir) {
  const root = path.resolve(gameDir);
  const handsDir = path.join(root, 'hands');
  let files = [];
  try {
    const st = fs.lstatSync(handsDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw coded('UNSAFE_PATH', 'hands 디렉터리가 안전하지 않습니다.');
    }
    files = fs.readdirSync(handsDir).filter((name) => /^hand-\d+\.json$/.test(name)).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const records = files.map((name) => {
    const parsed = readContainedJson(root, ['hands', name]);
    if (parsed == null) throw coded('UNSAFE_PATH', `${name}을 읽을 수 없습니다.`);
    return parsed;
  });
  const state = readContainedJson(root, ['state.json']);
  if (state?.lastHand?.handNo && !records.some((row) => row.handNo === state.lastHand.handNo)) {
    records.push(state.lastHand);
  }
  return { state, records: records.sort((a, b) => a.handNo - b.handNo) };
}

export function resolveExportDir({ gameDir, storeDir }) {
  if (storeDir) {
    const current = resolveCurrentSession(storeDir);
    if (!current) {
      const err = new Error('current session이 없습니다.');
      err.code = 'NO_GAME';
      throw err;
    }
    return current.sessionDir;
  }
  if (!gameDir) {
    const err = new Error('--game-dir 또는 --store-dir가 필요합니다.');
    err.code = 'USAGE';
    throw err;
  }
  return path.resolve(gameDir);
}

function publicHoles(record) {
  const revealed = new Set();
  for (const reveal of record.showdown?.reveals ?? []) {
    for (const card of reveal.cards ?? []) revealed.add(card);
  }
  const holes = {};
  if (record.holes?.user) holes.user = record.holes.user;
  for (const [playerId, cards] of Object.entries(record.holes ?? {})) {
    if (playerId === 'user') continue;
    if (cards.every((card) => revealed.has(card))) holes[playerId] = cards;
  }
  return holes;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function normalizeHand(record, { evaluations = [] } = {}) {
  return {
    handNo: record.handNo,
    button: record.button,
    blinds: record.blinds,
    seats: Object.entries(record.startStacks ?? {}).map(([playerId, stack]) => ({ playerId, stack })),
    heroCards: record.holes?.user ?? [],
    board: record.board ?? [],
    actions: (record.actions ?? []).map((action) => ({
      playerId: action.playerId,
      action: action.action,
      amount: action.amount,
      street: action.street,
      ...(typeof action.currentBet === 'number' ? { currentBet: action.currentBet } : {}),
    })),
    showdown: {
      reveals: record.showdown?.reveals ?? [],
      mucks: record.showdown?.mucks ?? [],
    },
    pots: record.pots ?? [],
    decisions: record.decisions ?? [],
    evaluations,
    holes: publicHoles(record),
    startStacks: record.startStacks ?? {},
    endStacks: record.endStacks ?? {},
    posts: Array.isArray(record.posts) ? structuredClone(record.posts) : record.posts,
    uncalledReturns: isPlainObject(record.uncalledReturns)
      ? { ...record.uncalledReturns }
      : record.uncalledReturns,
    allIn: [...(record.allIn ?? [])],
    folded: [...(record.folded ?? [])],
  };
}

export function assertNoSecrets(payload) {
  const json = JSON.stringify(payload);
  for (const key of FORBIDDEN) {
    if (json.includes(key)) {
      throw coded('FORBIDDEN_EXPORT', `forbidden field ${key}`);
    }
  }
  if (FORBIDDEN_PATH_RE.test(json)) {
    throw coded('FORBIDDEN_EXPORT', 'forbidden absolute path');
  }
}
