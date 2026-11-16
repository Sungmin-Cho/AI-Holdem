// Issue #351: the lobby's training preset fills existing setup fields so that a game lands in the play
// report's comparable population (training/play-report.js yardstickKey), and the lobby shows how many
// comparable hands there are. These tests run the lobby's own functions in a VM with a small form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeSetup, cliModeDefaults } from '../shared/game-setup.js';
import { formatAmount } from '../server/public/chip-format.js';

const source = fs.readFileSync(new URL('../server/public/lobby.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../server/public/lobby.html', import.meta.url), 'utf8');
const between = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `lobby.js has ${from} … ${to}`);
  return source.slice(start, end);
};

// The lobby form as lobby.html declares it, with its default values; `over` changes some.
function lobbyForm(over = {}) {
  const fields = {};
  const add = (name, value, extra = {}) => { fields[name] = { name, value: String(value), type: 'text', checked: false, disabled: false, ...extra }; };
  add('blinds', '25/50');
  add('aiCount', '5', { type: 'select-one' });
  add('opponentRuntime', 'policy', { type: 'select-one' });
  add('cashStackUnit', 'bb', { type: 'select-one' });
  add('cashStack', '5000', { type: 'number' });
  add('stackBb', '100', { type: 'number' });
  add('hands', '20', { type: 'number' });
  add('stack', '5000', { type: 'number' });
  add('levelMode', 'time', { type: 'select-one' });
  add('levelMinutes', '2', { type: 'number' });
  add('levelEvery', '8', { type: 'number' });
  add('hints', 'off', { type: 'select-one' });
  add('dealBias', 'off', { type: 'select-one' });
  add('mirrorSelf', 'on', { type: 'checkbox' });
  add('exploitSelf', 'on', { type: 'checkbox' });
  add('showdownPolicy', 'open', { type: 'select-one' });
  add('replayReveal', 'all', { type: 'select-one' });
  add('pace', 'normal', { type: 'select-one' });
  add('resultHoldSec', '4', { type: 'select-one' });
  add('playerSoftMs', '25000', { type: 'number' });
  add('playerHardMs', '300000', { type: 'number' });
  const mode = ['cash-training', 'tournament'].map((value) => ({ name: 'mode', type: 'radio', value, checked: value === 'cash-training', disabled: false }));
  for (const [name, value] of Object.entries(over)) {
    if (name === 'mode') for (const radio of mode) radio.checked = radio.value === value;
    else if (typeof value === 'boolean') fields[name].checked = value;
    else fields[name].value = String(value);
  }
  const changes = [];
  const elements = { ...fields, mode, namedItem: (name) => (name === 'mode' ? mode : fields[name] ?? null) };
  const form = { elements, changes, onchange() { changes.push('change'); } };
  // FormData of the form: the checked radio, checked boxes only, every other control's value.
  class FormData {
    constructor(target) { this.target = target; }
    #entry(name) {
      if (name === 'mode') return mode.find((radio) => radio.checked && !radio.disabled)?.value ?? null;
      const field = fields[name];
      if (!field || field.disabled) return null;
      if (field.type === 'checkbox') return field.checked ? field.value : null;
      return field.value;
    }
    get(name) { return this.#entry(name); }
    has(name) { return this.#entry(name) !== null; }
  }
  return { form, fields, mode, FormData };
}

function lobby({ room = null, form = lobbyForm() } = {}) {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, hidden: false, disabled: false, textContent: '', value: id === 'total-seats' ? '6' : '', attrs: {}, dataset: {},
        setAttribute(key, value) { this.attrs[key] = String(value); }, getAttribute(key) { return this.attrs[key] ?? null; } });
    }
    return nodes.get(id);
  };
  const context = { $, form: form.form, FormData: form.FormData, snapshot: { state: 'lobby', room, defaultSetup: { hands: 20 } },
    remoteHost: false, setTimeout, clearTimeout, requests: [], commands: [], normalizeSetup, formatAmount, validationShown: false,
    OPPONENT_HELP: {}, PACE_LABELS: {}, FIELD_ERRORS: {}, paintSeatDots() {}, markFieldError() { return null; },
    showError(error) { throw error; }, confirm(fn) { fn(); }, command(kind, setup) { context.commands.push({ kind, setup }); } };
  context.api = async (url, options = {}) => { context.requests.push({ url, ...options }); return context.answer(url, options); };
  context.answer = () => ({ ok: true, progress: null });
  vm.createContext(context);
  vm.runInContext(source.match(/^const roomIsLive = .*$/m)[0].replace('const roomIsLive', 'var roomIsLive'), context);
  vm.runInContext(between('function setupFromForm()', 'const FIELD_ERRORS = {'), context);
  vm.runInContext(between('form.onsubmit = (e) => {', '$("review").onclick'), context);
  return { context, $, form };
}

