// A failed module dependency must not leave an apparently usable, inert lobby.
try {
  await import('./lobby.js');
} catch (error) {
  document.getElementById('start').disabled = true;
  document.getElementById('status').textContent = '로비를 불러오지 못했습니다';
  document.getElementById('error').textContent =
    '화면을 불러오지 못했습니다. 새로고침해 주세요. 업데이트 이후에도 계속되면 진행 중인 게임을 확인한 뒤 로비 서버를 다시 실행해 주세요.';
  console.error('Lobby initialization failed', error);
}
