import {appGameId, appEpoch, appFetch, eventStream} from './app-transport.js';
import { createHintState, formatHint, hintPotPercent } from './hint-format.js';
import { applyTrainingAnnotation, formatTrainingCard, mergeTrainingItems, verifyTrainingDetail } from './training-format.js';
import { formatReplay, actionVerbs } from './replay-format.js';

import { clampRaiseTo, potRaiseTo, bbRaiseTo, reviewDismissalAfterUpdate, studyLink } from './table-controls.js';
import { createActionController } from './action-controller.js';
import {formatAmount, formatSignedAmount, readPreference, writePreference} from './chip-format.js';
import {seatPresentation, participantSummary, mobileSeatSlot, blindPositions, ovalPoint} from './seat-format.js';
import {aggregatePot, showPotBreakdown, logBlindContexts} from './table-presentation.js';
import {createAmountEditor, parseChipInput} from './amount-editor.js';
import {createDialogController} from './dialog-controller.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SUIT = {
  s: { id: 'suit-s', name: '스페이드', red: false },
  h: { id: 'suit-h', name: '하트', red: true },
  d: { id: 'suit-d', name: '다이아몬드', red: true },
  c: { id: 'suit-c', name: '클럽', red: false },
};
const STREET = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' };
const ACTION = { fold: '폴드', check: '체크', call: '콜', bet: '벳', raise: '레이즈' };

const ui = { hint: null, view: null, log: [], coach: [], training: [], trainingAnnotations: [], review: undefined, handReplays: Object.create(null) };
let pendingAction = true;
let revisionAtHintClear=-1;
const hintState=createHintState();
const hintRequests=new WeakMap();
function hideHint(decisionId=ui.view?.legal?.decisionId) {revisionAtHintClear=typeof revision==='number'?revision:0;hintState.invalidate(decisionId);ui.hint=null;paintHint();}
function paintHint() {
  const card=$('pre-action-hint');if(!card)return;
  const formatted=formatHint(ui.hint);card.hidden=!formatted;card.replaceChildren();if(!formatted)return;
  const title=document.createElement('strong');title.textContent=formatted.title;card.append(title);
  const lines=[...formatted.lines];
  const pot=ui.view?.legal?.potTotal;
  const percent=hintPotPercent(ui.hint,pot);
  if(percent!==null)lines.push(`콜 후 팟 대비 추가 레이즈 ${percent.toFixed(1)}%`);
  if(formatted.source)lines.push(formatted.source);
  for(const text of lines){const row=document.createElement('div');row.textContent=text;card.append(row);}
}
let actionController = null;
let selectedTab = 'log';
const unread = { coach: 0, training: 0 };
const detailCache = new Map();
const detailLoading = new Set();
const detailErrors = new Set();
let authenticatedStudyUrl = null;
let raiseTo = 0;
let lastDecisionId = null;
let displayUnit = readPreference();
const amountEditor = createAmountEditor();

const $ = (id) => document.getElementById(id);
const dialogs = createDialogController(document, () => {
  if(openReplayHandNo != null && $('replay-overlay').hidden)openReplayHandNo=null;
  queueMicrotask(()=>paintReview(ui.view));
});
let selectedSeatId = null;

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

function amountText(value, bb = ui.view?.blinds?.[1], signed = false) {
  const parts = signed ? formatSignedAmount(value, bb, displayUnit) : formatAmount(value, bb, displayUnit);
  return [parts.primary, parts.secondary === 'BB 기준 없음' ? '' : parts.secondary].filter(Boolean).join(' / ');
}
function amountNode(value, bb = ui.view?.blinds?.[1], className = '') {
  const parts = formatAmount(value, bb, displayUnit);
  const node = el('span', `amount-pair ${className}`);
  node.append(el('span', 'amount-primary', parts.primary), el('span', 'amount-secondary', parts.secondary));
  return node;
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
  let matching = false;
  for (const item of ui.log) {
    if (item.type === 'hand_start') {
      matching = item.handNo === ui.view?.handNo;
      for (const key of Object.keys(map)) delete map[key];
      mucks.clear();
    }
    if (matching && item.type === 'showdown') {
      for (const reveal of item.reveals ?? []) map[reveal.playerId] = reveal;
      for (const pid of item.mucks ?? []) mucks.add(pid);
    }
  }
  return { map, mucks };
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
  if(!on)hideHint();
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
  btn.replaceChildren(document.createTextNode(`${label} `), amountNode(amount, ui.view?.blinds?.[1], 'num'));
}