const settle = () => new Promise((resolve) => { setImmediate(resolve); });
const PRESET_SETUP = { mode: 'cash-training', opponentRuntime: 'policy', aiCount: 5, stackBb: 100, hands: 50, pace: 'fast',
  showdownPolicy: 'open', replayReveal: 'all', dealBias: 'off', mirrorSelf: false, exploitSelf: false };
const pick = (setup) => Object.fromEntries(Object.keys(PRESET_SETUP).map((key) => [key, setup[key]]));

test('the training preset makes the start request the comparable configuration', () => {
  const { context, form } = lobby({ form: lobbyForm({ mode: 'tournament', aiCount: 8, opponentRuntime: 'llm', pace: 'slow', hands: 30,
    showdownPolicy: 'standard', replayReveal: 'showdown', dealBias: 'strong', mirrorSelf: true, exploitSelf: true }) });
  assert.equal(context.presetMatches(), false);
  context.applyTrainingPreset();
  assert.ok(form.form.changes.length >= 1, 'the form repaints its fields and summary');
  const setup = normalizeSetup(context.setupFromForm());
  assert.deepEqual(pick(setup), PRESET_SETUP);
  assert.equal(setup.stack, undefined);
  assert.equal(setup.totalSeats, undefined);
  assert.equal(context.presetMatches(), true);
  // Fields outside the preset keep the user's choice.
  assert.equal(setup.blinds, '25/50');
  assert.equal(setup.hints, 'off');
  assert.equal(setup.resultHoldSec, 4);
  const hinted = lobby({ form: lobbyForm({ hints: 'on', resultHoldSec: 10, blinds: '50/100' }) });
  hinted.context.applyTrainingPreset();
  const kept = normalizeSetup(hinted.context.setupFromForm());
  assert.deepEqual([kept.hints, kept.resultHoldSec, kept.blinds], ['on', 10, '50/100']);
  assert.deepEqual(pick(kept), PRESET_SETUP);
});

test('a form whose cash stack is in chips sends stackBb 100 once the preset is chosen', () => {
  const { context, form: { fields } } = lobby({ form: lobbyForm({ cashStackUnit: 'chips', cashStack: 7000 }) });
  assert.equal(context.setupFromForm().stack, 7000, 'fixture: the chip stack is what would be sent');
  context.applyTrainingPreset();
  assert.equal(fields.cashStackUnit.value, 'bb');
  const setup = context.setupFromForm();
  assert.equal(setup.stackBb, 100);
  assert.equal(Object.hasOwn(setup, 'stack'), false);
  assert.equal(context.presetMatches(), true);
  // Back to chips: the request would carry chips again, so the preset is no longer shown.
  fields.cashStackUnit.value = 'chips';
  assert.equal(context.presetMatches(), false);
});

