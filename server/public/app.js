const SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' };
const STREET = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' };
const ACTION = { fold: '폴드', check: '체크', call: '콜', raise: '레이즈' };

const ui = { view: null, log: [], coach: [], review: undefined };
let pendingAction = false;
let raiseTo = 0;
let lastDecisionId = null;
let lastTalk = {};
let overlayDismissed = false;

const $ = (id) => document.getElementById(id);

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
  if (!code || typeof code !== 'string' || code.length < 2) return { rank: '?', suit: '?', red: false };
  const rankRaw = code.slice(0, -1);
  const suitKey = code.slice(-1);
  return {
    rank: rankRaw === 'T' ? '10' : rankRaw,
    suit: SUITS[suitKey] || suitKey,
    red: suitKey === 'h' || suitKey === 'd',
  };
}

function cardNode(code, { faceDown = false, small = false, slot = false } = {}) {
  const el = document.createElement('div');
  el.className = 'card';
  if (small) el.classList.add('sm');
  if (slot) {
    el.classList.add('slot');
    return el;
  }
  if (faceDown || !code) {
    el.classList.add('back');
    return el;
  }
  const parsed = formatCard(code);
  if (parsed.red) el.classList.add('red');
  const rank = document.createElement('span');
  rank.className = 'rank';
  rank.textContent = parsed.rank;
  const suit = document.createElement('span');
  suit.className = 'suit';
  suit.textContent = parsed.suit;
  el.append(rank, suit);
  return el;
}

function playerName(playerId) {
  if (playerId === 'user') return '나';
  const seat = ui.view?.seats?.find((s) => s.playerId === playerId);
  return seat?.name ?? playerId ?? '';
}

function cardsText(codes) {
  return (codes ?? []).map((code) => {
    const parsed = formatCard(code);
    return `${parsed.rank}${parsed.suit}`;
  }).join(' ');
}

function revealedCards() {
  const map = {};
  const mucks = new Set();
  for (const item of ui.log) {
    if (item.type === 'hand_start') {
      for (const key of Object.keys(map)) delete map[key];
      mucks.clear();
      lastTalk = {};
    }
    if (item.type === 'showdown') {
      for (const reveal of item.reveals ?? []) map[reveal.playerId] = reveal;
      for (const pid of item.mucks ?? []) mucks.add(pid);
    }
    if (item.type === 'talk' && item.playerId && item.text) lastTalk[item.playerId] = item.text;
  }
  return { map, mucks };
}

function formatLogItem(item) {
  switch (item.type) {
    case 'hand_start':
      return `핸드 ${item.handNo} 시작 · 버튼 ${playerName(item.button)}`;
    case 'blinds_posted':
      return `블라인드 게시 ${formatChip(item.sb)}/${formatChip(item.bb)}`;
    case 'level_up':
      return `레벨 업 — 블라인드 ${formatChip(item.sb)}/${formatChip(item.bb)}`;
    case 'action': {
      const verb = ACTION[item.action] ?? item.action;
      const extra = item.action === 'raise' && item.amount != null ? ` ${formatChip(item.amount)}` : '';
      const allIn = item.allIn ? ' 올인' : '';
      return `${playerName(item.playerId)} ${verb}${extra}${allIn}`;
    }
    case 'street':
      return `${STREET[item.street] ?? item.street} ${cardsText(item.board)}`;
    case 'showdown': {
      const shown = (item.reveals ?? []).map((r) => {
        const hand = r.handName ? ` (${r.handName})` : '';
        return `${playerName(r.playerId)} ${cardsText(r.cards)}${hand}`;
      });
      const mucked = (item.mucks ?? []).map((pid) => `${playerName(pid)} 머크`);
      return `쇼다운 — ${[...shown, ...mucked].join(', ')}`;
    }
    case 'pot_award': {
      const winners = (item.winners ?? []).map((w) => `${playerName(w.playerId)} ${formatChip(w.share)}`);
      return `팟 ${formatChip(item.amount)} → ${winners.join(', ') || '없음'}`;
    }
    case 'bust':
      return `${playerName(item.playerId)} 탈락`;
    case 'game_over':
      return `게임 종료: ${item.result === 'win' ? '우승' : item.result === 'lose' ? '패배' : item.result}`;
    case 'talk':
      return `${playerName(item.playerId)}: ${item.text ?? ''}`;
    case 'narration':
      return item.text ?? '';
    default:
      return item.text ?? item.type ?? '';
  }
}

