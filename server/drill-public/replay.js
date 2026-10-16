import { mountReplayPlayer } from '../public/replay-player.js';
import { createReplaySelection, readReplayEntry, startReplayHeartbeat, createAbortScope } from './replay-library-state.js';

const ERRORS = Object.freeze({
  REPLAY_BAD_REQUEST: '잘못된 기록 요청입니다.', REPLAY_NOT_FOUND: '기록을 찾을 수 없습니다.',
  REPLAY_NOT_COMPLETED: '아직 완료되지 않은 핸드입니다.', REPLAY_UNAVAILABLE: '기록을 확인할 수 없습니다.',
  REPLAY_UNSUPPORTED: '지원하지 않는 형식의 기록입니다.', REPLAY_LIMIT_EXCEEDED: '기록이 조회 한도를 초과했습니다.',
  REPLAY_BUSY: '기록을 읽는 중 변경되었거나 다른 조회가 진행 중입니다. 다시 시도해 주세요.',
  UNAUTHORIZED: '접속 토큰이 만료되었거나 유효하지 않습니다. 학습실 링크를 다시 열어 주세요.',
  FORBIDDEN: '이 주소에서는 기록을 열 수 없습니다.', CONNECTION: '학습 서비스에 연결하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.',
});
const STATUS = { completed: '완료', aborted: '중단', unfinished: '미종료 (실행 여부 미확인)', unavailable: '기록 확인 불가' };
export async function mountReplayLibrary({ doc = document, location = window.location, history = window.history, fetcher = fetch, heartbeatFactory = startReplayHeartbeat } = {}) {
  const $ = id => doc.getElementById(id);
  const entry = readReplayEntry(location);
  history.replaceState(null, '', entry.cleanUrl);
  $('back-study').href = entry.studyUrl;
  const status = $('library-status'), content = $('library-content'), nav = $('library-nav'), playerBox = $('library-player');
  const node = (tag, text, cls) => { const el = doc.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; };
  const button = (text, action) => { const b = node('button', text, 'ui-btn ui-btn--quiet'); b.type = 'button'; b.addEventListener('click', action); return b; };
  let player = null, authenticated = true, lastFocus = null, gameOffset = 0, gameLimit = 25, pendingFocus = false, closed = false, stopHeartbeat = () => {};
  const pageAbort = new AbortController();
  status.setAttribute('tabindex','-1');
  $('replay-unit').addEventListener('change',()=>player?.setUnit($('replay-unit').value));
  async function api(pathname, options = {}) {
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 35000);
    const scope = createAbortScope([pageAbort.signal, timeout.signal, ...(options.signal ? [options.signal] : [])]);
    const signal = scope.signal;
    try {
      const response = await fetcher(pathname, { method: options.method ?? 'GET', signal, cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'x-drill-token': entry.token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
      const body = await response.json();
      if (response.status === 401) authenticated = false;
      return { ...body, ok: response.ok && body.ok === true };
    } finally { clearTimeout(timer); scope.dispose(); }
  }
  function disposePlayer() { player?.dispose(); player = null; playerBox.replaceChildren(); }
  function retry(state) {
    return state.page === 'hand' ? selection.hand(state.gameId, state.handNo, state.offset, state.limit)
      : state.page === 'hands' ? selection.hands(state.gameId, state.offset, state.limit) : selection.games(state.offset, state.limit);
  }
  function pager(state, nextOffset) {
    if (state.offset > 0) nav.append(button('이전 페이지', () => state.page === 'games' ? selection.games(Math.max(0,state.offset-state.limit),state.limit) : selection.hands(state.gameId,Math.max(0,state.offset-state.limit),state.limit)));
    if (nextOffset != null) nav.append(button('다음 페이지', () => state.page === 'games' ? selection.games(nextOffset,state.limit) : selection.hands(state.gameId,nextOffset,state.limit)));
  }
  function render(state) {
    if (state.kind === 'loading') pendingFocus = content.contains(doc.activeElement) || nav.contains(doc.activeElement) || doc.activeElement === doc.body;
    content.replaceChildren(); nav.replaceChildren();
    if (state.page !== 'games') nav.append(button('게임 목록', () => { lastFocus = {gameId:state.gameId}; selection.games(gameOffset,gameLimit); }));
    if (state.page === 'hand') nav.append(button('핸드 목록', () => { lastFocus = {handNo:state.handNo}; selection.hands(state.gameId,state.offset,state.limit); }));
    if (state.kind === 'loading') { status.textContent = '기록을 불러오고 있습니다.'; if (pendingFocus) status.focus(); return; }
    nav.append(button('새로고침', () => retry(state)));
    if (state.kind === 'error') {
      disposePlayer(); status.textContent = ERRORS[state.code] ?? ERRORS.CONNECTION;
      nav.append(button('다시 시도', () => retry(state)));
      if (state.code === 'REPLAY_LIMIT_EXCEEDED' && state.page !== 'hand' && state.limit > 1) {
        nav.append(button('페이지 크기 줄여 다시 시도', () => state.page === 'games'
          ? selection.games(state.offset,Math.max(1,Math.floor(state.limit/2)))
          : selection.hands(state.gameId,state.offset,Math.max(1,Math.floor(state.limit/2)))));
      }
      if (pendingFocus) status.focus();
      pendingFocus = false; return;
    }
    if (state.kind !== 'ready') return;
    status.textContent = '';
    const value = state.value;
    if (state.page === 'games') {
      gameOffset = state.offset; gameLimit = state.limit;
      if (!value.games.length) content.append(node('p', value.legacyPresent ? '이전 형식의 기록은 아직 보관함에서 지원하지 않습니다.' : '저장된 플레이 기록이 없습니다.'));
      const list = node('ul', null, 'replay-records');
      for (const game of value.games) {
        const item = node('li'), b = button(`${game.mode === 'cash-training' ? '캐시 연습' : game.mode === 'tournament' ? '토너먼트' : '종류 확인 불가'} · ${game.seatCount ?? '?'}인 · ${game.unavailableCode === 'REPLAY_BUSY' ? '읽기 중 변경 · 다시 시도' : STATUS[game.status] ?? STATUS.unavailable}`, () => selection.hands(game.gameId));
        b.dataset.gameId = game.gameId; b.disabled = game.status === 'unavailable';
        item.append(b, node('p', game.savedAt ? `최근 저장 ${new Date(game.savedAt).toLocaleString('ko-KR')}` : '저장 시각 확인 불가', 'ui-muted'));
        if (game.unavailableCode === 'REPLAY_BUSY') item.append(button('이 게임 다시 확인',()=>selection.games(state.offset,state.limit)));
        if (game.unavailableCode) item.append(node('p', ERRORS[game.unavailableCode] ?? ERRORS.REPLAY_UNAVAILABLE));
        list.append(item);
      }
      content.append(list); pager(state,value.nextOffset);
    } else if (state.page === 'hands') {
      content.append(node('h2','완료된 핸드'));
      if (!value.hands.length) content.append(node('p','완료된 핸드가 없습니다.'));
      const list = node('ul',null,'replay-records');
      for (const hand of value.hands) {
        const item=node('li'), b=button(`핸드 ${hand.handNo} · 블라인드 ${(hand.blinds ?? []).join('/')} · ${hand.heroDealt === false ? '참여 안 함' : hand.heroPosition ?? '위치 정보 없음'}`,()=>selection.hand(state.gameId,hand.handNo,state.offset,state.limit));
        b.dataset.handNo=String(hand.handNo); b.disabled=!hand.available; item.append(b);
        if (hand.unavailableCode === 'REPLAY_BUSY') item.append(button('이 핸드 다시 확인',()=>selection.hands(state.gameId,state.offset,state.limit)));
        if (!hand.available) item.append(node('p',ERRORS[hand.unavailableCode] ?? ERRORS.REPLAY_UNAVAILABLE));
        list.append(item);
      }
      content.append(list); pager(state,value.nextOffset);
    } else {
      const names=Object.fromEntries((value.game.seats ?? []).map(seat=>[seat.playerId,seat.name]));
      player = mountReplayPlayer(playerBox,{replay:value.replay,names,viewer:value.game.viewerId ?? 'user',perspective:'own',unit:$('replay-unit').value});
    }
    if (lastFocus) {
      const target=[...content.querySelectorAll('button')].find(b=>lastFocus.gameId ? b.dataset.gameId===lastFocus.gameId : b.dataset.handNo===String(lastFocus.handNo));
      (target ?? content).focus(); lastFocus=null;
    } else if (pendingFocus) {
      if (state.page==='hand') playerBox.querySelector('.replayer-play,button')?.focus();
      else { const heading=content.querySelector('h2'); if(heading) heading.setAttribute('tabindex','-1'); (heading ?? content).focus(); }
    }
    pendingFocus=false;
  }
  const selection = createReplaySelection({api,onState:render,disposePlayer});
  async function start() {
    nav.replaceChildren();
    if (!entry.token) { status.textContent = '접속 토큰이 없습니다. 학습실 링크를 다시 열어 주세요.'; return; }
    try {
      const health = await api('/api/health');
      if (closed) return;
      if (!health.ok) { status.textContent=ERRORS[health.code] ?? ERRORS.CONNECTION; nav.append(button('다시 확인',start)); return; }
      if (health.capabilities?.replayLibrary !== 1) { status.textContent='구버전 학습 서비스가 실행 중입니다. 서버에서 학습 서비스를 종료한 뒤 다시 열어 주세요.'; nav.append(button('다시 확인',start)); return; }
      stopHeartbeat(); stopHeartbeat=heartbeatFactory({api,visible:()=>authenticated && doc.visibilityState!=='hidden',onError:code=>{status.textContent=ERRORS[code] ?? ERRORS.CONNECTION;}});
      await selection.games();
    } catch { if (closed) return; status.textContent=ERRORS.CONNECTION; nav.append(button('다시 확인',start)); }
  }
  const dispose=()=>{closed=true;pageAbort.abort();stopHeartbeat();selection.dispose();};
  doc.defaultView?.addEventListener('pagehide',dispose,{once:true});
  doc.defaultView?.addEventListener('pageshow',event=>{if(event.persisted) location.reload();});
  await start();
  return {dispose,selection};
}
if (typeof document !== 'undefined') await mountReplayLibrary();