test('while a session room is open the preset cannot be chosen and is never shown as applied', () => {
  for (const status of ['open', 'locked']) {
    const { context, $, form } = lobby({ room: { status } });
    context.paintPreset();
    assert.equal($('training-preset').disabled, true, status);
    assert.equal($('training-preset-room').hidden, false, status);
    assert.equal($('training-preset').getAttribute('aria-pressed'), 'false');
    const before = JSON.stringify(context.setupFromForm());
    context.applyTrainingPreset();
    assert.equal(JSON.stringify(context.setupFromForm()), before, 'a click that slipped through changes nothing');
    assert.equal(form.form.changes.length, 0);
    // Even a form that holds the preset values is not "applied": the request names totalSeats.
    const live = lobby({ room: { status }, form: lobbyForm({ hands: 50, pace: 'fast' }) });
    assert.equal(live.context.setupFromForm().totalSeats, 6);
    assert.equal(live.context.presetMatches(), false);
  }
  // A closed room is not live: the preset is available again.
  const closed = lobby({ room: { status: 'closed' } });
  closed.context.paintPreset();
  assert.equal(closed.$('training-preset').disabled, false);
  assert.equal(closed.$('training-preset-room').hidden, true);
});

test('changing any preset field releases the indicator, and changing it back restores it', () => {
  const { context, $, fields, mode } = (() => { const made = lobby(); return { ...made, fields: made.form.fields, mode: made.form.mode }; })();
  context.applyTrainingPreset();
  context.paintPreset();
  assert.equal($('training-preset').getAttribute('aria-pressed'), 'true');
  const edits = [
    ['aiCount', '4'], ['opponentRuntime', 'jev'], ['stackBb', '80'], ['hands', '60'], ['pace', 'normal'], ['showdownPolicy', 'standard'],
    ['replayReveal', 'showdown'], ['dealBias', 'light'], ['mirrorSelf', true], ['exploitSelf', true], ['cashStackUnit', 'chips'],
  ];
  for (const [name, value] of edits) {
    const field = fields[name];
    const old = typeof value === 'boolean' ? field.checked : field.value;
    if (typeof value === 'boolean') field.checked = value; else field.value = value;
    context.paintPreset();
    assert.equal($('training-preset').getAttribute('aria-pressed'), 'false', name);
    if (typeof value === 'boolean') field.checked = old; else field.value = old;
    context.paintPreset();
    assert.equal($('training-preset').getAttribute('aria-pressed'), 'true', `${name} restored`);
  }
  for (const radio of mode) radio.checked = radio.value === 'tournament';
  context.paintPreset();
  assert.equal($('training-preset').getAttribute('aria-pressed'), 'false', 'mode');
  // Fields outside the preset do not release it.
  for (const radio of mode) radio.checked = radio.value === 'cash-training';
  fields.hints.value = 'on';
  fields.blinds.value = '50/100';
  context.paintPreset();
  assert.equal($('training-preset').getAttribute('aria-pressed'), 'true');
});

test('the preset changes neither the new-game defaults nor a resumed or restarted game', () => {
  // The server-side defaults are untouched.
  assert.equal(normalizeSetup({}).hands, 20);
  assert.equal(normalizeSetup({}).pace, undefined);
  assert.deepEqual(cliModeDefaults({ storeDir: 'game' }), { storeDir: 'game', mode: 'cash-training', ai: 5, stackBb: 100, hands: 20,
    opponentRuntime: 'policy', showdownPolicy: 'open', replayReveal: 'all', hints: 'off', dealBias: 'off' });
  // The lobby page keeps its own defaults: 20 hands at the normal pace.
  assert.match(html, /name="hands" type="number" value="20"/);
  assert.match(html, /<option value="normal" selected>/);
  // Choosing the preset makes no request and leaves the server's defaults as they were.
  const { context } = lobby();
  const defaults = JSON.stringify(context.snapshot.defaultSetup);
  context.applyTrainingPreset();
  assert.equal(context.requests.length, 0);
  assert.equal(JSON.stringify(context.snapshot.defaultSetup), defaults);
  // Resume and same-setup restart send no setup at all: the stored one is used.
  assert.match(source, /\$\("resume"\)\.onclick = \(\) => command\("resume"\);/);
  assert.match(source, /\$\("restart"\)\.onclick = \(\) => confirm\(\(\) => command\("restart"\)\);/);
  assert.match(source, /\$\("recover"\)\.onclick = \(\) => command\("resume"\);/);
  // Nothing about the preset is stored in the browser.
  const block = between('function setupFromForm()', 'function updateSetupSummary()');
  assert.doesNotMatch(block, /localStorage|sessionStorage/);
});

