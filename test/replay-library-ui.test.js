import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplaySelection, readReplayEntry, startReplayHeartbeat } from '../server/drill-public/replay-library-state.js';
import { replayEntryState } from '../server/drill-public/drill.js';

test('late hand responses and errors cannot replace new selection, and old player disposes immediately', async () => {
  const pending = [], states = []; let disposed = 0;
  const selection = createReplaySelection({ api: (path, {signal}) => new Promise((resolve,reject) => pending.push({path,signal,resolve,reject})), onState: value => states.push(value), disposePlayer: () => disposed++ });
  const old = selection.hand('game-a', 1), next = selection.hand('game-b', 1);
  assert.equal(pending[0].signal.aborted, true); assert.equal(disposed, 2);
  pending[1].resolve({ok:true, revision:'b'}); await next;
  pending[0].resolve({ok:true, revision:'a'}); await old;
  assert.equal(selection.state().gameId, 'game-b'); assert.equal(selection.state().value.revision, 'b');
  const late = selection.hand('game-a',2); selection.dispose(); pending[2].reject(new Error('late')); await late;
  assert.equal(states.at(-1).kind, 'loading'); assert.equal(disposed, 4);
});
test('replay entry removes legacy query token and uses fragment for round trip', () => {
  const result = readReplayEntry({href:'http://127.0.0.1:123/replay.html?token=secret&x=1'});
  assert.equal(new URL(result.cleanUrl).searchParams.has('token'),false);
  assert.equal(result.studyUrl,'/drill.html#token=secret');
  assert.equal(readReplayEntry({href:'http://localhost/replay.html?token=old#token=new'}).token,'new');
});
test('old service capability never enables replay navigation and requires stop then reopen', () => {
  assert.equal(replayEntryState({ok:true,capabilities:{study:true}},'secret').href,undefined);
  assert.match(replayEntryState({ok:true},'secret').message,/종료한 뒤 다시/);
  assert.equal(replayEntryState(null,'secret').retry,true);
  assert.equal(replayEntryState({ok:true,capabilities:{replayLibrary:1}},'secret').href,'/replay.html#token=secret');
});
test('heartbeat skips hidden pages, serializes requests and disposes timer', async () => {
  let tick, active=true, calls=0, stopped=false, resolve;
  const stop = startReplayHeartbeat({ api: () => {calls++;return new Promise(r=>resolve=r);}, visible:()=>active, setInterval:(fn,ms)=>{tick=fn;assert.equal(ms,30000);return 9;}, clearInterval:id=>{assert.equal(id,9);stopped=true;} });
  active=false; await tick(); assert.equal(calls,0);
  active=true;const first=tick();await tick();assert.equal(calls,1);resolve({ok:true});await first;
  stop();await tick();assert.equal(calls,1);assert.equal(stopped,true);
});

test('portable abort composition works without AbortSignal.any and removes listeners', async () => {
  const {createAbortScope}=await import('../server/drill-public/replay-library-state.js');
  const a=new AbortController(), b=new AbortController();
  const scope=createAbortScope([a.signal,b.signal]);assert.equal(scope.signal.aborted,false);
  b.abort();assert.equal(scope.signal.aborted,true);scope.dispose();
  const c=new AbortController(), done=createAbortScope([c.signal]);done.dispose();c.abort();assert.equal(done.signal.aborted,false);
  assert.equal(createAbortScope([a.signal,b.signal]).signal.aborted,true);
});
test('explicit smaller-page retry preserves its limit through list and hand navigation', async () => {
  const paths=[];const selection=createReplaySelection({api:async(path)=>{paths.push(path);return {ok:true};}});
  await selection.games(0,12);assert.equal(selection.state().limit,12);
  await selection.hands('g',0,20);assert.equal(selection.state().limit,20);
  await selection.hand('g',1,0,20);assert.equal(selection.state().limit,20);
  assert.deepEqual(paths,['/api/replays/games?offset=0&limit=12','/api/replays/games/g/hands?offset=0&limit=20','/api/replays/games/g/hands/1']);
});
