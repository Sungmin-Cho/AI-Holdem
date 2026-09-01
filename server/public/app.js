import { formatTrainingCard } from './training-format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SUIT = {
  s: { id: 'suit-s', name: '스페이드', red: false },
  h: { id: 'suit-h', name: '하트', red: true },
  d: { id: 'suit-d', name: '다이아몬드', red: true },
  c: { id: 'suit-c', name: '클럽', red: false },
};
const STREET = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' };
const ACTION = { fold: '폴드', check: '체크', call: '콜', bet: '벳', raise: '레이즈' };

const ui = { view: null, log: [], coach: [], training: [], review: undefined };
let pendingAction = false;
let raiseTo = 0;
let lastDecisionId = null;
let overlayDismissed = false;

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function svgUse(id, className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', id === 'chip' ? '0 0 20 20' : '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatChip(n) {
  return Number(n).toLocaleString('ko-KR');
}

function formatCard(code) {
  if (!code || typeof code !== 'string' || code.length < 2) {
    return { rank: '?', suit: null, red: false };
  }
  const rankRaw = code.slice(0, -1);
  const suit = SUIT[code.slice(-1)] ?? null;
  return {
    rank: rankRaw === 'T' ? '10' : rankRaw,
    suit,
    red: Boolean(suit?.red),
  };
}

function cardLabel(parsed) {
  return `${parsed.rank} ${parsed.suit?.name ?? ''}`.trim();
}

function cardNode(code, { faceDown = false, small = false, hero = false, slot = false } = {}) {
  const node = el('div', 'card');
  if (small) node.classList.add('card--sm');
  if (hero) node.classList.add('card--hero');
  if (slot) {
    node.classList.add('card--slot');
    return node;
  }
  if (faceDown || !code) {
    node.classList.add('card--back');
    return node;
  }
  const parsed = formatCard(code);
  if (parsed.red) node.classList.add('is-red');
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', cardLabel(parsed));
  const rank = el('span', parsed.rank === '10' ? 'card-rank is-ten' : 'card-rank', parsed.rank);
  node.append(rank);
  if (parsed.suit) node.append(svgUse(parsed.suit.id, 'card-suit'), svgUse(parsed.suit.id, 'card-pip'));
  return node;
}

function miniCard(code) {
  const parsed = formatCard(code);
  const node = el('span', parsed.red ? 'mini-card is-red' : 'mini-card');
  node.setAttribute('aria-label', cardLabel(parsed));
  node.append(document.createTextNode(parsed.rank));
  if (parsed.suit) node.append(svgUse(parsed.suit.id, 'mini-suit'));
  return node;
}

function playerName(playerId) {
  if (playerId === 'user') return '나';
  const seat = ui.view?.seats?.find((s) => s.playerId === playerId);
  return seat?.name ?? playerId ?? '';
}

function revealedCards() {
  const map = {};
  const mucks = new Set();
  for (const item of ui.log) {
    if (item.type === 'hand_start') {
      for (const key of Object.keys(map)) delete map[key];
      mucks.clear();
    }
    if (item.type === 'showdown') {
      for (const reveal of item.reveals ?? []) map[reveal.playerId] = reveal;
      for (const pid of item.mucks ?? []) mucks.add(pid);
    }
  }
  return { map, mucks };
}

// 엔진은 자발적 베팅을 전부 raise로 내보낸다. 스트리트에 선행 베팅이 없었다면
// 그것은 레이즈가 아니라 벳이므로, 로그에서만 그 구분을 되살린다.
function actionVerbs(items) {
  const verbs = new Map();
  let street = null;
  let wagered = false;
  for (const item of items) {
    if (item.type === 'hand_start') {
      street = 'preflop';
      wagered = true;
      continue;
    }
    if (item.type === 'street') {
      street = item.street;
      wagered = false;
      continue;
    }
    if (item.type !== 'action') continue;
    if (item.street !== street) {
      street = item.street;
      wagered = item.street === 'preflop';
    }
    if (item.action === 'raise') {
      verbs.set(item, wagered ? 'raise' : 'bet');
      wagered = true;
      continue;
    }
    verbs.set(item, item.action);
    if (item.action === 'call') wagered = true;
  }
  return verbs;
}

function clampRaiseTo(value, legal) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return legal.minRaiseTo;
  return Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, n));
}

