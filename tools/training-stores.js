import {
  appendJsonl,
  ensureDir,
  readJsonl,
  readJsonSecure,
  writeJsonSecure,
  writeTextSecure,
} from './training-store.js';
import { createMistakeBank as createBank } from '../training/mistake-bank.js';
import { createProfileStore as createStore } from '../training/profile-store.js';
import * as notes from '../training/opponent-notes.js';

// R12의 "주입자는 tools/CLI". training/ 쪽 저장 모듈은 fs helper를 기본값 없이
// 요구하므로, 그 helper를 실제로 쥐고 있는 이 계층이 유일한 조립 지점이다.
const io = Object.freeze({
  appendJsonl,
  ensureDir,
  readJsonl,
  readJsonSecure,
  writeJsonSecure,
  writeTextSecure,
});

export { io as trainingStoreIo };

export function createMistakeBank(storeDir, options = {}) {
  return createBank(storeDir, { ...options, io });
}

export function createProfileStore(storeDir, options = {}) {
  return createStore(storeDir, { ...options, io });
}

export function writeOpponentNote(storeDir, note) {
  return notes.writeOpponentNote(storeDir, note, { io });
}

export function readOpponentNotes(storeDir) {
  return notes.readOpponentNotes(storeDir, { io });
}

export function rewriteOpponentNotesForbidden(storeDir) {
  return notes.rewriteOpponentNotesForbidden(storeDir, { io });
}

export function persistReadReport(storeDir, report) {
  return notes.persistReadReport(storeDir, report, { io });
}

export { readAccuracy } from '../training/opponent-notes.js';
