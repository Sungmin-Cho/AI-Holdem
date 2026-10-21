// CLI 자식 한 번의 구간 시각(#312). 어댑터 `runOnce`가 `spawnCli`의 observe로 받는다.
//
// stdout을 줄 단위로 보고 JSONL 이벤트의 **이름**(`type`)만 읽는다 — 원문·메시지·세션 id는 남기지 않는다.
// 시각은 모두 spawn 기준 ms(단조 시계)이고, 관측하지 못한 값은 0이 아니라 null이다. 기준 시각의 규칙은
// 비교 도구(/4) 타임라인과 같다: 첫 `thread.started`, 첫 `turn.started`, 첫 `turn.completed`/`turn.failed`.
// codex만 이 이벤트를 낸다. claude·grok은 exit·close만 채워진다.
// 한 줄(개행 없이 이어지는 버퍼 포함)이 64KiB를 넘으면 그 줄은 이름을 뽑지 않는다.
const LINE_LIMIT = 64 * 1024;
const MILESTONE_HINT = /"(?:thread\.started|turn\.(?:started|completed|failed))"/;

const since = (later, earlier) => (later === null || earlier === null ? null : later - earlier);

export function createPhaseTiming(now = () => performance.now()) {
  const startedAt = now();
  const marks = { bootMs: null, turnStartMs: null, turnEndMs: null, signalMs: null, exitMs: null, closeMs: null };
  let pending = '';
  let skipping = false;
  const at = () => Math.max(0, Math.round(now() - startedAt));
  const tooLong = (text) => text.length > LINE_LIMIT || Buffer.byteLength(text) > LINE_LIMIT;
  const readLine = (line, ms) => {
    if (!MILESTONE_HINT.test(line)) return;
    let type;
    try { type = JSON.parse(line)?.type; } catch { return; }
    if (type === 'thread.started' && marks.bootMs === null) marks.bootMs = ms;
    else if (type === 'turn.started' && marks.turnStartMs === null) marks.turnStartMs = ms;
    else if ((type === 'turn.completed' || type === 'turn.failed') && marks.turnEndMs === null) marks.turnEndMs = ms;
  };
  const observe = (event) => {
    if (event?.type === 'stdout') {
      const ms = at();
      const lines = (pending + String(event.chunk)).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        // 상한을 넘겨 버린 줄의 나머지는 이름을 뽑지 않는다.
        if (skipping) { skipping = false; continue; }
        if (!tooLong(line)) readLine(line, ms);
      }
      if (tooLong(pending)) {
        skipping = true;
        pending = '';
      }
    } else if (event?.type === 'exit') {
      if (marks.exitMs === null) marks.exitMs = at();
    } else if (event?.type === 'close') {
      if (pending && !skipping && !tooLong(pending)) readLine(pending, at());
      pending = '';
      skipping = false;
      if (marks.closeMs === null) marks.closeMs = at();
    }
  };
  // 첫 종료 신호를 요청한 시각. 같은 자식에 두 번째 신호가 가도 첫 시각을 유지한다.
  const markSignal = () => {
    if (marks.signalMs === null) marks.signalMs = at();
  };
  const view = () => ({
    ...marks,
    turnMs: since(marks.turnEndMs, marks.turnStartMs),
    // turn이 시작됐지만 끝이 관측되지 않았다(신호·exit로 잘림).
    censored: marks.turnStartMs !== null && marks.turnEndMs === null,
    exitToCloseMs: since(marks.closeMs, marks.exitMs),
  });
  return { observe, markSignal, view };
}

/** 오류에 그 호출의 구간 시각을 붙인다. 이미 붙어 있으면 덮지 않는다. */
export function withTiming(error, timing) {
  if (error && typeof error === 'object' && error.timing === undefined && Object.isExtensible(error)) {
    try { error.timing = timing; } catch { /* 계측은 오류 전달에 관여하지 않는다 */ }
  }
  return error;
}
