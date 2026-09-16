import { normalizeFreeText } from './free-text.js';
import { RESERVED_SEAT_NAMES } from './reserved-names.js';

export const HOST_ID = 'user';
export const PARTICIPANT_ID_RE = /^h[1-8]$/;

function invalid(message) {
  const error = new Error(message);
  error.code = 'BAD_CONFIG';
  throw error;
}

export function isHumanSeat(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.kind === 'human') return true;
  if (row.kind === 'ai') return false;
  return row.playerId === HOST_ID;
}

export function humanIdsOf(rows) {
  return (Array.isArray(rows) ? rows : []).filter(isHumanSeat).map((row) => row.playerId);
}

export function aiRowsOf(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => !isHumanSeat(row));
}

export function seatLabel(row) {
  if (!row) return '';
  if (row.playerId === HOST_ID) return '호스트';
  if (PARTICIPANT_ID_RE.test(row.playerId)) return `참가자 ${row.playerId.slice(1)}`;
  return row.name ?? row.playerId;
}

export function validateParticipantName(name, { reserved = RESERVED_SEAT_NAMES, hostName } = {}) {
  if (typeof name !== 'string') invalid('참가자 이름이 문자열이 아닙니다.');
  const trimmed = name.trim();
  const normalized = normalizeFreeText(name, { maxChars: 64, maxBytes: 256 });
  if (trimmed !== normalized) invalid('참가자 이름에 제어문자·개행·연속 공백이 있습니다.');
  const length = [...trimmed].length;
  if (length < 1 || length > 12) invalid('참가자 이름은 1~12자여야 합니다.');
  const reservedKeys = new Set([...reserved].map((entry) => String(entry).toLowerCase()));
  if (hostName != null && String(hostName).trim()) {
    reservedKeys.add(String(hostName).trim().toLowerCase());
  }
  if (reservedKeys.has(trimmed.toLowerCase())) invalid('참가자 이름이 예약어이거나 호스트 이름과 같습니다.');
  return trimmed;
}

export function validateParticipantList(list, { hostName } = {}) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 8) {
    invalid('참가자는 1~8명이어야 합니다.');
  }
  const seenNames = new Set();
  const seenParticipantIds = new Set();
  for (let index = 0; index < list.length; index += 1) {
    const row = list[index];
    const expectedId = `h${index + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.playerId !== expectedId) {
      invalid('참가자 id는 h1부터 연속이어야 합니다.');
    }
    if (!PARTICIPANT_ID_RE.test(row.playerId)) invalid('참가자 id가 올바르지 않습니다.');
    if (typeof row.participantId !== 'string' || row.participantId.length === 0 || row.participantId.length > 128) {
      invalid('participantId가 올바르지 않습니다.');
    }
    if (seenParticipantIds.has(row.participantId)) invalid('participantId가 중복입니다.');
    seenParticipantIds.add(row.participantId);
    const name = validateParticipantName(row.name, { hostName });
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) invalid('참가자 이름이 중복입니다.');
    seenNames.add(nameKey);
  }
  return list;
}