function potRaiseTo(legal, myBet, fraction) {
  return clampRaiseTo(myBet + legal.callAmount + legal.potTotal * fraction, legal);
}

function myBetOf(view) {
  const seat = view?.seats?.find((s) => s.playerId === 'user');
  return seat?.bet ?? 0;
}

function handsUntilLevel(view) {
  const every = view?.levelEvery;
  if (!every || !view.handNo) return null;
  return every - ((view.handNo - 1) % every);
}

function setConn(on) {
  const box = $('conn');
  $('conn-text').textContent = on ? '연결됨' : '재접속 중…';
  box.classList.toggle('on', on);
  box.classList.toggle('off', !on);
}

function showBootError(text) {
  $('boot-error-text').textContent = text;
  $('boot-error').hidden = false;
}

function setBtnLabel(btn, label, amount) {
  btn.replaceChildren(document.createTextNode(`${label} `), el('span', 'num', formatChip(amount)));
}

function renderMarkdown(src) {
  const lines = String(src ?? '').split('\n');
  let html = '';
  let list = false;
  const close = () => { if (list) { html += '</ul>'; list = false; } };
  const inline = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const li = line.match(/^[-*]\s+(.*)$/);
    if (h) {
      close();
      const tag = `h${h[1].length}`;
      html += `<${tag}>${inline(h[2])}</${tag}>`;
    } else if (li) {
      if (!list) { html += '<ul>'; list = true; }
      html += `<li>${inline(li[1])}</li>`;
    } else if (line.trim() === '') {
      close();
    } else {
      close();
      html += `<p>${inline(line)}</p>`;
    }
  }
  close();
  return html;
}

// 오버레이가 이미 "종합 리뷰" 제목을 달고 있으므로 본문 맨 앞 문서 제목은 중복이다.
function reviewBody(src) {
  const lines = String(src ?? '').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i < lines.length && /^#\s+/.test(lines[i])) return lines.slice(i + 1).join('\n');
  return lines.join('\n');
}

function paintTop(view) {
  $('hand-no').textContent = view?.handNo ?? '—';
  $('level').textContent = view == null ? '—' : String((view.level ?? 0) + 1);
  $('blinds').textContent = view?.blinds ? `${formatChip(view.blinds[0])}/${formatChip(view.blinds[1])}` : '—';
  const left = view ? handsUntilLevel(view) : null;
  $('level-left').textContent = left == null ? '—' : String(left);
}

function paintBoard(view) {
  const board = $('board');
  board.replaceChildren();
  const cards = view?.board ?? [];
  for (let i = 0; i < 5; i += 1) {
    board.append(cards[i] ? cardNode(cards[i]) : cardNode(null, { slot: true }));
  }
}

function paintPots(view) {
  const box = $('pots');
  box.replaceChildren(svgUse('chip', 'pot-chip'));
  const pots = view?.pots ?? [];
  if (pots.length <= 1) {
    box.append(el('span', 'pot-label', '팟'), el('span', 'pot-amount num', formatChip(pots[0]?.amount ?? 0)));
    return;
  }
  pots.forEach((pot, i) => {
    const item = el('span', 'pot-item', i === 0 ? '메인 팟' : '사이드팟');
    item.append(el('span', 'pot-amount num', formatChip(pot.amount)));
    box.append(item);
  });
}

// 좌석은 스타디움 레일을 따라 앉는다. 지수 2/3의 초타원이 원형 배치보다
// 모서리 쪽으로 좌석을 밀어내 실제 테이블 윤곽에 붙는다.
function ovalPoint(index, count, rx, ry) {
  const angle = (Math.PI * 2 * index) / count;
  const bulge = (v) => Math.sign(v) * Math.abs(v) ** (2 / 3);
  return {
    x: 50 + rx * bulge(Math.sin(angle)),
    y: 52 + ry * bulge(Math.cos(angle)),
  };
}

