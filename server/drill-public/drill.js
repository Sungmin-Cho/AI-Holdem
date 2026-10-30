import {KNOWN_REFERENCE_SOURCES} from '../../shared/reference.js';
import { STUDY_MODES, STUDY_MODE_HELP, formatQuestion, formatFeedback, formatFeedbackStep, formatSummary, formatStudyError, unfinishedRun, nextStepView, cardGate, completionGuidance, formatSource, formatSourceShort, formatTrends, readStudyEntry, drillRequest, spotDiagram, handCards, feedbackBars, runProgress, modeAvailability, nextEnrollmentBoundary, enrollmentBoundaryCrossed, boundaryDelay, ENROLLMENT_CHANGED_NOTICE } from './study-format.js';
import { createChartPanel, renderSpotChart } from './spot-chart.js';
import { mountPotOddsDrill } from './pot-odds-drill.js';
import { helpButton, openHelp } from '../public/help-panel.js';
import { openDisplaySettings } from '../public/display-settings.js';

/** The "평가와 재평가" card list. Cards are keyed by run id and updated in place:
 * a button that is being pressed must stay the same element (a rebuilt button
 * loses the click between mousedown and mouseup, issue 329). The list is
 * rebuilt only when the order of run ids changes; a state change touches
 * `disabled` and the gate line only; a new summary changes text only.
 *
 * `cards` are the display cards of study-format.js formatSummary. `getGate`
 * returns the current gate ({ text }) or null and is asked again at click time,
 * so a stale render cannot start a run. `onRetest(card)` does the start. */
export function createRunCards(document, box, { onRetest, getGate = () => null, gateBox = null } = {}) {
  const entries = new Map();
  let order = [];
  let empty = null;

  const node = (tag, className) => { const element = document.createElement(tag); if (className) element.className = className; return element; };
  const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
  const show = (element, text) => { element.hidden = !text; setText(element, text || ''); };

  function build(card) {
    const root = node('article', 'assessment');
    const title = node('h3');
    const badge = node('span', 'assessment-badge');
    const heading = node('span', 'assessment-title');
    title.append(heading, badge);
    const parts = { root, heading, badge, meta: node('p', 'assessment-meta'), relation: node('p', 'assessment-relation'),
      rate: node('p', 'assessment-rate'), status: node('p'), baseline: node('p', 'assessment-baseline'), available: node('p'),
      note: node('p', 'assessment-note'), button: null };
    root.append(title, parts.meta, parts.relation, parts.rate, parts.status, parts.baseline, parts.available, parts.note);
    const entry = { card, parts };
    if (card.kind === 'assessment') {
      const button = node('button', 'ui-btn ui-btn--ghost');
      button.type = 'button';
      button.textContent = '이 평가 재평가하기';
      // The handler reads the entry at click time: the card data and the gate
      // are whatever is current, not what was rendered when the button was made.
      button.addEventListener('click', () => {
        if (!entry.card.canRetest || getGate()) return;
        onRetest(entry.card);
      });
      parts.button = button;
      root.append(button);
    }
    return entry;
  }

  function fill(entry, card) {
    entry.card = card;
    const { parts } = entry;
    setText(parts.heading, card.title);
    show(parts.badge, card.badge);
    show(parts.meta, card.meta);
    show(parts.relation, card.relation);
    setText(parts.rate, `${card.rate} · ${card.samples}`);
    setText(parts.status, card.status);
    show(parts.baseline, card.baseline);
    show(parts.available, card.availableAt ? `재평가 가능 시각: ${card.availableAt}` : '');
    show(parts.note, card.note);
  }

  /** The gate line and every button's `disabled`; nothing else changes. The
   * line explains a held-back retest, so it is empty when no card could retest. */
  function refreshGate() {
    const gate = getGate();
    let retestable = false;
    for (const entry of entries.values()) {
      if (!entry.parts.button) continue;
      retestable ||= entry.card.canRetest === true;
      entry.parts.button.disabled = !entry.card.canRetest || gate !== null;
    }
    if (gateBox) setText(gateBox, retestable ? gate?.text ?? '' : '');
  }

  function sync(cards) {
    const list = [];
    const seen = new Set();
    for (const card of cards) {
      if (typeof card?.key !== 'string' || seen.has(card.key)) continue;
      seen.add(card.key);
      list.push(card);
    }
    const keys = list.map((card) => card.key);
    for (const key of [...entries.keys()]) if (!seen.has(key)) entries.delete(key);
    for (const card of list) {
      const entry = entries.get(card.key) ?? build(card);
      entries.set(card.key, entry);
      fill(entry, card);
    }
    const changed = keys.length !== order.length || keys.some((key, index) => key !== order[index]);
    if (changed || (!keys.length && !empty)) {
      order = keys;
      if (keys.length) { empty = null; box.replaceChildren(...keys.map((key) => entries.get(key).parts.root)); }
      else {
        empty = node('p');
        empty.textContent = '완료한 새 문제 평가가 없습니다. 평가를 완료하면 24시간 뒤 같은 문항으로 재평가할 수 있습니다.';
        box.replaceChildren(empty);
      }
    }
    refreshGate();
  }

  return { sync, refreshGate, get keys() { return [...order]; }, buttonOf: (key) => entries.get(key)?.parts.button ?? null, elementOf: (key) => entries.get(key)?.parts.root ?? null };
}