function paintParticipants(view) {
  const list=$('participants-list');
  const signature=JSON.stringify([view?.seats,view?.handInProgress,view?.toAct,displayUnit,view?.blinds]);
  if(list._signature===signature)return;
  list._signature=signature;list.replaceChildren();
  for(const seat of view?.seats??[]) {
    const row=el('div','participant-row');
    row.append(el('strong','',seat.name??seat.playerId),el('span','',seatPresentation(view,seat).status),amountNode(seat.stack));
    list.append(row);
  }
  paintSeatDetails();
}
function paintSeatDetails() {
  const seat=ui.view?.seats?.find(s=>s.playerId===selectedSeatId);
  if(!seat)return;
  $('seat-detail-title').textContent=seat.name??seat.playerId;
  $('seat-detail-body').replaceChildren(el('p','',seatPresentation(ui.view,seat).status),amountNode(seat.stack),el('p','',`이번 스트리트 베팅 ${amountText(seat.bet)}`));
}
function openSeatDetails(playerId) {
  selectedSeatId=playerId;paintSeatDetails();dialogs.open($('seat-overlay'),()=>dialogs.close());
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
  $('hand-no').textContent = view?.handLimit ? `${view.handNo} / ${view.handLimit}` : (view?.handNo ?? '—');
  const cash = view?.mode === 'cash-training';
  $('game-mode').textContent = cash ? '캐시 연습' : '토너먼트';
  if(view?.dealBias && view.dealBias!=='off') $('game-mode').textContent += ' · 유리한 딜 (평가 제외)';
  for (const row of document.querySelectorAll('[data-tournament-meta]')) row.hidden = cash;
  const net = view?.sessionNet?.user;
  $('session-net').closest('.meta-seg').hidden = !cash;
  $('session-net').textContent = amountText(net, view?.blinds?.[1], true);
  $('participants-summary').textContent = view ? participantSummary(view) : '참가자 —';
  $('cash-reset-note').hidden = !(cash && view.handInProgress === false && !view.gameOver && view.handNo > 0);
  $('learning-scope').textContent = cash
    ? '새 세션은 6·8·9인 100BB 프리플롭 기준표를 참고합니다. 스택·사이즈 투영은 점수에서 제외하며, 기존 세션은 기록된 출처를 유지합니다.'
    : '토너먼트 상황은 기준표 채점 범위 밖입니다. 결정 복기를 참고하세요.';
  $('level').textContent = view == null ? '—' : String((view.level ?? 0) + 1);
  $('blinds').textContent = view?.blinds ? `${formatChip(view.blinds[0])} / ${formatChip(view.blinds[1])} 칩 · 1 BB = ${formatChip(view.blinds[1])} 칩` : '—';
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
  const signature = JSON.stringify([view?.handNo,view?.handInProgress,view?.pots,view?.legal?.potTotal,view?.blinds,displayUnit]);
  if(box._signature===signature)return;
  box._signature=signature;
  const previous = box.querySelector('.pot-detail');
  const sameHand = box.dataset.handNo === String(view?.handNo);
  const wasOpen = sameHand && previous?.open;
  const hadFocus = sameHand && previous?.contains(document.activeElement);
  box.dataset.handNo = String(view?.handNo);
  box.replaceChildren(svgUse('chip', 'pot-chip'));
  const pot = aggregatePot(view);
  box.hidden = pot.kind === 'hidden';
  if (pot.kind !== 'ready') {box.append(el('span', 'pot-label', pot.kind === 'mismatch' ? '팟 정보 확인 중' : '팟 정보 없음'));return;}
  box.append(el('span', 'pot-label', view.handInProgress === true ? '현재 베팅 포함 총액' : '팟 합계'), amountNode(pot.total, view.blinds?.[1], 'pot-amount num'));
  if (showPotBreakdown(view)) {
    const detail = el('details', 'pot-detail');detail.append(el('summary', '', '정산 팟 상세'));
    detail.open = Boolean(wasOpen);
    view.pots.forEach((p,i)=>detail.append(el('div','',`${i ? `사이드 ${i}` : '메인'} · ${amountText(p.amount)}`)));
    box.append(detail);
    if (hadFocus) detail.querySelector('summary').focus({preventScroll:true});
  }
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
  if (seatPresentation(view, seat).showBacks) {
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
  const previous = new Map([...seatRoot.children].map(node=>[node.dataset.playerId,node]));
  betRoot.replaceChildren();
  const seats = view?.seats ?? [];
  $('table').classList.toggle('is-crowded', seats.length >= 7);
  if (!seats.length) {seatRoot.replaceChildren();paintParticipants(view);return;}

  const userIdx = Math.max(0, seats.findIndex((s) => s.playerId === 'user'));
  const { map: revealed, mucks } = revealedCards();
  const n = seats.length;
  const positions = blindPositions(view);

  for (let i = 0; i < n; i += 1) {
    const seat = seats[(userIdx + i) % n];
    const isHero = seat.playerId === 'user';
    const state = seatPresentation(view, seat);
    const active = state.active;

    const node = previous.get(seat.playerId) ?? el('div', 'seat');
    node.dataset.playerId = seat.playerId;
    node.dataset.status = state.status;
    node.className = 'seat';
    if (isHero) node.classList.add('is-hero');
    if (state.folded) node.classList.add('is-folded');
    if (state.out) node.classList.add('is-out');
    if (active) node.classList.add('is-to-act');
    const at = ovalPoint(i, n, 38, 40);
    node.dataset.side = at.x < 50 ? 'left' : 'right';
    node.dataset.betBand = at.y > 75 ? 'lower' : at.y > 16 && at.y < 40 ? 'upper' : 'middle';
    node.dataset.betEdge = at.y < 25 || at.y > 75 ? 'bottom' : at.x < 50 ? 'right' : 'left';
    node.style.left = `${at.x}%`;
    node.style.top = `${at.y}%`;
    node.style.setProperty('--desktop-seat-x', `${at.x}%`);
    node.style.setProperty('--desktop-seat-y', `${at.y}%`);
    const mobile = mobileSeatSlot(i,n);
    node.style.setProperty('--seat-x', `${mobile.x}%`);
    node.style.setProperty('--seat-y', `${mobile.y}%`);

    const plate = node.querySelector('.plate') ?? el('button', 'plate');
    plate.type = 'button';
    plate.setAttribute('aria-label', `${seat.name ?? seat.playerId}, ${positions[seat.playerId] ?? ''}, ${state.status}, 스택 ${amountText(seat.stack)}, 이번 스트리트 베팅 ${amountText(seat.bet)}. 좌석 상세`);
    plate.onclick = () => openSeatDetails(seat.playerId);
    plate.replaceChildren();
    const avatarWrap = el('span', 'avatar-wrap');
    avatarWrap.append(el('span', 'avatar', (seat.name ?? '?').slice(0, 1)));
    if (active) avatarWrap.append(avatarRing());

    const info = el('span', 'plate-info');
    info.append(
      el('span', 'plate-name', isHero ? '나' : (seat.name ?? seat.playerId)),
      amountNode(seat.stack, view.blinds?.[1], 'plate-stack'),
    );
    plate.append(avatarWrap, info);

    plate.append(el('span', `plate-tag${state.allIn ? ' is-allin' : ''}`, state.status));
    const position = positions[seat.playerId];
    if (state.showButton || position) {
      const badge = el('span', `dealer-btn${position?.includes('SB') ? ' is-sb' : position === 'BB' ? ' is-bb' : ''}`, position ?? 'D');
      badge.title = position === 'D/SB' ? '딜러 · 스몰 블라인드' : position === 'SB' ? '스몰 블라인드' : position === 'BB' ? '빅 블라인드' : '딜러';
      plate.append(badge);
    }
    if (state.showBet) {
      const bet = el('span', 'seat-bet', `베팅 ${formatAmount(seat.bet, view.blinds?.[1], displayUnit).primary}`);
      plate.append(bet);
    }

    const cards=seatCards(seat, view, revealed, mucks);
    node.querySelector('.seat-cards')?.remove();
    node.prepend(cards);
    if(!plate.parentNode)node.append(plate);
    if(!node.parentNode)seatRoot.append(node);
    previous.delete(seat.playerId);

    if (state.showBet && !isHero) {
      const marker = el('span', 'bet-marker');
      marker.setAttribute('aria-hidden', 'true');
      marker.dataset.playerId = seat.playerId;
      marker.title = `${seat.name ?? seat.playerId} · 이번 스트리트 베팅 ${amountText(seat.bet)}`;
      marker.append(svgUse('chip', 'bet-chip'), el('span', 'bet-amount', formatAmount(seat.bet, view.blinds?.[1], displayUnit).primary));
      plate.append(marker);
    }
  }
  for(const node of previous.values())node.remove();
  paintParticipants(view);
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
  input.value = amountEditor.state.text;
}

function markAmountValid(valid) {
  $('raise-amount').closest('.amount-field').classList.toggle('is-invalid', !valid);
  $('raise-amount').setAttribute('aria-invalid', String(!valid));
  $('amount-error').textContent = !valid ? '칩 정수와 합법 범위를 확인해 주세요.' : amountEditor.state.pendingCorrection ? '합법 범위로 보정했습니다. 레이즈를 눌러 금액을 확인해 주세요.' : amountEditor.state.confirmedCorrection ? `보정된 ${amountEditor.state.value.toLocaleString('ko-KR')} 칩을 확인했습니다. 레이즈를 다시 눌러 제출하세요.` : '';
}

function setRaiseTo(value, { fromInput = false } = {}) {
  const legal = ui.view?.legal;
  if (!legal || pendingAction) return;
  raiseTo = fromInput ? amountEditor.state.value : amountEditor.choose(value, legal).value;
  $('raise-slider').value = String(raiseTo);
  setBtnLabel($('btn-raise'), '총액 레이즈', raiseTo);
  if (!fromInput) $('raise-amount').value = amountEditor.state.text;
}

function commitAmount() {
  const legal = ui.view?.legal;
  if (!legal || pendingAction) return;
  const input = $('raise-amount');
  const state = amountEditor.commit(legal);
  raiseTo = state.value; input.value = state.text;
  $('raise-slider').value = String(raiseTo);
  setBtnLabel($('btn-raise'), '총액 레이즈', raiseTo);
  markAmountValid(!state.invalid);
}

function adoptDecision(legal) {
  if (legal.decisionId !== lastDecisionId) {
    lastDecisionId = legal.decisionId;
    raiseTo = amountEditor.adopt(legal).value;
    $('raise-amount').value = amountEditor.state.text;
    markAmountValid(true);
    const intent = $('intent-note');
    if (intent) intent.value = '';
  }
}

function syncRaisePanel(legal) {
  adoptDecision(legal);
  raiseTo = clampRaiseTo(raiseTo, legal);
  const slider = $('raise-slider');
  slider.min = String(legal.minRaiseTo);
  slider.max = String(legal.maxRaiseTo);
  slider.value = String(raiseTo);
  setBtnLabel($('btn-raise'), '총액 레이즈', raiseTo);
  writeAmountField(raiseTo);
  $('raise-range').textContent = `이번 스트리트 총액 · 최소 ${amountText(legal.minRaiseTo)} · 최대 ${amountText(legal.maxRaiseTo)}`;
}

function paintActionBar(view) {
  const bar = $('action-bar');
  const legal = view?.legal;
  const mine = Boolean(legal) && !view?.gameOver;
  bar.hidden = !mine;
  if (!mine) return;
  const hero=view.seats?.find(s=>s.playerId==='user');
  const pot=aggregatePot(view);
  const cards=(view.myCards??[]).map(code=>cardLabel(formatCard(code))).join(', ');
  $('action-summary').textContent = `내 스택 ${amountText(hero?.stack)} · 팟 ${pot.kind==='ready' ? amountText(pot.total) : '정보 확인 중'} · 내 카드 ${cards}`;
  adoptDecision(legal);

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
    const multiple = btn.dataset.preset === 'rfi' ? 2.5 : btn.dataset.preset === 'threebet' ? 8.5 : null;
    const available = multiple === null || (view.street === 'preflop' && bbRaiseTo(legal, view.blinds?.[1], multiple) !== null);
    btn.hidden = !available;
    btn.disabled = raiseOff || !available;
  }

  $('btn-allin-only').hidden = !shortAllIn;
  $('btn-allin-only').disabled = pendingAction || !legal.canRaise;
  setBtnLabel($('btn-allin-only'), '올인', legal.maxRaiseTo);
  if (!shortAllIn) syncRaisePanel(legal);
}

