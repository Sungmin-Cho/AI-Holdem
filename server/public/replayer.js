/** Visual hand replayer (design §10.1): a mini table, step controls, a
 * timeline and the current step explained. It only draws *frames* from a
 * projector (replay-perspective.js): it never reads the replay record, the
 * rebuilt model or the fact-card calculation, so whatever the perspective hid
 * is not in this module's reach. The table DOM is built once; each step is
 * painted in place, the timeline rows are keyed by step index and only
 * appended or removed at the end, so focus, the timeline scroll position and
 * the live region stay where the reader left them. */
import { renderCard, renderMiniCard } from './card-render.js';
import { ovalPoint, mobileSeatSlot } from './seat-format.js';
import { resolveProjector, stepHeadline, POLICY_LEGEND } from './replay-perspective.js';

export { stepHeadline, POLICY_LEGEND };
export const REPLAY_SPEEDS = Object.freeze([0.5, 1, 2]);

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function mountReplayer(container, ctx) {
  const doc = container.ownerDocument;
  let projector = resolveProjector(ctx);
  // The mini table has room for the primary unit only; lists keep both.
  const fmt = { amount: (value) => ctx.amount(value), short: (value) => (ctx.short ?? ctx.amount)(value) };
  const layout = projector.layout;
  let frame = null;

  const root = el(doc, 'div', 'replayer');
  // Seven or more seats get compact plates so neighbours never overlap.
  if (layout.crowded) root.classList.add('is-crowded');
  const legendNode = el(doc, 'p', 'replay-legend');

  // Mini table: the viewer sits at the bottom like the live table.
  const stage = el(doc, 'div', 'replayer-stage');
  stage.setAttribute('aria-hidden', 'true');
  const felt = el(doc, 'div', 'replayer-felt');
  const seatNodes = new Map();
  layout.seats.forEach(({ playerId, name, position }, offset) => {
    const at = ovalPoint(offset, layout.seats.length, 41, 38);
    // Phones use the live table's slot table (kept inside the felt).
    const slot = mobileSeatSlot(offset, layout.seats.length);
    const seat = el(doc, 'div', 'replayer-seat');
    seat.dataset.playerId = playerId;
    seat.style.setProperty('--seat-x', `${at.x}%`);
    seat.style.setProperty('--seat-y', `${at.y}%`);
    seat.style.setProperty('--seat-mx', `${11 + slot.x * 0.78}%`);
    seat.style.setProperty('--seat-my', `${9 + slot.y * 0.82}%`);
    const cards = el(doc, 'div', 'replayer-seat-cards');
    const plate = el(doc, 'div', 'replayer-plate');
    plate.append(
      el(doc, 'span', 'replayer-seat-name', name),
      el(doc, 'span', 'replayer-seat-pos', position),
      el(doc, 'span', 'replayer-seat-stack num'),
    );
    const marks = el(doc, 'div', 'replayer-seat-marks');
    const tag = el(doc, 'span', 'replayer-seat-tag');
    const bet = el(doc, 'span', 'replayer-seat-bet num');
    marks.append(tag, bet);
    seat.append(cards, plate, marks);
    felt.append(seat);
    seatNodes.set(playerId, { seat, cards, stack: plate.querySelector('.replayer-seat-stack'), tag, bet, holesKey: null });
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
  const current = () => ctx.state();
  const first = button('replayer-first', '처음', '처음 단계', 'ctl-first', () => ctx.onStep(0));
  const prev = button('replayer-prev', '이전', '이전 단계', 'ctl-prev', () => ctx.onStep(current().step - 1));
  // The visible word is the name ("재생" ↔ "일시정지"); no pressed state on top.
  const play = button('replayer-play', '재생', null, 'ctl-play', () => ctx.onPlay());
  const next = button('replayer-next', '다음', '다음 단계', 'ctl-next', () => ctx.onStep(current().step + 1));
  // Accessible names contain the visible word (WCAG 2.5.3); "끝" needs no label.
  // It exists only where the perspective may show the end of the hand.
  const lastStep = button('replayer-last', '끝', null, 'ctl-last', () => ctx.onStep(frame?.controls.limit ?? current().step));
  const transport = el(doc, 'div', 'replayer-transport');
  transport.append(first, prev, play, next);
  controls.append(transport);
  let decisions = null;
  let prevDecision = null;
  let nextDecision = null;
  if (ctx.onPrevDecision || ctx.onNextDecision) {
    decisions = el(doc, 'div', 'replayer-decisions');
    prevDecision = button('replayer-prev-decision', '이전 내 결정', null, 'ctl-prev-decision', () => ctx.onPrevDecision?.());
    nextDecision = button('replayer-next-decision', '다음 내 결정', null, 'ctl-next-decision', () => ctx.onNextDecision?.());
    decisions.append(prevDecision, nextDecision);
    controls.append(decisions);
  }
  const streets = el(doc, 'div', 'replayer-streets');
  const streetNodes = new Map();
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
  controls.append(streets, speedLabel, progress);
  const notice = el(doc, 'p', 'replayer-notice');
  notice.setAttribute('role', 'status');

  const now = el(doc, 'section', 'replayer-now');
  now.setAttribute('aria-label', '현재 단계');
  const nowTitle = el(doc, 'p', 'replayer-now-title');
  nowTitle.setAttribute('aria-live', 'polite');
  const nowDetail = el(doc, 'div', 'replayer-now-detail');
  // The drawn table is aria-hidden; this list says the same (board, pot, and
  // each seat's stack, bet, cards within the perspective, state) as text. It
  // is not a live region, so autoplay does not read it out on every step.
  const seatSummary = el(doc, 'ul', 'ui-sr-only replayer-seat-summary');
  seatSummary.setAttribute('aria-label', '테이블 상태');
  now.append(nowTitle, nowDetail, seatSummary);

  const timeline = el(doc, 'ol', 'replayer-timeline');
  timeline.setAttribute('aria-label', '진행 순서');
  const lower = el(doc, 'div', 'replayer-lower');
  lower.append(now, timeline);
  root.append(stage, controls, notice, lower);
  container.append(root);

  function studyButton(evaluationId, key) {
    const node = el(doc, 'button', 'replay-study', '학습 카드');
    node.type = 'button';
    node.dataset.studyId = evaluationId;
    node.dataset.focusKey = key;
    node.addEventListener('click', () => ctx.onStudy?.(evaluationId));
    return node;
  }

  // ── timeline rows, keyed by step index ────────────────────────────────
  const rowNodes = new Map();
  function buildRow(data) {
    const item = el(doc, 'li', `replayer-item is-${data.kind}`);
    const jump = el(doc, 'button', 'replayer-jump');
    jump.type = 'button';
    jump.dataset.step = String(data.key);
    jump.dataset.focusKey = `jump-${data.key}`;
    jump.addEventListener('click', () => ctx.onStep(data.key));
    item.append(jump);
    const entry = { item, jump, signature: null, study: null };
    return entry;
  }
  function fillRow(entry, data) {
    const signature = JSON.stringify([data.parts, data.cards, data.study]);
    if (entry.signature === signature) return;
    entry.signature = signature;
    entry.jump.replaceChildren(...data.parts.map((part) => el(doc, 'span', part.className, part.text)));
    if (data.cards) {
      const cards = el(doc, 'span', 'replay-cards');
      for (const code of data.cards) cards.append(renderMiniCard(code, { doc }));
      entry.jump.append(cards);
    }
    if (entry.study) { entry.study.remove(); entry.study = null; }
    if (data.study) {
      entry.study = studyButton(data.study, `tl-study-${data.study}`);
      entry.item.append(entry.study);
    }
  }
  function reconcileRows(rows) {
    const wanted = new Set(rows.map((row) => row.key));
    for (const [key, entry] of rowNodes) {
      if (!wanted.has(key)) { entry.item.remove(); rowNodes.delete(key); }
    }
    for (const data of rows) {
      let entry = rowNodes.get(data.key);
      if (!entry) {
        entry = buildRow(data);
        rowNodes.set(data.key, entry);
        timeline.append(entry.item);
      }
      fillRow(entry, data);
    }
    // Rows only ever grow or shrink at the end, so the order is already right;
    // if it somehow is not, put the same nodes back in order.
    const ordered = rows.map((data) => rowNodes.get(data.key).item);
    if (timeline.children.length !== ordered.length || ordered.some((node, at) => timeline.children[at] !== node)) {
      timeline.replaceChildren(...ordered);
    }
  }

  // ── street buttons: only the streets the perspective has reached ──────
  function reconcileStreets(list) {
    const wanted = new Set(list.map((row) => row.key));
    for (const [key, node] of streetNodes) {
      if (!wanted.has(key)) { node.remove(); streetNodes.delete(key); }
    }
    for (const row of list) {
      let node = streetNodes.get(row.key);
      if (!node) {
        node = button('replayer-street', row.label, null, `street-${row.key}`, () => ctx.onStep(Number(node.dataset.step)));
        streets.append(node);
        streetNodes.set(row.key, node);
      }
      node.dataset.step = String(row.index);
      if (row.current) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    }
    const ordered = list.map((row) => streetNodes.get(row.key));
    if (streets.children.length !== ordered.length || ordered.some((node, at) => streets.children[at] !== node)) {
      streets.replaceChildren(...ordered);
    }
  }

  let paintedCursor = null;
  let detailSignature = null;
  let boardKey = null;
  let summaryKey = null;
  let legendText = null;

  function paint() {
    const state = current();
    frame = projector.at(state.step, fmt);
    const active = doc.activeElement;
    const hadFocus = Boolean(active) && root.contains(active);
    const focusKey = hadFocus ? active.dataset?.focusKey ?? null : null;

    const legend = projector.layout.legend ?? null;
    if (legend !== legendText) {
      legendText = legend;
      if (legend) { legendNode.textContent = legend; root.prepend(legendNode); } else legendNode.remove();
    }

    for (const [playerId, seat] of seatNodes) {
      const view = frame.seats[playerId];
      seat.seat.classList.toggle('is-actor', view.actor);
      seat.seat.classList.toggle('is-folded', view.folded);
      seat.seat.classList.toggle('is-allin', view.allIn);
      seat.seat.classList.toggle('is-winner', view.winner);
      seat.stack.textContent = view.stack;
      seat.bet.hidden = !view.bet;
      seat.bet.textContent = view.bet;
      seat.tag.textContent = view.tag;
      seat.tag.hidden = !view.tag;
      const holes = frame.holes[playerId];
      const holesKey = Array.isArray(holes) ? holes.join(',') : '';
      if (seat.holesKey !== holesKey) {
        seat.holesKey = holesKey;
        const cards = [];
        for (let index = 0; index < 2; index += 1) cards.push(renderCard(Array.isArray(holes) ? holes[index] : null, { small: true, faceDown: !Array.isArray(holes), doc }));
        seat.cards.replaceChildren(...cards);
      }
    }
    const nextBoardKey = frame.board.join(',');
    if (nextBoardKey !== boardKey) {
      boardKey = nextBoardKey;
      board.replaceChildren();
      for (let slot = 0; slot < 5; slot += 1) board.append(renderCard(frame.board[slot], { small: true, slot: slot >= frame.board.length, doc }));
    }
    const nextSummary = frame.summary.join('\n');
    if (nextSummary !== summaryKey) {
      summaryKey = nextSummary;
      seatSummary.replaceChildren(...frame.summary.map((text) => el(doc, 'li', null, text)));
    }
    pot.textContent = frame.pot;

    const c = state.controls ?? {
      canFirst: frame.cursor > 0,
      canPrev: frame.cursor > 0,
      canPlay: true,
      canNext: frame.cursor < (frame.controls.limit ?? frame.cursor),
      canLast: frame.cursor < (frame.controls.limit ?? frame.cursor),
      canPrevDecision: false,
      canNextDecision: false,
    };
    first.disabled = c.canFirst === false;
    prev.disabled = c.canPrev === false;
    play.disabled = c.canPlay === false;
    next.disabled = c.canNext === false;
    if (frame.controls.last) {
      if (!lastStep.parentNode) transport.append(lastStep);
      lastStep.disabled = c.canLast === false;
    } else if (lastStep.parentNode) lastStep.remove();
    if (decisions) {
      prevDecision.disabled = !c.canPrevDecision;
      nextDecision.disabled = !c.canNextDecision;
    }
    play.textContent = state.playing ? '일시정지' : '재생';
    play.classList.toggle('is-playing', state.playing);
    speed.value = String(state.speed);
    progress.textContent = frame.controls.progress;
    const message = state.notice ?? '';
    if (notice.textContent !== message) notice.textContent = message;
    reconcileStreets(frame.controls.streets);

    // Autoplay would queue one announcement per step; speak only when paused.
    nowTitle.setAttribute('aria-live', state.playing ? 'off' : 'polite');
    if (nowTitle.textContent !== frame.headline) nowTitle.textContent = frame.headline;
    const signature = JSON.stringify(frame.details);
    if (signature !== detailSignature) {
      detailSignature = signature;
      nowDetail.replaceChildren(...frame.details.map((detail) => (detail.study
        ? studyButton(detail.study, `now-study-${detail.study}`)
        : el(doc, 'p', detail.className, detail.text))));
    }

    const hadRows = rowNodes.size;
    reconcileRows(frame.timeline);
    const currentRow = rowNodes.get(frame.cursor);
    for (const [key, entry] of rowNodes) {
      const isCurrent = key === frame.cursor;
      entry.item.classList.toggle('is-current', isCurrent);
      if (isCurrent) entry.jump.setAttribute('aria-current', 'step');
      else entry.jump.removeAttribute('aria-current');
    }
    if (paintedCursor !== frame.cursor || hadRows !== rowNodes.size) {
      // Keep the current row in view inside the timeline only (never the page).
      const row = currentRow.item;
      if (timeline.scrollHeight > timeline.clientHeight) {
        const top = row.offsetTop - timeline.offsetTop;
        if (top < timeline.scrollTop || top + row.offsetHeight > timeline.scrollTop + timeline.clientHeight) {
          timeline.scrollTop = Math.max(0, top - timeline.clientHeight / 2);
        }
      }
      paintedCursor = frame.cursor;
    }

    // Focus never leaves the dialog: a control that became disabled, or an
    // element that was replaced or removed, hands focus to a live control.
    const after = doc.activeElement;
    if (hadFocus && (after?.disabled || !root.contains(after))) {
      const same = focusKey ? controlsIn(root).find((node) => node.dataset.focusKey === focusKey && !node.disabled) : null;
      const rowFocus = currentRow.jump;
      const candidates = focusKey?.includes('study-') ? [rowFocus, play, ctx.focusFallback?.()] : [play, ctx.focusFallback?.(), rowFocus];
      (same ?? candidates.find((node) => node && !node.disabled))?.focus({ preventScroll: true });
    }
  }

  function controlsIn(scope) { return [...scope.querySelectorAll('button, select')]; }

  paint();
  return {
    paint,
    root,
    /** Switch to another perspective's frames for the same hand: the table,
     * seats and timeline stay mounted and are repainted in place. */
    setProjector(next) {
      const same = next.layout.seats.length === layout.seats.length
        && next.layout.seats.every((seat, at) => seat.playerId === layout.seats[at].playerId);
      if (!same) throw new Error('replayer: perspectives of one hand share one seating');
      projector = next;
      detailSignature = null;
      paint();
    },
    dispose() { root.remove(); },
  };
}
