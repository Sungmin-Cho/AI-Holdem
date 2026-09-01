import fs from 'node:fs';
import path from 'node:path';
import { resolveCurrentSession } from '../engine/session-catalog.js';

const FORBIDDEN = ['archetype', 'personality', 'bluffFreq', 'policySeed', 'sessionToken'];

export function listHands(gameDir) {
  const handsDir = path.join(gameDir, 'hands');
  const files = fs.existsSync(handsDir)
    ? fs.readdirSync(handsDir).filter((name) => /^hand-\d+\.json$/.test(name)).sort()
    : [];
  const records = files.map((name) => JSON.parse(fs.readFileSync(path.join(handsDir, name), 'utf8')));
  try {
    const state = JSON.parse(fs.readFileSync(path.join(gameDir, 'state.json'), 'utf8'));
    if (state.lastHand?.handNo && !records.some((row) => row.handNo === state.lastHand.handNo)) {
      records.push(state.lastHand);
    }
    return { state, records: records.sort((a, b) => a.handNo - b.handNo) };
  } catch {
    return { state: null, records: records.sort((a, b) => a.handNo - b.handNo) };
  }
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
    })),
    showdown: {
      reveals: record.showdown?.reveals ?? [],
    },
    pots: record.pots ?? [],
    decisions: record.decisions ?? [],
    evaluations,
    holes: publicHoles(record),
    startStacks: record.startStacks ?? {},
    endStacks: record.endStacks ?? {},
  };
}

export function assertNoSecrets(payload) {
  const json = JSON.stringify(payload);
  for (const key of FORBIDDEN) {
    if (json.includes(key)) {
      const err = new Error(`forbidden field ${key}`);
      err.code = 'FORBIDDEN_EXPORT';
      throw err;
    }
  }
}
