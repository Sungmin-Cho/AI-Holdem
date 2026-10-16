// Hand-coach input that exists at decision time. The coach evaluates ONE user decision,
// picked by a result-independent committed-cost rule, and sees only that decision's own
// validated snapshot, the engine facts computed from it, and the result-independent practice
// focus. Nothing here reads the completed board, opponent cards, final actions or stacks,
// the hand result, or the user's other decisions (a later snapshot carries later boards).
// The note's `outcome` is a fixed sidecar message, never a model statement.
import { decisionFacts } from './review-facts.js';

export const COACH_FIXED_OUTCOME = '결과는 리플레이에서 별도로 확인하세요.';
export const COACH_HOST_ID = 'user';

const STREET_RANK = { preflop: 0, flop: 1, turn: 2, river: 3 };

const orderOf = (decision) => [STREET_RANK[decision.street] ?? 9, Number(decision.decisionId.split('-').at(-1))];

// Chips this decision committed (call, bet, raise) or, for a fold, the price it declined.
// A check costs nothing. Only the decision's own snapshot is read, never what followed.
export function committedCost(decision) {
  const { action, amount } = decision.chosenAction;
  if (action === 'call' || action === 'fold') return decision.toCall;
  if (action === 'raise' || action === 'bet') return Math.max(0, amount - decision.actorBet);
  return 0;
}

// processInput: buildProcessInput([capturedHandRecord]). Only validated, available decisions
// with computable facts compete. A timeout auto-action (forced) is judged only when the user
// made no deliberate decision. Cost descending, then the earlier decision. Null = no target.
export function selectCoachTarget(processInput, handNo, { factsOf = decisionFacts } = {}) {
  const hand = (processInput?.hands ?? []).find((row) => row.handNo === handNo);
  const candidates = [];
  for (const decision of hand?.decisions ?? []) {
    if (decision.processStatus !== 'available' || decision.handNo !== handNo
      || decision.actorId !== COACH_HOST_ID) continue;
    let facts = null;
    try {
      facts = factsOf(decision);
    } catch {
      facts = null;
    }
    if (!facts || typeof facts.line !== 'string' || facts.line === '') continue;
    candidates.push({ decision, factsLine: `${decision.decisionId}: ${facts.line}`, cost: committedCost(decision) });
  }
  candidates.sort((a, b) => (
    Number(a.decision.forced) - Number(b.decision.forced)
    || b.cost - a.cost
    || orderOf(a.decision)[0] - orderOf(b.decision)[0]
    || orderOf(a.decision)[1] - orderOf(b.decision)[1]
  ));
  const [first] = candidates;
  return first ? { decision: first.decision, factsLine: first.factsLine, cost: first.cost } : null;
}

// What the model reads of the target: its own validated fields, prior actions without the
// per-action stack maps. Everything else in the snapshot is dropped by the validated projection.
export function targetView(decision) {
  const { priorActions, processStatus, ...rest } = decision;
  return {
    ...rest,
    priorActions: priorActions.map((action) => ({
      decisionId: action.decisionId, playerId: action.playerId, action: action.action,
      amount: action.amount, street: action.street, potTotal: action.potTotal,
    })),
  };
}

