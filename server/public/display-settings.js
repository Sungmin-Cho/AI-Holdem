/** Display settings (design §3.4): theme, amount unit, deck colours, motion,
 * and replaying the first-turn guide. Per browser only — localStorage behind
 * try/catch, defaults when storage is unavailable, nothing sent to a server.
 * Other documents of the same origin follow through `storage` events
 * (theme-boot.js, app.js, lobby.js); this document is updated directly. */
import { readPreference, writePreference } from './chip-format.js';

export const DISPLAY_KEYS = Object.freeze({
  theme: 'holdem.theme.v1',
  deck: 'holdem.deck-colors.v1',
  motion: 'holdem.motion.v1',
  onboarding: 'holdem.onboarding.v1',
});

const THEMES = Object.freeze([['b', '미드나잇 (기본)'], ['a', '클래식'], ['c', '페이퍼']]);
const NORMAL = Object.freeze({
  theme: (value) => (value === 'a' || value === 'c' ? value : 'b'),
  unit: (value) => (value === 'chips' ? 'chips' : 'bb'),
  deck: (value) => (value === '2' ? '2' : '4'),
  motion: (value) => (value === 'reduce' ? 'reduce' : 'system'),
});
// Choices this document could not save: they stay applied here, and a later
// change must not fall back to the stored (or default) value for them.
const pageChoices = new WeakMap();

function store(storage) { try { return storage ?? globalThis.localStorage ?? null; } catch { return null; } }
function read(storage, key) { try { return store(storage)?.getItem(key) ?? null; } catch { return null; } }
function write(storage, key, value) {
  try {
    const target = store(storage);
    if (!target) return false;
    if (value == null) target.removeItem(key); else target.setItem(key, value);
    return true;
  } catch { return false; }
}

/** The current choices, with defaults for anything unset or unreadable. */
export function readDisplaySettings(storage) {
  const theme = read(storage, DISPLAY_KEYS.theme);
  return {
    theme: theme === 'a' || theme === 'c' ? theme : 'b',
    unit: readPreference(store(storage) ?? undefined),
    deck: read(storage, DISPLAY_KEYS.deck) === '2' ? '2' : '4',
    motion: read(storage, DISPLAY_KEYS.motion) === 'reduce' ? 'reduce' : 'system',
  };
}

/** What this document shows: stored choices plus any this page could not save. */
export function currentDisplaySettings({ doc = globalThis.document, storage } = {}) {
  return { ...readDisplaySettings(storage), ...(doc ? pageChoices.get(doc) : null) };
}

/** Mirrors theme-boot.js for this document after a change. */
export function applyDisplaySettings(doc = globalThis.document, settings = readDisplaySettings()) {
  const root = doc.documentElement;
  const set = (name, value) => { if (value) root.setAttribute(name, value); else root.removeAttribute(name); };
  set('data-theme', settings.theme === 'b' ? null : settings.theme);
  set('data-deck', settings.deck === '2' ? '2' : null);
  set('data-motion', settings.motion === 'reduce' ? 'reduce' : null);
}

/** Saves one choice and applies it here; returns whether it was saved. */
export function saveDisplaySetting(name, value, { doc = globalThis.document, storage } = {}) {
  if (!Object.hasOwn(NORMAL, name)) return false;
  const choice = NORMAL[name](value);
  let saved;
  if (name === 'theme') saved = write(storage, DISPLAY_KEYS.theme, choice === 'b' ? null : choice);
  else if (name === 'deck') saved = write(storage, DISPLAY_KEYS.deck, choice === '2' ? '2' : null);
  else if (name === 'motion') saved = write(storage, DISPLAY_KEYS.motion, choice === 'reduce' ? 'reduce' : null);
  else saved = writePreference(choice, store(storage) ?? undefined);
  const choices = { ...pageChoices.get(doc) };
  if (saved) delete choices[name]; else choices[name] = choice;
  pageChoices.set(doc, choices);
  applyDisplaySettings(doc, currentDisplaySettings({ doc, storage }));
  // Same-document listeners (the lobby's header, the table) repaint amounts.
  if (name === 'unit') doc.defaultView?.dispatchEvent(new CustomEvent('holdem:display-unit', { detail: choice }));
  return saved;
}

/** Forget that the first-turn guide was seen; the table shows it again. */
export function replayOnboarding({ doc = globalThis.document, storage } = {}) {
  write(storage, DISPLAY_KEYS.onboarding, null);
  try { globalThis.sessionStorage?.removeItem(DISPLAY_KEYS.onboarding); } catch { /* optional */ }
  doc.defaultView?.dispatchEvent(new CustomEvent('holdem:onboarding-reset'));
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function radioGroup(doc, name, legend, options, current, onPick) {
  const group = el(doc, 'fieldset', 'display-group');
  group.append(el(doc, 'legend', 'ui-label', legend));
  for (const [value, label] of options) {
    const wrap = el(doc, 'label', 'display-option');
    const input = el(doc, 'input');
    input.type = 'radio';
    input.name = `display-${name}`;
    input.value = value;
    input.checked = value === current;
    input.addEventListener('change', () => { if (input.checked) onPick(value); });
    wrap.append(input, el(doc, 'span', null, label));
    group.append(wrap);
  }
  return group;
}

/** Opens (building on first use) the settings dialog. */
export function openDisplaySettings({ doc = globalThis.document, storage } = {}) {
  doc.getElementById('display-settings')?.remove();
  const settings = currentDisplaySettings({ doc, storage });
  const dialog = el(doc, 'dialog', 'ui-dialog ui-sheet display-settings');
  dialog.id = 'display-settings';
  dialog.setAttribute('aria-labelledby', 'display-settings-title');
  const title = el(doc, 'h2', 'display-title', '표시 설정');
  title.id = 'display-settings-title';
  const note = el(doc, 'p', 'display-note', '이 브라우저에만 저장됩니다.');
  note.setAttribute('role', 'status');
  const pick = (name) => (value) => {
    note.textContent = saveDisplaySetting(name, value, { doc, storage }) ? '저장했습니다. 이 브라우저에만 적용됩니다.' : '이 브라우저에 저장할 수 없어 이번 화면에만 적용했습니다.';
  };
  const again = el(doc, 'button', 'ui-btn ui-btn--ghost display-onboarding', '처음 안내 다시 보기');
  again.type = 'button';
  again.addEventListener('click', () => { replayOnboarding({ doc, storage }); note.textContent = '다음 내 차례에 처음 안내를 다시 보여 드립니다.'; });
  const close = el(doc, 'button', 'ui-btn ui-btn--primary display-close', '닫기');
  close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  dialog.append(
    title,
    radioGroup(doc, 'theme', '테마', THEMES, settings.theme, pick('theme')),
    radioGroup(doc, 'unit', '금액 단위', [['bb', 'BB 중심'], ['chips', '칩 중심']], settings.unit, pick('unit')),
    radioGroup(doc, 'deck', '카드 무늬 색', [['4', '4색 (무늬마다 다른 색)'], ['2', '2색 (빨강·검정)']], settings.deck, pick('deck')),
    radioGroup(doc, 'motion', '모션', [['system', '시스템 설정 따름'], ['reduce', '줄이기']], settings.motion, pick('motion')),
    again, note, close,
  );
  dialog.addEventListener('close', () => dialog.remove());
  doc.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('input:checked')?.focus();
  return dialog;
}
