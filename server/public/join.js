import {paintFinalPanel} from './final-panel.js';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.get('code')) $('join-code').value = params.get('code');
if (location.hash.startsWith('#rejoin=')) {
  sessionStorage.setItem('holdem-participant-token', location.hash.slice(8));
  history.replaceState(null, '', location.pathname);
}
let fails = 0;
let latest = null;
let tableIdentity = null;
let polling = false;
let summaryIdentity=null,finalSummary=null,finalPanelKey=null;
async function loadSummary(state,token) {
  const id=state.game.gameId,epoch=state.game.gameEpoch,key=`${id}:${epoch}`;
  if(summaryIdentity===key)return;
  summaryIdentity=key;finalSummary=null;
  for(let attempt=0;attempt<4;attempt++) {
    if(attempt)await new Promise(resolve=>setTimeout(resolve,2500));
    if(summaryIdentity!==key)return;
    try {
      const response=await fetch(`/api/p/game/${id}/summary`,{headers:{authorization:`Bearer ${token}`,'x-game-epoch':epoch},signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw new Error('SUMMARY_UNAVAILABLE');
      const summary=await response.json();
      if(summaryIdentity===key){finalSummary=summary;paintFinal(latest.game.final,latest);}
      return;
    } catch { /* bounded retries, final stacks remain available */ }
  }
}
const JOIN_ERRORS = {
  BAD_CODE: '참가 코드가 올바르지 않습니다.',
  ROOM_FULL: '참가 인원이 가득 찼습니다.',
  ROOM_LOCKED: '게임 준비 또는 진행 중입니다. 게임 종료 후 다시 시도하세요.',
  SPECTATOR_FULL: '관전 정원(20명)이 가득 찼습니다.',
  STALE_ROOM: '방 상태가 바뀌었습니다. 다시 시도하세요.',
  NAME_TAKEN: '이미 쓰인 이름입니다. 다른 이름을 선택하세요.',
  JOIN_LOCKED: '이 주소는 잠시 참가가 잠겼습니다.',
  ROOM_NOT_FOUND: '세션을 찾을 수 없습니다.',
  RATE_LIMIT: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
};
function paintFinal(final,state) {
  if(!final?.stacks)return;
  const spectator=state.me.roomRole==='spectator'||state.me.viewerRole==='spectator';
  const key=JSON.stringify([final,finalSummary,state.me.playerId,spectator]);if(key===finalPanelKey)return;finalPanelKey=key;
  const table=$('final-stacks');table.replaceChildren();
  const hasNet=final.stacks.every(row=>Number.isSafeInteger(row.net));
  const head=document.createElement('tr');
  for(const label of ['순위','이름',...(hasNet?['증감']:[]),'최종 스택']){const th=document.createElement('th');th.textContent=label;head.append(th);}
  const thead=document.createElement('thead');thead.append(head);table.append(thead);
  for(const row of [...final.stacks].sort((a,b)=>(a.rank??Infinity)-(b.rank??Infinity))) {
    const tr=document.createElement('tr');
    for(const value of [row.rank??'—',row.name??row.playerId,...(hasNet?[`${row.net>0?'+':''}${row.net}`]:[]),row.stack??'']){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}table.append(tr);
  }
  paintFinalPanel($('final-details'),{summary:finalSummary,viewer:spectator?null:state.me.playerId,
    view:{seats:[],mode:'tournament'},includeRanking:false});

}
async function poll() {
  const token = sessionStorage.getItem('holdem-participant-token');
  if (!token || polling) return;
  polling = true;
  try {
    const res = await fetch('/api/p/state', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('offline');
    fails = 0;
    if($('join-error').dataset.kind==='offline'){$('join-error').textContent='';delete $('join-error').dataset.kind;}
    const state = await res.json();
    latest = state;
    $('member-controls').hidden = false;
    const spectator = state.me.roomRole === 'spectator';
    const watching = spectator || state.me.viewerRole === 'spectator';
    $('member-role').textContent = `${watching ? '관전 중 · 모든 카드 공개' : '플레이어'} · 관전자 ${state.room.spectatorCount ?? 0}명`;
    $('seat-request').hidden = !spectator;
    $('seat-request').disabled = !state.room.canRequestSeat;
    $('seat-request').title = state.room.status !== 'open' ? '게임 종료 후 신청 가능' : state.room.canRequestSeat ? '' : '참가 인원이 가득 찼습니다';
    $('leave').hidden = !watching && state.room.status === 'locked';
    $('leave').textContent = watching ? '관전 나가기' : '나가기';
    $('join-form').hidden = true;
    const inGame = ['playing','pausing','paused','stopping','finalizing','completed','ended'].includes(state.game?.state);
    $('waiting').hidden = inGame || Boolean(state.game?.final);
    $('playing').hidden = !inGame;
    document.body.classList.toggle('has-game', !$('playing').hidden);
    $('pause-banner').hidden = state.game?.state !== 'paused';
    $('final').hidden = !state.game?.final;
    if (state.game?.final) {
      paintFinal(state.game.final,state);
      void loadSummary(state,token);
      $('final-reason').textContent = state.game.final.result === 'lose' ? '모든 인간 플레이어 탈락으로 종료되었습니다.'
        : state.game.final.result === 'abort' ? '게임이 중단되었습니다.' : '게임이 완료되었습니다.';
    }
    $('waiting-status').textContent = state.game?.state === 'starting'
      ? '게임 준비 중'
      : '호스트가 시작하기를 기다리는 중';
    const identity = inGame && state.game?.gameId && state.game?.gameEpoch
      ? `${state.game.gameId}:${state.game.gameEpoch}:${state.me.viewerGeneration}` : null;
    if (identity !== tableIdentity) {
      // Remove the old document and its SSE/card/receipt state before any new game.
      const table = document.createElement('iframe');table.id='table';table.title='홀덤 테이블';
      $('table').replaceWith(table);tableIdentity=identity;
      if(summaryIdentity && !summaryIdentity.startsWith(`${state.game?.gameId}:`)){summaryIdentity=null;finalSummary=null;finalPanelKey=null;}
    }
    if (identity && !$('table').getAttribute('src')) {
      $('table').src = `/table?participant=1&appGame=${state.game.gameId}&epoch=${encodeURIComponent(state.game.gameEpoch)}${['completed','ended'].includes(state.game.state)?'&terminal=1':''}`;
    }
  } catch {
    fails += 1;
    if (fails >= 5){$('join-error').dataset.kind='offline';$('join-error').textContent = '세션이 닫혔거나 호스트가 오프라인입니다';}
  } finally {polling=false;}
}
$('join-form').onsubmit = async (event) => {
  event.preventDefault();
  $('join-error').textContent = '';
  const res = await fetch('/api/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: $('join-code').value, name: $('join-name').value }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    delete $('join-error').dataset.kind;
    $('join-error').textContent = JOIN_ERRORS[body.code] ?? body.code ?? '참가에 실패했습니다';
    return;
  }
  sessionStorage.setItem('holdem-participant-token', body.participantToken);
  history.replaceState(null, '', location.pathname);
  await poll();
};
$('leave')?.addEventListener('click', async () => {
  const token = sessionStorage.getItem('holdem-participant-token');
  const response = await fetch('/api/p/leave', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) { delete $('join-error').dataset.kind; $('join-error').textContent='지금은 나갈 수 없습니다. 잠시 후 다시 시도하세요.';return; }
  sessionStorage.removeItem('holdem-participant-token');
  location.reload();
});
$('seat-request')?.addEventListener('click', async () => {
  if (!latest) return;
  const response = await fetch('/api/p/seat-request', {method:'POST',headers:{
    authorization:`Bearer ${sessionStorage.getItem('holdem-participant-token')}`,'content-type':'application/json'},
    body:JSON.stringify({expectedRoomId:latest.room.roomId,expectedRevision:latest.room.revision})});
  const result = await response.json().catch(()=>({}));
  delete $('join-error').dataset.kind;
  $('join-error').textContent=response.ok ? '' : JOIN_ERRORS[result.code] ?? '참가 신청에 실패했습니다.';
  await poll();
});
setInterval(poll, 1000);
poll();
