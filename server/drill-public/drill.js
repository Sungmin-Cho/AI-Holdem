const token = new URLSearchParams(location.search).get('token');
const idempotencyKey = crypto.randomUUID();
let sessionId = null;

async function api(pathname, { method = 'GET', body } = {}) {
  const url = `${pathname}?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { httpStatus: res.status, ...json };
}

async function show() {
  const nxt = await api('/api/next');
  const prompt = document.getElementById('prompt');
  const actions = document.getElementById('actions');
  const feedback = document.getElementById('feedback');
  if (nxt.sessionId) sessionId = nxt.sessionId;
  if (nxt.httpStatus === 409 || (!nxt.ok && nxt.code)) {
    feedback.textContent = nxt.code ?? 'error';
    return;
  }
  if (nxt.done || !nxt.question) {
    prompt.textContent = '세션이 끝났습니다.';
    actions.replaceChildren();
    return;
  }
  const q = nxt.question.prompt;
  prompt.textContent = `${q.position} / ${q.stackBb}BB / ${q.handClass}`;
  actions.replaceChildren();
  for (const legal of q.legalActions) {
    const [action, size] = legal.split(':');
    const btn = document.createElement('button');
    btn.textContent = legal;
    btn.addEventListener('click', async () => {
      const out = await api('/api/answer', {
        method: 'POST',
        body: {
          action,
          sizeBb: size ? Number(size) : undefined,
          sessionId,
          questionId: nxt.question.questionId,
          attemptNo: nxt.attemptNo,
        },
      });
      if (!out.ok) {
        feedback.textContent = out.code ?? 'error';
        if (out.httpStatus === 409) await show();
        return;
      }
      feedback.textContent = JSON.stringify(out.result, null, 2);
      await show();
    });
    actions.append(btn);
  }
}

const started = await api('/api/start', {
  method: 'POST',
  body: { mode: 'free', seed: '1', idempotencyKey },
});
if (!started.ok) {
  document.getElementById('prompt').textContent = started.code ?? 'start failed';
} else {
  sessionId = started.sessionId;
  await show();
}
