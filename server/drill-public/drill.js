const token = new URLSearchParams(location.search).get('token');

async function api(pathname, { method = 'GET', body } = {}) {
  const url = `${pathname}?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function show() {
  const nxt = await api('/api/next');
  const prompt = document.getElementById('prompt');
  const actions = document.getElementById('actions');
  const feedback = document.getElementById('feedback');
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
        body: { action, sizeBb: size ? Number(size) : undefined },
      });
      feedback.textContent = JSON.stringify(out.result, null, 2);
      await show();
    });
    actions.append(btn);
  }
}

await api('/api/start', { method: 'POST', body: { mode: 'free', seed: '1' } });
await show();
