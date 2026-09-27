import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShellEmbed } from '../server/public/shell-embed.js';
import { createShellBridge } from '../server/public/shell-bridge.js';

const ORIGIN = 'http://127.0.0.1:4000';
const GAME = { gameId: '0b3c2d6e-1111-4222-8333-944455556666', gameEpoch: 'ab'.repeat(32) };

function setup({ embedded = true, identity = GAME } = {}) {
  const posted = [];
  const listeners = new Map();
  const timers = [];
  const parent = { postMessage(message, origin) { posted.push({ message, origin }); } };
  const win = {
    location: { origin: ORIGIN },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  win.parent = embedded ? parent : win;
  let readyCalls = 0;
  const embed = createShellEmbed({
    win, ...identity, onReady: () => { readyCalls += 1; },
    schedule: (fn) => { timers.push(fn); return timers.length; }, cancel: () => {},
  });
  const deliver = (data, { origin = ORIGIN, source = parent } = {}) => listeners.get('message')?.({ data, origin, source });
  const runTimers = () => { while (timers.length) timers.shift()(); };
  return { embed, posted, deliver, runTimers, parent, readyCalls: () => readyCalls };
}
const context = { handNo: 7, handLimit: 20, blinds: [25, 50], sessionNet: -1250, conn: 'on', retryCount: 0, gameOver: false, handInProgress: true, mode: 'cash-training' };

test('an embedded table says hello with its own game and stays standalone until the parent answers', () => {
  const { embed, posted, runTimers, readyCalls } = setup();
  assert.deepEqual(posted, [{ message: { type: 'holdem:shell-hello', v: 1, ...GAME }, origin: ORIGIN }]);
  embed.send(context);
  runTimers();
  assert.equal(posted.length, 1, 'no context before the handshake');
  assert.equal(readyCalls(), 0);
  assert.equal(embed.ready, false);
});

test('only a same-origin shell-ready from the parent for this game completes the handshake', () => {
  const { embed, deliver, readyCalls } = setup();
  const ready = { type: 'holdem:shell-ready', v: 1, ...GAME };
  deliver(ready, { origin: 'http://evil.example' });
  deliver(ready, { source: {} });
  deliver({ ...ready, gameEpoch: 'cd'.repeat(32) });
  deliver({ ...ready, v: 2 });
  deliver('holdem:shell-ready');
  assert.equal(readyCalls(), 0);
  deliver(ready);
  deliver(ready);
  assert.equal(readyCalls(), 1);
  assert.equal(embed.ready, true);
});

test('after the handshake context is sent to this origin, throttled and only when it changes', () => {
  const { embed, posted, deliver, runTimers } = setup();
  embed.send(context);
  deliver({ type: 'holdem:shell-ready', v: 1, ...GAME });
  assert.deepEqual(posted.at(-1), { message: { type: 'holdem:context', v: 1, ...GAME, ...context }, origin: ORIGIN });
  embed.send({ ...context });
  runTimers();
  assert.equal(posted.length, 2, 'unchanged context is not resent');
  embed.send({ ...context, handNo: 8 });
  embed.send({ ...context, handNo: 9, holeCards: ['As', 'Kd'], token: 'x' });
  runTimers();
  assert.equal(posted.length, 3, 'bursts collapse to the latest context');
  assert.equal(posted.at(-1).message.handNo, 9);
  assert.equal('holeCards' in posted.at(-1).message, false);
  assert.equal('token' in posted.at(-1).message, false);
});

test('a standalone table (no parent) never posts or hides its bar', () => {
  const { embed, posted, readyCalls } = setup({ embedded: false });
  embed.send(context);
  assert.equal(embed.embedded, false);
  assert.deepEqual(posted, []);
  assert.equal(readyCalls(), 0);
  const noIdentity = setup({ identity: { gameId: null, gameEpoch: null } });
  assert.deepEqual(noIdentity.posted, []);
});

test('the embed and the parent bridge agree end to end', () => {
  const listeners = { parent: new Map(), child: new Map() };
  const make = (side) => ({ location: { origin: ORIGIN }, addEventListener: (type, fn) => listeners[side].set(type, fn), removeEventListener: () => {} });
  const parentWin = make('parent');
  const childWin = make('child');
  // In a browser the parent's WindowProxy is the child's `window.parent`, and the
  // child's WindowProxy is the frame's `contentWindow`.
  parentWin.postMessage = (data, origin) => listeners.parent.get('message')?.({ data, origin, source: childWin });
  childWin.postMessage = (data, origin) => listeners.child.get('message')?.({ data, origin, source: parentWin });
  childWin.parent = parentWin;
  parentWin.parent = parentWin;
  const frame = { addEventListener: () => {}, removeEventListener: () => {}, contentWindow: childWin };
  const seen = [];
  createShellBridge({ win: parentWin, frame, identity: () => GAME, onContext: (value) => seen.push(value) });
  let hidden = false;
  const embed = createShellEmbed({ win: childWin, ...GAME, onReady: () => { hidden = true; }, schedule: (fn) => { fn(); return 1; } });
  embed.send(context);
  assert.equal(hidden, true, 'hello → shell-ready → embedded');
  assert.equal(seen.at(-1)?.handNo, 7);
  assert.equal(seen.at(-1)?.sessionNet, -1250);
});