test('the lobby asks for comparable-hand progress without blocking, and hides the line when there is none', async () => {
  const progress = { hands: 80, target: 200, line: '비교 가능한 핸드 80 / 200 (6인 · 100BB · 정책 v3)' };
  const { context, $ } = lobby();
  context.answer = () => ({ ok: true, progress });
  await context.askTrainingProgress();
  assert.equal(context.requests[0].url, '/api/training-progress');
  assert.equal($('training-progress').hidden, false);
  assert.equal($('training-progress').textContent, progress.line);
  // Over the deadline, failed, refused by an older app service, or malformed: no line.
  for (const answer of [() => ({ ok: true, progress: null, pending: true }), () => { throw Object.assign(new Error('NOT_FOUND'), { status: 404 }); },
    () => { throw new Error('PROGRESS_UNAVAILABLE'); }, () => ({ ok: true, progress: { line: 7 } }), () => ({ ok: true })]) {
    context.answer = () => ({ ok: true, progress });
    await context.askTrainingProgress();
    assert.equal($('training-progress').hidden, false);
    context.answer = answer;
    await context.askTrainingProgress();
    assert.equal($('training-progress').hidden, true);
    assert.equal($('training-progress').textContent, '');
  }
  // A remote host page does not ask (the route is loopback-only).
  const remote = lobby();
  remote.context.remoteHost = true;
  await remote.context.askTrainingProgress();
  assert.equal(remote.context.requests.length, 0);
  assert.equal(remote.$('training-progress').hidden, true);
});

test('a pending answer is asked again a few times while the setup screen is shown', async () => {
  const { context, $ } = lobby();
  const timers = [];
  context.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  context.clearTimeout = () => {};
  context.answer = () => ({ ok: true, progress: null, pending: true });
  context.progressTries = 0;
  await context.askTrainingProgress();
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms >= 1000);
  for (let n = 0; n < 20 && timers.length; n += 1) {
    const next = timers.shift();
    await next.fn();
  }
  assert.ok(context.requests.length <= 8, `bounded retries: ${context.requests.length}`);
  assert.equal(timers.length, 0);
  // A hidden setup screen stops the retries.
  const hidden = lobby();
  const later = [];
  hidden.context.setTimeout = (fn, ms) => { later.push(fn); return 1; };
  hidden.context.answer = () => ({ ok: true, progress: null, pending: true });
  hidden.$('setup').hidden = true;
  await hidden.context.askTrainingProgress();
  assert.equal(later.length, 0);
});

test('the preset section is in the lobby markup', () => {
  for (const id of ['training-preset', 'training-preset-room', 'training-progress']) assert.equal(html.split(`id="${id}"`).length, 2, id);
  assert.match(html, /<button type="button" id="training-preset" class="ui-btn[^"]*"[^>]* aria-pressed="false"/);
  assert.match(html, /id="training-progress"[^>]* hidden/);
  assert.match(html, /id="training-preset-room"[^>]* hidden/);
});