// Exact pre-start rejections from createDrillHandler/startDrill. An unknown
// response or a pending journal is not a failed start proof.
const START_REJECTIONS = Object.freeze({
  UNSUPPORTED_SPOT: 400, UNSUPPORTED_HAND: 400, INVALID_DRILL_MODE: 400,
  INVALID_DRILL_LIMIT: 400, USAGE: 400, BAD_JSON: 400, PAYLOAD_TOO_LARGE: 413,
  RETEST_NOT_DUE: 409, INCOMPLETE_ASSESSMENT: 409, SOURCE_CHANGED: 409, UNFINISHED_RUN: 409,
});
const ANSWER_SOURCE_REJECTIONS = new Set(['SOURCE_UNVERIFIED', 'SOURCE_CHANGED']);

export function createLatestRequest() {
  let generation = 0;
  return async (load) => {
    const ticket = ++generation;
    try {
      const value = await load();
      return ticket === generation ? { current: true, value } : { current: false };
    } catch (error) {
      if (ticket !== generation) return { current: false };
      throw error;
    }
  };
}

/** Explicit user actions own run creation and progression. Recovery reads the
 * authoritative session and only retries a captured request on an explicit click. */
export function createStudyController({ api, storage, storageKey, initialTarget = null, uuid = () => crypto.randomUUID(), onState = () => {} }) {
  let session = null;
  let pending = null;
  let busy = false;
  let recovery = true;
  let awaitNext = false;
  let replacementOnly = false;
  let feedback = null;
  let error = null;
  let loaded = false;
  let target = initialTarget && (initialTarget.spotKey || initialTarget.handClass)
    ? { ...(initialTarget.spotKey ? { spotKey: initialTarget.spotKey } : {}), ...(initialTarget.handClass ? { handClass: initialTarget.handClass } : {}) } : null;
  const state = () => ({ session, pending, busy, recovery, awaitNext, replacementOnly, feedback, error, target });
  const emit = () => { onState(state()); return state(); };
  function save(value) {
    try {
      if (value) storage.setItem(storageKey, JSON.stringify(value));
      else storage.removeItem(storageKey);
      pending = value; return true;
    } catch { error = { code: 'STORAGE' }; recovery = true; emit(); return false; }
  }
  function captureCurrent(current) {
    replacementOnly = false;
    session = current; feedback = current.lastResult ?? null; awaitNext = Boolean(feedback);
    if (pending?.kind === 'answer') {
      // A later confirmed index or an independently changed session cannot need
      // this old answer again. A still-current question keeps exact retry only.
      if (current.sessionId !== pending.body.sessionId || current.index > pending.body.attemptNo) save(null);
    }
    recovery = Boolean(pending);
    error = pending ? { code: 'STALE_QUESTION' } : null;
    // The authoritative DTO exposes a null source only for a validated legacy
    // session. It is readable but never answerable, including after refresh.
    if (!pending && current.sessionId && current.sourceIdentity === null) {
      replacementOnly = true; awaitNext = false; error = { code: 'SOURCE_UNVERIFIED' };
    }
  }
  async function readCurrent() {
    const current = await api('/api/current');
    if (current.ok !== true) {
      error = current;
      if (!pending && current.httpStatus === 409 && ANSWER_SOURCE_REJECTIONS.has(current.code)) {
        replacementOnly = true; recovery = false; awaitNext = false;
      } else recovery = true;
      return false;
    }
    captureCurrent(current); return true;
  }
  async function restore() {
    if (busy) return state();
    busy = true; emit();
    try {
      if (!loaded) {
        const raw = storage.getItem(storageKey); loaded = true;
        if (raw) {
          const value = JSON.parse(raw);
          if (!['start', 'answer'].includes(value?.kind) || !value.body || typeof value.body !== 'object') throw new Error('STORAGE');
          pending = value;
        }
      }
      await readCurrent();
    } catch { error = { code: 'CONNECTION' }; recovery = true; }
    finally { busy = false; emit(); }
    return state();
  }
  async function submit(captured) {
    if (!save(captured)) return state();
    busy = true; recovery = true; error = null; emit();
    try {
      const response = await api(captured.kind === 'start' ? '/api/start' : '/api/answer', { method: 'POST', body: captured.body });
      if (response.ok !== true) {
        error = response;
        const rejectedStart = captured.kind === 'start' && Object.hasOwn(START_REJECTIONS, response.code)
          && response.httpStatus === START_REJECTIONS[response.code];
        const rejectedAnswer = captured.kind === 'answer' && response.httpStatus === 400 && response.code === 'INVALID_DRILL_ANSWER';
        const rejectedAnswerSource = captured.kind === 'answer' && response.httpStatus === 409
          && ANSWER_SOURCE_REJECTIONS.has(response.code);
        if (rejectedAnswerSource) {
          // Source-changed sessions cannot be read. Legacy sessions remain
          // readable; bind their definitive rejection to the exact captured turn.
          const current = await api('/api/current');
          const sameLegacyTurn = response.code === 'SOURCE_UNVERIFIED' && current.ok === true
            && current.sourceIdentity === null && current.sessionId === captured.body.sessionId
            && current.question?.questionId === captured.body.questionId
            && Number.isSafeInteger(current.index) && current.index === captured.body.attemptNo
            && current.attemptNo === captured.body.attemptNo;
          const changedSource = response.code === 'SOURCE_CHANGED' && current.ok === false
            && current.httpStatus === 409 && current.code === response.code;
          if (sameLegacyTurn || changedSource) {
            if (!save(null)) return state();
            if (sameLegacyTurn) captureCurrent(current);
            replacementOnly = true; recovery = false; awaitNext = false; error = response;
          } else { error = current.ok === true ? { code: 'STALE_QUESTION' } : current; recovery = true; }
          return state();
        }
        if (rejectedStart || rejectedAnswer) {
          if (rejectedStart && ['UNSUPPORTED_SPOT', 'UNSUPPORTED_HAND'].includes(response.code)) target = null;
          if (!save(null)) return state();
          const confirmed = await readCurrent();
          if (confirmed) error = response;
        }
        if (response.code === 'PENDING_UNRESOLVED' && captured.kind === 'start') save(null);
        return state();
      }
      save(null);
      if (captured.kind === 'answer') {
        // The answer response proves the write, but /api/current owns session
        // progress and completion. Keep the confirmed feedback while binding the
        // next/finish UI to that authoritative DTO.
        feedback = response.result ?? null; awaitNext = true; recovery = true;
        const confirmed = await readCurrent();
        const advanced = confirmed && session?.sessionId === captured.body.sessionId
          && Number.isSafeInteger(session.index) && session.index > captured.body.attemptNo
          && session.lastResult != null;
        if (advanced) { recovery = false; error = null; awaitNext = true; }
        else if (confirmed) { recovery = true; error = { code: 'STALE_QUESTION' }; awaitNext = false; }
      } else await readCurrent();
    } catch { error = { code: 'CONNECTION' }; recovery = true; }
    finally { busy = false; emit(); }
    return state();
  }
  return {
    get state() { return state(); }, restore,
    // protectUnfinished: the next-step suggestion never replaces a run the user
    // has not finished (any mode), nor a legacy session awaiting replacement. This
    // tab's cached state can be stale (another tab may have started a run), so the
    // condition also travels in the request and the server enforces it under its
    // drill lock. The ordinary Start button sends no condition and replaces.
    async start(selectors, { protectUnfinished = false } = {}) {
      if (busy || recovery || pending) return state();
      if (protectUnfinished && (replacementOnly || unfinishedRun(state()))) return state();
      if (!Object.hasOwn(STUDY_MODES, selectors?.mode)) { error = { code: 'INVALID_DRILL_MODE' }; return emit(); }
      if (selectors.mode === 'free' && selectors.source && target?.spotKey && selectors.source.version !== (target.spotKey.endsWith('-v3') ? '3.0.0' : target.spotKey.endsWith('-v2') ? '2.0.0' : '1.0.0')) target = null;
      return submit({ kind: 'start', body: { ...(selectors.mode === 'free' ? target : null), ...selectors,
        ...(protectUnfinished ? { protectUnfinished: true } : null), seed: uuid(), idempotencyKey: uuid() } });
    },
    async answer(action, sizeBb) {
      if (busy || recovery || awaitNext || replacementOnly || !session?.question) return state();
      if (!formatQuestion(session.question).actions.some((row) => row.action === action && row.sizeBb === sizeBb)) return state();
      return submit({ kind: 'answer', body: { action, ...(sizeBb !== undefined ? { sizeBb } : {}),
        sessionId: session.sessionId, questionId: session.question.questionId, attemptNo: session.attemptNo } });
    },
    async retry() {
      if (busy || !pending) return state();
      if (error?.code === 'PENDING_UNRESOLVED') return restore();
      return submit(pending);
    },
    async next() {
      if (busy || recovery || replacementOnly) return state();
      busy = true; emit();
      try {
        const current = await api('/api/next');
        if (!current.ok) { error = current; recovery = true; }
        else { captureCurrent(current); awaitNext = false; }
      } catch { error = { code: 'CONNECTION' }; recovery = true; }
      finally { busy = false; emit(); }
      return state();
    },
  };
}