function avatarRing() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'avatar-ring');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cls, dash] of [['ring-track', null], ['ring-arc', '40 92']]) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('class', cls);
    circle.setAttribute('cx', '24');
    circle.setAttribute('cy', '24');
    circle.setAttribute('r', '21');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke-width', '3');
    if (dash) {
      circle.setAttribute('stroke-dasharray', dash);
      circle.setAttribute('stroke-linecap', 'round');
    }
    svg.append(circle);
  }
  return svg;
}

function seatCards(seat, view, revealed, mucks) {
  const box = el('div', 'seat-cards');
  if (seat.playerId === 'user') {
    for (const code of view.myCards ?? []) box.append(cardNode(code, { hero: true }));
    return box;
  }
  if (revealed[seat.playerId]) {
    for (const code of revealed[seat.playerId].cards ?? []) box.append(cardNode(code, { small: true }));
    return box;
  }
  if (mucks.has(seat.playerId)) {
    box.append(el('div', 'plate-tag', '머크'));
    return box;
  }
  if (!seat.folded && view.street) {
    box.append(
      cardNode(null, { faceDown: true, small: true }),
      cardNode(null, { faceDown: true, small: true }),
    );
  }
  return box;
}

function paintSeats(view) {
  const seatRoot = $('seats');
  const betRoot = $('bets');
  seatRoot.replaceChildren();
  betRoot.replaceChildren();
  const seats = view?.seats ?? [];
  $('table').classList.toggle('is-crowded', seats.length >= 7);
  if (!seats.length) return;

  const userIdx = Math.max(0, seats.findIndex((s) => s.playerId === 'user'));
  const { map: revealed, mucks } = revealedCards();
  const n = seats.length;

  for (let i = 0; i < n; i += 1) {
    const seat = seats[(userIdx + i) % n];
    const isHero = seat.playerId === 'user';
    const active = view.toAct === seat.playerId && !view.gameOver;

    const node = el('div', 'seat');
    if (isHero) node.classList.add('is-hero');
    if (seat.folded) node.classList.add('is-folded');
    if (active) node.classList.add('is-to-act');
    const at = ovalPoint(i, n, 38, 40);
    node.style.left = `${at.x}%`;
    node.style.top = `${at.y}%`;

    const plate = el('div', 'plate');
    const avatarWrap = el('div', 'avatar-wrap');
    avatarWrap.append(el('div', 'avatar', (seat.name ?? '?').slice(0, 1)));
    if (active) avatarWrap.append(avatarRing());

    const info = el('div', 'plate-info');
    info.append(
      el('div', 'plate-name', isHero ? '나' : (seat.name ?? seat.playerId)),
      el('div', 'plate-stack', formatChip(seat.stack)),
    );
    plate.append(avatarWrap, info);

    if (seat.allIn) plate.append(el('div', 'plate-tag is-allin', '올인'));
    else if (seat.folded) plate.append(el('div', 'plate-tag', '폴드'));
    if (seat.isButton) plate.append(el('div', 'dealer-btn', 'D'));

    node.append(seatCards(seat, view, revealed, mucks), plate);
    seatRoot.append(node);

    if (seat.bet > 0) {
      const spot = ovalPoint(i, n, 26, 26);
      const marker = el('div', 'bet-marker');
      marker.style.left = `${spot.x}%`;
      marker.style.top = `${spot.y}%`;
      marker.append(svgUse('chip', 'bet-chip'), el('span', 'bet-amount', formatChip(seat.bet)));
      betRoot.append(marker);
    }
  }
}

function paintThinking(view) {
  const box = $('thinking');
  const idle = $('idle-hint');
  if (!view) {
    box.hidden = true;
    idle.hidden = false;
    idle.textContent = '게임을 기다리는 중…';
    return;
  }
  idle.hidden = true;
  if (view.toAct && view.toAct !== 'user' && !view.gameOver) {
    box.hidden = false;
    box.textContent = `${playerName(view.toAct)} 생각 중…`;
    return;
  }
  box.hidden = true;
  box.textContent = '';
}

function writeAmountField(value) {
  const input = $('raise-amount');
  if (document.activeElement === input) return;
  input.value = formatChip(value);
}

function markAmountValid(valid) {
  $('raise-amount').closest('.amount-field').classList.toggle('is-invalid', !valid);
}

