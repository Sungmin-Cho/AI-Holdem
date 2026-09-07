import fs from 'node:fs';
import path from 'node:path';
import { emptyTendency, mergeTendency } from '../training/tendency/contracts.js';
import { tendencyFromRecords } from '../training/tendency/extract.js';
import { openContained } from './training-store.js';

const STATE_MAX_BYTES = 4 * 1024 * 1024;
const HAND_MAX_BYTES = 1 * 1024 * 1024;
const LOOP_MAX_BYTES = 1 * 1024 * 1024;
const HAND_FILE_RE = /^hand-.*\.json$/;

function readJson(root, segments, maxBytes) {
  const buf = openContained(root, segments, { maxBytes });
  return JSON.parse(buf.toString('utf8'));
}

function scanSessions(storeDir) {
  const sessionsRoot = path.join(storeDir, '.session-store', 'sessions');
  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { eligible: [], skippedSessions: 0 };
    throw error;
  }
  const eligible = [];
  let skippedSessions = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const sessionDir = path.join(sessionsRoot, entry.name);
    try {
      const state = readJson(sessionDir, ['state.json'], STATE_MAX_BYTES);
      if (state?.gameOver !== true) {
        skippedSessions += 1;
        continue;
      }
      let opponentRuntime = state.policySeed ? 'policy' : 'llm';
      try {
        const loop = readJson(sessionDir, ['loop-state.json'], LOOP_MAX_BYTES);
        if (loop?.opponentRuntime === 'policy' || loop?.opponentRuntime === 'llm') {
          opponentRuntime = loop.opponentRuntime;
        }
      } catch {
        /* loop-state is optional for archive-only sessions */
      }
      eligible.push({
        gameId: entry.name,
        sessionDir,
        mode: state.config?.mode === 'cash-training' ? 'cash-training' : 'tournament',
        opponentRuntime,
        seats: Array.isArray(state.seats) ? state.seats.length : 0,
      });
    } catch {
      skippedSessions += 1;
    }
  }
  return { eligible, skippedSessions };
}

export function listGameOverSessions(storeDir) {
  return scanSessions(storeDir).eligible;
}

export function collectStoreTendency(storeDir) {
  const { eligible, skippedSessions } = scanSessions(storeDir);
  let tendency = emptyTendency('user');
  let skippedHands = 0;
  const sources = [];
  for (const session of eligible) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(session.sessionDir, 'hands'))
        .filter((name) => HAND_FILE_RE.test(name))
        .sort();
    } catch {
      files = [];
    }
    const records = [];
    for (const name of files) {
      try {
        records.push(readJson(session.sessionDir, ['hands', name], HAND_MAX_BYTES));
      } catch {
        skippedHands += 1;
      }
    }
    const source = {
      gameId: session.gameId,
      hands: records.length,
      mode: session.mode,
      opponentRuntime: session.opponentRuntime,
      seats: session.seats,
    };
    sources.push(source);
    tendency = mergeTendency(
      tendency,
      tendencyFromRecords(records, 'user', { sources: [source] }),
    );
  }
  return { tendency, sources, skippedSessions, skippedHands };
}
