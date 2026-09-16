import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRoomManager } from '../tools/room-manager.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';

function mgr(extra = {}) {
  const storeDir = createOwnedTempDir('holdem-room');
  const revoked = [];
  const room = createRoomManager({
    storeDir,
    writeThrottleMs: extra.writeThrottleMs ?? 0,
    onRevoke: (info) => revoked.push(info),
    ...extra,
  });
  return { storeDir, room, revoked };
}

test('open→join×2→정원·이름 규칙', () => {
  const { room } = mgr();
  room.open({ hostName: '호스트', totalSeats: 6, actionTimeoutSec: 60 });
  const a = room.join({ code: room.load().joinCode, name: '민준', addr: '1.1.1.1' });
  const b = room.join({ code: room.load().joinCode, name: '서연', addr: '1.1.1.2' });
  assert.equal(a.participantId.length > 0, true);
  assert.equal(b.participantToken.length, 64);
  const view = room.hostView();
  assert.equal(view.participants.length, 2);
  assert.equal(view.capacity, 5);
  assert.equal(view.aiPreview, 3);
  assert.throws(() => room.join({ code: room.load().joinCode, name: '민준', addr: '1.1.1.3' }), { code: 'NAME_TAKEN' });
  assert.throws(() => room.join({ code: room.load().joinCode, name: '나', addr: '1.1.1.3' }), { code: 'BAD_CONFIG' });
  for (let i = 0; i < 3; i += 1) {
    room.join({ code: room.load().joinCode, name: `손님${i}`, addr: `2.2.2.${i}` });
  }
  assert.throws(() => room.join({ code: room.load().joinCode, name: '마지막', addr: '8.8.8.8' }), { code: 'ROOM_FULL' });
});

test('잘못된 코드 10회면 그 주소 JOIN_LOCKED, 코드는 유지', () => {
  const { room } = mgr();
  room.open({ totalSeats: 4 });
  const code = room.load().joinCode;
  for (let i = 0; i < 10; i += 1) {
    assert.throws(() => room.join({ code: 'AAAAAAAA', name: '민준', addr: '9.9.9.9' }), { code: 'BAD_CODE' });
  }
  assert.throws(() => room.join({ code, name: '민준', addr: '9.9.9.9' }), { code: 'JOIN_LOCKED' });
  const other = room.join({ code, name: '서연', addr: '8.8.8.8' });
  assert.ok(other.participantId);
  assert.equal(room.load().joinCode, code);
  room.rotateCode();
  assert.notEqual(room.load().joinCode, code);
});

test('reissue는 옛 토큰을 무효화하고 onRevoke를 부른다', () => {
  const { room, revoked } = mgr();
  room.open({ totalSeats: 3 });
  const joined = room.join({ code: room.load().joinCode, name: '민준', addr: '1.1.1.1' });
  room.authenticate(joined.participantToken);
  const next = room.reissue(joined.participantId);
  assert.throws(() => room.authenticate(joined.participantToken), { code: 'UNAUTHORIZED' });
  room.authenticate(next.token);
  assert.equal(revoked[0].participantId, joined.participantId);
  room.remove(joined.participantId);
  assert.throws(() => room.authenticate(next.token), { code: 'UNAUTHORIZED' });
});

test('lockForStart·bind 멱등·unlock 복원', () => {
  const { room } = mgr();
  room.open({ totalSeats: 4 });
  const a = room.join({ code: room.load().joinCode, name: '민준', addr: '1' });
  const locked = room.lockForStart({ requestId: 'req-a' });
  assert.equal(locked.participants.length, 1);
  assert.throws(() => room.join({ code: room.load().joinCode, name: '서연', addr: '2' }), { code: 'ROOM_LOCKED' });
  room.bind('game-1', [{ participantId: a.participantId, playerId: 'h1' }]);
  assert.equal(room.participantView(a.participantId).me.playerId, 'h1');
  room.bind('game-1', [{ participantId: a.participantId, playerId: 'h1' }]);
  assert.equal(room.boundGameId, 'game-1');
  room.unlock('other');
  assert.equal(room.load().status, 'locked');
  room.unlock('req-a');
  assert.equal(room.load().status, 'open');
});

test('recover 판정: 미완료 행 유지, 터미널 open, 집합 일치 bind, 불일치 error', () => {
  const { room } = mgr();
  room.open({ totalSeats: 3 });
  const a = room.join({ code: room.load().joinCode, name: '민준', addr: '1' });
  room.lockForStart({ requestId: 'start-1' });
  room.recover({ unfinishedRow: { requestId: 'start-1' } });
  assert.equal(room.load().status, 'locked');
  room.recover({ gameTerminal: true });
  assert.equal(room.load().status, 'open');
  room.lockForStart({ requestId: 'start-2' });
  room.recover({
    current: { gameId: 'g2' },
    players: [{ participantId: a.participantId, playerId: 'h1' }],
    gameTerminal: false,
  });
  assert.equal(room.load().status, 'locked');
  assert.equal(room.boundGameId, 'g2');
  room.lockForStart({ requestId: 'start-3' });
  room.recover({
    current: { gameId: 'g3' },
    players: [{ participantId: 'other', playerId: 'h1' }],
    gameTerminal: false,
  });
  assert.equal(room.load().status, 'error');
  assert.equal(room.load().errorCode, 'ROOM_MISMATCH');
  room.close();
  assert.equal(room.load().status, 'closed');
});

test('presence touch는 쓰기 합침', () => {
  const { room, storeDir } = mgr({ writeThrottleMs: 60_000 });
  room.open({ totalSeats: 3 });
  const a = room.join({ code: room.load().joinCode, name: '민준', addr: '1' });
  const file = path.join(storeDir, '.app', 'room.json');
  const before = fs.statSync(file).mtimeMs;
  room.touch(a.participantId);
  room.touch(a.participantId);
  assert.equal(fs.statSync(file).mtimeMs, before);
});
