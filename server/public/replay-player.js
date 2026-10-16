/** Replay player (design §7): one mounted replay for a finished hand with its
 * own/full perspective toggle, header, own-decision navigation, one autoplay
 * timer and a text fallback. The library page calls `mountReplayPlayer`; it
 * owns which hand is open, this module owns what the viewer sees of it.
 *
 *   dispose()            stops the timer and removes the player
 *   setUnit(unit)        'chips' | 'bb', repainted in place
 *   setPerspective(p)    'own' | 'full' (the same thing the toggle does)
 *   state()              { step, playing, speed, perspective, notice }
 *
 * The verified replay is rebuilt into a model once; both perspectives and the
 * fact-card cache share it. Only perspective frames reach the renderer. */
import { formatReplay } from './replay-format.js';
import { buildReplaySteps, replaySeatOrder } from './replay-model.js';
import { mountReplayer } from './replayer.js';
import { createProjector, createFactsProvider, buildHeader } from './replay-perspective.js';
import { createReplayController, NO_MORE_DECISIONS } from './replay-controller.js';
import { formatAmount } from './chip-format.js';
import { renderMiniCard } from './card-render.js';

export const NO_MORE_DECISIONS_TEXT = '더 이동할 내 결정이 없습니다';
export const OWN_CAP_HINT = '여기까지가 내 시점에서 볼 수 있는 마지막 장면입니다. 결과와 상대 패는 “전체 복기 보기”에서 확인할 수 있습니다.';
export const OWN_FALLBACK_NOTICE = '이 핸드는 기록된 숫자로 테이블을 다시 그릴 수 없습니다. 내 시점에서는 목록을 대신 보여 드리지 않습니다. “전체 복기 보기”를 선택하면 목록으로 볼 수 있습니다.';
export const FULL_FALLBACK_NOTICE = '이 핸드는 기록된 숫자로 테이블을 다시 그릴 수 없어 목록으로 보여 드립니다.';
export const ABSENT_NOTICE = '이 핸드에 참여하지 않았습니다.';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const chipNumber = (value) => Number(value).toLocaleString('ko-KR');

function renderHeader(doc, header) {
  const node = el(doc, 'div', 'replay-player-header');
  node.append(el(doc, 'h3', 'replay-player-title', `핸드 ${header.handNo}`));
  const meta = el(doc, 'div', 'replay-meta');
  if (header.blinds) meta.append(el(doc, 'span', 'replay-blinds', `블라인드 ${chipNumber(header.blinds[0])}/${chipNumber(header.blinds[1])}`));
  if (header.kind === 'full') {
    if (header.button) meta.append(el(doc, 'span', 'replay-button', `버튼 ${header.button}`));
    if (header.winners.length) meta.append(el(doc, 'span', 'replay-winners', `승자 ${header.winners.join(', ')}`));
  }
  node.append(meta);
  if (header.kind === 'own') node.append(el(doc, 'p', 'replay-player-banner', header.banner));
  else node.append(el(doc, 'p', 'replay-disclaimer', `${header.disclaimer}. ${header.reliability}`));
  if (header.absent) node.append(el(doc, 'p', 'replay-player-absent', ABSENT_NOTICE));
  return node;
}

/** The text replay of the full perspective: the fallback when the numbers of a
 * record cannot be rebuilt. It reads only the formatted view. */
