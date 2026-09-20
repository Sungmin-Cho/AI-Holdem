import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRoomManager } from '../tools/room-manager.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';

function fixture() {
  const storeDir = createOwnedTempDir('spectator-room');
  const room = createRoomManager({storeDir});
  room.open({totalSeats:2});
  const player = room.join({code:room.load().joinCode,name:'Player',addr:'1'});
  room.lockForStart({requestId:'start'});
  room.bind('game-a',[{participantId:player.participantId,playerId:'h1'}]);
  const join = name => room.join({code:room.load().joinCode,name,addr:'2',game:{state:'playing',gameId:'game-a'}});
  return {room,storeDir,player,join};
}

test('late observers never consume seats and survive room recovery', () => {
  const f=fixture(); const observer=f.join('Observer');
  assert.equal(f.room.authenticate(observer.participantToken).roomRole,'spectator');
  assert.equal(f.room.authenticate(observer.participantToken).playerId,null);
  assert.equal(f.room.hostView().participants.length,1);
  assert.equal(f.room.hostView().spectators.length,1);
  const room=createRoomManager({storeDir:f.storeDir});
  room.recover({current:{gameId:'game-a'},players:[{participantId:f.player.participantId,playerId:'h1'}]});
  assert.equal(room.load().status,'locked');
  assert.equal(room.lockForStart({requestId:'restart'}).participants.length,1);
});

test('observer promotion is explicit, capacity checked and start-fenced', () => {
  const f=fixture();const observer=f.join('Observer');
  assert.throws(()=>f.room.requestSeat(observer.participantId,{expectedRoomId:f.room.load().roomId,expectedRevision:f.room.load().revision}),{code:'ROOM_LOCKED'});
  f.room.release('game-a');
  const expected=()=>({expectedRoomId:f.room.load().roomId,expectedRevision:f.room.load().revision});
  assert.throws(()=>f.room.requestSeat(observer.participantId,expected()),{code:'ROOM_FULL'});
  f.room.update({totalSeats:3});
  const before=expected();
  f.room.requestSeat(observer.participantId,before);
  f.room.requestSeat(observer.participantId,before);
  assert.equal(f.room.hostView().participants.length,2);
  assert.equal(f.room.hostView().spectators.length,0);
  assert.equal(f.room.authenticate(observer.participantToken).roomRole,'seated');
});

test('observer capacity and revoke do not mutate bound seated membership', () => {
  const f=fixture();const first=f.join('Observer0');
  for(let i=1;i<20;i++)f.join(`Observer${i}`);
  assert.throws(()=>f.join('Extra'),{code:'SPECTATOR_FULL'});
  f.room.remove(first.participantId);
  assert.throws(()=>f.room.authenticate(first.participantToken),{code:'UNAUTHORIZED'});
  f.join('Replacement');
  assert.throws(()=>f.room.remove(f.player.participantId),{code:'ROOM_LOCKED'});
  f.room.leaveEliminated(f.player.participantId);
  assert.throws(()=>f.room.authenticate(f.player.participantToken),{code:'UNAUTHORIZED'});
  assert.equal(f.room.hostView().participants.length,1);
  f.room.release('game-a');
  const rejoin=f.room.reissue(f.player.participantId);
  assert.equal(f.room.authenticate(rejoin.token).participantId,f.player.participantId);
  f.room.remove(f.player.participantId);
  assert.equal(f.room.hostView().participants.length,0);
});

test('v1 room migration preserves credentials and rejects unknown schemas', () => {
  const f=fixture();const file=path.join(f.storeDir,'.app','room.json');
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  raw.schemaVersion=1;for(const row of raw.participants)delete row.roomRole;
  fs.writeFileSync(file,JSON.stringify(raw));
  const restored=createRoomManager({storeDir:f.storeDir});
  assert.equal(restored.authenticate(f.player.participantToken).roomRole,'seated');
  restored.rotateCode();
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).schemaVersion,2);
  raw.schemaVersion=99;fs.writeFileSync(file,JSON.stringify(raw));
  assert.throws(()=>createRoomManager({storeDir:f.storeDir}).load(),{code:'ROOM_SCHEMA_INVALID'});
});

test('late admission fails closed during start, replacement and stale binding', () => {
  const f=fixture();
  for(const game of [{state:'starting',gameId:'game-a'},{state:'playing',gameId:'game-b'},{state:'playing',gameId:'game-a',pendingRequestId:'restart'}]) {
    assert.throws(()=>f.room.join({code:f.room.load().joinCode,name:'X',addr:'3',game}),{code:'ROOM_LOCKED'});
  }
});