export function buildProspectiveCoachPrompt({ handNo, selection, practiceFocus, overfoldReserved, retry = false }) {
  const target = selection.decision;
  const prompt = [
    '너는 공정한 홀덤 코치다. 아래에 인라인된 입력만 사용한다. 다른 파일·도구·네트워크를 조회하지 마라.',
    '입력은 사용자가 이 결정을 내리던 시점까지의 공개 정보와 사용자 자신의 카드뿐이다. 이후 보드·상대 홀카드·이후 액션·최종 스택·승패는 주어지지 않았고 너도 모른다.',
    '상대 홀카드·덱·아키타입·스타일·이후 전개를 추측하거나 언급하지 마라. 결과(이겼다·졌다·어떤 카드가 나왔다 등)를 아는 것처럼 쓰지 마라.',
    '',
    `hand ${handNo} (redacted):`,
    `결정 시점 스냅샷(${target.decisionId}, 이 결정 이전 정보만):`,
    JSON.stringify(targetView(target)),
    '',
    '결정 사실 카드(엔진 계산 — 수치는 이 값만 인용):',
    selection.factsLine,
    '',
    '읽는 법:',
    '- 필요 승률·팟 오즈·SPR은 가격 산술이다. 에퀴티는 별도의 휴리스틱 시뮬레이션(무작위 상대 또는 추정 레인지)이며 검증된 값이 아니다. 둘을 같은 근거로 합치거나 콜의 EV로 환산하지 마라.',
    '- 메이드 핸드 강도·드로는 사실이다. 그것이 곧 이 액션의 EV는 아니다. 강한 핸드라서 콜·레이즈가 이득이라고 단정하지 마라.',
    '- 에퀴티는 이후 베팅이 남은 상황의 콜 EV를 확정하지 못한다. 추정 레인지 에퀴티는 "추정"이라고 밝힌다.',
    '',
    'practiceFocus:',
    practiceFocus,
    '',
    `과폴드 코멘트: ${overfoldReserved ? '허용' : '금지'}`,
    '',
    `할 일: 엔진이 결과와 무관하게 고른 가장 비싼(결정적인) 결정 1개(${target.decisionId})만 한국어 1~2줄로 평가한다. 다른 결정은 평가하지 마라.`,
    '(a) 결정 시점 판단: 사실 카드의 수치 1개 이상(필요 승률·SPR·에퀴티·선택 크기 등)을 근거로 든다.',
    '(b) 대안 라인 한 줄과 근거. 결과로 결정의 옳고 그름을 판정하지 않는다.',
    '폴드가 타당했다면 그 이유를 한 문장으로 구체적으로 쓴다. 판에 박힌 칭찬 문구는 쓰지 않는다.',
    '수치는 사실 카드에 있는 값만 인용하고 새 숫자를 만들지 마라.',
    '기대값(EV)은 숫자 없이 개념으로만 쓴다. 검증된 최적·GTO 정답·확정 누수를 주장하지 마라.',
    overfoldReserved
      ? '이 핸드는 과폴드 누수 코멘트를 한 번 사용할 수 있고, 사용하면 "overfold":true를 추가한다.'
      : '이 핸드에서는 과폴드 누수 코멘트를 사용하지 마라.',
    '',
    `출력은 JSON 한 줄만: {"handNo":${handNo},"text":"...","decisions":[{"decisionId":"${target.decisionId}","why":"...","alternative":"..."}]}`,
    'outcome 필드는 쓰지 마라. 결과 문구는 시스템이 고정 문장으로 채운다.',
    'decisions는 선택이며 위 decisionId 한 개만 허용된다. 각 필드는 비어 있지 않은 문자열이다.',
    'text.trim()은 비어 있으면 안 되고, 설명·마크다운·코드펜스·추가 필드는 금지한다.',
  ].join('\n');
  return retry
    ? `${prompt}\n재시도 사유: 직전 출력이 기계적 JSON 계약을 만족하지 못했다. 부분 출력은 무시하고 동일 입력으로 새로 작성하라.`
    : prompt;
}

// Applied to the parsed, already-sanitized model note before it is validated, sealed and
// proved. It changes one thing: every decision row's `outcome` becomes the fixed sidecar
// message, so the published outcome is never a model statement. It does not read or rewrite
// `text`, `why` or `alternative`; what the model wrote there is judged only by the existing
// contract and private-card validators, and this module makes no claim about it.
// `keepModelOutcome` is for the containment pass only: an `outcome` the model wrote anyway
// stays in the note so those validators see every word it produced (a row without one gets
// the fixed message so the shape validates). That version is never sealed or published.
export function applyProspectiveNoteContract(note, { keepModelOutcome = false } = {}) {
  if (!note || typeof note !== 'object' || Array.isArray(note) || !Array.isArray(note.decisions)) return note;
  return {
    ...note,
    decisions: note.decisions.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      return keepModelOutcome && Object.hasOwn(row, 'outcome') ? row : { ...row, outcome: COACH_FIXED_OUTCOME };
    }),
  };
}