function setRaiseTo(value, { fromInput = false } = {}) {
  const legal = ui.view?.legal;
  if (!legal) return;
  raiseTo = clampRaiseTo(value, legal);
  $('raise-slider').value = String(raiseTo);
  setBtnLabel($('btn-raise'), '레이즈', raiseTo);
  if (!fromInput) writeAmountField(raiseTo);
}

function commitAmount() {
  const legal = ui.view?.legal;
  if (!legal) return;
  const input = $('raise-amount');
  const digits = input.value.replace(/[^0-9]/g, '');
  setRaiseTo(digits === '' ? raiseTo : Number(digits));
  input.value = formatChip(raiseTo);
  markAmountValid(true);
}

function syncRaisePanel(legal) {
  if (legal.decisionId !== lastDecisionId) {
    lastDecisionId = legal.decisionId;
    raiseTo = legal.minRaiseTo > legal.maxRaiseTo ? legal.maxRaiseTo : legal.minRaiseTo;
    markAmountValid(true);
  }
  raiseTo = clampRaiseTo(raiseTo, legal);
  const slider = $('raise-slider');
  slider.min = String(legal.minRaiseTo);
  slider.max = String(legal.maxRaiseTo);
  slider.value = String(raiseTo);
  setBtnLabel($('btn-raise'), '레이즈', raiseTo);
  writeAmountField(raiseTo);
  $('raise-range').textContent = `${formatChip(legal.minRaiseTo)} – ${formatChip(legal.maxRaiseTo)}`;
}

function paintActionBar(view) {
  const bar = $('action-bar');
  const legal = view?.legal;
  const mine = Boolean(legal) && !view?.gameOver;
  bar.hidden = !mine;
  if (!mine) return;

  const shortAllIn = legal.minRaiseTo > legal.maxRaiseTo;
  const raiseOff = pendingAction || !legal.canRaise;
  $('btn-fold').disabled = pendingAction;
  $('btn-check').hidden = !legal.canCheck;
  $('btn-check').disabled = pendingAction;
  $('btn-call').hidden = Boolean(legal.canCheck);
  $('btn-call').disabled = pendingAction;
  setBtnLabel($('btn-call'), '콜', legal.callAmount);

  $('raise-panel').hidden = shortAllIn;
  $('act-sep').hidden = shortAllIn;
  $('raise-slider').disabled = raiseOff;
  $('btn-raise').disabled = raiseOff;
  $('btn-raise').hidden = shortAllIn;
  const amount = $('raise-amount');
  amount.disabled = raiseOff;
  amount.closest('.amount-field').classList.toggle('is-disabled', raiseOff);
  for (const btn of $('raise-panel').querySelectorAll('[data-preset]')) {
    btn.disabled = raiseOff;
  }

  $('btn-allin-only').hidden = !shortAllIn;
  $('btn-allin-only').disabled = pendingAction || !legal.canRaise;
  setBtnLabel($('btn-allin-only'), '올인', legal.maxRaiseTo);
  if (!shortAllIn) syncRaisePanel(legal);
}

