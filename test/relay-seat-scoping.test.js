import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, publicSnapshot, projectForSeat } from '../server/server.js';
import { HOST_ID } from '../publish-contract.js';
import { createSessionControl, withActionGate } from '../tools/session-control.js';
import { createOwnedTempDir, registerOwnedServer } from './helpers/owned-fixtures.mjs';
import { writeSecurityFixtures } from './helpers/security-fixtures.js';
import { createGame, startHand } from '../engine/hand.js';
import { newDeck } from '../engine/cards.js';
import { viewFor } from '../engine/views.js';
import { gameEpochOf } from '../publish-contract.js';
import { saveState, writeJsonAtomic } from '../engine/state.js';

const TOKEN = 'seat-scope-token';

function people() {
  return [{ playerId: 'h1', name: '민준', participantId: 'part-1' }];
}

test('projectForSeat: 참가자는 호스트 채널 키가 없고 호스트는 views를 제거한다', () => {
  const payload = {
    view: { viewer: 'user', myCards: ['As', 'Kd'] },
    views: {
      user: { viewer: 'user', myCards: ['As', 'Kd'] },
      h1: { viewer: 'h1', myCards: ['7h', '2c'] },
    },
    events: [{ type: 'action' }],
    messages: [{ type: 'narration', code: 'RESYNC', params: {} }],
    coach: [{ handNo: 1, text: 'secret' }],
    training: [{ handNo: 1, reason: 'x' }],
    trainingAnnotations: [],
    handReplays: [],
    review: 'review',
    hint: { status: 'supported' },
    studyUrl: 'http://127.0.0.1:1/#token=ab',
    turnDeadline: { decisionId: 'd-1-preflop-0', at: '2026-01-01T00:00:00.000Z' },
  };
  const host = projectForSeat(payload, HOST_ID);
  assert.equal('views' in host, false);
  assert.equal('coach' in host, true);
  const guest = projectForSeat(payload, 'h1');
  assert.deepEqual(Object.keys(guest).sort(), ['events', 'messages', 'turnDeadline', 'view']);
  assert.deepEqual(guest.view.myCards, ['7h', '2c']);
  for (const key of ['coach', 'training', 'trainingAnnotations', 'handReplays', 'review', 'hint', 'views', 'studyUrl']) {
    assert.equal(key in guest, false, key);
  }
  const empty = projectForSeat({ coach: [{ text: 'only' }] }, 'h1');
  assert.deepEqual(empty, {});
});

test('closeDecision은 playing에서만 기록하고 pausing이면 건너뛴다', () => {
  const dir = createOwnedTempDir('holdem-close-decision');
  const epoch = 'ab'.repeat(32);
  const playing = createSessionControl(dir, epoch);
  assert.deepEqual(playing.closeDecision('d-1-preflop-0'), { closed: true });
  assert.equal(playing.read().closedDecisionId, 'd-1-preflop-0');
  playing.set('pausing');
  assert.equal(playing.read().closedDecisionId, null);
  const pausedDir = createOwnedTempDir('holdem-close-paused');
  const pausing = createSessionControl(pausedDir, epoch, { startPaused: true });
  assert.deepEqual(pausing.closeDecision('d-1-preflop-0'), { closed: false });
  assert.equal(pausing.read().closedDecisionId, undefined);
  assert.throws(
    () => withActionGate(dir, epoch, () => {}, { decisionId: 'd-1-preflop-0' }),
    { code: 'GAME_PAUSED' },
  );
});

test('DECISION_CLOSED는 같은 결정만 거부한다', () => {
  const dir = createOwnedTempDir('holdem-closed-gate');
  const epoch = gameEpochOf(TOKEN);
  const control = createSessionControl(dir, epoch);
  control.closeDecision('d-1-preflop-0');
  assert.throws(
    () => withActionGate(dir, epoch, () => 'ok', { decisionId: 'd-1-preflop-0' }),
    { code: 'DECISION_CLOSED' },
  );
  assert.equal(withActionGate(dir, epoch, () => 'ok', { decisionId: 'd-1-preflop-1' }), 'ok');
});

