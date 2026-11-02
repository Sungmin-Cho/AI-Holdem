import { HOST_TOKEN_KEY, loginErrorText } from './remote-host.js';

// Inert without a DOM: the boundary test imports every server file in Node.
const doc = globalThis.document;
if (doc) {
  const $ = (id) => doc.getElementById(id);
  const form = $('login-form'), input = $('password'), submit = $('login-submit'), error = $('login-error');
  if (new URLSearchParams(location.search).get('expired') === '1')
    $('login-note').textContent = '로그인이 만료됐습니다. 다시 로그인하세요.';
  // The server only serves this page over HTTPS; refuse to take a password anywhere else. The
  // form starts disabled in the markup and is enabled only after its handler is installed.
  if (location.protocol !== 'https:') {
    error.textContent = '암호화되지 않은 주소에서는 로그인할 수 없습니다. 원격 호스트 HTTPS 주소로 접속하세요.';
  } else form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    error.textContent = '';
    try {
      const response = await fetch('/api/host/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: input.value }),
        signal: AbortSignal.timeout(30000),
      });
      let data = {};
      try { data = await response.json(); } catch { /* not JSON */ }
      if (response.ok && /^[0-9a-f]{64}$/.test(data.token ?? '')) {
        sessionStorage.setItem(HOST_TOKEN_KEY, data.token);
        input.value = '';
        location.replace('/');
        return;
      }
      error.textContent = loginErrorText(data.code, data.retryAfterSec);
      input.select();
    } catch {
      error.textContent = loginErrorText(null);
    } finally {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
    }
  });
  if (location.protocol === 'https:') {
    input.disabled = false;
    submit.disabled = false;
    input.focus?.();
  }
}