function logNode(item, verb) {
  switch (item.type) {
    case 'hand_start': {
      const row = el('div', 'log-divider');
      row.append(
        el('div', 'log-divider-rule'),
        el('div', 'log-divider-text', `핸드 ${item.handNo} · 버튼 ${playerName(item.button)}`),
        el('div', 'log-divider-rule'),
      );
      return row;
    }
    case 'level_up': {
      const row = el('div', 'log-divider');
      row.append(
        el('div', 'log-divider-rule'),
        el('div', 'log-divider-text', `레벨 업 · 블라인드 ${formatChip(item.sb)}/${formatChip(item.bb)}`),
        el('div', 'log-divider-rule'),
      );
      return row;
    }
    case 'blinds_posted': {
      const row = el('div', 'log-row');
      row.append(
        el('span', 'log-text', '블라인드 게시'),
        el('span', 'log-amount num', `${formatChip(item.sb)}/${formatChip(item.bb)}`),
      );
      return row;
    }
    case 'action': {
      const row = el('div', 'log-row');
      row.append(
        el('span', 'log-name', playerName(item.playerId)),
        el('span', `log-act is-${verb}`, ACTION[verb] ?? verb),
      );
      if (item.allIn) row.append(el('span', 'log-act is-allin', '올인'));
      if (item.action === 'raise' && item.amount != null) {
        row.append(el('span', 'log-amount num', formatChip(item.amount)));
      }
      return row;
    }
    case 'street': {
      const row = el('div', 'log-street');
      row.append(el('span', 'log-street-name', STREET[item.street] ?? item.street));
      for (const code of item.board ?? []) row.append(miniCard(code));
      return row;
    }
    case 'showdown': {
      const box = document.createDocumentFragment();
      for (const reveal of item.reveals ?? []) {
        const row = el('div', 'log-row');
        row.append(el('span', 'log-name', playerName(reveal.playerId)));
        for (const code of reveal.cards ?? []) row.append(miniCard(code));
        if (reveal.handName) row.append(el('span', 'log-amount', reveal.handName));
        box.append(row);
      }
      for (const pid of item.mucks ?? []) {
        const row = el('div', 'log-row');
        row.append(el('span', 'log-name', playerName(pid)), el('span', 'log-act is-fold', '머크'));
        box.append(row);
      }
      return box;
    }
    case 'pot_award': {
      const row = el('div', 'log-row');
      const winners = (item.winners ?? []).map((w) => playerName(w.playerId)).join(', ') || '없음';
      row.append(
        el('span', 'log-text', `팟 ${formatChip(item.amount)} → ${winners}`),
      );
      return row;
    }
    case 'bust':
      return el('div', 'log-row', `${playerName(item.playerId)} 탈락`);
    case 'game_over': {
      const label = item.result === 'win' ? '우승'
        : item.result === 'lose' ? '패배'
          : item.result === 'completed' ? '세션 완료'
            : item.result;
      const row = el('div', 'log-divider');
      row.append(
        el('div', 'log-divider-rule'),
        el('div', 'log-divider-text', `게임 종료 · ${label}`),
        el('div', 'log-divider-rule'),
      );
      return row;
    }
    case 'narration':
      return el('div', 'log-note', item.text ?? '');
    default:
      return el('div', 'log-row', item.text ?? item.type ?? '');
  }
}

function paintLog() {
  const list = $('log-list');
  if (!ui.log.length) {
    list.replaceChildren(el('div', 'log-empty', '아직 이벤트가 없습니다.'));
    return;
  }
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  const verbs = actionVerbs(ui.log);
  list.replaceChildren();
  for (const item of ui.log) {
    if (item.type === 'talk') continue;
    list.append(logNode(item, verbs.get(item)));
  }
  if (stick) list.scrollTop = list.scrollHeight;
}

function paintCoach() {
  const list = $('coach-list');
  if (!ui.coach.length) {
    list.replaceChildren(el('div', 'coach-empty', '핸드가 끝나면 코칭이 쌓입니다.'));
    return;
  }
  list.replaceChildren();
  for (const note of ui.coach) {
    const box = el('div', 'coach-note');
    if (note.unavailable) box.classList.add('is-unavailable');
    box.append(
      el('div', 'coach-hand', `핸드 ${note.handNo}`),
      el('div', 'coach-text', note.text ?? ''),
    );
    list.append(box);
  }
}

function paintTraining() {
  const list = $('training-list');
  if (!list) return;
  if (!ui.training.length) {
    list.replaceChildren(el('div', 'coach-empty', '핸드가 끝나면 결정 리뷰가 쌓입니다.'));
    return;
  }
  list.replaceChildren();
  for (const item of ui.training) {
    const card = formatTrainingCard(item);
    const box = el('details', 'training-card');
    if (item.status === 'unsupported') box.classList.add('is-unsupported');
    if (card.grade) box.classList.add(`grade-${card.grade}`);
    if (card.forced) box.classList.add('is-forced');
    const summary = el('summary', 'training-summary');
    summary.append(
      el('div', 'training-title', card.title),
      el('div', 'training-choice', card.choice),
      el('div', 'training-rec', card.recommendation),
      el('div', 'training-grade', card.forced ? card.note : (card.grade ?? card.note)),
    );
    box.append(summary);
    const body = el('div', 'training-body');
    if (card.note && !card.forced) body.append(el('div', 'training-note', card.note));
    if (card.explanation) body.append(el('div', 'training-explain', card.explanation));
    if (card.source) body.append(el('div', 'training-source', card.source));
    if (Array.isArray(item.recommended)) {
      for (const action of item.recommended) {
        const freq = action.frequency != null ? ` ${(action.frequency * 100).toFixed(0)}%` : '';
        const size = action.sizeBb != null ? ` ${action.sizeBb}bb` : '';
        body.append(el('div', 'training-action', `${action.action}${size}${freq}`));
      }
    }
    box.append(body);
    list.append(box);
  }
}

