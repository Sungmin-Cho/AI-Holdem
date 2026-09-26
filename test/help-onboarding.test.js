import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMiniDocument } from './helpers/mini-dom.js';
import { readDisplaySettings, saveDisplaySetting, applyDisplaySettings, replayOnboarding, currentDisplaySettings, DISPLAY_KEYS } from '../server/public/display-settings.js';
import { createDialogController } from '../server/public/dialog-controller.js';
import { createOnboarding, ONBOARDING_STEPS } from '../server/public/onboarding.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    data,
  };
}
const brokenStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };

function withWindow(doc) {
  const events = [];
  doc.documentElement = doc.createElement('html');
  doc.defaultView = { dispatchEvent: (event) => events.push(event) };
  return events;
}

test('display settings default safely, save per browser and apply to this document', () => {
  assert.deepEqual(readDisplaySettings(brokenStorage), { theme: 'b', unit: 'bb', deck: '4', motion: 'system' });
  const doc = createMiniDocument();
  const events = withWindow(doc);
  const storage = memoryStorage();
  assert.equal(saveDisplaySetting('theme', 'c', { doc, storage }), true);
  assert.equal(storage.getItem(DISPLAY_KEYS.theme), 'c');
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'c');
  saveDisplaySetting('deck', '2', { doc, storage });
  saveDisplaySetting('motion', 'reduce', { doc, storage });
  assert.equal(doc.documentElement.getAttribute('data-deck'), '2');
  assert.equal(doc.documentElement.getAttribute('data-motion'), 'reduce');
  saveDisplaySetting('theme', 'b', { doc, storage });
  assert.equal(storage.getItem(DISPLAY_KEYS.theme), null, 'the default theme is stored as no choice');
  assert.equal(doc.documentElement.getAttribute('data-theme'), null);
  saveDisplaySetting('unit', 'chips', { doc, storage });
  assert.equal(readDisplaySettings(storage).unit, 'chips');
  assert.equal(events.at(-1).type, 'holdem:display-unit', 'same-document listeners repaint amounts');
});

test('when storage refuses, a choice still applies to this page', () => {
  const doc = createMiniDocument();
  withWindow(doc);
  assert.equal(saveDisplaySetting('theme', 'a', { doc, storage: brokenStorage }), false);
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'a');
  applyDisplaySettings(doc, { theme: 'b', deck: '4', motion: 'system' });
  assert.equal(doc.documentElement.getAttribute('data-theme'), null);
});

function guide(storage) {
  const doc = createMiniDocument();
  const side = doc.createElement('aside');
  const seat = doc.createElement('div');
  const bar = doc.createElement('div');
  const tabs = doc.createElement('div');
  doc.body.append(side, seat, bar, tabs);
  const onboarding = createOnboarding({ doc, storage, container: () => side, targets: { seat: () => seat, actions: () => bar, side: () => tabs } });
  return { doc, side, seat, bar, tabs, onboarding };
}

test('the first-turn guide waits for a deadline-free turn, never takes focus, and is seen once', () => {
  const storage = memoryStorage();
  const { doc, side, seat, bar, onboarding } = guide(storage);
  const action = doc.createElement('button');
  doc.body.append(action);
  action.focus();
  assert.equal(onboarding.offer({ myTurn: false, deadline: false }), false);
  assert.equal(onboarding.offer({ myTurn: true, deadline: true }), false, 'an online turn with a deadline is left alone');
  assert.equal(onboarding.offer({ myTurn: true, deadline: false }), true);
  assert.equal(doc.activeElement, action, 'focus stays on the action button');
  assert.ok(side.querySelector('.onboarding-card'), 'the card sits in the side panel');
  assert.ok(seat.classList.contains('onboarding-focus'));
  side.querySelector('.onboarding-next').click();
  assert.ok(bar.classList.contains('onboarding-focus'));
  assert.equal(seat.classList.contains('onboarding-focus'), false);
  for (let step = 1; step < ONBOARDING_STEPS.length; step += 1) side.querySelector('.onboarding-next').click();
  assert.equal(onboarding.active, false);
  assert.equal(side.querySelector('.onboarding-card'), null);
  assert.equal(storage.getItem('holdem.onboarding.v1'), 'done');
  assert.equal(onboarding.offer({ myTurn: true, deadline: false }), false, 'not again');
  const next = guide(storage);
  assert.equal(next.onboarding.offer({ myTurn: true, deadline: false }), false, 'not in a new page either');
});