function logNode(item, verb, bb) {
  switch (item.type) {
    case 'hand_start': {
      const row = el('div', 'log-divider');
      const label = el('div', 'log-divider-text', `핸드 ${item.handNo} · 버튼 ${playerName(item.button)}`);
      const btn = el('button', 'replay-open', '복기');
      btn.type = 'button';
      const replay = ui.handReplays?.[item.handNo];
      if (!replay) btn.disabled = true;
      else if (replay.unavailable) btn.title = formatReplay(replay).message ?? '';
      btn.addEventListener('click', () => openReplay(item.handNo));
      label.append(btn);
      row.append(
        el('div', 'log-divider-rule'),
        label,
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
      if ((item.action === 'raise' || item.action === 'call') && item.amount != null) {
        row.append(el('span', 'log-amount num', amountText(item.amount, bb)));
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
      const box = el('div','log-group');
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
        el('span', 'log-text', `팟 ${amountText(item.amount, bb)} → ${winners}`),
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
    list._keys=[];list._unread=0;$('log-new').hidden=true;
    return;
  }
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  const scroll=list.scrollTop;
  const oldKeys=list._keys??[];
  const focused=document.activeElement;
  const focusedRow=focused?.closest('[data-log-index]');
  const anchor=[...list.children].find(node=>node.getBoundingClientRect().bottom>list.getBoundingClientRect().top);
  const anchorIndex=anchor?.dataset.logIndex;
  const anchorOffset=anchor?.getBoundingClientRect().top-list.getBoundingClientRect().top;
  const contexts=logBlindContexts(ui.log,ui.handReplays);
  const keys=ui.log.map((item,i)=>{const replay=item.type==='hand_start'?ui.handReplays?.[item.handNo]:null;return JSON.stringify([item,contexts[i],displayUnit,replay?{unavailable:replay.unavailable??false,reason:replay.reason??null}:null]);});
  if(JSON.stringify(oldKeys)===JSON.stringify(keys))return;
  const appendOnly=oldKeys.length>0 && oldKeys.every((key,i)=>key===keys[i]);
  const verbs = actionVerbs(ui.log);
  const previous=new Map([...list.children].map(node=>[Number(node.dataset.logIndex),node]));
  const rows=[];
  for (let i=appendOnly ? oldKeys.length : 0;i<ui.log.length;i++) {
    const item=ui.log[i];
    if (item.type === 'talk') continue;
    const node=oldKeys[i]===keys[i] ? previous.get(i) : null;
    const row=node??logNode(item, verbs.get(item), contexts[i]);
    row.dataset.logIndex=String(i);
    if(appendOnly)list.append(row);else rows.push(row);
  }
  if(!appendOnly) {
    list.replaceChildren(...rows);
    if(focusedRow)list.querySelector(`[data-log-index="${focusedRow.dataset.logIndex}"] button`)?.focus({preventScroll:true});
  }
  list._keys=keys;
  if (stick) {list.scrollTop = list.scrollHeight;list._unread=0;$('log-new').hidden=true;}
  else {
    list.scrollTop=scroll;
    const restored=anchorIndex==null?null:list.querySelector(`[data-log-index="${anchorIndex}"]`);
    if(restored)list.scrollTop+=restored.getBoundingClientRect().top-list.getBoundingClientRect().top-anchorOffset;
    list._unread=(list._unread??0)+ui.log.slice(oldKeys.length).filter(item=>item.type!=='talk').length;
    if(list._unread){$('log-new').hidden=false;$('log-new').textContent=`새 이벤트 ${list._unread}개 · 최신으로`;}
  }
}

function paintCoach() {
  const list = $('coach-list');
  const signature=JSON.stringify(ui.coach);
  if(list._signature===signature)return;
  list._signature=signature;
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

function detailKey(item) { return `${item.evaluationId}:${item.detailSha256}`; }

async function loadTrainingDetail(item) {
  const key = detailKey(item);
  if (detailLoading.has(key) || detailCache.has(key)) return;
  detailLoading.add(key);
  detailErrors.delete(key);
  try {
    const params = new URLSearchParams({ token, ref: item.detailRef });
    const response = await (appGameId ? appFetch(`training-detail?${new URLSearchParams({ref:item.detailRef})}`) : fetch(`/api/training-detail?${params}`));
    if (!response.ok) throw new Error('DETAIL_UNAVAILABLE');
    const payload = await response.json();
    const verifiedDetail = await verifyTrainingDetail(item, payload.detail);
    if (!verifiedDetail) throw new Error('DETAIL_UNVERIFIED');
    detailCache.set(key, verifiedDetail);
  } catch { detailErrors.add(key); }
  finally { detailLoading.delete(key); paintTraining(); }
}

function paintTraining() {
  const list = $('training-list');
  if (!list) return;
  const panel = $('panel-training');
  const scroll = { list: list.scrollTop, panel: panel.scrollTop };
  if (!ui.training.length) {
    list.replaceChildren(el('div', 'coach-empty', '핸드가 끝나면 결정 리뷰가 쌓입니다.'));
    return;
  }
  for (const empty of list.querySelectorAll('.coach-empty')) empty.remove();
  const existing = new Map([...list.querySelectorAll('[data-evaluation-id]')].map((node) => [node.dataset.evaluationId, node]));
  for (const item of ui.training) {
    const key = detailKey(item);
    let box = existing.get(item.evaluationId);
    const card = formatTrainingCard(item, { verifiedDetail: detailCache.get(key) });
    if (!box) {
      box = el('details', 'training-card');
      box.dataset.evaluationId = item.evaluationId;
      box.addEventListener('toggle', () => {
        if (box.open) void loadTrainingDetail(ui.training.find((row) => row.evaluationId === box.dataset.evaluationId));
      });
      box.append(el('summary', 'training-summary'), el('div', 'training-body'));
      list.append(box);
    }
    existing.delete(item.evaluationId);
    const signature = JSON.stringify([card, authenticatedStudyUrl, detailErrors.has(key)]);
    if (box._signature === signature) continue;
    box._signature = signature;
    const focused = box.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    box.classList.toggle('is-unsupported', item.status === 'unsupported');
    box.classList.toggle('is-forced', card.forced);
    box.querySelector('summary').replaceChildren(
      el('div', 'training-title', card.title), el('div', 'training-choice', card.choice),
      el('div', 'training-rec', card.recommendation),
      el('div', 'training-grade', card.forced ? card.note : (card.gradeLabel || card.note)),
    );
    const body = box.querySelector('.training-body');
    body.replaceChildren();
    if (card.note && !card.forced) body.append(el('div', 'training-note', card.note));
    if (card.exploit) body.append(el('div', 'training-exploit', card.exploit));
    if (card.explanation) body.append(el('div', 'training-explain', card.explanation === 'unavailable' ? '설명을 준비하지 못했습니다.' : card.explanation));
    body.append(el('div', 'training-source', [card.source, card.sourceLabel].filter(Boolean).join(' · ')));
    if (detailErrors.has(key)) {
      const retry = el('button', 'btn btn-ghost', '출처 확인 다시 시도');
      retry.type = 'button'; retry.dataset.focus = 'source-retry';
      retry.addEventListener('click', () => void loadTrainingDetail(item));
      body.append(el('p', 'training-note', '검증된 상세 근거를 불러오지 못했습니다.'), retry);
    }
    if (authenticatedStudyUrl) {
      const href = studyLink(authenticatedStudyUrl, card.practiceTarget ? { mode: 'free', ...card.practiceTarget } : {});
      if (href) {
        const link = el('a', 'study-link', card.practiceTarget ? '이 상황 연습하기' : '학습실에서 지원 상황 보기');
        link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.dataset.focus = 'practice';
        body.append(link);
      }
    }
    if (focused) box.querySelector(`[data-focus="${focused}"]`)?.focus({ preventScroll: true });
    if (box.open && !detailCache.has(key) && !detailErrors.has(key)) void loadTrainingDetail(item);
  }
  for (const node of existing.values()) node.remove();
  list.scrollTop = scroll.list;
  panel.scrollTop = scroll.panel;
}

let openReplayHandNo = null;

function seatNames() {
  const names = { user: '나' };
  for (const seat of ui.view?.seats ?? []) {
    names[seat.playerId] = seat.playerId === 'user' ? '나' : (seat.name ?? seat.playerId);
  }
  return names;
}

function replayViewFor(handNo) {
  const replay = ui.handReplays?.[handNo]
    ?? { handNo, unavailable: true, reason: 'REPLAY_NOT_COMPLETED' };
  return formatReplay(replay, {
    names: seatNames(),
    coachNote: ui.coach.find((note) => note.handNo === handNo),
    trainingItems: ui.training.filter((item) => item.handNo === handNo),
  });
}

function paintReplay() {
  const overlay = $('replay-overlay');
  if (!overlay) return;
  if (openReplayHandNo == null) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  const view = replayViewFor(openReplayHandNo);
  const title = $('replay-title');
  const disclaimer = $('replay-disclaimer');
  const body = $('replay-body');
  const signature=JSON.stringify([view,displayUnit]);
  if(body._signature===signature)return;
  body._signature=signature;
  const scroll=body.scrollTop;
  const focusedStudy=body.contains(document.activeElement) ? document.activeElement.dataset.studyId : null;
  body.replaceChildren();
  if (view.kind === 'marker') {
    title.textContent = `핸드 ${view.handNo ?? openReplayHandNo} 복기`;
    disclaimer.textContent = '';
    body.append(el('p', 'replay-marker', view.message));
    return;
  }
  title.textContent = `핸드 ${view.header.handNo} 복기`;
  disclaimer.textContent = `${view.header.disclaimer}. ${view.header.reliability}`;
  const meta = el('div', 'replay-meta');
  if (view.header.blinds) {
    meta.append(el('span', 'replay-blinds', `블라인드 ${formatChip(view.header.blinds[0])}/${formatChip(view.header.blinds[1])}`));
  }
  if (view.header.winners.length) {
    meta.append(el('span', 'replay-winners', `승자 ${view.header.winners.join(', ')}`));
  }
  body.append(meta);
  const board = el('div', 'replay-board');
  for (const code of view.header.board) board.append(miniCard(code));
  if (view.header.board.length) body.append(board);
  for (const street of view.streets) {
    const block = el('section', 'replay-street');
    block.append(el('h2', 'replay-street-name', street.label));
    for (const row of street.rows) {
      const line = el('div', 'replay-row');
      const who = [row.name, row.position].filter(Boolean).join(' · ');
      line.append(el('span', 'replay-name', who));
      line.append(el('span', `replay-act is-${row.verb}`, row.verbLabel ?? row.verb));
      if (row.amount != null) line.append(el('span', 'replay-amount num', amountText(row.amount,view.header.blinds?.[1]??null)));
      if (row.pot != null) line.append(el('span', 'replay-pot num', `팟 ${amountText(row.pot,view.header.blinds?.[1]??null)}`));
      if (row.cards) {
        const cards = el('span', 'replay-cards');
        for (const code of row.cards) cards.append(miniCard(code));
        line.append(cards);
      }
      if (row.reasonText) line.append(el('div', 'replay-reason', row.reasonText));
      if (row.noteText) line.append(el('div', 'replay-note', row.noteText));
      if (row.coach?.status === 'ready') {
        const coach = el('div', 'replay-coach');
        coach.append(el('div', 'replay-coach-line', `왜: ${row.coach.why}`));
        coach.append(el('div', 'replay-coach-line', `결과: ${row.coach.outcome}`));
        coach.append(el('div', 'replay-coach-line', `대안: ${row.coach.alternative}`));
        line.append(coach);
      } else if (row.coach?.message) {
        line.append(el('div', 'replay-coach is-pending', row.coach.message));
      }
      if (row.study?.evaluationId) {
        const link = el('button', 'replay-study', '학습 카드');
        link.type = 'button';
        link.dataset.studyId=row.study.evaluationId;
        link.addEventListener('click', () => {
          closeReplay();
          selectTab('training');
          const card = document.querySelector(`[data-evaluation-id="${row.study.evaluationId}"]`);
          if (card instanceof HTMLDetailsElement) card.open = true;
          card?.scrollIntoView({ block: 'nearest' });
          card?.querySelector('summary')?.focus({preventScroll:true});
        });
        line.append(link);
      }
      block.append(line);
    }
    body.append(block);
  }
  if (view.coachSummary) body.append(el('p', 'replay-summary', view.coachSummary));
  body.scrollTop=scroll;
  if(focusedStudy)[...body.querySelectorAll('[data-study-id]')].find(node=>node.dataset.studyId===focusedStudy)?.focus({preventScroll:true});
}

function openReplay(handNo) {
  openReplayHandNo = handNo;
  paintReplay();
  dialogs.open($('replay-overlay'),closeReplay);
}

function closeReplay() {
  openReplayHandNo = null;
  const overlay = $('replay-overlay');
  if (overlay) overlay.hidden = true;
  if(dialogs.active===overlay)dialogs.close();
}

function paintReview(view) {
  const overlay = $('review-overlay');
  $('review-reopen').hidden = !ui.review;
  const dismissed = overlay.dataset.dismissed === 'true';
  const show = Boolean(view?.gameOver && ui.review) && !dismissed && (!dialogs.active || dialogs.active===overlay);
  overlay.hidden = !show;
  if (!show) {
    if(dialogs.active===overlay)dialogs.close();
    return;
  }
  if(dialogs.active!==overlay)dialogs.open(overlay,()=>{overlay.dataset.dismissed='true';dialogs.close();});
  const result = $('review-result');
  result.textContent = view.result === 'win' ? '우승'
    : view.result === 'lose' ? '패배'
      : view.result === 'completed' ? '세션 완료'
        : '';
  result.classList.toggle('is-win', view.result === 'win');
  result.classList.toggle('is-lose', view.result === 'lose');
  const review = $('review-body');
  if (review._source !== ui.review) {
    const scroll = review.scrollTop;
    review.innerHTML = renderMarkdown(reviewBody(ui.review));
    review._source = ui.review; review.scrollTop = scroll;
  }
}

function paint() {
  const view = ui.view;
  paintTop(view);
  paintBoard(view);
  paintPots(view);
  paintSeats(view);
  paintThinking(view);
  paintActionBar(view);
  paintHint();
  paintLog();
  const coachScroll = $('panel-coach').scrollTop;
  paintCoach();
  $('panel-coach').scrollTop = coachScroll;
  paintTraining();
  paintUnread();
  paintReview(view);
  if (openReplayHandNo != null) paintReplay();
}

function upsertHandReplays(rows, replace) {
  if (replace) ui.handReplays = Object.create(null);
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (row && Number.isInteger(row.handNo)) ui.handReplays[row.handNo] = row;
  }
}

function mergeAnnotationOntoCards(ann) {
  const at = ui.training.findIndex((existing) => existing.evaluationId === ann.evaluationId);
  if (at === -1) return;
  ui.training[at] = applyTrainingAnnotation(ui.training[at], ann);
}

function renderSnapshot(snap) {
  ui.hint=hintState.accept(snap.hint,snap.view,hintRequests.get(snap)??{generation:-1});
  ui.view = snap.view ?? null;
  ui.log = Array.isArray(snap.log) ? snap.log.slice() : [];
  ui.coach = Array.isArray(snap.coach) ? snap.coach.slice() : [];
  ui.training = Array.isArray(snap.training) ? snap.training.slice() : [];
  ui.trainingAnnotations = Array.isArray(snap.trainingAnnotations)
    ? snap.trainingAnnotations.slice()
    : [];
  for (const ann of ui.trainingAnnotations) mergeAnnotationOntoCards(ann);
  ui.review = snap.review;
  upsertHandReplays(snap.handReplays, true);
  authenticatedStudyUrl = studyLink(snap.studyUrl);
  const study = $('study-open');
  study.hidden = !authenticatedStudyUrl;
  if (authenticatedStudyUrl) study.href = authenticatedStudyUrl;
  else study.removeAttribute('href');
  paint();
}

function render(m) {
  ui.hint=hintState.accept(m.hint,m.view??ui.view,{generation:m.hintGeneration??-1,canRestore:m.hint?.status==='supported'&&m.revision>revisionAtHintClear});
  if (m.view !== undefined) {
    const previous=new Map((ui.view?.seats??[]).map(s=>[s.playerId,s.out]));
    const eliminated=m.view?.mode==='cash-training'?[]:(m.view?.seats??[]).filter(s=>s.out===true&&previous.get(s.playerId)===false);
    if(eliminated.length)$('seat-announcement').textContent=eliminated.map(s=>`${s.name??s.playerId} 탈락`).join(', ');
    ui.view = m.view;
    actionController?.observe(ui.view, { revision: m.revision });
  }
  if (Array.isArray(m.events) && m.events.length) ui.log.push(...m.events);
  if (Array.isArray(m.messages) && m.messages.length) ui.log.push(...m.messages);
  if (Array.isArray(m.coach) && m.coach.length) {
    if (selectedTab !== 'coach') unread.coach += m.coach.length;
    // Notes arrive whenever their background coach finishes, not in hand order.
    for (const note of m.coach) {
      const at = ui.coach.findIndex((existing) => existing.handNo === note.handNo);
      if (at === -1) ui.coach.push(note);
      else ui.coach[at] = note;
    }
    ui.coach.sort((a, b) => (a.handNo ?? 0) - (b.handNo ?? 0));
  }
  if (Array.isArray(m.training) && m.training.length) {
    if (selectedTab !== 'training') unread.training += m.training.filter((item) => !ui.training.some((old) => old.evaluationId === item.evaluationId)).length;
    ui.training = mergeTrainingItems(ui.training, m.training);
    for (const ann of ui.trainingAnnotations) mergeAnnotationOntoCards(ann);
  }
  if (Array.isArray(m.trainingAnnotations) && m.trainingAnnotations.length) {
    if (selectedTab !== 'training') unread.training += m.trainingAnnotations.filter((ann) => !ui.trainingAnnotations.some((old) => old.evaluationId === ann.evaluationId && old.field === ann.field && JSON.stringify(old) === JSON.stringify(ann))).length;
    for (const ann of m.trainingAnnotations) {
      const at = ui.trainingAnnotations.findIndex((existing) => (
        existing.evaluationId === ann.evaluationId && existing.field === ann.field
      ));
      if (at === -1) ui.trainingAnnotations.push(ann);
      else ui.trainingAnnotations[at] = ann;
      mergeAnnotationOntoCards(ann);
    }
  }
  if (m.review !== undefined) {
    const overlay = $('review-overlay');
    overlay.dataset.dismissed = String(reviewDismissalAfterUpdate(
      overlay.dataset.dismissed === 'true', ui.review, m.review,
    ));
    ui.review = m.review;
  }
  if (Array.isArray(m.handReplays) && m.handReplays.length) upsertHandReplays(m.handReplays, false);
  paint();
}

async function sendAction(action, amount) {
  if (!ui.view?.legal || pendingAction) return;
  hideHint();
  const note = $('intent-note')?.value;
  await actionController?.send(action, amount === undefined ? undefined : Number(amount), note);
}

$('btn-fold').addEventListener('click', () => sendAction('fold'));
$('btn-check').addEventListener('click', () => sendAction('check'));
$('btn-call').addEventListener('click', () => sendAction('call'));
$('btn-raise').addEventListener('click', () => {
  const legal=ui.view?.legal;if(!legal || pendingAction)return;
  if($('raise-amount').value!==amountEditor.state.text)amountEditor.edit($('raise-amount').value,legal);
  const amount=amountEditor.submit(legal,{locked:pendingAction});
  const state=amountEditor.state;raiseTo=state.value;$('raise-amount').value=state.text;markAmountValid(!state.invalid);
  setBtnLabel($('btn-raise'),'총액 레이즈',raiseTo);
  if(amount!==null)void sendAction('raise',amount);
});
$('btn-allin-only').addEventListener('click', () => sendAction('raise', ui.view?.legal?.maxRaiseTo));

$('raise-slider').addEventListener('input', (ev) => {
  if (!ui.view?.legal || pendingAction) return;
  setRaiseTo(ev.target.value);
  markAmountValid(true);
});

$('raise-panel').addEventListener('click', (ev) => {
  const preset = ev.target.closest('[data-preset]')?.dataset.preset;
  const legal = ui.view?.legal;
  if (!preset || !legal || pendingAction || legal.minRaiseTo > legal.maxRaiseTo) return;
  const myBet = myBetOf(ui.view);
  if (preset === 'min') setRaiseTo(legal.minRaiseTo);
  else if (preset === 'half') setRaiseTo(potRaiseTo(legal, myBet, 0.5));
  else if (preset === 'pot') setRaiseTo(potRaiseTo(legal, myBet, 1));
  else if (preset === 'allin') setRaiseTo(legal.maxRaiseTo);
  else if (preset === 'rfi' || preset === 'threebet') {
    const amount = bbRaiseTo(legal, ui.view.blinds?.[1], preset === 'rfi' ? 2.5 : 8.5);
    if (amount !== null) setRaiseTo(amount);
  }
  markAmountValid(true);
});

// 직접 입력 — 유효 값은 전체 선택하고, 잘못된 원문과 보정 확인 상태는 보존한다.
$('raise-amount').addEventListener('focus', (ev) => {
  if(amountEditor.state.invalid || parseChipInput(ev.target.value)!==raiseTo)return;
  ev.target.value = amountEditor.state.text;
  ev.target.select();
});

$('raise-amount').addEventListener('input', (ev) => {
  const legal = ui.view?.legal;
  if (!legal || pendingAction) return;
  const state=amountEditor.edit(ev.target.value,legal);
  markAmountValid(!state.invalid);
  if(!state.invalid)setRaiseTo(state.value,{fromInput:true});
});

$('raise-amount').addEventListener('blur', commitAmount);

$('raise-amount').addEventListener('keydown', (ev) => {
  const legal = ui.view?.legal;
  if (!legal || pendingAction) return;
  if (ev.key === 'Enter') {
    ev.preventDefault();
    commitAmount();
    return;
  }
  if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
  ev.preventDefault();
  const step = ui.view?.blinds?.[1] ?? 1;
  const base = amountEditor.state.invalid ? raiseTo : (parseChipInput(ev.target.value) ?? raiseTo);
  setRaiseTo(base + (ev.key === 'ArrowUp' ? step : -step));
  markAmountValid(true);
});

function paintUnread() {
  for (const name of ['coach', 'training']) {
    const badge = $(`unread-${name}`);
    badge.textContent = unread[name] ? `새 ${unread[name]}` : '';
    badge.hidden = !unread[name];
  }
}

function selectTab(which) {
  selectedTab = which;
  if (which in unread) unread[which] = 0;
  paintUnread();
  for (const name of ['log', 'coach', 'training', 'participants']) {
    const on = name === which;
    $(`tab-${name}`)?.classList.toggle('on', on);
    $(`tab-${name}`)?.setAttribute('aria-selected', String(on));
    if($(`tab-${name}`))$(`tab-${name}`).tabIndex=on?0:-1;
    const panel = $(`panel-${name}`);
    if (panel) panel.hidden = !on;
  }
}

$('tab-log').addEventListener('click', () => selectTab('log'));
$('tab-coach').addEventListener('click', () => selectTab('coach'));
$('tab-training')?.addEventListener('click', () => selectTab('training'));
$('tab-participants').addEventListener('click',()=>selectTab('participants'));
selectTab('log');
document.querySelector('.tabs').addEventListener('keydown',ev=>{
  const tabs=['log','coach','training','participants'];let index=tabs.indexOf(selectedTab);
  if(ev.key==='ArrowRight')index=(index+1)%tabs.length;
  else if(ev.key==='ArrowLeft')index=(index+tabs.length-1)%tabs.length;
  else if(ev.key==='Home')index=0;else if(ev.key==='End')index=tabs.length-1;else return;
  ev.preventDefault();selectTab(tabs[index]);$(`tab-${tabs[index]}`).focus();
});
$('display-unit').value=displayUnit;
$('display-unit').addEventListener('change',ev=>{
  displayUnit=ev.target.value==='chips'?'chips':'bb';writePreference(displayUnit);
  paintTop(ui.view);paintPots(ui.view);paintSeats(ui.view);paintActionBar(ui.view);paintLog();if(openReplayHandNo!==null)paintReplay();
});
$('seat-close').addEventListener('click',()=>dialogs.close());
$('log-new').addEventListener('click',()=>{$('log-list').scrollTop=$('log-list').scrollHeight;$('log-list')._unread=0;$('log-new').hidden=true;});

$('replay-close')?.addEventListener('click', () => {
  closeReplay();
});
$('replay-overlay')?.addEventListener('click', (ev) => {
  if (ev.target === $('replay-overlay')) closeReplay();
});
$('review-close').addEventListener('click', () => {
  const overlay = $('review-overlay');
  overlay.dataset.dismissed = 'true';
  dialogs.close();
  $('review-reopen').focus();
});
$('review-reopen').addEventListener('click', () => {
  if(dialogs.active)dialogs.dismiss();
  $('review-overlay').dataset.dismissed = 'false';
  paintReview(ui.view);
  $('review-close').focus();
});
$('action-reconcile').addEventListener('click', () => void actionController?.reconcile());
$('action-retry').addEventListener('click', () => void actionController?.retry());

const token = appGameId ? sessionStorage.getItem('holdem-app-token') : new URLSearchParams(location.search).get('token');
let revision = 0;
const buffer = [];
let booted = false;
let opening = false;
async function getSnapshot({ signal } = {}) {
  const generation=hintState.capture();
  const response = await (appGameId ? appFetch('snapshot',{signal}) : fetch(`/api/snapshot?${new URLSearchParams({ token })}`, { signal }));
  if (!response.ok) throw new Error('AUTHORITY_UNAVAILABLE');
  const snapshot=await response.json();let canRestore=false;
  try{if(appGameId&&new URLSearchParams(location.search).get('terminal')==='1')return snapshot;const status=await getStatus({signal});canRestore=status.decisionId===snapshot.view?.legal?.decisionId&&['rejected','unreceived'].includes(status.phase);}catch{}
  hintRequests.set(snapshot,{generation,canRestore});return snapshot;
}
async function getStatus({ signal } = {}) {
  const response = await (appGameId ? appFetch('action-status',{signal}) : fetch(`/api/action-status?${new URLSearchParams({ token })}`, { signal }));
  if (!response.ok) throw new Error('AUTHORITY_UNAVAILABLE');
  return response.json();
}
async function initializeController() {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const gameEpoch = appGameId ? appEpoch : Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  actionController = createActionController({
    gameEpoch, getSnapshot, getStatus, storage: sessionStorage,
    postAction: async (body, { signal }) => {
      const live = $('intent-note')?.value;
      const note = typeof body.note === 'string' ? body.note
        : typeof live === 'string' ? live
          : undefined;
      const payload = appGameId ? {...body} : { token, ...body };
      if (typeof note === 'string') payload.note = note;
      else delete payload.note;
      const actionOptions={method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)};
      const response=await (appGameId ? appFetch('action',actionOptions) : fetch('/api/action',actionOptions));
      const result = await response.json();
      return response.ok ? result : { ...result, ok: false };
    },
    onSnapshot: (snapshot) => {
      if (snapshot.revision < revision) return;
      renderSnapshot(snapshot); revision = snapshot.revision;
    },
    onState: (state) => {
      pendingAction = state.disabled;
      $('action-status').textContent = state.message;
      $('action-retry').hidden = !state.canRetry;
      $('action-retry').disabled = !state.canRetry;
      $('action-reconcile').hidden = !['unknown', 'unreceived', 'accepted', 'delivered', 'consumed'].includes(state.phase);
      paintActionBar(ui.view);
    },
  });
}
function applyMessage(m) {
  if (m.revision <= revision) return;
  revision = m.revision; render(m);
}
if (!token) showBootError('접속 토큰이 없습니다. 게임에서 제공한 접속 링크를 다시 열어 주세요.');
else if (appGameId && new URLSearchParams(location.search).get('terminal') === '1') {
  try { const snapshot=await getSnapshot();renderSnapshot(snapshot);setConn(true);$('action-status').textContent='종료된 게임 기록입니다.'; } catch {showBootError('기록을 불러오지 못했습니다.');}
}
else {
  const es = appGameId ? eventStream('events?after=0') : new EventSource(`/api/events?${new URLSearchParams({ token, after: '0' })}`);
  es.addEventListener('hint-clear',event=>{
    try{const payload=JSON.parse(event.data);if(payload.decisionId===ui.view?.legal?.decisionId){hideHint(payload.decisionId);void actionController?.reconcile();}}catch{hideHint();}
  });
  es.onmessage = (event) => {
    try {
      const msg = { revision: Number(event.lastEventId), ...JSON.parse(event.data),hintGeneration:hintState.capture() };
      if (!booted) { buffer.push(msg); return; }
      applyMessage(msg);
    } catch (error) {
      console.error('UI_RENDER_FAILED', error?.name, String(error?.stack??'').split('\n').slice(1).join('\n'));
      setConn(false); actionController?.disconnect();
    }
  };
  es.onopen = async () => {
    if (opening) return;
    opening = true;
    try {
      const snapshot = await getSnapshot();
      if (!actionController) await initializeController();
      await actionController.connect(snapshot);
      booted = true; setConn(true);
      for (const msg of buffer.splice(0)) applyMessage(msg);
    } catch {
      booted = false; setConn(false); actionController?.disconnect();
      $('action-status').textContent = '현재 상태를 불러오지 못했습니다. 연결 또는 접속 링크를 확인하세요.';
    } finally { opening = false; }
  };
  es.onerror = () => { booted = false; setConn(false); actionController?.disconnect(); };
  const poll = setInterval(() => {
    if (booted && actionController && ['unknown', 'unreceived', 'accepted', 'delivered', 'consumed'].includes(actionController.state.phase)) void actionController.reconcile();
  }, 2500);
  window.addEventListener('pagehide', () => { clearInterval(poll); es.close(); });
}
paint();