function paintReview(view) {
  const overlay = $('review-overlay');
  const show = Boolean(view?.gameOver && ui.review) && !overlayDismissed;
  overlay.hidden = !show;
  if (!show) return;
  const result = $('review-result');
  result.textContent = view.result === 'win' ? '우승'
    : view.result === 'lose' ? '패배'
      : view.result === 'completed' ? '세션 완료'
        : '';
  result.classList.toggle('is-win', view.result === 'win');
  result.classList.toggle('is-lose', view.result === 'lose');
  $('review-body').innerHTML = renderMarkdown(reviewBody(ui.review));
}

function paint() {
  const view = ui.view;
  paintTop(view);
  paintBoard(view);
  paintPots(view);
  paintSeats(view);
  paintThinking(view);
  paintActionBar(view);
  paintLog();
  paintCoach();
  paintTraining();
  paintReview(view);
}

function renderSnapshot(snap) {
  ui.view = snap.view ?? null;
  ui.log = Array.isArray(snap.log) ? snap.log.slice() : [];
  ui.coach = Array.isArray(snap.coach) ? snap.coach.slice() : [];
  ui.training = Array.isArray(snap.training) ? snap.training.slice() : [];
  ui.review = snap.review;
  pendingAction = false;
  lastDecisionId = null;
  overlayDismissed = false;
  paint();
}

function render(m) {
  if (m.view !== undefined) {
    ui.view = m.view;
    pendingAction = false;
  }
  if (Array.isArray(m.events) && m.events.length) ui.log.push(...m.events);
  if (Array.isArray(m.messages) && m.messages.length) ui.log.push(...m.messages);
  if (Array.isArray(m.coach) && m.coach.length) {
    // Notes arrive whenever their background coach finishes, not in hand order.
    for (const note of m.coach) {
      const at = ui.coach.findIndex((existing) => existing.handNo === note.handNo);
      if (at === -1) ui.coach.push(note);
      else ui.coach[at] = note;
    }
    ui.coach.sort((a, b) => (a.handNo ?? 0) - (b.handNo ?? 0));
  }
  if (Array.isArray(m.training) && m.training.length) {
    for (const item of m.training) {
      const at = ui.training.findIndex((existing) => existing.evaluationId === item.evaluationId);
      if (at === -1) ui.training.push(item);
      else if (ui.training[at].payloadSha256 === item.payloadSha256) { /* same digest no-op */ }
      else ui.training[at] = item;
    }
    ui.training.sort((a, b) => (a.handNo ?? 0) - (b.handNo ?? 0));
  }
  if (m.review !== undefined) {
    ui.review = m.review;
    overlayDismissed = false;
  }
  paint();
}

async function sendAction(action, amount) {
  const legal = ui.view?.legal;
  if (!legal || pendingAction) return;
  pendingAction = true;
  paint();
  const body = { token, decisionId: legal.decisionId, action };
  if (amount !== undefined) body.amount = Number(amount);
  try {
    await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    /* 재활성은 다음 view 게시 */
  }
}

$('btn-fold').addEventListener('click', () => sendAction('fold'));
$('btn-check').addEventListener('click', () => sendAction('check'));
$('btn-call').addEventListener('click', () => sendAction('call'));
$('btn-raise').addEventListener('click', () => sendAction('raise', raiseTo));
$('btn-allin-only').addEventListener('click', () => sendAction('raise', ui.view?.legal?.maxRaiseTo));