function clampRaiseTo(value, legal) {
  const n = Math.round(Number(value));
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
  const el = $('conn');
  el.textContent = on ? '연결됨' : '재접속 중…';
  el.classList.toggle('on', on);
  el.classList.toggle('off', !on);
}

function showBootError(text) {
  $('boot-error-text').textContent = text;
  $('boot-error').hidden = false;
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
  const pots = view?.pots ?? [];
  if (!pots.length) {
    $('pots').textContent = '팟 0';
    return;
  }
  if (pots.length === 1) {
    $('pots').textContent = `팟 ${formatChip(pots[0].amount)}`;
    return;
  }
  $('pots').textContent = pots.map((pot, i) => (
    `${i === 0 ? '메인 팟' : '사이드팟'} ${formatChip(pot.amount)}`
  )).join(' · ');
}

function paintSeats(view) {
  const root = $('seats');
  root.replaceChildren();
  const seats = view?.seats ?? [];
  if (!seats.length) return;
  const userIdx = Math.max(0, seats.findIndex((s) => s.playerId === 'user'));
  const { map: revealed, mucks } = revealedCards();
  const n = seats.length;
  for (let i = 0; i < n; i += 1) {
    const seat = seats[(userIdx + i) % n];
    const angle = (Math.PI * 2 * i) / n;
    const el = document.createElement('div');
    el.className = 'seat';
    if (seat.folded) el.classList.add('folded');
    if (view.toAct === seat.playerId) el.classList.add('to-act');
    el.style.left = `${50 + 42 * Math.sin(angle)}%`;
    el.style.top = `${52 + 38 * Math.cos(angle)}%`;

    const cards = document.createElement('div');
    cards.className = 'seat-cards';
    if (seat.playerId === 'user') {
      for (const code of view.myCards ?? []) cards.append(cardNode(code, { small: true }));
    } else if (revealed[seat.playerId]) {
      for (const code of revealed[seat.playerId].cards ?? []) cards.append(cardNode(code, { small: true }));
    } else if (mucks.has(seat.playerId)) {
      const mk = document.createElement('div');
      mk.className = 'badge';
      mk.textContent = '머크';
      cards.append(mk);
    } else if (!seat.folded && view.street) {
      cards.append(cardNode(null, { faceDown: true, small: true }), cardNode(null, { faceDown: true, small: true }));
    }

    const body = document.createElement('div');
    body.className = 'seat-body';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = (seat.name ?? '?').slice(0, 1);
    const info = document.createElement('div');
    info.className = 'seat-info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = seat.playerId === 'user' ? '나' : (seat.name ?? seat.playerId);
    const stack = document.createElement('div');
    stack.className = 'stack';
    stack.textContent = formatChip(seat.stack);
    info.append(name, stack);
    body.append(avatar, info);
    if (seat.isButton) {
      const d = document.createElement('div');
      d.className = 'dealer-btn';
      d.textContent = 'D';
      body.append(d);
    }

    const bet = document.createElement('div');
    bet.className = 'bet';
    bet.textContent = seat.bet ? formatChip(seat.bet) : '';

    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = seat.allIn ? '올인' : seat.folded ? '폴드' : '';

    el.append(cards, body, bet, badge);
    const talk = lastTalk[seat.playerId];
    if (talk) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = talk;
      el.append(bubble);
    }
    root.append(el);
  }
}

