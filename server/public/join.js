const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.get('code')) $('join-code').value = params.get('code');
if (location.hash.startsWith('#rejoin=')) {
  sessionStorage.setItem('holdem-participant-token', location.hash.slice(8));
  history.replaceState(null, '', location.pathname);
}
let fails = 0;
const JOIN_ERRORS = {
  BAD_CODE: '참가 코드가 올바르지 않습니다.',
  ROOM_FULL: '참가 인원이 가득 찼습니다.',
  ROOM_LOCKED: '게임이 진행 중이라 지금 참가할 수 없습니다.',
  NAME_TAKEN: '이미 쓰인 이름입니다. 다른 이름을 선택하세요.',
  JOIN_LOCKED: '이 주소는 잠시 참가가 잠겼습니다.',
  ROOM_NOT_FOUND: '세션을 찾을 수 없습니다.',
  RATE_LIMIT: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
};
function paintFinal(final) {
  const table = $('final-stacks');
  if (!table || !final?.stacks) return;
  table.replaceChildren();
  for (const row of final.stacks) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = row.name ?? row.playerId;
    const stack = document.createElement('td');
    stack.textContent = String(row.stack ?? '');
    tr.append(name, stack);
    table.append(tr);
  }
}
async function poll() {
  const token = sessionStorage.getItem('holdem-participant-token');
  if (!token) return;
  try {
    const res = await fetch('/api/p/state', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('offline');
    fails = 0;
    const state = await res.json();
    $('join-form').hidden = true;
    $('waiting').hidden = state.game?.state === 'playing' || state.game?.state === 'paused' || Boolean(state.game?.final);
    $('playing').hidden = !['playing', 'paused'].includes(state.game?.state);
    $('pause-banner').hidden = state.game?.state !== 'paused';
    $('final').hidden = !state.game?.final;
    if (state.game?.final) paintFinal(state.game.final);
    $('waiting-status').textContent = state.game?.state === 'starting'
      ? '게임 준비 중'
      : '호스트가 시작하기를 기다리는 중';
    if (state.game?.gameId && $('table').src === '') {
      $('table').src = `/table?participant=1&appGame=${state.game.gameId}&epoch=${state.game.gameEpoch ?? ''}`;
    }
  } catch {
    fails += 1;
    if (fails >= 5) $('join-error').textContent = '세션이 닫혔거나 호스트가 오프라인입니다';
  }
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
    $('join-error').textContent = JOIN_ERRORS[body.code] ?? body.code ?? '참가에 실패했습니다';
    return;
  }
  sessionStorage.setItem('holdem-participant-token', body.participantToken);
  history.replaceState(null, '', location.pathname);
  await poll();
};
$('leave')?.addEventListener('click', async () => {
  const token = sessionStorage.getItem('holdem-participant-token');
  await fetch('/api/p/leave', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  sessionStorage.removeItem('holdem-participant-token');
  location.reload();
});
setInterval(poll, 1000);
poll();
