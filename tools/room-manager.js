import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writePrivateJson, readPrivateJson } from './app-files.js';
import { validateParticipantName } from '../shared/seat-roles.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const FILE = ['.app', 'room.json'];

function coded(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function randomCode(random) {
  const bytes = random ? random(8) : randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function randomToken(random) {
  const bytes = random ? random(32) : randomBytes(32);
  return Buffer.from(bytes).toString('hex');
}

function normalizeCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function codesEqual(left, right) {
  const a = Buffer.from(normalizeCode(left));
  const b = Buffer.from(normalizeCode(right));
  if (a.length !== 8 || b.length !== 8 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function displayCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function createRoomManager({
  storeDir,
  now = () => new Date(),
  random,
  writeThrottleMs = 5000,
  onRevoke = () => {},
} = {}) {
  if (!storeDir) throw new Error('storeDir required');
  const file = path.join(storeDir, ...FILE);
  let memory = null;
  let lastWrite = 0;
  let pendingTouch = false;
  const revokeListeners = [];
  function notifyRevoke(event) {
    try { onRevoke(event); } catch { /* constructor hook must not break room ops */ }
    for (const fn of revokeListeners) {
      try { fn(event); } catch { /* listener errors must not break room ops */ }
    }
  }

  const iso = () => now().toISOString();

  function load() {
    if (memory) return memory;
    try {
      memory = readPrivateJson(file);
    } catch {
      memory = null;
    }
    return memory;
  }

  function save(room, { force = false } = {}) {
    const t = now().getTime();
    if (!force && t - lastWrite < writeThrottleMs) {
      memory = room;
      pendingTouch = true;
      return room;
    }
    room.updatedAt = iso();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writePrivateJson(file, room);
    lastWrite = t;
    pendingTouch = false;
    memory = room;
    return room;
  }

  function requireRoom() {
    const room = load();
    if (!room) throw coded('ROOM_NOT_FOUND', '룸이 없습니다.');
    return room;
  }

  function activeParticipants(room) {
    return (room.participants ?? []).filter((row) => row.status === 'active');
  }

  function hostView() {
    const room = load();
    if (!room) return null;
    const active = activeParticipants(room);
    const capacity = Math.max(0, (room.totalSeats ?? 9) - 1);
    const lockedAddresses = Object.keys(room.joinFailures ?? {}).length;
    return {
      status: room.status,
      errorCode: room.errorCode ?? null,
      hostName: room.hostName,
      totalSeats: room.totalSeats,
      actionTimeoutSec: room.actionTimeoutSec,
      joinCode: displayCode(room.joinCode),
      tls: false,
      capacity,
      lockedAddresses,
      participants: active.map((row) => ({
        participantId: row.participantId,
        name: row.name,
        connected: now().getTime() - Date.parse(row.lastSeenAt ?? row.joinedAt) < 10_000,
        playerId: row.playerId ?? null,
      })),
      aiPreview: Math.max(0, room.totalSeats - 1 - active.length),
    };
  }

  function participantView(participantId) {
    const room = requireRoom();
    const me = room.participants.find((row) => row.participantId === participantId);
    if (!me || me.status !== 'active') throw coded('UNAUTHORIZED');
    return {
      status: room.status,
      hostName: room.hostName,
      totalSeats: room.totalSeats,
      me: { participantId: me.participantId, name: me.name, playerId: me.playerId ?? null },
      participants: activeParticipants(room).map((row) => ({
        name: row.name,
        connected: now().getTime() - Date.parse(row.lastSeenAt ?? row.joinedAt) < 10_000,
        me: row.participantId === participantId,
      })),
    };
  }

  function open({ hostName = '호스트', totalSeats = 9, actionTimeoutSec = 60 } = {}) {
    if (load() && !['closed', 'error'].includes(load().status)) throw coded('ROOM_EXISTS');
    if (!Number.isInteger(totalSeats) || totalSeats < 2 || totalSeats > 9) throw coded('INVALID_SETUP');
    if (actionTimeoutSec !== 0 && (actionTimeoutSec < 10 || actionTimeoutSec > 600)) throw coded('INVALID_SETUP');
    const room = {
      schemaVersion: 1,
      roomId: randomBytes(16).toString('hex'),
      status: 'open',
      errorCode: null,
      createdAt: iso(),
      updatedAt: iso(),
      hostName,
      totalSeats,
      actionTimeoutSec,
      joinCode: randomCode(random),
      codeRotatedAt: iso(),
      joinFailures: {},
      publicOrigin: null,
      lock: { requestId: null, boundGameId: null, previous: null },
      participants: [],
    };
    return save(room, { force: true });
  }

  function join({ code, name, addr } = {}) {
    const room = requireRoom();
    if (room.status === 'locked') throw coded('ROOM_LOCKED', '게임 진행 중 — 끝나면 참가할 수 있습니다');
    if (room.status !== 'open') throw coded('ROOM_NOT_FOUND');
    const failures = room.joinFailures[addr] ?? [];
    const windowStart = now().getTime() - 10 * 60 * 1000;
    const recent = failures.map((t) => Date.parse(t)).filter((t) => t >= windowStart);
    if (recent.length >= 10) throw coded('JOIN_LOCKED');
    if (!codesEqual(code, room.joinCode)) {
      room.joinFailures[addr ?? 'unknown'] = [...recent.map((t) => new Date(t).toISOString()), iso()];
      save(room, { force: true });
      throw coded('BAD_CODE');
    }
    try {
      validateParticipantName(name, { hostName: room.hostName });
    } catch (error) {
      const host = String(room.hostName ?? '').trim().toLowerCase();
      if (error?.code === 'BAD_CONFIG' && String(name ?? '').trim().toLowerCase() === host) {
        throw coded('NAME_TAKEN', error.message);
      }
      throw error;
    }
    const taken = activeParticipants(room).some((row) => row.name.toLowerCase() === name.trim().toLowerCase());
    if (taken) throw coded('NAME_TAKEN');
    if (activeParticipants(room).length >= room.totalSeats - 1) throw coded('ROOM_FULL');
    const token = randomToken(random);
    const participant = {
      participantId: randomBytes(16).toString('hex'),
      name: name.trim(),
      tokenSha256: sha256(token),
      tokenGeneration: 1,
      joinedAt: iso(),
      lastSeenAt: iso(),
      status: 'active',
      playerId: null,
    };
    room.participants.push(participant);
    save(room, { force: true });
    return { participantToken: token, participantId: participant.participantId, roomId: room.roomId };
  }

  function authenticate(token) {
    const room = requireRoom();
    const digest = sha256(token);
    const row = room.participants.find((entry) => entry.tokenSha256 === digest && entry.status === 'active');
    if (!row) throw coded('UNAUTHORIZED');
    return row;
  }

  function rotateCode() {
    const room = requireRoom();
    if (room.status === 'locked') throw coded('ROOM_LOCKED');
    room.joinCode = randomCode(random);
    room.codeRotatedAt = iso();
    save(room, { force: true });
    return displayCode(room.joinCode);
  }

  function reissue(participantId) {
    const room = requireRoom();
    if (room.status === 'locked') throw coded('ROOM_LOCKED');
    const row = room.participants.find((entry) => entry.participantId === participantId && entry.status === 'active');
    if (!row) throw coded('UNAUTHORIZED');
    const previous = row.tokenGeneration;
    const token = randomToken(random);
    row.tokenSha256 = sha256(token);
    row.tokenGeneration += 1;
    save(room, { force: true });
    notifyRevoke({ participantId, previousGeneration: previous });
    return { token, link: `/join#rejoin=${token}` };
  }

  function remove(participantId) {
    const room = requireRoom();
    if (room.status === 'locked') throw coded('ROOM_LOCKED');
    const row = room.participants.find((entry) => entry.participantId === participantId);
    if (!row) return;
    const previous = row.tokenGeneration;
    row.status = 'removed';
    row.tokenSha256 = sha256(randomToken(random));
    save(room, { force: true });
    notifyRevoke({ participantId, previousGeneration: previous });
  }

  function update({ totalSeats, actionTimeoutSec } = {}) {
    const room = requireRoom();
    if (room.status !== 'open') throw coded('ROOM_LOCKED');
    if (totalSeats !== undefined) {
      if (!Number.isInteger(totalSeats) || totalSeats < 2 || totalSeats > 9) throw coded('INVALID_SETUP');
      if (totalSeats < 1 + activeParticipants(room).length) throw coded('INVALID_SETUP');
      room.totalSeats = totalSeats;
    }
    if (actionTimeoutSec !== undefined) room.actionTimeoutSec = actionTimeoutSec;
    save(room, { force: true });
    return room;
  }

  function close() {
    const room = requireRoom();
    if (room.status === 'locked') throw coded('ROOM_LOCKED');
    for (const row of room.participants) {
      if (row.status === 'active') notifyRevoke({ participantId: row.participantId, previousGeneration: row.tokenGeneration });
      row.status = 'removed';
    }
    room.status = 'closed';
    save(room, { force: true });
    memory = room;
    return room;
  }

  function lockForStart({ requestId } = {}) {
    const room = requireRoom();
    if (room.status === 'locked' && room.lock?.boundGameId) {
      const previous = { status: room.status, boundGameId: room.lock.boundGameId, requestId: room.lock.requestId };
      room.lock = { ...room.lock, requestId, previous };
      save(room, { force: true });
      return {
        roomId: room.roomId,
        hostName: room.hostName,
        actionTimeoutSec: room.actionTimeoutSec,
        participants: activeParticipants(room)
          .slice()
          .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt))
          .map((row) => ({ participantId: row.participantId, name: row.name })),
      };
    }
    if (room.status !== 'open') throw coded('ROOM_LOCKED');
    room.lock = {
      requestId,
      boundGameId: null,
      previous: { status: room.status, boundGameId: room.lock?.boundGameId ?? null, requestId: room.lock?.requestId ?? null },
    };
    room.status = 'locked';
    save(room, { force: true });
    return {
      roomId: room.roomId,
      hostName: room.hostName,
      actionTimeoutSec: room.actionTimeoutSec,
      participants: activeParticipants(room)
        .slice()
        .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt))
        .map((row) => ({ participantId: row.participantId, name: row.name })),
    };
  }

  function bind(gameId, players) {
    const room = requireRoom();
    const list = Array.isArray(players) ? players : [];
    for (const row of activeParticipants(room)) {
      const mapped = list.find((player) => player.participantId === row.participantId);
      row.playerId = mapped?.playerId ?? row.playerId;
    }
    room.lock = { ...(room.lock ?? {}), boundGameId: gameId };
    room.status = 'locked';
    save(room, { force: true });
    return room;
  }

  function unlock(requestId) {
    const room = requireRoom();
    if (room.lock?.requestId !== requestId) return room;
    const previous = room.lock.previous;
    if (previous?.status === 'locked' && previous.boundGameId) {
      room.status = 'locked';
      room.lock = { requestId: previous.requestId, boundGameId: previous.boundGameId, previous: null };
    } else {
      room.status = 'open';
      room.lock = { requestId: null, boundGameId: null, previous: null };
    }
    save(room, { force: true });
    return room;
  }

  function release(gameId, { pendingRequestId } = {}) {
    const room = requireRoom();
    if (room.lock?.boundGameId !== gameId) return room;
    if (pendingRequestId && room.lock.requestId && room.lock.requestId !== pendingRequestId) return room;
    if (pendingRequestId) return room;
    room.status = 'open';
    room.lock = { requestId: null, boundGameId: null, previous: null };
    for (const row of room.participants) row.playerId = row.status === 'active' ? row.playerId : row.playerId;
    save(room, { force: true });
    return room;
  }

  function recover({ current, players, unfinishedRow, gameTerminal } = {}) {
    const room = load();
    if (!room) return null;
    if (unfinishedRow) {
      room.status = 'locked';
      room.lock = { ...(room.lock ?? {}), requestId: unfinishedRow.requestId ?? room.lock?.requestId };
      save(room, { force: true });
      return room;
    }
    if (room.status === 'locked') {
      if (gameTerminal) {
        room.status = 'open';
        room.lock = { requestId: null, boundGameId: null, previous: null };
        save(room, { force: true });
        return room;
      }
      if (!room.lock?.boundGameId && !current) {
        room.status = 'open';
        room.lock = { requestId: null, boundGameId: null, previous: null };
        save(room, { force: true });
        return room;
      }
      const roomIds = new Set(activeParticipants(room).map((row) => row.participantId));
      const playerIds = new Set((players ?? []).map((row) => row.participantId).filter(Boolean));
      const same = roomIds.size === playerIds.size && [...roomIds].every((id) => playerIds.has(id));
      if (same) {
        bind(current?.gameId ?? current, players ?? []);
        return load();
      }
      room.status = 'error';
      room.errorCode = 'ROOM_MISMATCH';
      save(room, { force: true });
      return room;
    }
    return room;
  }

  function touch(participantId) {
    const room = requireRoom();
    const row = room.participants.find((entry) => entry.participantId === participantId);
    if (!row) return;
    row.lastSeenAt = iso();
    save(room, { force: false });
  }

  function flush() {
    if (pendingTouch && memory) save(memory, { force: true });
  }

  return {
    open, join, authenticate, rotateCode, reissue, remove, update, close,
    lockForStart, bind, unlock, release, recover, touch, flush,
    hostView, participantView, load, displayCode,
    addRevokeListener(fn) { revokeListeners.push(fn); },
    get boundGameId() { return load()?.lock?.boundGameId ?? null; },
  };
}
