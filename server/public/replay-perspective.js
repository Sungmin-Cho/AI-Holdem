/** Replay display projection (design §7.1): the verified replay and its rebuilt
 * model go in, a closed, presentation-only frame comes out for one cursor.
 *
 * `own` is the viewer's table-side view: the viewer's cards, and only what had
 * happened by the cursor. It never reads a field of the future, the result or
 * another seat's cards — it builds each frame from an explicit per-step
 * allowlist — so nothing leaks through the DOM, the accessibility tree or the
 * text list. `full` is the existing after-the-hand replay inside the server's
 * reveal scope. Fact cards come from the whole model (so the numbers match the
 * live table) but are only attached to the step they explain.
 *
 * The renderer receives frames only; it never sees `replay`, `model` or `view`. */
import { streetStarts } from './replay-model.js';
import { ownCap } from './replay-controller.js';
import { replayFactsLine } from './replay-facts.js';
import { parseCard, cardLabel } from './card-render.js';

export const OWN_BANNER = '내 시점 · 결과와 상대 패를 가리고 있습니다';
export const POLICY_LEGEND = '정책 플레이어 — 빈도표에서 샘플된 결정, 사유 없음. 정책 정체는 종합 리뷰에서 공개';
export const STREET_LABEL = Object.freeze({ preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버', result: '결과' });
const VERB_LABEL = Object.freeze({ fold: '폴드', check: '체크', call: '콜', bet: '벳', raise: '레이즈' });

const boardText = (cards) => cards.map((code) => cardLabel(parseCard(code))).join(' ');

/** Words for one step, shared by the timeline row and the current-step panel.
 * `positions` maps a seat to its table position (public); `name` and `amount`
 * format a seat and a chip count. */
export function stepHeadline(step, { positions = {}, name, amount }) {
  const who = (playerId) => [name(playerId), positions[playerId] ?? ''].filter(Boolean).join(' · ');
  if (step.kind === 'deal') return '카드 배분 · 블라인드';
  if (step.kind === 'street') return `${STREET_LABEL[step.street]} · ${boardText(step.board)}`;
  if (step.kind === 'runout') return `${STREET_LABEL[step.street]} · ${boardText(step.board)} (올인 런아웃)`;
  if (step.kind === 'return') return '콜되지 않은 베팅 반환';
  if (step.kind === 'showdown') return '쇼다운';
  if (step.kind === 'result') return '결과';
  const verb = VERB_LABEL[step.verb] ?? step.verb;
  return [who(step.actor), verb, step.amount != null ? amount(step.amount) : ''].filter(Boolean).join(' ');
}

/** Fact lines for the viewer's own actions, computed from the full verified
 * model and replay (the decision match and the equity seed are the live
 * table's) and cached per step. */
export function createFactsProvider(model, replay, viewer = 'user') {
  const cache = new Map();
  return (index) => {
    if (!cache.has(index)) cache.set(index, replayFactsLine(model, replay, viewer, index));
    return cache.get(index);
  };
}

/** The fields of a step a frame may use. The own view copies only what is
 * public at the table at that moment; the result's awards, pots and the
 * showdown reveals belong to the full replay alone. */
function publicStep(step, own) {
  const out = {
    index: step.index,
    kind: step.kind,
    street: step.street,
    board: [...step.board],
    stacks: { ...step.stacks },
    bets: { ...step.bets },
    pot: step.pot,
    total: step.total,
    folded: [...step.folded],
    allIn: [...step.allIn],
    actor: step.actor ?? null,
    actionIndex: step.actionIndex ?? null,
    verb: null,
    amount: null,
  };
  if (step.kind === 'action') {
    out.verb = step.verb;
    out.amount = step.amount ?? null;
  } else if (step.kind === 'deal') {
    out.posts = (step.posts ?? []).map((post) => ({ playerId: post.playerId, amount: post.amount }));
  } else if (step.kind === 'street') {
    out.collected = step.collected;
  } else if (step.kind === 'return') {
    out.returned = (step.returned ?? []).map((row) => ({ playerId: row.playerId, amount: row.amount }));
  }
  if (!own) {
    if (step.kind === 'showdown') out.reveals = step.reveals.map((row) => ({ playerId: row.playerId, handName: row.handName ?? null }));
    if (step.kind === 'result') {
      out.returned = (step.returned ?? []).map((row) => ({ playerId: row.playerId, amount: row.amount }));
      out.awards = step.awards.map((row) => ({ ...row }));
      out.pots = step.pots.map((pot) => ({ potIndex: pot.potIndex, amount: pot.amount, winners: pot.winners.map((row) => ({ ...row })) }));
    }
  }
  return out;
}

/** The header lines of a perspective. The own header carries the hand number,
 * the blinds and the own-view line only (plus whether the viewer sat the hand
 * out); winners and the disclosure belong to the full replay. It needs no
 * model, so a hand whose numbers cannot be rebuilt still gets its header. */
export function buildHeader({ perspective, replay, view, name, viewer = 'user' }) {
  const absent = !Object.prototype.hasOwnProperty.call(replay.startStacks ?? {}, viewer);
  if (perspective !== 'full') {
    return {
      kind: 'own', handNo: replay.handNo, blinds: Array.isArray(replay.blinds) ? [...replay.blinds] : null, banner: OWN_BANNER, absent,
    };
  }
  return {
    kind: 'full',
    handNo: view.header.handNo,
    blinds: Array.isArray(view.header.blinds) ? [...view.header.blinds] : null,
    button: typeof replay.button === 'string' ? name(replay.button) : null,
    winners: [...view.header.winners],
    disclaimer: view.header.disclaimer,
    reliability: view.header.reliability,
    absent,
  };
}

export function createProjector({
  perspective = 'own', replay, model, view, viewer = 'user', name, facts, forcedFacts = true,
} = {}) {
  const own = perspective !== 'full';
  const steps = model.steps;
  const cap = own ? ownCap(steps) : steps.length - 1;
  const positions = { ...(replay.positions ?? {}) };
  const nameOf = name ?? ((playerId) => (playerId === 'user' ? '나' : playerId));
  const rows = view.streets.flatMap((street) => street.rows);
  const rowOf = (step) => (step.actionIndex == null ? null : rows[step.actionIndex] ?? null);
  const factsAt = facts ?? createFactsProvider(model, replay, viewer);
  const starts = streetStarts(steps);

  // What the viewer may see of the hole cards: their own, or the server's reveal scope.
  const visibleHoles = {};
  if (own) {
    const mine = replay.holes?.[viewer];
    if (Array.isArray(mine) && mine.length === 2) visibleHoles[viewer] = [...mine];
  } else {
    for (const [playerId, cards] of Object.entries(replay.holes ?? {})) if (Array.isArray(cards)) visibleHoles[playerId] = [...cards];
  }

  // The viewer sits at the bottom like the live table; a viewer who sat the hand out gives the first seat.
  const order = model.seats;
  const start = Math.max(0, order.indexOf(viewer));
  const layoutSeats = order.map((_, offset) => {
    const playerId = order[(start + offset) % order.length];
    return { playerId, name: nameOf(playerId), position: positions[playerId] ?? '' };
  });
  const policySeats = !own && rows.some((row) => row.reasonKind === 'policy');
  const layout = { seats: layoutSeats, crowded: order.length >= 7, legend: policySeats ? POLICY_LEGEND : null };

  const header = buildHeader({ perspective: own ? 'own' : 'full', replay, view, name: nameOf, viewer });

  function timelineItem(step, fmt) {
    const row = rowOf(step);
    const item = { key: step.index, kind: step.kind, parts: [], cards: null, study: null };
    if (row) {
      item.parts.push({ className: 'replay-name', text: [row.name, row.position].filter(Boolean).join(' · ') });
      item.parts.push({ className: `replay-act is-${row.verb}`, text: row.verbLabel ?? row.verb });
      if (row.amount != null) item.parts.push({ className: 'replay-amount num', text: fmt.amount(row.amount) });
      if (replay.actions?.[step.actionIndex]?.forced === true && step.actor === viewer) {
        item.parts.push({ className: 'replayer-forced-tag', text: '강제 액션(기록)' });
      }
      if (!own && row.reasonKind === 'policy') item.parts.push({ className: 'replayer-policy-tag', text: '정책 결정' });
      if (!own && row.study?.evaluationId) item.study = row.study.evaluationId;
    } else {
      const wording = step.kind === 'street' || step.kind === 'runout'
        ? `${STREET_LABEL[step.street]}${step.kind === 'runout' ? ' (런아웃)' : ''}`
        : stepHeadline(step, { positions, name: nameOf, amount: fmt.amount });
      item.parts.push({ className: 'replayer-jump-label', text: wording });
      if (step.kind === 'street' || step.kind === 'runout') item.cards = step.board.slice(step.street === 'flop' ? 0 : -1);
    }
    return item;
  }

  function detailsFor(step, fmt) {
    const lines = [];
    const line = (className, text) => lines.push({ className, text });
    const money = fmt.amount;
    if (step.kind === 'deal') {
      for (const post of step.posts ?? []) line('replayer-line', `${nameOf(post.playerId)} ${positions[post.playerId] ?? ''} 블라인드 ${money(post.amount)}`.replace(/\s+/g, ' '));
    } else if (step.kind === 'showdown') {
      for (const row of step.reveals ?? []) line('replayer-line', `${nameOf(row.playerId)}${row.handName ? ` · ${row.handName}` : ' · 공개'}`);
    } else if (step.kind === 'return') {
      for (const row of step.returned ?? []) line('replayer-line', `${nameOf(row.playerId)}에게 돌려준 금액 ${money(row.amount)} (아무도 따라오지 않은 베팅)`);
    } else if (step.kind === 'result') {
      for (const row of step.returned ?? []) line('replayer-line', `${nameOf(row.playerId)}에게 돌려준 금액 ${money(row.amount)}`);
      for (const pot of step.pots ?? []) {
        const label = pot.potIndex === 0 ? '메인 팟' : `사이드 팟 ${pot.potIndex}`;
        line('replayer-line', `${label} ${money(pot.amount)} · ${pot.winners.map((row) => `${nameOf(row.playerId)} ${money(row.share)} 획득`).join(', ')}`);
      }
    } else if (step.kind === 'action') {
      const row = rowOf(step);
      const mine = step.actor === viewer;
      const forced = replay.actions?.[step.actionIndex]?.forced === true;
      if (forced && mine) line('replay-forced', '강제 액션(기록)');
      if (!own) {
        if (row?.reasonKind === 'policy') line('replayer-policy-tag', '정책 결정');
        else if (row?.reasonText) line('replay-reason', row.reasonText);
      }
      // The memo and fact card belong to the viewer's action once it is made.
      if (row?.noteText && (!own || mine)) line('replay-note', row.noteText);
      if (mine && (!forced || forcedFacts)) {
        const fact = factsAt(step.index);
        if (fact) line('replay-facts', `사실 카드(엔진 계산) · ${fact}`);
      }
      if (!own) {
        if (row?.coach?.status === 'ready') {
          line('replay-coach', `왜: ${row.coach.why}`);
          line('replay-coach', `결과: ${row.coach.outcome}`);
          line('replay-coach', `대안: ${row.coach.alternative}`);
        } else if (row?.coach?.message) line('replay-coach is-pending', row.coach.message);
        if (row?.study?.evaluationId) lines.push({ study: row.study.evaluationId });
      }
    } else if (step.kind === 'runout') {
      line('replayer-line', '더 베팅할 수 있는 플레이어가 없어 남은 보드를 공개합니다.');
    } else {
      line('replayer-line', step.collected > 0 ? `보드 공개 · 이전 스트리트 베팅이 팟으로 모였습니다(${money(step.collected)}).` : '보드 공개 · 이전 스트리트에는 베팅이 없었습니다.');
    }
    return lines;
  }

  function at(requested, fmt) {
    const cursor = Math.max(0, Math.min(cap, Number.isFinite(requested) ? Math.trunc(requested) : 0));
    const step = publicStep(steps[cursor], own);
    const winners = new Set((step.awards ?? []).map((row) => row.playerId));
    const revealed = new Map((step.reveals ?? []).map((row) => [row.playerId, row.handName]));
    const seats = {};
    for (const { playerId } of layoutSeats) {
      const folded = step.folded.includes(playerId);
      const allIn = step.allIn.includes(playerId) && !folded;
      const chips = step.bets[playerId] ?? 0;
      const tag = winners.has(playerId) ? '승리'
        : revealed.has(playerId) ? (revealed.get(playerId) ?? '공개')
          : step.actor === playerId ? (VERB_LABEL[step.verb] ?? step.verb)
            : folded ? '폴드' : step.allIn.includes(playerId) ? '올인' : '';
      seats[playerId] = {
        stack: fmt.short(step.stacks[playerId]),
        bet: chips > 0 ? fmt.short(chips) : '',
        tag,
        actor: step.actor === playerId,
        folded,
        allIn,
        winner: winners.has(playerId),
      };
    }
    const potText = step.kind === 'result'
      ? (step.pots.length > 2 ? `팟 ${fmt.short(step.total)} · ${step.pots.length}개`
        : step.pots.map((row) => `${row.potIndex === 0 ? (step.pots.length > 1 ? '메인' : '팟') : `사이드 ${row.potIndex}`} ${fmt.short(row.amount)}`).join(' · '))
      : step.total > step.pot ? `팟 ${fmt.short(step.pot)} · 베팅 포함 ${fmt.short(step.total)}` : `팟 ${fmt.short(step.pot)}`;
    const summary = [`보드 ${step.board.length ? boardText(step.board) : '없음'} · 팟 ${fmt.amount(step.kind === 'result' ? step.total : step.pot)}`];
    for (const { playerId } of layoutSeats) {
      const holes = visibleHoles[playerId];
      const state = winners.has(playerId) ? '승리' : step.folded.includes(playerId) ? '폴드' : step.allIn.includes(playerId) ? '올인' : '';
      const bet = step.bets[playerId] ?? 0;
      summary.push([
        `${nameOf(playerId)}${positions[playerId] ? ` ${positions[playerId]}` : ''}: 스택 ${fmt.amount(step.stacks[playerId])}`,
        bet > 0 ? `이번 스트리트 베팅 ${fmt.amount(bet)}` : '',
        `카드 ${holes ? boardText(holes) : '비공개'}`,
        state,
      ].filter(Boolean).join(', '));
    }
    const currentKey = step.kind === 'result' || step.kind === 'showdown' ? 'result' : step.street;
    const timeline = [];
    for (let index = 0; index <= (own ? cursor : steps.length - 1); index += 1) timeline.push(timelineItem(steps[index], fmt));
    const controls = {
      streets: starts
        .filter((row) => !own || row.index <= cursor)
        .map((row) => ({ key: row.key, label: STREET_LABEL[row.key] ?? row.key, index: row.index, current: row.key === currentKey })),
      progress: own ? `단계 ${cursor + 1}` : `${cursor + 1} / ${steps.length}`,
      last: !own,
    };
    if (!own) controls.limit = steps.length - 1;
    return {
      cursor,
      kind: step.kind,
      street: step.street,
      headline: stepHeadline(step, { positions, name: nameOf, amount: fmt.amount }),
      board: step.board,
      holes: Object.fromEntries(Object.entries(visibleHoles).map(([playerId, cards]) => [playerId, [...cards]])),
      pot: potText,
      seats,
      summary,
      details: detailsFor(step, fmt),
      timeline,
      controls,
    };
  }

  return { perspective: own ? 'own' : 'full', viewer, cap, layout, header, at };
}

/** The renderer's input when its caller predates projectors: the verified
 * replay, model and view become a full-perspective projector. */
export function resolveProjector(ctx) {
  if (ctx.projector) return ctx.projector;
  return createProjector({
    perspective: 'full',
    replay: ctx.replay,
    model: ctx.model,
    view: ctx.view,
    viewer: ctx.viewer ?? 'user',
    name: ctx.name,
    facts: ctx.facts,
  });
}