test('skip ends the guide for good; without storage it shows once per page; replay brings it back', () => {
  const storage = memoryStorage();
  const { side, onboarding } = guide(storage);
  onboarding.offer({ myTurn: true, deadline: false });
  side.querySelector('.onboarding-skip').click();
  assert.equal(onboarding.active, false);
  assert.equal(storage.getItem('holdem.onboarding.v1'), 'done');
  onboarding.reset();
  assert.equal(onboarding.offer({ myTurn: true, deadline: false }), true, 'replayed from the display settings');
  const blind = guide(brokenStorage);
  assert.equal(blind.onboarding.offer({ myTurn: true, deadline: false }), true);
  blind.onboarding.skip();
  assert.equal(blind.onboarding.offer({ myTurn: true, deadline: false }), false, 'once per page without storage');
  const doc = createMiniDocument();
  const events = withWindow(doc);
  replayOnboarding({ doc, storage });
  assert.equal(storage.getItem('holdem.onboarding.v1'), null);
  assert.equal(events.at(-1).type, 'holdem:onboarding-reset');
});

test('without storage, each choice stays on this page and a later one does not undo an earlier one', () => {
  const doc = createMiniDocument();
  const events = withWindow(doc);
  assert.equal(saveDisplaySetting('theme', 'c', { doc, storage: brokenStorage }), false);
  assert.equal(saveDisplaySetting('deck', '2', { doc, storage: brokenStorage }), false);
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'c', 'the unsaved theme survives the next change');
  assert.equal(doc.documentElement.getAttribute('data-deck'), '2');
  saveDisplaySetting('unit', 'chips', { doc, storage: brokenStorage });
  assert.deepEqual(currentDisplaySettings({ doc, storage: brokenStorage }), { theme: 'c', unit: 'chips', deck: '2', motion: 'system' });
  assert.equal(events.at(-1).detail, 'chips');
  const other = createMiniDocument();
  withWindow(other);
  assert.equal(currentDisplaySettings({ doc: other, storage: brokenStorage }).theme, 'b', 'another page starts from its own state');
  // Once storage works again, a saved choice replaces the page-only one.
  const storage = memoryStorage();
  saveDisplaySetting('theme', 'a', { doc, storage });
  assert.equal(currentDisplaySettings({ doc, storage }).theme, 'a');
});

test('a first turn with a deadline defers the guide to the wait after it, only while seated', () => {
  const { onboarding } = guide(memoryStorage());
  assert.equal(onboarding.offer({ myTurn: false, deadline: false, seated: true }), false, 'nothing before a first turn');
  assert.equal(onboarding.offer({ myTurn: true, deadline: true, seated: true }), false, 'the timed turn is left alone');
  assert.equal(onboarding.offer({ myTurn: false, deadline: false, seated: false }), false, 'not once the viewer has left the table');
  assert.equal(onboarding.offer({ myTurn: false, deadline: false, seated: true }), true, 'shown in the wait after that turn');
  const again = guide(memoryStorage());
  again.onboarding.offer({ myTurn: true, deadline: true, seated: true });
  again.onboarding.reset();
  assert.equal(again.onboarding.offer({ myTurn: false, deadline: false, seated: true }), false, 'reset clears the deferral');
});

function fakeDialogDocument() {
  const listeners = [];
  const doc = { activeElement: null, openDialogs: [], body: { children: [] },
    addEventListener: (type, handler) => { if (type === 'keydown') listeners.push(handler); },
    querySelectorAll: (selector) => (selector === 'dialog[open]' ? doc.openDialogs : []),
    key(key, extra = {}) { const event = { key, shiftKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra }; for (const handler of listeners) handler(event); return event; } };
  const button = (name) => ({ name, hidden: false, getClientRects: () => [1], hasAttribute: () => false, matches: () => true, focus() { doc.activeElement = this; } });
  const first = button('first'), last = button('last');
  const overlay = { hidden: true, contains: (node) => node === first || node === last, querySelectorAll: () => [first, last], querySelector: () => null };
  return { doc, overlay, first, last };
}

test('the table dialog trap yields Tab and Esc to a native modal opened above it', () => {
  const { doc, overlay, first, last } = fakeDialogDocument();
  let dismissed = 0;
  const dialogs = createDialogController(doc);
  dialogs.open(overlay, () => { dismissed += 1; });
  assert.equal(doc.activeElement, first);
  doc.activeElement = last;
  assert.equal(doc.key('Tab').prevented, true, 'the trap wraps Tab inside the overlay');
  assert.equal(doc.activeElement, first);
  const help = { localName: 'dialog' };
  doc.openDialogs = [help];
  doc.activeElement = help;
  const tab = doc.key('Tab');
  assert.equal(tab.prevented, false, 'the help drawer keeps its own Tab order');
  assert.equal(doc.activeElement, help);
  doc.key('Escape');
  assert.equal(dismissed, 0, 'Esc closes the help drawer, not the replay under it');
  assert.equal(dialogs.active, overlay);
  doc.openDialogs = [];
  doc.key('Escape');
  assert.equal(dismissed, 1);
});