test('the setup summary repaints the preset, and the start or replace request is what it shows', () => {
  const { context, $, form } = lobby({ form: lobbyForm({ mode: 'tournament', levelMode: 'hands', cashStackUnit: 'chips', mirrorSelf: true,
    exploitSelf: true, hints: 'on', blinds: '50/100', resultHoldSec: 10 }) });
  context.updateSetupSummary();
  assert.equal($('training-preset').getAttribute('aria-pressed'), 'false');
  assert.equal($('training-preset').textContent, '훈련 세션으로 맞추기');
  context.applyTrainingPreset();
  context.updateSetupSummary();
  assert.equal($('training-preset').getAttribute('aria-pressed'), 'true');
  assert.equal($('training-preset').textContent, '훈련 세션 설정 적용됨');
  assert.match($('setup-summary').textContent, /^캐시 트레이닝 · 로컬 정책 · 총 6명 · .* · 50핸드$/);
  // The actual submit path: start from the lobby, replace-current from a paused game.
  for (const [state, kind] of [['lobby', 'start'], ['paused', 'replace-current']]) {
    context.commands.length = 0;
    context.snapshot.state = state;
    form.form.onsubmit({ preventDefault() {} });
    assert.equal(context.commands.length, 1);
    const sent = context.commands[0];
    assert.equal(sent.kind, kind);
    const normalized = normalizeSetup(sent.setup);
    assert.deepEqual(pick(normalized), PRESET_SETUP);
    for (const key of ['stack', 'levelEvery', 'levelMinutes', 'totalSeats']) assert.equal(Object.hasOwn(sent.setup, key), false, key);
    assert.deepEqual([sent.setup.hints, sent.setup.blinds, sent.setup.resultHoldSec], ['on', '50/100', 10]);
  }
  // A room opened or closed later, with no form event: the summary repaint follows it.
  context.snapshot.state = 'lobby';
  context.snapshot.room = { status: 'open' };
  context.updateSetupSummary();
  assert.equal($('training-preset').disabled, true);
  assert.equal($('training-preset').getAttribute('aria-pressed'), 'false');
  context.commands.length = 0;
  form.form.onsubmit({ preventDefault() {} });
  assert.equal(context.commands[0].setup.totalSeats, 6, 'what is sent with a room open is not the preset, and is not shown as one');
  context.snapshot.room = { status: 'closed' };
  context.updateSetupSummary();
  assert.equal($('training-preset').disabled, false);
  assert.equal($('training-preset').getAttribute('aria-pressed'), 'true', 'closing the room restores it');
  // paintShell repaints the summary when the room changes and watches the setup screen.
  const shell = between('function paintShell()', 'function paintBoot()');
  assert.match(shell, /if \(roomIsLive\(\) !== roomShown\) \{ roomShown = roomIsLive\(\); updateSetupSummary\(\); \}/);
  assert.match(shell, /watchTrainingProgress\(\);\n\}/);
  assert.match(source, /\$\("training-preset"\)\.onclick = applyTrainingPreset;/);
  assert.match(source, /form\.addEventListener\('input',updateSetupSummary\);/);
});

test('progress is asked when the setup screen comes into view, and an older answer never replaces a newer one', async () => {
  const { context, $ } = lobby();
  const line = (hands) => `비교 가능한 핸드 ${hands} / 200 (6인 · 100BB · 정책 v3)`;
  context.answer = () => ({ ok: true, progress: { hands: 3, target: 200, line: line(3) } });
  context.watchTrainingProgress();
  await settle();
  assert.equal(context.requests.length, 1);
  assert.equal($('training-progress').textContent, line(3));
  // Polls and renders while the screen stays do not ask again.
  for (let n = 0; n < 5; n += 1) context.watchTrainingProgress();
  await settle();
  assert.equal(context.requests.length, 1);
  // Hidden (a game is played) and shown again (back to the lobby): asked again.
  $('setup').hidden = true;
  context.watchTrainingProgress();
  assert.equal(context.requests.length, 1);
  $('setup').hidden = false;
  context.answer = () => ({ ok: true, progress: { hands: 53, target: 200, line: line(53) } });
  context.watchTrainingProgress();
  await settle();
  assert.equal(context.requests.length, 2);
  assert.equal($('training-progress').textContent, line(53));
  // A slow first answer that lands after a newer one is dropped.
  let release;
  context.answer = () => new Promise((resolve) => { release = () => resolve({ ok: true, progress: { hands: 1, target: 200, line: line(1) } }); });
  const slow = context.askTrainingProgress();
  context.answer = () => ({ ok: true, progress: { hands: 60, target: 200, line: line(60) } });
  await context.askTrainingProgress();
  release();
  await slow;
  assert.equal($('training-progress').textContent, line(60));
  // A pending answer that carries the last finished count shows it while the scan goes on.
  context.answer = () => ({ ok: true, progress: { hands: 60, target: 200, line: line(60) }, pending: true });
  const timers = [];
  context.setTimeout = (fn, ms) => { timers.push(ms); return 1; };
  await context.askTrainingProgress();
  assert.equal($('training-progress').textContent, line(60));
  assert.deepEqual(timers, [5000]);
});
