import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDrillServer } from '../tools/drill-server.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';

const GAME = '12345678-1234-4234-8234-123456789abc';
async function fixture(t, overrides = {}) {
  const calls = [];
  const library = Object.fromEntries(['listGames', 'listHands', 'readHand'].map(method => [method, async (...args) => {
    calls.push([method, ...args]); return { ok: true, schemaVersion: 1, method };
  }]));
  const handle = await startDrillServer({ storeDir: createOwnedTempDir('replay-api'), token: 'study-secret', replayLibrary: library, ...overrides });
  t.after(() => handle.close());
  const request = async (pathname, options = {}) => {
    const res = await fetch(`http://127.0.0.1:${handle.port}${pathname}`, {
      ...options, headers: { 'x-drill-token': 'study-secret', ...options.headers },
    });
    return { res, body: await res.json() };
  };
  return { calls, request, handle };
}
test('replay capability and strict GET dispatch use read-only library', async t => {
  const { calls, request } = await fixture(t);
  assert.equal((await request('/api/health')).body.capabilities.replayLibrary, 1);
  assert.equal((await request('/api/replays/games?offset=2&limit=3')).res.status, 200);
  await request(`/api/replays/games/${GAME}/hands?limit=10`);
  await request(`/api/replays/games/${GAME}/hands/1`);
  assert.deepEqual(calls, [['listGames', { offset: 2, limit: 3 }], ['listHands', GAME, { offset: 0, limit: 10 }], ['readHand', GAME, 1]]);
});
test('authentication, origin and lifecycle checks precede library access', async t => {
  let hooks = 0;
  const { calls, request } = await fixture(t, { beforeRequest: () => { hooks++; } });
  for (const token of ['', 'app-secret', 'participant-secret']) assert.equal((await request('/api/replays/games', { headers: { 'x-drill-token': token } })).res.status, 401);
  assert.equal((await request('/api/replays/games', { headers: { origin: 'http://evil.test' } })).res.status, 403);
  assert.equal(calls.length, 0); assert.equal(hooks, 0);
  await request('/api/replays/games'); assert.equal(hooks, 1); assert.equal(calls.length, 1);
});
test('invalid paths/queries/methods never reach the reader', async t => {
  const { calls, request } = await fixture(t);
  for (const pathname of ['/api/replays/games?offset=-1', '/api/replays/games?limit=51', '/api/replays/games?offset=1&offset=2', '/api/replays/games?extra=1', `/api/replays/games/${GAME}/hands?limit=101`, `/api/replays/games/${GAME}/hands/01`, `/api/replays/games/${GAME}/hands/1?offset=0`, '/api/replays/games/not-a-uuid/hands', `/api/replays/games/${GAME}/hands/1%2f2`]) {
    const result = await request(pathname); assert.equal(result.res.status, 400, pathname); assert.equal(result.body.code, 'REPLAY_BAD_REQUEST');
  }
  assert.equal((await request('/api/replays/games', { method: 'POST' })).res.status, 404);
  assert.equal(calls.length, 0);
});
test('library error codes map to safe errors with no path disclosure', async t => {
  const statuses = { REPLAY_BAD_REQUEST: 400, REPLAY_NOT_FOUND: 404, REPLAY_NOT_COMPLETED: 409, REPLAY_UNAVAILABLE: 422, REPLAY_UNSUPPORTED: 422, REPLAY_LIMIT_EXCEEDED: 413, REPLAY_BUSY: 429 };
  let code;
  const { request } = await fixture(t, { replayLibrary: { listGames: async () => { throw Object.assign(new Error('/private/secret'), { code }); } } });
  for (const [next, expected] of Object.entries(statuses)) {
    code = next; const { res, body } = await request('/api/replays/games'); assert.equal(res.status, expected); assert.deepEqual(body, { ok: false, code }); assert.equal(res.headers.get('cache-control'), 'no-store'); assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  }
});
test('old-handler seam removes replay capability, API and new assets', async t => {
  const { calls, request, handle } = await fixture(t, { replayEnabled: false });
  assert.equal((await request('/api/health')).body.capabilities.replayLibrary, undefined);
  assert.equal((await request('/api/replays/games')).res.status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${handle.port}/replay.html`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${handle.port}/drill.js`)).status, 200);
  assert.equal(calls.length, 0);
});
test('study replay assets include their recursive ES module closure', async t => {
  const {handle}=await fixture(t);
  const {scanModule}=await import('./helpers/module-scan.mjs');
  const origin=`http://127.0.0.1:${handle.port}`, seen=new Set();
  async function visit(pathname) {
    if(seen.has(pathname))return;seen.add(pathname);
    const response=await fetch(origin+pathname);assert.equal(response.status,200,pathname);
    const source=await response.text();
    if(!pathname.endsWith('.js'))return;
    assert.match(response.headers.get('content-type'),/javascript/);
    const scan=scanModule(source);assert.deepEqual(scan.unresolved,[],pathname);
    for(const item of scan.imports) {
      const spec=typeof item==='string'?item:item.specifier;
      assert.equal(typeof spec,'string',JSON.stringify(item));
      await visit(new URL(spec,origin+pathname).pathname);
    }
  }
  await visit('/replay.js');await visit('/replay.html');await visit('/replay.css');await visit('/public/replay.css');
});
test('real managed engine sessions are readable without changing any source bytes', async t => {
  const { createReplayGame, sourceSnapshot } = await import('./helpers/replay-library-fixture.mjs');
  const storeDir=createOwnedTempDir('replay-api-engine');
  const past=createReplayGame(storeDir,{hands:2});
  const active=createReplayGame(storeDir,{hands:1,ongoing:true});
  const before=sourceSnapshot(storeDir);
  const handle=await startDrillServer({storeDir,token:'engine-study'});t.after(()=>handle.close());
  const read=async pathname=>{
    const response=await fetch('http://127.0.0.1:'+handle.port+pathname,{headers:{'x-drill-token':'engine-study'}});
    const value=await response.json();return {status:response.status,value};
  };
  const list=await read('/api/replays/games');
  assert.equal(list.status,200);assert.equal(list.value.games.length,2);
  for(const game of [past,active]) {
    const page=await read('/api/replays/games/'+game.gameId+'/hands');
    assert.equal(page.status,200);assert.equal(page.value.hands.length,game===past?2:1);
    const hand=await read('/api/replays/games/'+game.gameId+'/hands/1');
    assert.equal(hand.status,200);assert.equal(hand.value.game.viewerId,'user');assert.equal(hand.value.replay.handNo,1);
    const {buildReplaySteps}=await import('../server/public/replay-model.js');assert.equal(buildReplaySteps(hand.value.replay).ok,true);
  }
  assert.equal((await read('/api/replays/games/'+active.gameId+'/hands/2')).status,409);
  assert.deepEqual(sourceSnapshot(storeDir),before);
});

