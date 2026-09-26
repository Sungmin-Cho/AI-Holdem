import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMiniDocument } from './helpers/mini-dom.js';
import { readDisplaySettings, saveDisplaySetting, applyDisplaySettings, replayOnboarding, DISPLAY_KEYS } from '../server/public/display-settings.js';
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
