// CLI 자식 한 번의 구간 시각(#312). 어댑터 `runOnce`가 `spawnCli`의 observe로 받는다.
//
// stdout을 줄 단위로 보고 JSONL 이벤트의 **이름**(`type`)만 읽는다 — 원문·메시지·세션 id는 남기지 않는다.
// 시각은 모두 spawn 기준 ms(단조 시계)이고, 관측하지 못한 값은 0이 아니라 null이다. 기준 시각의 규칙은
// 비교 도구(/4) 타임라인과 같다: 첫 `thread.started`, 첫 `turn.started`, 첫 `turn.completed`/`turn.failed`.
// codex만 이 이벤트를 낸다. claude·grok은 exit·close만 채워진다.
// 한 줄(개행 없이 이어지는 버퍼 포함)이 64KiB를 넘으면 그 줄은 이름을 뽑지 않는다.
//
// 실패 위치(#312 진단): turn을 끝낸 이벤트의 종류(`turnEnd`), `turn.failed` 메시지의 닫힌 분류(`turnError`),
// `error` 이벤트·완료된 error 항목의 분류별 수(`errorEvents`), 자식의 exit 코드·신호를 함께 싣는다. 메시지는
// 아래 닫힌 분류의 이름으로만 남고, 목록 밖은 `other`다. codex 0.163.0은 실패 turn을 `error`와
// `turn.failed`(`error.message`만, 구조화된 코드 없음) 뒤 exit 1로 낸다.
const LINE_LIMIT = 64 * 1024;
const MILESTONE_HINT = /"(?:thread\.started|turn\.(?:started|completed|failed)|error)"/;

// error 계열 메시지의 닫힌 분류. 첫 일치가 이긴다. 비교 도구(/4)의 타임라인 이름과 같은 목록이다.
// capacity(#312 L5: "Selected model is at capacity")는 기존 분류를 바꾸지 않도록 끝에 둔다.
export const ERROR_CLASSES = Object.freeze([
  ['reconnect', /reconnect|retrying|stream disconnected/i],
  ['rate_limit', /rate.?limit|429|too many requests|usage limit/i],
  ['code_mode_unavailable', /code mode/i],
  ['timeout', /timed? ?out|timeout/i],
  ['capacity', /at capacity|overloaded/i],
]);
export const ERROR_CLASS_NAMES = Object.freeze([...ERROR_CLASSES.map(([name]) => name), 'other']);

/** error 계열 JSONL 이벤트 하나의 분류 이름. 메시지 원문은 돌려주지 않는다. */
export function errorClassOf(event) {
  const message = [event?.message, event?.item?.message, event?.error?.message, event?.item?.text]
    .find((value) => typeof value === 'string') ?? '';
  return ERROR_CLASSES.find(([, pattern]) => pattern.test(message))?.[0] ?? 'other';
}

// 신호 이름의 닫힌 목록(darwin·linux·win32의 `os.constants.signals` 합집합). 기록은 다른 플랫폼에서도 읽히므로
// 실행 플랫폼의 목록이 아니라 이 고정 목록과 정확히 비교한다. 목록 밖 값은 `other`다.
export const SIGNAL_NAMES = Object.freeze([
  'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGIOT', 'SIGBUS', 'SIGEMT', 'SIGFPE', 'SIGKILL',
  'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGSTKFLT', 'SIGCHLD', 'SIGCONT', 'SIGSTOP',
  'SIGTSTP', 'SIGBREAK', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH',
  'SIGIO', 'SIGPOLL', 'SIGLOST', 'SIGPWR', 'SIGINFO', 'SIGSYS', 'SIGUNUSED',
]);
const exitCodeOf = (code) => (Number.isSafeInteger(code) ? code : null);
const exitSignalOf = (signal) => (signal == null ? null : SIGNAL_NAMES.includes(signal) ? signal : 'other');

const since = (later, earlier) => (later === null || earlier === null ? null : later - earlier);

export function createPhaseTiming(now = () => performance.now()) {
  const startedAt = now();
  const marks = { bootMs: null, turnStartMs: null, turnEndMs: null, signalMs: null, exitMs: null, closeMs: null };
  let turnEnd = null;
  let turnError = null;
  const errorEvents = {};
  let exit = null;
  let pending = '';
  let skipping = false;
  const at = () => Math.max(0, Math.round(now() - startedAt));
  const tooLong = (text) => text.length > LINE_LIMIT || Buffer.byteLength(text) > LINE_LIMIT;
  const readLine = (line, ms) => {
    if (!MILESTONE_HINT.test(line)) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const type = event?.type;
    if (type === 'thread.started' && marks.bootMs === null) marks.bootMs = ms;
    else if (type === 'turn.started' && marks.turnStartMs === null) marks.turnStartMs = ms;
    else if ((type === 'turn.completed' || type === 'turn.failed') && marks.turnEndMs === null) {
      marks.turnEndMs = ms;
      turnEnd = type === 'turn.completed' ? 'completed' : 'failed';
      if (type === 'turn.failed') turnError = errorClassOf(event);
    } else if (type === 'error' || (type === 'item.completed' && event?.item?.type === 'error')) {
      const name = errorClassOf(event);
      errorEvents[name] = (errorEvents[name] ?? 0) + 1;
    }
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
      if (marks.exitMs === null) {
        marks.exitMs = at();
        exit = { code: exitCodeOf(event.code), signal: exitSignalOf(event.signal) };
      }
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
    turnEnd,
    turnError,
    errorEvents: { ...errorEvents },
    // exit을 관측하지 못했으면 둘 다 null이다(close만 본 경우 포함).
    exitCode: exit?.code ?? null,
    exitSignal: exit?.signal ?? null,
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