test('failed lifecycle authorization hooks never call the replay reader', async t => {
  for(const hook of ['beforeRequest','onActivity']) {
    const {calls,request}=await fixture(t,{[hook]:()=>{throw new Error('/private/not-for-client');}});
    const result=await request('/api/replays/games');
    assert.equal(result.res.status,500);assert.deepEqual(result.body,{ok:false,code:'ERROR'});assert.equal(calls.length,0);
  }
});
test('reader DTO preserves live decision IDs, prices and fact seeds; invalid optional IDs keep normalized perspective parity', async t => {
  const {createReplayGame}=await import('./helpers/replay-library-fixture.mjs');
  const {createReplayLibrary}=await import('../tools/replay-library.js');
  const {replayRecord}=await import('../shared/hand-replay.js');
  const {buildReplaySteps}=await import('../server/public/replay-model.js');
  const {replayDecisionSnapshot,replayFactsLine}=await import('../server/public/replay-facts.js');
  const {formatReplay}=await import('../server/public/replay-format.js');
  const {createProjector}=await import('../server/public/replay-perspective.js');
  const fs=await import('node:fs');
  const store=createOwnedTempDir('replay-facts-parity'),game=createReplayGame(store,{aiCount:2,hands:1});
  const lib=createReplayLibrary(store), detail=await lib.readHand(game.gameId,1);
  const live=replayRecord(game.state.lastHand,{reveal:'all',humanIds:['user']});
  const fullModel=buildReplaySteps(live), libraryModel=buildReplaySteps(detail.replay);
  assert.equal(fullModel.ok,true);assert.equal(libraryModel.ok,true);
  const own=libraryModel.steps.filter(step=>step.kind==='action' && step.actor==='user');assert.ok(own.length>0);
  for(const step of own) {
    const a=replayDecisionSnapshot(fullModel,live,'user',step.index),b=replayDecisionSnapshot(libraryModel,detail.replay,'user',step.index);
    for(const key of ['decisionId','potBefore','toCall'])assert.equal(b[key],a[key],key);
    assert.equal(replayFactsLine(fullModel,live,'user',step.index),replayFactsLine(libraryModel,detail.replay,'user',step.index));
  }
  const raw=JSON.parse(fs.readFileSync(game.handPath(1),'utf8'));raw.decisions.find(d=>d.actorId==='user').decisionId={invalid:true};fs.writeFileSync(game.handPath(1),JSON.stringify(raw));
  const normalized=(await lib.readHand(game.gameId,1)).replay,model=buildReplaySteps(normalized),view=formatReplay(normalized,{feedback:'omit'});
  const project=perspective=>createProjector({perspective,replay:normalized,model,view,viewer:'user'});
  const fmt={amount:String,short:String};
  for(const step of own) {
    const facts=p=>p.at(step.index,fmt).details.filter(row=>row.className==='replay-facts');
    assert.deepEqual(facts(project('own')),facts(project('full')));
  }
  assert.match(replayDecisionSnapshot(model,normalized,'user',own[0].index).decisionId,/^replay-/);
});

