// Remote host pages. The local lobby is always served from http://127.0.0.1:<port> (the app
// descriptor contract), so any other hostname is the remote host listener: a page there signs in
// with a password and keeps the session token where the local lobby keeps its service token.
export const HOST_TOKEN_KEY = 'holdem-app-token';

export function isRemoteHostPage(loc = globalThis.location) {
  return Boolean(loc) && loc.hostname !== '127.0.0.1';
}

export function loginPath({ expired = false } = {}) {
  return expired ? '/login?expired=1' : '/login';
}

/** Navigate the whole tab (the lobby when called from its table iframe) to the login page. */
export function goToLogin({ expired = false, win = globalThis.window } = {}) {
  let target = win;
  try {
    if (win.top && win.top !== win && win.top.location.origin === win.location.origin) target = win.top;
  } catch {
    /* a cross-origin parent: leave it alone */
  }
  target.location.replace(loginPath({ expired }));
}

/** A page restored from the back/forward cache has closed streams and a possibly ended session. */
export function reloadWhenRestored(win = globalThis.window) {
  win.addEventListener('pageshow', (event) => {
    if (event.persisted) win.location.reload();
  });
}

function waitText(sec) {
  const seconds = Number.isFinite(sec) && sec > 0 ? Math.ceil(sec) : 60;
  return seconds >= 60 ? `${Math.ceil(seconds / 60)}분` : `${seconds}초`;
}

export function loginErrorText(code, retryAfterSec) {
  switch (code) {
    case 'LOGIN_FAILED':
      return '비밀번호가 맞지 않습니다.';
    case 'LOGIN_RATE_LIMIT':
      return `로그인 시도가 너무 많습니다. ${waitText(retryAfterSec)} 뒤에 다시 시도하세요.`;
    case 'LOGIN_BUSY':
      return '다른 로그인을 확인하는 중입니다. 잠시 뒤 다시 시도하세요.';
    case 'HOST_PASSWORD_NOT_SET':
      return '서버에 원격 호스트 비밀번호가 없습니다. 서버에서 host-password로 먼저 설정하세요.';
    case 'HOST_AUTH_INVALID':
      return '서버의 원격 호스트 자격 파일을 읽지 못했습니다. 서버에서 host-password로 다시 설정하세요.';
    case 'NOT_FOUND':
      return '이 주소에서는 호스트 로그인을 할 수 없습니다. 원격 호스트 주소로 접속하세요.';
    case 'BAD_ORIGIN':
      return '등록되지 않은 주소로 접속했습니다. 서버에 등록한 이름으로 접속하세요.';
    default:
      return '로그인하지 못했습니다. 연결을 확인하고 다시 시도하세요.';
  }
}