function paintThinking(view) {
  const el = $('thinking');
  const idle = $('idle-hint');
  if (!view) {
    el.hidden = true;
    idle.hidden = false;
    idle.textContent = '게임을 기다리는 중…';
    return;
  }
  idle.hidden = true;
  if (view.toAct && view.toAct !== 'user' && !view.gameOver) {
    el.hidden = false;
    el.textContent = `${playerName(view.toAct)} 생각 중…`;
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}

function syncRaiseTo(legal, view) {
  if (!legal) {
    lastDecisionId = null;
    raiseTo = 0;
    return;
  }
  if (legal.decisionId !== lastDecisionId) {
    lastDecisionId = legal.decisionId;
    raiseTo = legal.minRaiseTo > legal.maxRaiseTo ? legal.maxRaiseTo : legal.minRaiseTo;
  }
  if (legal.minRaiseTo <= legal.maxRaiseTo) raiseTo = clampRaiseTo(raiseTo, legal);
  $('raise-slider').min = legal.minRaiseTo;
  $('raise-slider').max = legal.maxRaiseTo;
  $('raise-slider').value = raiseTo;
  $('btn-raise').textContent = `레이즈 ${formatChip(raiseTo)}`;
  const myBet = myBetOf(view);
  $('raise-panel').dataset.half = String(potRaiseTo(legal, myBet, 0.5));
  $('raise-panel').dataset.pot = String(potRaiseTo(legal, myBet, 1));
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
  $('btn-call').textContent = `콜 ${formatChip(legal.callAmount)}`;
  $('raise-panel').hidden = shortAllIn;
  $('raise-slider').disabled = raiseOff;
  $('btn-raise').disabled = raiseOff;
  for (const btn of $('raise-panel').querySelectorAll('[data-preset]')) {
    btn.disabled = raiseOff;
  }
  $('btn-allin-only').hidden = !shortAllIn;
  $('btn-allin-only').disabled = raiseOff;
  $('btn-allin-only').textContent = `올인 ${formatChip(legal.maxRaiseTo)}`;
  if (!shortAllIn) syncRaiseTo(legal, view);
}

function paintLog() {
  const list = $('log-list');
  if (!ui.log.length) {
    list.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = '아직 이벤트가 없습니다.';
    list.append(empty);
    return;
  }
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  list.replaceChildren();
  for (const item of ui.log) {
    const row = document.createElement('div');
    row.className = `log-item log-${item.type || 'event'}`;
    row.textContent = formatLogItem(item);
    list.append(row);
  }
  if (stick) list.scrollTop = list.scrollHeight;
}

function paintCoach() {
  const list = $('coach-list');
  list.replaceChildren();
  if (!ui.coach.length) {
    const empty = document.createElement('div');
    empty.className = 'coach-empty';
    empty.textContent = '핸드가 끝나면 코칭이 쌓입니다.';
    list.append(empty);
    return;
  }
  for (const note of ui.coach) {
    const wrap = document.createElement('div');
    wrap.className = 'coach-note';
    const hn = document.createElement('div');
    hn.className = 'hn';
    hn.textContent = `핸드 ${note.handNo}`;
    const tx = document.createElement('div');
    tx.textContent = note.text ?? '';
    wrap.append(hn, tx);
    list.append(wrap);
  }
}

function paintReview(view) {
  const overlay = $('review-overlay');
  const show = Boolean(view?.gameOver && ui.review) && !overlayDismissed;
  overlay.hidden = !show;
  if (!show) return;
  $('review-result').textContent = view.result === 'win' ? '우승' : view.result === 'lose' ? '패배' : '';
  $('review-body').innerHTML = renderMarkdown(ui.review);
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
  paintReview(view);
}

function renderSnapshot(snap) {
  ui.view = snap.view ?? null;
  ui.log = Array.isArray(snap.log) ? snap.log.slice() : [];
  ui.coach = Array.isArray(snap.coach) ? snap.coach.slice() : [];
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
  if (Array.isArray(m.coach) && m.coach.length) ui.coach.push(...m.coach);
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
  const legal = ui.view?.legal;
  if (!legal) return;
  raiseTo = clampRaiseTo(ev.target.value, legal);
  $('btn-raise').textContent = `레이즈 ${formatChip(raiseTo)}`;
});
$('raise-panel').addEventListener('click', (ev) => {
  const preset = ev.target.closest('[data-preset]')?.dataset.preset;
  const legal = ui.view?.legal;
  if (!preset || !legal || legal.minRaiseTo > legal.maxRaiseTo) return;
  const myBet = myBetOf(ui.view);
  if (preset === 'min') raiseTo = legal.minRaiseTo;
  else if (preset === 'half') raiseTo = potRaiseTo(legal, myBet, 0.5);
  else if (preset === 'pot') raiseTo = potRaiseTo(legal, myBet, 1);
  else if (preset === 'allin') raiseTo = legal.maxRaiseTo;
  $('raise-slider').value = raiseTo;
  $('btn-raise').textContent = `레이즈 ${formatChip(raiseTo)}`;
});

$('tab-log').addEventListener('click', () => {
  $('tab-log').classList.add('on');
  $('tab-coach').classList.remove('on');
  $('tab-log').setAttribute('aria-selected', 'true');
  $('tab-coach').setAttribute('aria-selected', 'false');
  $('panel-log').hidden = false;
  $('panel-coach').hidden = true;
});
$('tab-coach').addEventListener('click', () => {
  $('tab-coach').classList.add('on');
  $('tab-log').classList.remove('on');
  $('tab-coach').setAttribute('aria-selected', 'true');
  $('tab-log').setAttribute('aria-selected', 'false');
  $('panel-coach').hidden = false;
  $('panel-log').hidden = true;
});
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