function renderTextList(doc, view, { amount, onStudy }) {
  const list = el(doc, 'div', 'replay-list');
  const board = el(doc, 'div', 'replay-board');
  for (const code of view.header.board) board.append(renderMiniCard(code, { doc }));
  if (view.header.board.length) list.append(board);
  for (const street of view.streets) {
    const block = el(doc, 'section', 'replay-street');
    block.append(el(doc, 'h4', 'replay-street-name', street.label));
    for (const row of street.rows) {
      const line = el(doc, 'div', 'replay-row');
      line.append(el(doc, 'span', 'replay-name', [row.name, row.position].filter(Boolean).join(' · ')));
      line.append(el(doc, 'span', `replay-act is-${row.verb}`, row.verbLabel ?? row.verb));
      if (row.amount != null) line.append(el(doc, 'span', 'replay-amount num', amount(row.amount)));
      if (row.pot != null) line.append(el(doc, 'span', 'replay-pot num', `팟 ${amount(row.pot)}`));
      if (row.cards) {
        const cards = el(doc, 'span', 'replay-cards');
        for (const code of row.cards) cards.append(renderMiniCard(code, { doc }));
        line.append(cards);
      }
      if (row.recordedForced) line.append(el(doc, 'div', 'replay-forced', '강제 액션(기록)'));
      if (row.reasonText) line.append(el(doc, 'div', 'replay-reason', row.reasonText));
      if (row.noteText) line.append(el(doc, 'div', 'replay-note', row.noteText));
      if (row.coach?.status === 'ready') {
        const coach = el(doc, 'div', 'replay-coach');
        coach.append(el(doc, 'div', 'replay-coach-line', `왜: ${row.coach.why}`));
        coach.append(el(doc, 'div', 'replay-coach-line', `결과: ${row.coach.outcome}`));
        coach.append(el(doc, 'div', 'replay-coach-line', `대안: ${row.coach.alternative}`));
        line.append(coach);
      } else if (row.coach?.message) line.append(el(doc, 'div', 'replay-coach is-pending', row.coach.message));
      if (row.study?.evaluationId) {
        const link = el(doc, 'button', 'replay-study', '학습 카드');
        link.type = 'button';
        link.dataset.studyId = row.study.evaluationId;
        link.addEventListener('click', () => onStudy?.(row.study.evaluationId));
        line.append(link);
      }
      block.append(line);
    }
    list.append(block);
  }
  if (view.coachSummary) list.append(el(doc, 'p', 'replay-summary', view.coachSummary));
  return list;
}

