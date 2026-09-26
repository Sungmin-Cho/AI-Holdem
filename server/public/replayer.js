/** Visual hand replayer (design §10.1): a mini table, step controls, a
 * timeline that is always visible and the current step explained. The DOM is
 * built once per replay/unit and each step is painted in place, so focus,
 * scroll position and the live region stay where the reader left them.
 * Cards come only from `replay.holes` (the server's reveal scope); reasons come
 * only from `reasonKind` via formatReplay (never from the `forced` flag). */
import { renderCard, renderMiniCard, parseCard, cardLabel } from './card-render.js';
import { ovalPoint, mobileSeatSlot } from './seat-format.js';
import { streetStarts } from './replay-model.js';

const STREET_LABEL = Object.freeze({ preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버', result: '결과' });
const VERB_LABEL = Object.freeze({ fold: '폴드', check: '체크', call: '콜', bet: '벳', raise: '레이즈' });
export const POLICY_LEGEND = '정책 플레이어 — 빈도표에서 샘플된 결정, 사유 없음. 정책 정체는 종합 리뷰에서 공개';
export const REPLAY_SPEEDS = Object.freeze([0.5, 1, 2]);

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const boardText = (cards) => cards.map((code) => cardLabel(parseCard(code))).join(' ');

/** Words for one step, shared by the timeline row and the current-step panel. */
export function stepHeadline(step, { replay, name, amount }) {
  const position = (playerId) => replay.positions?.[playerId] ?? '';
  const who = (playerId) => [name(playerId), position(playerId)].filter(Boolean).join(' · ');
  if (step.kind === 'deal') return '카드 배분 · 블라인드';
  if (step.kind === 'street') return `${STREET_LABEL[step.street]} · ${boardText(step.board)}`;
  if (step.kind === 'runout') return `${STREET_LABEL[step.street]} · ${boardText(step.board)} (올인 런아웃)`;
  if (step.kind === 'return') return '콜되지 않은 베팅 반환';
  if (step.kind === 'showdown') return '쇼다운';
  if (step.kind === 'result') return '결과';
  const verb = VERB_LABEL[step.verb] ?? step.verb;
  return [who(step.actor), verb, step.amount != null ? amount(step.amount) : ''].filter(Boolean).join(' ');
}

export function mountReplayer(container, ctx) {
  const doc = container.ownerDocument;
  const { replay, view, model, name, viewer, amount } = ctx;
  // The mini table has room for the primary unit only; lists keep both.
  const short = ctx.short ?? amount;
  const rows = view.streets.flatMap((street) => street.rows);
  const rowOf = (step) => (step.actionIndex == null ? null : rows[step.actionIndex] ?? null);
  const starts = streetStarts(model.steps);
  const policySeats = rows.some((row) => row.reasonKind === 'policy');

  const root = el(doc, 'div', 'replayer');
  // Seven or more seats get compact plates so neighbours never overlap.
  if (model.seats.length >= 7) root.classList.add('is-crowded');
  if (policySeats) root.append(el(doc, 'p', 'replay-legend', POLICY_LEGEND));

  // Mini table: the viewer sits at the bottom like the live table.
  const stage = el(doc, 'div', 'replayer-stage');
  stage.setAttribute('aria-hidden', 'true');
  const felt = el(doc, 'div', 'replayer-felt');
  const seatNodes = new Map();
  const order = model.seats;
  const start = Math.max(0, order.indexOf(viewer));
  order.forEach((_, offset) => {
    const playerId = order[(start + offset) % order.length];
    const at = ovalPoint(offset, order.length, 41, 38);
    // Phones use the live table's slot table (kept inside the felt).
    const slot = mobileSeatSlot(offset, order.length);
    const seat = el(doc, 'div', 'replayer-seat');
    seat.dataset.playerId = playerId;
    seat.style.setProperty('--seat-x', `${at.x}%`);
    seat.style.setProperty('--seat-y', `${at.y}%`);
    seat.style.setProperty('--seat-mx', `${11 + slot.x * 0.78}%`);
    seat.style.setProperty('--seat-my', `${9 + slot.y * 0.82}%`);
    const cards = el(doc, 'div', 'replayer-seat-cards');
    const holes = replay.holes?.[playerId];
    for (let index = 0; index < 2; index += 1) cards.append(renderCard(Array.isArray(holes) ? holes[index] : null, { small: true, faceDown: !Array.isArray(holes), doc }));
    const plate = el(doc, 'div', 'replayer-plate');
    plate.append(
      el(doc, 'span', 'replayer-seat-name', name(playerId)),
      el(doc, 'span', 'replayer-seat-pos', replay.positions?.[playerId] ?? ''),
      el(doc, 'span', 'replayer-seat-stack num'),
    );
    const marks = el(doc, 'div', 'replayer-seat-marks');
    marks.append(el(doc, 'span', 'replayer-seat-tag'), el(doc, 'span', 'replayer-seat-bet num'));
    seat.append(cards, plate, marks);
    felt.append(seat);
    seatNodes.set(playerId, seat);
  });
  const center = el(doc, 'div', 'replayer-center');
  const board = el(doc, 'div', 'replayer-board');
  const pot = el(doc, 'div', 'replayer-pot num');
  center.append(board, pot);
  felt.append(center);
  stage.append(felt);

  const controls = el(doc, 'div', 'replayer-controls');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', '복기 재생');
  const button = (className, text, label, key, onClick) => {
    const node = el(doc, 'button', `btn btn-ghost ${className}`, text);
    node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    node.dataset.focusKey = key;
    node.addEventListener('click', onClick);
    return node;
  };
  const first = button('replayer-first', '처음', '처음 단계', 'ctl-first', () => ctx.onStep(0));
  const prev = button('replayer-prev', '이전', '이전 단계', 'ctl-prev', () => ctx.onStep(ctx.state().step - 1));
  // The visible word is the name ("재생" ↔ "일시정지"); no pressed state on top.
  const play = button('replayer-play', '재생', null, 'ctl-play', () => ctx.onPlay());
  const next = button('replayer-next', '다음', '다음 단계', 'ctl-next', () => ctx.onStep(ctx.state().step + 1));
  // Accessible names contain the visible word (WCAG 2.5.3); "끝" needs no label.
  const lastStep = button('replayer-last', '끝', null, 'ctl-last', () => ctx.onStep(model.steps.length - 1));
  const transport = el(doc, 'div', 'replayer-transport');
  transport.append(first, prev, play, next, lastStep);
  const streets = el(doc, 'div', 'replayer-streets');
  const streetButtons = starts.map((row) => {
    const node = button('replayer-street', STREET_LABEL[row.key] ?? row.key, null, `street-${row.key}`, () => ctx.onStep(row.index));
    node.dataset.step = String(row.index);
    streets.append(node);
    return node;
  });
  const speedLabel = el(doc, 'label', 'replayer-speed');
  const speed = el(doc, 'select');
  speed.dataset.focusKey = 'ctl-speed';
  speed.setAttribute('aria-label', '재생 속도');
  for (const value of REPLAY_SPEEDS) {
    const option = el(doc, 'option', null, `${value}×`);
    option.value = String(value);
    speed.append(option);
  }
  speed.addEventListener('change', () => ctx.onSpeed(Number(speed.value)));
  speedLabel.append(el(doc, 'span', 'replayer-speed-text', '속도'), speed);
  const progress = el(doc, 'span', 'replayer-progress num');
  controls.append(transport, streets, speedLabel, progress);

  const now = el(doc, 'section', 'replayer-now');
  now.setAttribute('aria-label', '현재 단계');
  const nowTitle = el(doc, 'p', 'replayer-now-title');
  nowTitle.setAttribute('aria-live', 'polite');
  const nowDetail = el(doc, 'div', 'replayer-now-detail');
  now.append(nowTitle, nowDetail);

  const timeline = el(doc, 'ol', 'replayer-timeline');
  timeline.setAttribute('aria-label', '진행 순서');
  const items = model.steps.map((step) => {
    const item = el(doc, 'li', `replayer-item is-${step.kind}`);
    const jump = el(doc, 'button', 'replayer-jump');
    jump.type = 'button';
    jump.dataset.step = String(step.index);
    jump.dataset.focusKey = `jump-${step.index}`;
    const row = rowOf(step);
    if (row) {
      jump.append(el(doc, 'span', 'replay-name', [row.name, row.position].filter(Boolean).join(' · ')));
      jump.append(el(doc, 'span', `replay-act is-${row.verb}`, row.verbLabel ?? row.verb));
      if (row.amount != null) jump.append(el(doc, 'span', 'replay-amount num', amount(row.amount)));
      if (row.reasonKind === 'policy') jump.append(el(doc, 'span', 'replayer-policy-tag', '정책 결정'));
    } else {
      jump.append(el(doc, 'span', 'replayer-jump-label', step.kind === 'street' || step.kind === 'runout'
        ? `${STREET_LABEL[step.street]}${step.kind === 'runout' ? ' (런아웃)' : ''}`
        : stepHeadline(step, ctx)));
      if (step.kind === 'street' || step.kind === 'runout') {
        const cards = el(doc, 'span', 'replay-cards');
        for (const code of step.board.slice(step.street === 'flop' ? 0 : -1)) cards.append(renderMiniCard(code, { doc }));
        jump.append(cards);
      }
    }
    jump.addEventListener('click', () => ctx.onStep(step.index));
    item.append(jump);
    if (row?.study?.evaluationId) item.append(studyButton(row.study.evaluationId, `tl-study-${row.study.evaluationId}`));
    timeline.append(item);
    return { item, jump };
  });

  function studyButton(evaluationId, key) {
    const node = el(doc, 'button', 'replay-study', '학습 카드');
    node.type = 'button';
    node.dataset.studyId = evaluationId;
    node.dataset.focusKey = key;
    node.addEventListener('click', () => ctx.onStudy(evaluationId));
    return node;
  }

  const lower = el(doc, 'div', 'replayer-lower');
  lower.append(now, timeline);
  root.append(stage, controls, lower);
  container.append(root);

  let painted = null;
  function paint() {
    const { step: index, playing, speed: rate } = ctx.state();
    const active = doc.activeElement;
    const hadFocus = Boolean(active) && root.contains(active);
    const focusKey = hadFocus ? active.dataset?.focusKey ?? null : null;
    const step = model.steps[index];
    const winners = new Set((step.awards ?? []).map((row) => row.playerId));
    const revealed = new Map((step.reveals ?? []).map((row) => [row.playerId, row.handName]));
    for (const [playerId, seat] of seatNodes) {
      seat.classList.toggle('is-actor', step.actor === playerId);
      seat.classList.toggle('is-folded', step.folded.includes(playerId));
      seat.classList.toggle('is-allin', step.allIn.includes(playerId) && !step.folded.includes(playerId));
      seat.classList.toggle('is-winner', winners.has(playerId));
      seat.querySelector('.replayer-seat-stack').textContent = short(step.stacks[playerId]);
      const chips = step.bets[playerId] ?? 0;
      const betNode = seat.querySelector('.replayer-seat-bet');
      betNode.hidden = chips <= 0;
      betNode.textContent = chips > 0 ? short(chips) : '';
      const tagText = winners.has(playerId) ? '승리'
        : revealed.has(playerId) ? (revealed.get(playerId) ?? '공개')
          : step.actor === playerId ? (VERB_LABEL[step.verb] ?? step.verb)
            : step.folded.includes(playerId) ? '폴드' : step.allIn.includes(playerId) ? '올인' : '';
      const tag = seat.querySelector('.replayer-seat-tag');
      tag.textContent = tagText;
      tag.hidden = !tagText;
    }
    board.replaceChildren();
    for (let slot = 0; slot < 5; slot += 1) board.append(renderCard(step.board[slot], { small: true, slot: slot >= step.board.length, doc }));
    pot.textContent = step.kind === 'result'
      ? step.pots.map((row) => `${row.potIndex === 0 ? (step.pots.length > 1 ? '메인' : '팟') : `사이드 ${row.potIndex}`} ${short(row.amount)}`).join(' · ')
      : step.total > step.pot ? `팟 ${short(step.pot)} · 베팅 포함 ${short(step.total)}` : `팟 ${short(step.pot)}`;

    first.disabled = prev.disabled = index <= 0;
    next.disabled = lastStep.disabled = index >= model.steps.length - 1;
    play.textContent = playing ? '일시정지' : '재생';
    play.classList.toggle('is-playing', playing);
    speed.value = String(rate);
    progress.textContent = `${index + 1} / ${model.steps.length}`;
    const currentKey = step.kind === 'result' || step.kind === 'showdown' ? 'result' : step.street;
    starts.forEach((row, at) => {
      if (row.key === currentKey) streetButtons[at].setAttribute('aria-current', 'true');
      else streetButtons[at].removeAttribute('aria-current');
    });

    // Autoplay would queue one announcement per step; speak only when paused.
    nowTitle.setAttribute('aria-live', playing ? 'off' : 'polite');
    const headline = stepHeadline(step, ctx);
    if (nowTitle.textContent !== headline) nowTitle.textContent = headline;
    if (painted !== index) {
      nowDetail.replaceChildren(...detailFor(step));
      items.forEach(({ item, jump }, at) => {
        item.classList.toggle('is-current', at === index);
        if (at === index) jump.setAttribute('aria-current', 'step');
        else jump.removeAttribute('aria-current');
      });
      // Keep the current row in view inside the timeline only (never the page).
      const current = items[index].item;
      if (timeline.scrollHeight > timeline.clientHeight) {
        const top = current.offsetTop - timeline.offsetTop;
        if (top < timeline.scrollTop || top + current.offsetHeight > timeline.scrollTop + timeline.clientHeight) {
          timeline.scrollTop = Math.max(0, top - timeline.clientHeight / 2);
        }
      }
      painted = index;
    }
    // Focus never leaves the dialog: a control that became disabled, or a
    // current-step button that was replaced, hands focus to a live control.
    const now = doc.activeElement;
    if (hadFocus && (now?.disabled || !root.contains(now))) {
      const same = focusKey ? controlsIn(root).find((node) => node.dataset.focusKey === focusKey && !node.disabled) : null;
      // A transport control hands focus to Play; anything else to the current timeline row.
      const fallback = focusKey?.startsWith('ctl-') ? play : items[index].jump;
      (same ?? fallback).focus({ preventScroll: true });
    }
  }

  function controlsIn(scope) { return [...scope.querySelectorAll('button, select')]; }

  function detailFor(step) {
    const lines = [];
    const line = (className, text) => lines.push(el(doc, 'p', className, text));
    if (step.kind === 'deal') {
      for (const post of step.posts ?? []) line('replayer-line', `${name(post.playerId)} ${replay.positions?.[post.playerId] ?? ''} 블라인드 ${amount(post.amount)}`.replace(/\s+/g, ' '));
    } else if (step.kind === 'showdown') {
      for (const row of step.reveals) line('replayer-line', `${name(row.playerId)}${row.handName ? ` · ${row.handName}` : ' · 공개'}`);
    } else if (step.kind === 'return') {
      for (const row of step.returned) line('replayer-line', `${name(row.playerId)}에게 돌려준 금액 ${amount(row.amount)} (아무도 따라오지 않은 베팅)`);
    } else if (step.kind === 'result') {
      for (const row of step.returned) line('replayer-line', `${name(row.playerId)}에게 돌려준 금액 ${amount(row.amount)}`);
      for (const pot of step.pots) {
        const label = pot.potIndex === 0 ? '메인 팟' : `사이드 팟 ${pot.potIndex}`;
        line('replayer-line', `${label} ${amount(pot.amount)} · ${pot.winners.map((row) => `${name(row.playerId)} ${amount(row.share)} 획득`).join(', ')}`);
      }
    } else if (step.kind === 'action') {
      const row = rowOf(step);
      if (row?.reasonKind === 'policy') line('replayer-policy-tag', '정책 결정');
      else if (row?.reasonText) line('replay-reason', row.reasonText);
      if (row?.noteText) line('replay-note', row.noteText);
      if (row?.coach?.status === 'ready') {
        line('replay-coach', `왜: ${row.coach.why}`);
        line('replay-coach', `결과: ${row.coach.outcome}`);
        line('replay-coach', `대안: ${row.coach.alternative}`);
      } else if (row?.coach?.message) line('replay-coach is-pending', row.coach.message);
      if (row?.study?.evaluationId) lines.push(studyButton(row.study.evaluationId, `now-study-${row.study.evaluationId}`));
    } else if (step.kind === 'runout') {
      // Only a fact: someone may still hold chips (a covered call, a returned bet).
      line('replayer-line', '더 베팅할 수 있는 플레이어가 없어 남은 보드를 공개합니다.');
    } else {
      line('replayer-line', step.collected > 0 ? `보드 공개 · 이전 스트리트 베팅이 팟으로 모였습니다(${amount(step.collected)}).` : '보드 공개 · 이전 스트리트에는 베팅이 없었습니다.');
    }
    return lines;
  }

  paint();
  return { paint, root };
}