async function multiRelay(t) {
  const dir = createOwnedTempDir('holdem-relay-multi');
  const state = createGame({
    aiCount: 1,
    participants: people(),
    hostName: '호스트',
    names: ['AI'],
  });
  state.button = state.seats.length - 1;
  const started = startHand(state, { deck: [...newDeck()] }).state;
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'players.json'), [
    { playerId: 'user', seat: 0, name: '호스트', kind: 'human' },
    { playerId: 'h1', seat: 1, name: '민준', kind: 'human', participantId: 'part-1' },
    { playerId: 'p1', seat: 2, name: 'AI', kind: 'ai' },
  ]);
  saveState(dir, started);
  const relay = await startServer({ gameDir: dir, port: 0, token: TOKEN, controlProtocolVersion: 1 });
  registerOwnedServer(relay.server, 'relay-multi');
  t.after(async () => { if (relay.server.listening) await relay.close(); });
  const http = async (pathname, { method = 'GET', body, seat, headers = {} } = {}) => {
    const url = new URL(pathname, `http://127.0.0.1:${relay.port}`);
    url.searchParams.set('token', TOKEN);
    const response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(seat ? { 'x-seat': seat } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json = null;
    try { json = await response.json(); } catch { /* empty */ }
    return { status: response.status, json };
  };
  return { dir, relay, state: started, http };
}

test('참가자 있는 세션의 step 게시에서 views 없으면 VIEWS_REQUIRED', async (t) => {
  const f = await multiRelay(t);
  const published = await f.http('/api/publish', {
    method: 'POST',
    body: { token: TOKEN, publishId: 1, view: { handNo: 1, viewer: 'user' }, viewFor: 'user' },
  });
  assert.equal(published.status, 400);
  assert.equal(published.json.code, 'VIEWS_REQUIRED');
});

test('x-seat 위조와 참가자 note와 NOT_YOUR_TURN', async (t) => {
  const f = await multiRelay(t);
  assert.equal((await f.http('/api/snapshot', { seat: 'p1' })).status, 400);
  assert.equal((await f.http('/api/snapshot', { seat: 'h9' })).json.code, 'BAD_SEAT');
  const action = await f.http('/api/action', {
    method: 'POST',
    seat: 'h1',
    body: { token: TOKEN, decisionId: 'd-1-preflop-0', action: 'call', note: 'secret' },
  });
  assert.equal(action.status, 400);
  assert.equal(action.json.code, 'BAD_ACTION');
});

test('ui-snapshot history에는 views가 없고 구 형식은 user view로 복원된다', async (t) => {
  const dir = createOwnedTempDir('holdem-snapshot-views');
  writeSecurityFixtures(dir, { state: { sessionToken: TOKEN } });
  const snapPath = path.join(dir, 'ui-snapshot.json');
  fs.writeFileSync(snapPath, JSON.stringify({
    revision: 1,
    view: { handNo: 1, toAct: 'user', legal: { decisionId: 'd-1-preflop-0', toAct: 'user' } },
    views: { h1: { myCards: ['As', 'Ah'] }, user: { myCards: ['Kd', 'Kc'] } },
    log: [],
    coach: [],
    history: [{ revision: 1, at: 't', payload: { view: { handNo: 1 }, views: { h1: { myCards: ['As', 'Ah'] } } } }],
  }));
  const { loadUiState } = await import('../server/server.js');
  const loaded = loadUiState(dir, TOKEN);
  assert.equal('h1' in (loaded.views ?? {}), false);
  assert.equal(loaded.views.user.handNo, 1);
  assert.equal(loaded.decision.decisionId, 'd-1-preflop-0');
  assert.equal('views' in loaded.history[0].payload, false);
  assert.equal(JSON.stringify(loaded).includes('As'), false);
  const projected = publicSnapshot(loaded, null, 'h1');
  assert.equal('coach' in projected, false);
  assert.equal('studyUrl' in projected, false);
});

test('게시 후 디스크 ui-snapshot에는 views 키와 참가자 홀이 없다', async (t) => {
  const f = await multiRelay(t);
  const engine = JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8'));
  engine.sessionToken = TOKEN;
  saveState(f.dir, engine);
  const views = { user: viewFor(engine, 'user'), h1: viewFor(engine, 'h1') };
  const published = await f.http('/api/publish', {
    method: 'POST',
    body: {
      token: TOKEN,
      publishId: 1,
      view: views.user,
      views,
      viewFor: 'user',
      events: [],
    },
  });
  assert.equal(published.status, 200, JSON.stringify(published.json));
  const raw = JSON.parse(fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'), 'utf8'));
  assert.equal('views' in raw, false);
  assert.equal((raw.history ?? []).some((row) => row.payload && 'views' in row.payload), false);
  const blob = JSON.stringify(raw);
  for (const card of views.h1.myCards) {
    // Card values must be absent; the card-free epoch digest may contain "2c".
    assert.equal(blob.includes(JSON.stringify(card)), false, card);
  }
});
