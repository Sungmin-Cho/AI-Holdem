const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.get('code')) $('join-code').value = params.get('code');
if (location.hash.startsWith('#rejoin=')) {
  sessionStorage.setItem('holdem-participant-token', location.hash.slice(8));
  history.replaceState(null, '', location.pathname);
}
let fails = 0;
async function poll() {
  const token = sessionStorage.getItem('holdem-participant-token');
  if (!token) return;
  try {
    const res = await fetch('/api/p/state', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('offline');
    fails = 0;
    const state = await res.json();
    $('join-form').hidden = true;
    $('waiting').hidden = state.game?.state === 'playing' || state.game?.state === 'paused';
    $('playing').hidden = !['playing', 'paused'].includes(state.game?.state);
    $('pause-banner').hidden = state.game?.state !== 'paused';
    $('final').hidden = !state.game?.final;
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
    $('join-error').textContent = body.code ?? '참가에 실패했습니다';
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