test('historical human roster survives committed elimination, leave and credential reissue', async t => {
  const {createRoomManager}=await import('../tools/room-manager.js');
  const {createReplayGame,sourceSnapshot}=await import('./helpers/replay-library-fixture.mjs');
  const {createReplayLibrary}=await import('../tools/replay-library.js');
  const storeDir=createOwnedTempDir('replay-roster-history'),room=createRoomManager({storeDir});
  room.open({totalSeats:3});
  const joined=room.join({code:room.load().joinCode,name:'기록 참가자',addr:'fixture'});
  room.lockForStart({requestId:'historical'});
  const game=createReplayGame(storeDir,{mode:'tournament',aiCount:1,hands:1,participantAbsent:true,participants:[{playerId:'h1',participantId:joined.participantId,name:'기록 참가자'}]});
  room.bind(game.gameId,[{participantId:joined.participantId,playerId:'h1'}]);
  assert.equal(game.state.seats.find(seat=>seat.playerId==='h1').out,true);
  const library=createReplayLibrary(storeDir),before=await library.readHand(game.gameId,1),sources=sourceSnapshot(storeDir);
  room.leaveEliminated(joined.participantId);
  assert.throws(()=>room.authenticate(joined.participantToken),{code:'UNAUTHORIZED'});
  room.release(game.gameId);
  const rejoin=room.reissue(joined.participantId);
  assert.equal(room.authenticate(rejoin.token).playerId,'h1');
  assert.deepEqual(await library.readHand(game.gameId,1),before);
  assert.deepEqual(sourceSnapshot(storeDir),sources);
  assert.equal(before.game.seats.find(seat=>seat.playerId==='h1').kind,'human');
  assert.deepEqual(before.replay.holes.h1,['2c','7d']); // committed showdown cards remain public
});