export function replayEntryState(health, token) {
  if (health?.ok !== true) return { message: '플레이 기록 연결을 확인하지 못했습니다.', retry: true };
  if (health.capabilities?.replayLibrary !== 1) return { message: '구버전 학습 서비스가 실행 중입니다. 서버에서 학습 서비스를 종료한 뒤 다시 열어 주세요.', retry: true };
  return { href: `/replay.html#${new URLSearchParams({ token })}`, message: '', retry: false };
}

async function mountStudy() {
  const $ = (id) => document.getElementById(id);
  const entry = readStudyEntry(location);
  // Preserve fragment refresh capability; remove only the legacy query secret.
  const clean = new URL(location.href);
  clean.searchParams.delete('token');
  if (entry.token) clean.hash = new URLSearchParams({ token: entry.token }).toString();
  history.replaceState(null, '', clean);
  let authenticated = true;
  async function api(pathname, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(...drillRequest(pathname, entry.token, { ...options, signal: controller.signal }));
      const body = await response.json();
      if (response.status === 401) authenticated = false;
      return { ...body, httpStatus: response.status, ok: response.ok && body.ok === true };
    } finally { clearTimeout(timer); }
  }
  const node = (tag, text, cls) => { const value = document.createElement(tag); value.textContent = text; if (cls) value.className = cls; return value; };
  let controller;
  let summary = null;
  let summaryState = 'loading';
  let lastState = null;
  let formattedSummary = null;
  // When the current summary arrived and the timer toward the next enrollment
  // boundary (the post window opening or closing changes what the cards say).
  // `summaryAsOf` is when the request for the shown summary was SENT: a boundary that passed while it was in flight
  // may not be in it.
  let summaryAsOf = 0;
  let boundaryTimer = null;
  // The last question shown for answering and the choice made on it. The answer
  // DTO carries neither, so feedback visuals use them only for the same questionId.
  let shown = null;
  let chosen = null;
  const latestSummary = createLatestRequest();
  // The run cards update in place; the gate is asked again at click time.
  const cardsView = createRunCards(document, $('assessments'), { gateBox: $('assessments-gate'),
    getGate: () => cardGate(controller?.state ?? lastState, { authenticated }), onRetest: (card) => void startCardRetest(card) });
  function paintModeHelp() {
    const mode = $('mode').value;
    $('mode-description').textContent = STUDY_MODE_HELP[mode] ?? '';
    $('mode-availability').textContent = modeAvailability(mode, formattedSummary);
  }
  // The suggestion reads the raw summary and the controller state together, so a
  // summary rerender cannot re-enable it while a run is active or recovering.
  function paintNextStep() {
    const box = $('next-step');
    const start = $('next-step-start');
    const after = completionGuidance(lastState, summary);
    const view = summary && summaryState === 'ready' ? nextStepView(summary, lastState, { authenticated }) : null;
    box.dataset.state = view ? view.plan.kind : summaryState;
    $('next-step-title').textContent = view ? view.plan.title
      : summaryState === 'failed' ? '학습 요약을 불러오지 못해 다음 단계를 제안할 수 없습니다.' : '학습 요약을 확인하고 있습니다…';
    $('next-step-detail').textContent = view?.plan.detail ?? '';
    const notes = $('next-step-notes'); notes.replaceChildren();
    for (const line of view?.plan.notes ?? []) notes.append(node('li', line));
    notes.hidden = !notes.children.length;
    const coverage = view?.plan.coverage ?? null;
    $('next-step-coverage').hidden = !coverage;
    $('next-step-coverage-text').textContent = coverage?.text ?? '';
    $('next-step-coverage-suggestion').textContent = coverage?.suggestion ?? '';
    $('next-step-after').hidden = !after;
    $('next-step-after-title').textContent = after?.title ?? '';
    $('next-step-variation').textContent = after?.variation ?? '';
    $('next-step-retest').textContent = after?.retest ?? '';
    const choices = $('next-step-choices'); choices.replaceChildren();
    for (const choice of after?.choices ?? []) {
      const button = node('button', choice.label, 'ui-btn ui-btn--ghost'); button.type = 'button';
      // Only selects the mode in the picker; starting remains the user's own click.
      button.addEventListener('click', () => { $('mode').value = choice.mode; paintModeHelp(); });
      choices.append(button);
    }
    start.textContent = view?.plan.label ?? '다음 단계 시작';
    start.disabled = !view || view.disabled;
    $('next-step-gate').textContent = view?.gate?.text ?? '';
  }
  function paintProgress(current) {
    const meter = $('run-meter');
    const progress = runProgress(current);
    meter.hidden = !progress;
    if (!progress) return;
    meter.setAttribute('aria-valuemax', String(progress.count));
    meter.setAttribute('aria-valuenow', String(progress.index));
    meter.setAttribute('aria-valuetext', `${progress.index} / ${progress.count}문항 완료`);
    meter.querySelector('.study-meter__fill').style.width = `${progress.width}%`;
  }
  function paintSpot(prompt) {
    const diagram = prompt ? spotDiagram(prompt) : null;
    const cards = prompt ? handCards(prompt) : null;
    $('spot').hidden = !diagram && !cards;
    const box = $('spot-diagram');
    box.replaceChildren();
    box.hidden = !diagram;
    if (diagram) {
      box.setAttribute('aria-label', diagram.label);
      box.dataset.seated = String(diagram.seated);
      box.append(node('span', '', 'spot-felt'));
      const heroAt = diagram.seats.findIndex((seat) => seat.role === 'hero');
      diagram.seats.forEach((seat, index) => {
        // Hero at the bottom; betting order runs clockwise (bottom → left → top → right).
        const angle = Math.PI / 2 + ((index - heroAt) * 2 * Math.PI) / diagram.seats.length;
        const dot = node('span', seat.position, `spot-seat spot-seat--${seat.role}`);
        dot.style.setProperty('--x', `${(50 + 41 * Math.cos(angle)).toFixed(2)}%`);
        dot.style.setProperty('--y', `${(50 + 36 * Math.sin(angle)).toFixed(2)}%`);
        if (seat.role === 'opener') dot.append(node('span', '오픈', 'spot-tag'));
        box.append(dot);
      });
    }
    const hand = $('hand-cards');
    hand.replaceChildren();
    hand.hidden = !cards;
    if (cards) {
      const pair = node('span', '', `rank-cards rank-cards--${cards.kind}`);
      pair.setAttribute('aria-hidden', 'true');
      for (const rank of cards.ranks) pair.append(node('span', rank, 'rank-card'));
      hand.append(pair, node('span', cards.label, 'hand-kind'), node('span', `내 손패 ${cards.name}`, 'ui-sr-only'));
    }
  }
  function paintFeedback(state, current) {
    const box = $('feedback');
    const feedback = formatFeedback(state.feedback, current?.sourceIdentity);
    box.hidden = !feedback;
    box.replaceChildren();
    if (!feedback) return;
    const bars = feedbackBars(state.feedback, current?.sourceIdentity, chosen);
    box.append(node('h3', feedback.title, 'feedback-title'), node('p', feedback.detail, 'feedback-detail'));
    if (bars.rows.length) {
      const list = node('ul', '', 'freq-list');
      list.setAttribute('aria-label', '기준 빈도');
      for (const row of bars.rows) {
        const item = node('li', '', `freq-row${row.mine ? ' is-mine' : ''}`);
        const track = node('span', '', 'freq-track');
        track.setAttribute('aria-hidden', 'true');
        const fill = node('span', '', 'freq-fill');
        fill.style.width = `${row.width}%`;
        track.append(fill);
        item.append(node('span', row.label, 'freq-label'), track, node('span', row.percent, 'freq-value'));
        if (row.mine) item.append(node('span', '내 선택', 'freq-mine'));
        list.append(item);
      }
      box.append(list);
      if (bars.mineLabel && !bars.rows.some((row) => row.mine)) box.append(node('p', bars.mineLabel, 'feedback-mine'));
    } else box.append(...feedback.actions.map((text) => node('p', text, 'reference-action')));
    // The full chart of this spot, offered only outside runs that measure.
    const prompt = shown && state.feedback?.questionId === shown.questionId ? shown.prompt : null;
    const measuring = ['assessment', 'retest', 'transfer'].includes(current?.mode) && current?.index < current?.count;
    if (prompt?.spotKey && !measuring) {
      const open = node('button', '이 상황 전체 차트 보기', 'ui-btn ui-btn--ghost chart-open'); open.type = 'button';
      open.addEventListener('click', () => void showChart(prompt.spotKey, prompt.handClass, current?.sourceIdentity?.version));
      box.append(open);
    }
  }
  const chartPanel = createChartPanel({
    box: $('chart-box'),
    load: ({ spotKey, version }) => api(`/api/spot?spotKey=${encodeURIComponent(spotKey)}${version ? `&version=${encodeURIComponent(version)}` : ''}`),
    show: ({ loading, response, request }) => {
      const box = $('chart-box');
      if (loading) { box.replaceChildren(node('p', '차트를 불러오고 있습니다…')); return; }
      if (!response) { box.replaceChildren(node('p', '차트를 불러오지 못했습니다.')); return; }
      if (!response.ok) { box.replaceChildren(node('p', response.code === 'GRID_LOCKED' ? '평가·재평가·일반화 연습 중에는 차트를 볼 수 없습니다.' : formatStudyError(response))); return; }
      const legend = node('p', '막대: 레이즈 · 콜 · 폴드 비중. 차트를 본 상황의 손패는 7일 동안 새 문제 평가와 일반화 연습에서 미응답으로 세지 않습니다.', 'chart-legend');
      box.replaceChildren(renderSpotChart(document, response, { highlight: request.handClass }), legend);
    },
  });
  function showChart(spotKey, handClass, version) {
    return chartPanel.open({ spotKey, handClass, version });
  }
  function render(state) {
    const current = state.session;
    lastState = state;
    paintNextStep();
    cardsView.refreshGate();
    chartPanel.sync(current?.sessionId ?? null, ['assessment', 'retest', 'transfer'].includes(current?.mode) && current?.index < current?.count);
    if (!state.target && (entry.spotKey || entry.handClass)) {
      entry.spotKey = null; entry.handClass = null;
      const corrected = new URL(location.href);
      corrected.searchParams.delete('spotKey'); corrected.searchParams.delete('handClass');
      history.replaceState(null, '', corrected);
    }
    $('start').disabled = state.busy || state.recovery || !authenticated;
    $('mode').disabled = state.busy;
    if ($('reference-source')) $('reference-source').disabled = state.busy;
    $('recover').disabled = state.busy;
    $('retry').hidden = !state.pending;
    $('retry').disabled = state.busy;
    $('retry').textContent = state.pending?.kind === 'answer' ? '같은 답안 다시 확인' : '같은 시작 요청 확인';
    $('status').textContent = !authenticated ? formatStudyError({ code: 'UNAUTHORIZED' })
      : state.error ? formatStudyError(state.error)
        : state.busy ? '확인하고 있습니다…' : state.recovery ? '이전 요청을 확인한 뒤 이어서 진행하세요.' : '준비되었습니다.';
    $('run-progress').textContent = current?.sessionId ? `${STUDY_MODES[current.mode] ?? '연습'} · ${current.index} / ${current.count}문항 완료` : '모드를 선택하고 연습을 시작하세요.';
    paintProgress(current);
    $('question-source').textContent = current?.sessionId ? formatSourceShort(current.sourceIdentity) : '';
    const notices = (current?.notices ?? []).filter((value) => typeof value === 'string' && (/^추적된 미(?:노출|응답) 문항은 \d+개입니다\.$/.test(value) || value === '추적 시작 이전의 노출 여부는 알 수 없습니다.' || /^postflop 항목 \d+건은 드릴 대상이 아닙니다$/.test(value)));
    $('notices').textContent = notices.join(' ');
    const actions = $('actions'); actions.replaceChildren();
    const q = current?.question;
    if (q && !state.awaitNext) shown = { questionId: q.questionId, prompt: q.prompt };
    paintSpot(state.awaitNext
      ? (shown && state.feedback?.questionId === shown.questionId ? shown.prompt : null)
      : q?.prompt ?? null);
    if (state.awaitNext) {
      const step = formatFeedbackStep(current);
      $('prompt').textContent = step.title;
      $('context').textContent = step.context;
      $('next').textContent = step.nextLabel;
    } else if (q) {
      const formatted = formatQuestion(q);
      $('prompt').textContent = formatted.title; $('context').textContent = formatted.context;
      for (const offered of formatted.actions) {
        const button = node('button', offered.label, `answer ui-btn ui-btn--lg ${offered.action === 'fold' ? 'ui-btn--ghost' : 'ui-btn--secondary'}`); button.type = 'button';
        button.disabled = state.busy || state.recovery || state.replacementOnly || !authenticated;
        button.addEventListener('click', async () => {
          chosen = { questionId: q.questionId, action: offered.action, ...(offered.sizeBb !== undefined ? { sizeBb: offered.sizeBb } : {}) };
          const settled = await controller.answer(offered.action, offered.sizeBb);
          if (!settled.recovery && settled.awaitNext) await refreshSummary();
        });
        actions.append(button);
      }
    } else {
      $('prompt').textContent = current?.sessionId ? (current.count ? '연습을 완료했습니다' : '현재 모드에 해당하는 문항이 없습니다') : '오늘은 어떤 상황을 연습할까요';
      $('context').textContent = '자유 연습이나 새 문제 평가에서 기준표를 익힐 수 있습니다.';
      $('next').textContent = '다음 문제';
    }
    $('next').hidden = !state.awaitNext; $('next').disabled = state.busy || state.recovery;
    paintFeedback(state, current);
  }
  // A summary that cannot be read removes the enrollment guidance: a stale
  // confident sentence about the schedule is worse than none.
  function dropEnrollmentGuidance() {
    clearTimeout(boundaryTimer); boundaryTimer = null;
    $('assessments-enrollment').hidden = true; $('assessments-enrollment').textContent = '';
    if (formattedSummary) {
      formattedSummary = { ...formattedSummary, enrollment: null, enrollmentLine: null,
        cards: formattedSummary.cards.map((card) => ({ ...card, badge: null, note: null })) };
      cardsView.sync(formattedSummary.cards);
    }
    paintModeHelp();
  }
  function armBoundaryTimer() {
    clearTimeout(boundaryTimer); boundaryTimer = null;
    const at = summaryState === 'ready' ? nextEnrollmentBoundary(summary?.enrollment, Date.now()) : null;
    if (at === null) return;
    boundaryTimer = setTimeout(() => {
      boundaryTimer = null;
      if (Date.now() >= at) void refreshSummary(); else armBoundaryTimer();
    }, boundaryDelay(at, Date.now()));
  }
  // True when a schedule boundary passed since the shown summary arrived.
  const enrollmentStale = () => summaryState === 'ready' && enrollmentBoundaryCrossed(summary?.enrollment, summaryAsOf, Date.now());
  async function refreshForSchedule() {
    await refreshSummary();
    $('status').textContent = ENROLLMENT_CHANGED_NOTICE;
  }
  // A card's retest is a protected start: it never replaces a run in progress,
  // here (gate) or on the server (drill lock), and a second click is refused.
  async function startCardRetest(card) {
    if (enrollmentStale()) { await refreshForSchedule(); return; }
    await controller.start({ mode: 'retest', assessmentId: card.id }, { protectUnfinished: true });
    await refreshSummary();
  }
  async function refreshSummary() {
    try {
      const requestedAt = Date.now();
      const settled = await latestSummary(() => api('/api/summary'));
      if (!settled.current) return;
      const response = settled.value;
      if (!response.ok) { $('summary-status').textContent = formatStudyError(response); summary = null; summaryState = 'failed'; dropEnrollmentGuidance(); paintNextStep(); return; }
      summary = response.summary; summaryState = 'ready'; summaryAsOf = requestedAt;
      const formatted = formatSummary(summary);
      formattedSummary = formatted;
      paintModeHelp();
      $('summary-status').textContent = '';
      $('source').textContent = `출처: ${formatted.sourceShort}`; $('goal').textContent = formatted.goal; $('due').textContent = formatted.due;
      for (const origin of ['game', 'practice']) {
        const metrics = formatted[origin];
        $(`${origin}-rate`).textContent = metrics.rate; $(`${origin}-samples`).textContent = metrics.samples;
        $(`${origin}-rate`).classList.toggle('is-empty', !/^\d+%$/.test(metrics.rate));
        $(`${origin}-coverage`).textContent = metrics.coverage; $(`${origin}-calibration`).textContent = metrics.calibration;
      }
      $('assessments-enrollment').hidden = !formatted.enrollmentLine;
      $('assessments-enrollment').textContent = formatted.enrollmentLine ?? '';
      cardsView.sync(formatted.cards);
      paintTrends(formatTrends(summary.trends));
      armBoundaryTimer();
      paintNextStep();
      // A boundary passed while this request was in flight: the answer may predate it. Ask again; the new request
      // is sent after the boundary, so this cannot repeat.
      if (enrollmentStale()) void refreshSummary();
    } catch { $('summary-status').textContent = '학습 요약을 불러오지 못했습니다. 상태 확인을 눌러 주세요.'; summary = null; summaryState = 'failed'; dropEnrollmentGuidance(); paintNextStep(); }
  }
  function paintTrends(trends) {
    const box = $('trends'); box.replaceChildren();
    for (const series of trends.series) {
      const list = node('ul', '', 'trend-list');
      list.setAttribute('aria-label', series.label);
      for (const row of series.rows) {
        const item = node('li', '', 'trend-row');
        const track = node('span', '', 'freq-track'); track.setAttribute('aria-hidden', 'true');
        const fill = node('span', '', 'freq-fill'); fill.style.width = `${row.width}%`; track.append(fill);
        item.append(node('span', row.date, 'trend-date'), track, node('span', `${row.rate}${row.baseline ? ` (폴드 ${row.baseline})` : ''}`, 'trend-value'));
        list.append(item);
      }
      box.append(node('h3', series.label, 'trend-title'), list);
    }
    for (const group of trends.game) {
      const list = node('ul', '', 'trend-list');
      list.setAttribute('aria-label', `${group.label} 허용률`);
      for (const row of group.rows) {
        const item = node('li', '', 'trend-row');
        const track = node('span', '', 'freq-track'); track.setAttribute('aria-hidden', 'true');
        const fill = node('span', '', 'freq-fill'); fill.style.width = `${row.width}%`; track.append(fill);
        item.append(node('span', row.label, 'trend-date'), track, node('span', `${row.rate} · ${row.graded}`, 'trend-value'));
        list.append(item);
      }
      box.append(node('h3', group.label, 'trend-title'), list);
    }
    if (!box.children.length) box.append(node('p', '완료한 연습 실행과 채점된 게임이 쌓이면 추세가 보입니다.'));
  }
  $('mode').value = entry.mode;
  $('mode').addEventListener('change', paintModeHelp);
  paintModeHelp();
  try { mountPotOddsDrill(document, $('pot-odds'), { storage: localStorage }); } catch { $('pot-odds').textContent = '팟 오즈 연습을 준비하지 못했습니다.'; }
  $('open-help').addEventListener('click', () => openHelp('learning'));
  $('open-display-settings').addEventListener('click', () => openDisplaySettings());
  $('source-help').append(helpButton('learning', '학습 수치의 의미'));
  if (!entry.token) { if ($('replay-entry-status')) $('replay-entry-status').textContent = '플레이 기록을 열려면 접속 토큰이 필요합니다.'; $('status').textContent = '접속 토큰이 없습니다. 학습실에서 제공한 링크를 다시 열어 주세요.'; $('start').disabled = true; summaryState = 'failed'; paintNextStep(); return; }
  async function refreshReplayEntry() {
    if (!$('replay-entry-link')) return;
    $('replay-entry-link').hidden = true;
    $('replay-entry-retry').hidden = true;
    let health;
    try { health = await api('/api/health'); } catch { health = null; }
    const state = replayEntryState(health, entry.token);
    $('replay-entry-status').textContent = state.message;
    $('replay-entry-retry').hidden = !state.retry;
    if (state.href) { $('replay-entry-link').href = state.href; $('replay-entry-link').hidden = false; }
  }
  $('replay-entry-retry')?.addEventListener('click', refreshReplayEntry);
  void refreshReplayEntry();
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(entry.token));
    const identity = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    controller = createStudyController({ api, storage: sessionStorage, storageKey: `holdem.study.v1.${identity}`, initialTarget: { spotKey: entry.spotKey, handClass: entry.handClass }, onState: render });
    $('start').addEventListener('click', async () => {
      const source = KNOWN_REFERENCE_SOURCES.find(s=>s.version === $('reference-source')?.value);
      await controller.start({ mode: $('mode').value, ...(source ? {source} : {}) });
      await refreshSummary();
    });
    $('next-step-start').addEventListener('click', async () => {
      // Re-derived from the current summary and state at click time; the gate and
      // the controller both refuse while anything is busy, recovering or unfinished.
      if (enrollmentStale()) { await refreshForSchedule(); return; }
      const view = summary && summaryState === 'ready' ? nextStepView(summary, controller.state, { authenticated }) : null;
      if (!view || view.disabled) return;
      await controller.start(view.plan.selectors, { protectUnfinished: true });
      await refreshSummary();
    });
    $('next').addEventListener('click', async () => { await controller.next(); await refreshSummary(); });
    $('recover').addEventListener('click', async () => { await controller.restore(); await refreshSummary(); });
    $('retry').addEventListener('click', async () => { await controller.retry(); await refreshSummary(); });
    await controller.restore(); await refreshSummary();
    const heartbeat = setInterval(async () => {
      if (!authenticated || document.visibilityState === 'hidden') return;
      try { const response = await api('/api/heartbeat', { method: 'POST', body: {} }); if (!response.ok) $('status').textContent = formatStudyError(response); }
      catch { $('status').textContent = '학습실 연결을 확인하고 있습니다. 저장된 답안은 상태 확인으로 복원할 수 있습니다.'; }
    }, 30000);
    window.addEventListener('pagehide', () => clearInterval(heartbeat));
    // A tab that was hidden may have slept through a schedule boundary.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (summaryState === 'failed' || summary?.enrollment != null)) void refreshSummary();
    });
  } catch { $('status').textContent = '안전한 복구 저장소를 준비하지 못했습니다. 브라우저 저장 공간과 접속 링크를 확인하세요.'; $('start').disabled = true; }
}

if (typeof document !== 'undefined') await mountStudy();
