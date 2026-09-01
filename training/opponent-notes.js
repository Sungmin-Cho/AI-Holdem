import path from 'node:path';
import { withNamedLock } from '../engine/state.js';
import { ensureDir, readJsonl, appendJsonl, writeJsonSecure } from '../tools/training-store.js';

function notesPath(storeDir) {
  return path.join(storeDir, '.training', 'opponent-notes.jsonl');
}

export async function writeOpponentNote(storeDir, note) {
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
    writtenAt: note.writtenAt ?? new Date().toISOString(),
  };
  const dir = path.join(storeDir, '.training');
  ensureDir(dir);
  await withNamedLock(dir, 'notes.lock.d', async () => {
    appendJsonl(notesPath(storeDir), frozen);
  });
  return frozen;
}

export function readOpponentNotes(storeDir) {
  try {
    return readJsonl(notesPath(storeDir));
  } catch {
    return [];
  }
}

export async function rewriteOpponentNotesForbidden(storeDir) {
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

export function persistReadReport(storeDir, report) {
  ensureDir(path.join(storeDir, '.training'));
  writeJsonSecure(path.join(storeDir, '.training', 'read-accuracy.json'), report);
}
