import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShellBridge, sanitizeContext } from '../server/public/shell-bridge.js';

const ORIGIN = 'http://127.0.0.1:4000';
const GAME = { gameId: '0b3c2d6e-1111-4222-8333-944455556666', gameEpoch: 'ab'.repeat(32) };

function fakeWindow() {
  const listeners = new Map();
  const observers = [];
  return {
    location: { origin: ORIGIN },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    dispatch(type, event) { listeners.get(type)?.(event); },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; observers.push(this); }
      observe(node, options) { this.node = node; this.options = options; }
      disconnect() { this.disconnected = true; }
    },
    observers,
  };
}
function fakeFrame() {
  const posted = [];
  const listeners = new Map();
  const frame = {
    contentWindow: { postMessage(message, origin) { posted.push({ message, origin }); } },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    load() { listeners.get('load')?.(); },
    posted,
  };
  return frame;
}
const context = (extra = {}) => ({ type: 'holdem:context', v: 1, ...GAME, handNo: 7, handLimit: 20, blinds: [25, 50],
  sessionNet: -1250, conn: 'on', retryCount: 0, gameOver: false, handInProgress: true, mode: 'cash-training', ...extra });

function setup(identity = GAME) {
  const win = fakeWindow();
  const frame = fakeFrame();
  const seen = [];
  let current = identity;
  const bridge = createShellBridge({ win, frame, identity: () => current, onContext: (value) => seen.push(value) });
  return { win, frame, seen, bridge, setIdentity: (value) => { current = value; } };
}

test('every iframe load announces the parent with the selected game, to this origin only', () => {
  const { frame } = setup();
  frame.load();
  frame.load();
  assert.equal(frame.posted.length, 2);
  assert.deepEqual(frame.posted[0], { message: { type: 'holdem:shell-ready', v: 1, ...GAME }, origin: ORIGIN });
});

test('no announcement without a selected game', () => {
  const { frame } = setup(null);
  frame.load();
  assert.deepEqual(frame.posted, []);
});

test('contexts from another origin, another window, a bad schema or another game are ignored', () => {
  const { win, frame, seen } = setup();
  win.dispatch('message', { origin: 'http://evil.example', source: frame.contentWindow, data: context() });
  win.dispatch('message', { origin: ORIGIN, source: {}, data: context() });
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow, data: context({ v: 2 }) });
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow, data: context({ type: 'holdem:other' }) });
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow, data: context({ conn: 'maybe' }) });
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow, data: context({ gameId: 'f'.repeat(8) }) });
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow, data: context({ gameEpoch: 'cd'.repeat(32) }) });
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow, data: 'holdem:context' });
  assert.deepEqual(seen, []);
});

test('an accepted context keeps only allowlisted public fields', () => {
  const { win, frame, seen, bridge } = setup();
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow,
    data: context({ holeCards: ['As', 'Kd'], token: 'secret', decisionId: 'd-1', blinds: [25, 'x'] }) });
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['blinds', 'conn', 'gameEpoch', 'gameId', 'gameOver', 'handInProgress', 'handLimit',
    'handNo', 'level', 'levelLeft', 'mode', 'retryCount', 'sessionNet'].sort());
  assert.equal(seen[0].blinds, null, 'malformed optional fields become null, not partial values');
  assert.equal(bridge.context.handNo, 7);
  assert.doesNotMatch(JSON.stringify(seen), /secret|As|d-1/);
});

test('a new iframe source clears the header before any message from the next document', () => {
  const { win, frame, seen, bridge, setIdentity } = setup();
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow, data: context() });
  assert.equal(win.observers[0].options.attributeFilter[0], 'src');
  win.observers[0].fn();
  assert.equal(bridge.context, null);
  assert.equal(seen.at(-1), null);
  // A late message from the previous game is rejected once the selection moved on.
  setIdentity({ gameId: '1c3c2d6e-1111-4222-8333-944455556666', gameEpoch: 'ef'.repeat(32) });
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow, data: context() });
  assert.equal(bridge.context, null);
  frame.load();
  assert.equal(frame.posted.at(-1).message.gameEpoch, 'ef'.repeat(32));
});

test('a table that loaded before the parent listened can ask for the announcement of its own game only', () => {
  const { win, frame } = setup();
  const hello = { type: 'holdem:shell-hello', v: 1, ...GAME };
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow, data: hello });
  win.dispatch('message', { origin: 'http://evil.example', source: frame.contentWindow, data: hello });
  // The previous game's document (same WindowProxy after navigation) asks late.
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow, data: { ...hello, gameEpoch: 'cd'.repeat(32) } });
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow, data: { type: 'holdem:shell-hello', v: 1 } });
  assert.equal(frame.posted.length, 1);
});

test('sanitizeContext rejects non-objects and requires identity and connection state', () => {
  for (const bad of [null, [], 'x', 1, { type: 'holdem:context', v: 1 }, context({ gameEpoch: undefined })]) {
    assert.equal(sanitizeContext(bad), null);
  }
  assert.equal(sanitizeContext(context({ handNo: -1 })).handNo, null);
  assert.equal(sanitizeContext(context({ mode: 'weird' })).mode, null);
});

test('dispose detaches listeners and the observer', () => {
  const { win, frame, bridge, seen } = setup();
  bridge.dispose();
  win.dispatch('message', { origin: ORIGIN, source: frame.contentWindow, data: context() });
  assert.deepEqual(seen, []);
  assert.equal(win.observers[0].disconnected, true);
});