$('raise-slider').addEventListener('input', (ev) => {
  if (!ui.view?.legal) return;
  setRaiseTo(ev.target.value);
  markAmountValid(true);
});

$('raise-panel').addEventListener('click', (ev) => {
  const preset = ev.target.closest('[data-preset]')?.dataset.preset;
  const legal = ui.view?.legal;
  if (!preset || !legal || legal.minRaiseTo > legal.maxRaiseTo) return;
  const myBet = myBetOf(ui.view);
  if (preset === 'min') setRaiseTo(legal.minRaiseTo);
  else if (preset === 'half') setRaiseTo(potRaiseTo(legal, myBet, 0.5));
  else if (preset === 'pot') setRaiseTo(potRaiseTo(legal, myBet, 1));
  else if (preset === 'allin') setRaiseTo(legal.maxRaiseTo);
  markAmountValid(true);
});

// 직접 입력 — 편집 중에는 자릿수 구분 쉼표를 걷어내고, 확정할 때 다시 붙인다.
$('raise-amount').addEventListener('focus', (ev) => {
  ev.target.value = String(raiseTo);
  ev.target.select();
});

$('raise-amount').addEventListener('input', (ev) => {
  const digits = ev.target.value.replace(/[^0-9]/g, '');
  if (digits !== ev.target.value) ev.target.value = digits;
  const legal = ui.view?.legal;
  if (!legal) return;
  if (digits === '') {
    markAmountValid(true);
    return;
  }
  const next = Number(digits);
  const inRange = next >= legal.minRaiseTo && next <= legal.maxRaiseTo;
  markAmountValid(inRange);
  if (inRange) setRaiseTo(next, { fromInput: true });
});

$('raise-amount').addEventListener('blur', commitAmount);

$('raise-amount').addEventListener('keydown', (ev) => {
  const legal = ui.view?.legal;
  if (!legal) return;
  if (ev.key === 'Enter') {
    ev.preventDefault();
    commitAmount();
    return;
  }
  if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
  ev.preventDefault();
  const step = ui.view?.blinds?.[1] ?? 1;
  const base = Number(ev.target.value.replace(/[^0-9]/g, '')) || raiseTo;
  setRaiseTo(base + (ev.key === 'ArrowUp' ? step : -step), { fromInput: true });
  ev.target.value = String(raiseTo);
  markAmountValid(true);
});

function selectTab(which) {
  for (const name of ['log', 'coach', 'training']) {
    const on = name === which;
    $(`tab-${name}`)?.classList.toggle('on', on);
    $(`tab-${name}`)?.setAttribute('aria-selected', String(on));
    const panel = $(`panel-${name}`);
    if (panel) panel.hidden = !on;
  }
}

$('tab-log').addEventListener('click', () => selectTab('log'));
$('tab-coach').addEventListener('click', () => selectTab('coach'));
$('tab-training')?.addEventListener('click', () => selectTab('training'));

$('review-close').addEventListener('click', () => {
  overlayDismissed = true;
  $('review-overlay').hidden = true;
});

const token = new URLSearchParams(location.search).get('token');
let revision = 0; const buffer = [];
let booted = false;
const es = new EventSource(`/api/events?token=${token}&after=0`);
es.onmessage = (m) => {
  const msg = { revision: Number(m.lastEventId), ...JSON.parse(m.data) };
  if (!booted) { buffer.push(msg); return; }
  applyMessage(msg);                       // revision <= 현재면 무시
};
es.onopen = async () => {
  const snap = await (await fetch(`/api/snapshot?token=${token}`)).json();
  renderSnapshot(snap); revision = snap.revision;
  booted = true;
  for (const m of buffer.splice(0)) applyMessage(m); // snap 이후분만 적용됨
};
es.onerror = () => { booted = false; };     // 재접속 시 onopen이 다시 스냅샷 로드
function applyMessage(m) { if (m.revision <= revision) return; revision = m.revision; render(m); }

es.addEventListener('open', () => setConn(true));
es.addEventListener('error', () => setConn(false));
if (!token) showBootError('접속 토큰이 없습니다. /?token=... 으로 열어 주세요.');

paint();
