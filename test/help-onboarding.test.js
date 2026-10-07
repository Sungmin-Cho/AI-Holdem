import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMiniDocument } from './helpers/mini-dom.js';
import { readDisplaySettings, saveDisplaySetting, applyDisplaySettings, replayOnboarding, currentDisplaySettings, followStoredChoice, openDisplaySettings, DISPLAY_KEYS } from '../server/public/display-settings.js';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDialogController } from '../server/public/dialog-controller.js';
import { createOnboarding, ONBOARDING_STEPS, PARTICIPANT_ONBOARDING_STEPS } from '../server/public/onboarding.js';

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
  assert.deepEqual(readDisplaySettings(brokenStorage), { theme: 'b', unit: 'bb', deck: '4', motion: 'system', aid: 'on', hud: 'on' });
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
  // The decision aid and the HUD are on unless turned off; off is the only stored value.
  saveDisplaySetting('aid', 'off', { doc, storage });
  assert.equal(storage.getItem(DISPLAY_KEYS.aid), 'off');
  assert.equal(events.at(-1).type, 'holdem:display-learning');
  saveDisplaySetting('hud', 'off', { doc, storage });
  assert.deepEqual([readDisplaySettings(storage).aid, readDisplaySettings(storage).hud], ['off', 'off']);
  saveDisplaySetting('aid', 'on', { doc, storage });
  assert.equal(storage.getItem(DISPLAY_KEYS.aid), null);
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
  assert.deepEqual(currentDisplaySettings({ doc, storage: brokenStorage }), { theme: 'c', unit: 'chips', deck: '2', motion: 'system', aid: 'on', hud: 'on' });
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
  doc.helpDialog = { localName: 'dialog', inert: false };
  doc.sidePanel = { localName: 'aside', inert: false };
  doc.body.children = [doc.sidePanel, doc.helpDialog];
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

test('a shown guide steps aside for a later timed turn and comes back at the same step', () => {
  const { side, seat, bar, onboarding } = guide(memoryStorage());
  onboarding.offer({ myTurn: true, deadline: false, seated: true });
  side.querySelector('.onboarding-next').click();
  assert.equal(onboarding.step, 1);
  assert.equal(onboarding.offer({ myTurn: true, deadline: true, seated: true }), false);
  assert.equal(onboarding.suspended, true);
  assert.equal(side.querySelector('.onboarding-card'), null, 'hidden during the timed turn');
  assert.equal(bar.classList.contains('onboarding-focus') || seat.classList.contains('onboarding-focus'), false, 'no outline either');
  assert.equal(onboarding.offer({ myTurn: true, deadline: true, seated: true }), false, 'stays hidden while the turn lasts');
  assert.equal(onboarding.offer({ myTurn: false, deadline: false, seated: true }), true, 'back in the wait');
  assert.equal(onboarding.step, 1);
  assert.match(side.querySelector('.onboarding-count').textContent, /2 \/ 3/);
  assert.ok(bar.classList.contains('onboarding-focus'));
});

test('stepping the guide with the keyboard keeps focus in it, and finishing returns focus', () => {
  const { doc, side, onboarding } = guide(memoryStorage());
  const action = doc.createElement('button');
  doc.body.append(action);
  action.focus();
  onboarding.offer({ myTurn: true, deadline: false, seated: true });
  assert.equal(doc.activeElement, action, 'offering never moves focus');
  side.querySelector('.onboarding-next').focus();
  side.querySelector('.onboarding-next').click();
  assert.equal(doc.activeElement, side.querySelector('.onboarding-next'), 'focus moves to the new step');
  side.querySelector('.onboarding-next').click();
  side.querySelector('.onboarding-next').click();
  assert.equal(onboarding.active, false);
  assert.equal(doc.activeElement, action, 'finishing from the card returns focus to where it was');
  // A pointer click (focus elsewhere) leaves focus alone.
  const pointer = guide(memoryStorage());
  const other = pointer.doc.createElement('button');
  pointer.doc.body.append(other);
  pointer.onboarding.offer({ myTurn: true, deadline: false, seated: true });
  other.focus();
  pointer.side.querySelector('.onboarding-next').click();
  assert.equal(pointer.doc.activeElement, other);
});

test('opening a table overlay never makes a native dialog inert', () => {
  const { doc, overlay } = fakeDialogDocument();
  const dialogs = createDialogController(doc);
  dialogs.open(overlay, () => {});
  assert.equal(doc.sidePanel.inert, true);
  assert.equal(doc.helpDialog.inert, false, 'a help drawer reopened above the overlay stays usable');
  dialogs.close();
  assert.equal(doc.sidePanel.inert, false);
});

test('a choice saved in another document replaces this page\'s unsaved one; unrelated keys do not', () => {
  const doc = createMiniDocument();
  withWindow(doc);
  saveDisplaySetting('theme', 'c', { doc, storage: brokenStorage });
  saveDisplaySetting('deck', '2', { doc, storage: brokenStorage });
  assert.equal(doc.documentElement.getAttribute('data-display-local'), 'theme deck');
  assert.equal(followStoredChoice('holdem.onboarding.v1', { doc }), false);
  assert.equal(currentDisplaySettings({ doc, storage: brokenStorage }).theme, 'c');
  assert.equal(followStoredChoice(DISPLAY_KEYS.theme, { doc }), true);
  assert.equal(currentDisplaySettings({ doc, storage: brokenStorage }).theme, 'b');
  assert.equal(doc.documentElement.getAttribute('data-display-local'), 'deck');
});