export function mountReplayPlayer(container, {
  replay, names = {}, viewer = 'user', perspective = 'own', unit = 'chips', onStudy, coachNote, trainingItems, feedback, clock,
} = {}) {
  const doc = container.ownerDocument;
  let currentPerspective = perspective === 'full' ? 'full' : 'own';
  let currentUnit = unit === 'bb' ? 'bb' : 'chips';
  let disposed = false;
  let silent = false;
  let controller = null;
  let renderer = null;
  let fallback = null;

  const nameOf = (playerId) => names[playerId] ?? (playerId === 'user' ? '나' : playerId);
  const bb = Array.isArray(replay?.blinds) ? replay.blinds[1] : null;
  const amount = (value) => {
    const parts = formatAmount(value, bb, currentUnit);
    return [parts.primary, parts.secondary === 'BB 기준 없음' ? '' : parts.secondary].filter(Boolean).join(' / ');
  };
  const short = (value) => formatAmount(value, bb, currentUnit).primary;

  const root = el(doc, 'div', 'replay-player');
  container.append(root);
  // A hidden page must not keep a timer running; leaving it ends the player.
  const win = doc.defaultView;
  const onPageHide = () => handle.dispose();
  win?.addEventListener?.('pagehide', onPageHide);
  const handle = {
    dispose() {
      if (disposed) return;
      disposed = true;
      win?.removeEventListener?.('pagehide', onPageHide);
      controller?.dispose();
      root.remove();
    },
    setUnit() {},
    setPerspective() {},
    state: () => ({ step: 0, playing: false, speed: 1, perspective: currentPerspective, notice: null }),
    root,
  };

  // Without a feedback source the library has no coach: omit the wait copy and study cards.
  const view = formatReplay(replay, {
    coachNote, trainingItems, names, viewer, feedback: feedback ?? (coachNote !== undefined || trainingItems !== undefined ? 'live' : 'omit'),
  });
  if (view.kind === 'marker') {
    root.append(el(doc, 'p', 'replay-marker', view.message));
    return handle;
  }

  const header = el(doc, 'div', 'replay-player-header');
  const toggle = el(doc, 'div', 'replay-player-toggle');
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', '복기 관점');
  const ownButton = el(doc, 'button', 'btn btn-ghost replay-player-own', '내 시점');
  const fullButton = el(doc, 'button', 'btn btn-ghost replay-player-full', '전체 복기 보기');
  for (const [node, key, value] of [[ownButton, 'persp-own', 'own'], [fullButton, 'persp-full', 'full']]) {
    node.type = 'button';
    node.dataset.focusKey = key;
    node.addEventListener('click', () => handle.setPerspective(value));
  }
  toggle.append(ownButton, fullButton);
  const hint = el(doc, 'p', 'replay-player-hint');
  hint.setAttribute('role', 'status');
  const body = el(doc, 'div', 'replay-player-body');
  root.append(header, toggle, hint, body);

  const model = buildReplaySteps(replay, { seatOrder: replaySeatOrder(replay, Object.keys(names)) });
  const headers = (perspectiveName) => buildHeader({ perspective: perspectiveName, replay, view, name: nameOf, viewer });

  if (model.ok) {
    const facts = createFactsProvider(model, replay, viewer);
    const common = { replay, model, view, viewer, name: nameOf, facts };
    const projectors = { own: createProjector({ perspective: 'own', ...common, forcedFacts: false }), full: createProjector({ perspective: 'full', ...common, forcedFacts: false }) };
    controller = createReplayController({
      steps: model.steps,
      viewer,
      perspective: currentPerspective,
      // The study pause is part of both perspectives of the player.
      autoPause: 'own-decision',
      clock,
      onChange: () => { if (!silent && !disposed) { renderer?.paint(); paintShell(); } },
    });
    renderer = mountReplayer(body, {
      projector: projectors[currentPerspective],
      amount,
      short,
      state: () => {
        const state = controller.state();
        return { ...state, controls: controller.controls(), notice: state.notice === NO_MORE_DECISIONS ? NO_MORE_DECISIONS_TEXT : null };
      },
      onStep: (index) => controller.setStep(index),
      onPlay: () => controller.togglePlay(),
      onSpeed: (rate) => controller.setSpeed(rate),
      onPrevDecision: () => controller.prevDecision(),
      onNextDecision: () => controller.nextDecision(),
      onStudy,
      focusFallback: () => fullButton,
    });
    handle.projectors = projectors;
  }

  function paintFallback() {
    fallback?.remove();
    fallback = null;
    if (model.ok) return;
    fallback = el(doc, 'div', 'replay-player-fallback');
    if (currentPerspective === 'own') {
      fallback.append(el(doc, 'p', 'replay-marker replay-fallback', OWN_FALLBACK_NOTICE));
    } else {
      fallback.append(el(doc, 'p', 'replay-marker replay-fallback', FULL_FALLBACK_NOTICE));
      fallback.append(renderTextList(doc, view, { amount, onStudy }));
    }
    body.append(fallback);
  }

  function paintShell() {
    const next = renderHeader(doc, headers(currentPerspective));
    header.replaceChildren(...next.children);
    ownButton.setAttribute('aria-pressed', String(currentPerspective === 'own'));
    fullButton.setAttribute('aria-pressed', String(currentPerspective === 'full'));
    const atCap = controller && currentPerspective === 'own' && controller.state().step >= controller.limit();
    const text = atCap ? OWN_CAP_HINT : '';
    if (hint.textContent !== text) hint.textContent = text;
  }

  handle.setUnit = (next) => {
    if (disposed) return;
    currentUnit = next === 'bb' ? 'bb' : 'chips';
    renderer?.paint();
    paintFallback();
  };
  handle.setPerspective = (next) => {
    if (disposed) return;
    const target = next === 'full' ? 'full' : 'own';
    if (target === currentPerspective) return;
    currentPerspective = target;
    if (controller) {
      // One repaint for the whole switch: the controller's change is folded in.
      silent = true;
      try {
        controller.setPerspective(target);
        renderer.setProjector(handle.projectors[target]);
      } finally { silent = false; }
    }
    paintShell();
    paintFallback();
  };
  handle.state = () => (controller
    ? { ...controller.state(), perspective: currentPerspective }
    : { step: 0, playing: false, speed: 1, perspective: currentPerspective, notice: null });

  paintShell();
  paintFallback();
  return handle;
}
