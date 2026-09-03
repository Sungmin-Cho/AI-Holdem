import path from 'node:path';
import { withNamedLock } from '../engine/state.js';

function requireIo(io, names) {
  for (const name of names) {
    if (typeof io?.[name] !== 'function') {
      const error = new Error(`training store io.${name}가 필요합니다.`);
      error.code = 'IO_NOT_INJECTED';
      throw error;
    }
  }
  return io;
}


function notesPath(storeDir) {
  return path.join(storeDir, '.training', 'opponent-notes.jsonl');
}

export async function writeOpponentNote(storeDir, note, { io } = {}) {
  const { ensureDir, appendJsonl } = requireIo(io, ['ensureDir', 'appendJsonl']);
  if (!note?.playerId || !Number.isInteger(note.atHandNo) || note.atHandNo < 1) {
    const error = new Error('invalid opponent note');
    error.code = 'INVALID_NOTE';
    throw error;
  }
  const frozen = {
    playerId: note.playerId,
    atHandNo: note.atHandNo,
    observations: [...(note.observations ?? [])],
    confidence: note.confidence ?? null,
    // 작성자가 준 시각은 무시한다 — 노트의 시간순은 서버가 소유한다.
    writtenAt: new Date().toISOString(),
  };
  const dir = path.join(storeDir, '.training');
  ensureDir(dir);
  await withNamedLock(dir, 'notes.lock.d', async () => {
    appendJsonl(notesPath(storeDir), frozen);
  });
  return frozen;
}

export function readOpponentNotes(storeDir, { io } = {}) {
  const { readJsonl } = requireIo(io, ['readJsonl']);
  try {
    return readJsonl(notesPath(storeDir));
  } catch {
    return [];
  }
}

export async function rewriteOpponentNotesForbidden(storeDir, { io } = {}) {
  const { readJsonl } = requireIo(io, ['readJsonl']);
  const error = new Error('opponent notes cannot be rewritten');
  error.code = 'NOTE_IMMUTABLE';
  throw error;
}

export function readAccuracy(notes, modelLabels) {
  const observed = new Set((notes ?? []).flatMap((note) => note.observations ?? []));
  const truth = new Set(modelLabels ?? []);
  const hit = [...observed].filter((label) => truth.has(label));
  const missed = [...truth].filter((label) => !observed.has(label));
  const wrong = [...observed].filter((label) => !truth.has(label));
  return {
    hit,
    missed,
    wrong,
    score: truth.size ? hit.length / truth.size : (observed.size ? 0 : 1),
  };
}

export function persistReadReport(storeDir, report, { io } = {}) {
  const { ensureDir, writeJsonSecure } = requireIo(io, ['ensureDir', 'writeJsonSecure']);
  ensureDir(path.join(storeDir, '.training'));
  writeJsonSecure(path.join(storeDir, '.training', 'read-accuracy.json'), report);
}