test('theme boot repaints only the item another document saved and leaves unsaved choices', () => {
  const attrs = new Map();
  const root = { getAttribute: (k) => attrs.get(k) ?? null, setAttribute: (k, v) => attrs.set(k, String(v)), removeAttribute: (k) => attrs.delete(k) };
  const stored = new Map([['holdem.theme.v1', 'a'], ['holdem.deck-colors.v1', '2']]);
  let onStorage = null;
  const context = { document: { documentElement: root }, localStorage: { getItem: (k) => stored.get(k) ?? null },
    addEventListener: (type, handler) => { if (type === 'storage') onStorage = handler; } };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(new URL('../server/public/theme-boot.js', import.meta.url), 'utf8'), context);
  assert.equal(attrs.get('data-theme'), 'a');
  assert.equal(attrs.get('data-deck'), '2');
  // This page then chose (but could not save) theme C and a two-colour deck is stored.
  attrs.set('data-theme', 'c');
  attrs.set('data-display-local', 'theme');
  onStorage({ key: 'holdem.onboarding.v1' });
  assert.equal(attrs.get('data-theme'), 'c', 'an unrelated key leaves the page alone');
  onStorage({ key: null });
  assert.equal(attrs.get('data-theme'), 'c', 'a storage clear skips the unsaved choice');
  stored.set('holdem.theme.v1', 'a');
  onStorage({ key: 'holdem.theme.v1' });
  assert.equal(attrs.get('data-theme'), 'a', 'a theme saved elsewhere replaces the unsaved one');
  assert.equal(attrs.has('data-display-local'), false);
});

test('a timed turn hides the guide and moves focus that was in it to the action bar', () => {
  const { doc, side, bar, onboarding } = guide(memoryStorage());
  const call = doc.createElement('button');
  const disabled = doc.createElement('button');
  disabled.disabled = true;
  // Hidden by CSS (the desktop options toggle): no boxes, cannot take focus.
  const cssHidden = doc.createElement('button');
  cssHidden.getClientRects = () => [];
  bar.append(cssHidden, disabled, call);
  onboarding.offer({ myTurn: true, deadline: false, seated: true });
  side.querySelector('.onboarding-next').focus();
  onboarding.offer({ myTurn: true, deadline: true, seated: true });
  assert.equal(onboarding.suspended, true);
  assert.equal(doc.activeElement, call, 'focus goes to the first live action button');
  // Back in the wait, the guide returns without taking focus from where the user is.
  onboarding.offer({ myTurn: false, deadline: false, seated: true });
  assert.equal(doc.activeElement, call);
  // Focus elsewhere when the timed turn starts: it stays there.
  const other = guide(memoryStorage());
  const button = other.doc.createElement('button');
  other.doc.body.append(button);
  other.onboarding.offer({ myTurn: true, deadline: false, seated: true });
  button.focus();
  other.onboarding.offer({ myTurn: true, deadline: true, seated: true });
  assert.equal(other.doc.activeElement, button);
});

function dialogDocument(noOnboarding) {
  const doc = createMiniDocument();
  withWindow(doc);
  doc.getElementById = () => null;
  const create = doc.createElement;
  doc.createElement = (tag) => {
    const node = create(tag);
    if (tag === 'dialog') { node.showModal = () => { node.open = true; }; node.close = () => { node.open = false; }; }
    return node;
  };
  if (noOnboarding) doc.body.setAttribute('data-no-onboarding', '');
  return doc;
}

test('the study room (another origin, no table) does not offer the guide replay', () => {
  const table = openDisplaySettings({ doc: dialogDocument(false), storage: memoryStorage() });
  assert.ok(table.querySelector('.display-onboarding'), 'pages with the table offer it');
  const study = openDisplaySettings({ doc: dialogDocument(true), storage: memoryStorage() });
  assert.equal(study.querySelector('.display-onboarding'), null);
});

test('participants get a guide that names only what their table has', () => {
  const text = PARTICIPANT_ONBOARDING_STEPS.map((step) => `${step.title} ${step.text}`).join(' ');
  assert.doesNotMatch(text, /코치|학습|메모|일시정지/);
  assert.deepEqual(PARTICIPANT_ONBOARDING_STEPS.map((step) => step.target), ONBOARDING_STEPS.map((step) => step.target));
  const side = createMiniDocument().createElement('aside');
  const doc = side.ownerDocument;
  const onboarding = createOnboarding({ doc, storage: memoryStorage(), container: () => side, steps: PARTICIPANT_ONBOARDING_STEPS, targets: { seat: () => null, actions: () => null, side: () => null } });
  onboarding.offer({ myTurn: true, deadline: false, seated: true });
  side.querySelector('.onboarding-next').click();
  side.querySelector('.onboarding-next').click();
  assert.equal(side.querySelector('.onboarding-title').textContent, '로그와 참가자');
});

test('a guide on screen steps aside when the viewer leaves the table', () => {
  const { side, onboarding } = guide(memoryStorage());
  onboarding.offer({ myTurn: true, deadline: false, seated: true });
  assert.ok(side.querySelector('.onboarding-card'));
  assert.equal(onboarding.offer({ myTurn: false, deadline: false, seated: false }), false);
  assert.equal(side.querySelector('.onboarding-card'), null, 'out or game over: hidden');
  assert.equal(onboarding.suspended, true);
  assert.equal(onboarding.offer({ myTurn: false, deadline: false, seated: true }), true, 'back at a seat: shown again');
});
