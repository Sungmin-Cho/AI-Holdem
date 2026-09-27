/**
 * Host lobby notice projection. loop-state `notices` are operator-facing strings
 * that can carry PIDs, CLI flags, recovery commands and internal codes; the app
 * snapshot never forwards them. Known patterns map to fixed Korean copy whose
 * only substitutions are an allowlisted runtime name or an integer count.
 * Anything else is counted, never echoed.
 */
// Mirrors game-loop.js JEV_ROLL_FORWARD_NOTICE (a test pins the two together);
// importing the loop here would drag its whole module graph into a pure helper.
const JEV_ROLL_FORWARD_NOTICE = 'JEV 결정 규칙을 v2로 roll-forward했습니다. 기존 기록은 보존됩니다.';

export const MAX_PROJECTED_NOTICES = 10;
const RUNTIME_NAMES = new Set(['claude', 'codex', 'grok']);
const runtimeName = (value) => (RUNTIME_NAMES.has(value) ? value : '일부 런타임');
const count = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

// Order matters: the first matching rule wins. Repeats of the same code and
// copy collapse into one item with a count; `key` overrides the grouping (per
// runtime for the ladder notices).
const RULES = [
  {
    code: 'RUNTIME_CONTAINMENT_FAILED', level: 'warn',
    re: /^(?:컨테인먼트 실패|상위 컨테인먼트 probe 실패|grok 격리 검증 실패)\(([a-z]+)\//,
    render: (m) => ({ key: runtimeName(m[1]), text: `AI 연결 확인에서 ${runtimeName(m[1])}을(를) 안전하게 쓸 수 없어 제외했어요.` }),
  },
  {
    code: 'RUNTIME_PROBE_FAILED', level: 'warn',
    re: /^(?:(?:상위 모델|플레이어) probe 실패\(([a-z]+)\/|(?:상위 모델|플레이어) 런타임 ([a-z]+) (?:probe 오류|부적격))/,
    render: (m) => {
      const name = runtimeName(m[1] ?? m[2]);
      return { key: name, text: `AI 연결 확인에서 ${name} 응답을 받지 못해 다른 런타임을 찾았어요.` };
    },
  },
  {
    code: 'PLAYER_UNAVAILABLE', level: 'error', re: /^적격 플레이어 런타임이 없습니다/,
    render: () => ({ text: 'AI 플레이어로 쓸 수 있는 런타임이 없어 게임을 시작하지 못했어요.' }),
  },
  {
    code: 'UPPER_UNAVAILABLE', level: 'warn', re: /^상위 모델 런타임이 없습니다/,
    render: () => ({ text: 'AI 코치·리뷰에 쓸 모델을 찾지 못해 기록 기반 피드백으로 대신합니다.' }),
  },
  {
    code: 'UPPER_SPLIT', level: 'info', re: /^코치·리뷰 상위 모델은 ([a-z]+)로 갈라 씁니다/,
    render: (m) => ({ text: `AI 코치·리뷰는 ${runtimeName(m[1])}이(가) 맡습니다.` }),
  },
  {
    code: 'PLAYER_FALLBACK', level: 'info',
    re: /^(?:플레이어 런타임 폴백: [a-z]+ → ([a-z]+)|플레이어 런타임 미지정 — 폴백 사다리에서 ([a-z]+)를)/,
    render: (m) => ({ text: `AI 플레이어는 ${runtimeName(m[1] ?? m[2])}(으)로 진행합니다.` }),
  },
  {
    code: 'PLAYER_RUNTIME_IGNORED', level: 'info', re: /^알 수 없는 --player-runtime 값/,
    render: () => ({ text: '지정한 플레이어 런타임을 알 수 없어 기본 순서로 골랐어요.' }),
  },
  {
    code: 'COACH_FALLBACK', level: 'info',
    re: /^(?:상위 모델 런타임이 없어 핸드 \d+은 고정 코치 문구|핸드 \d+ 코치 .*고정 문구로 대체|핸드 \d+ 코치 파이프라인 오류)/,
    render: () => ({ text: '일부 핸드의 코치 노트를 기본 문구로 대신했어요.' }),
  },
  {
    code: 'COACH_RECOVERY_REQUIRED', level: 'error',
    re: /^(?:코치 프로세스가 아직 종료되지 않아|persisted (?:coach|코치))/,
    render: () => ({ text: '이전 코치 작업을 정리하지 못해 진행을 멈췄어요. 잠시 뒤 다시 이어 하기를 눌러 주세요.' }),
  },
  {
    code: 'REVIEW_MACHINE', level: 'info', re: /^LLM 종합 리뷰를 제공할 수 없어/,
    render: () => ({ text: 'AI 종합 리뷰 대신 이번 게임 기록으로 요약 리뷰를 작성했어요.' }),
  },
  {
    code: 'REVIEW_FAILED', level: 'error', re: /^(?:종합 리뷰|review_generated|스냅샷 view\.gameOver)/,
    render: () => ({ text: '종합 리뷰를 끝내지 못했어요. 게임 기록과 코치 노트는 그대로 남아 있어요.' }),
  },
  {
    code: 'FINALIZATION_HALTED', level: 'error',
    re: /^(?:finalization|코치 finalization|코치 봉인|Task 7B|training cutoff marker)/,
    render: () => ({ text: '게임 마무리 단계를 끝내지 못했어요. 게임 기록은 그대로 남아 있어요.' }),
  },
  {
    code: 'EXPLOIT_EVAL_PARTIAL', level: 'info', re: /^exploit 평가/,
    render: () => ({ text: '일부 결정은 상대 공략 평가를 남기지 못했어요.' }),
  },
  {
    code: 'JEV_ROLLED_FORWARD', level: 'info', exact: JEV_ROLL_FORWARD_NOTICE,
    render: () => ({ text: 'JEV 결정 규칙을 새 버전(v2)으로 올렸어요. 이전 기록은 그대로 보존됩니다.' }),
  },
  {
    code: 'POLICY_ROLLED_FORWARD', level: 'info', re: /^(?:policy|self-opponent strategy) roll-forward /,
    render: () => ({ text: 'AI 정책을 새 버전으로 올렸어요. 이전 기록은 그대로 보존됩니다.' }),
  },
  {
    code: 'SELF_MIRROR_SEATED', level: 'info', re: /^자기 복제 좌석 1석을 배정했습니다/,
    render: () => ({ text: '내 플레이를 따라 하는 AI 1명이 앉았어요. 어느 좌석인지는 종합 리뷰에서 공개됩니다.' }),
  },
  {
    code: 'SELF_EXPLOITER_SEATED', level: 'info', re: /^자기 공략 좌석 1석을 배정했습니다/,
    render: () => ({ text: '내 경향을 노리는 AI 1명이 앉았어요. 어느 좌석인지는 종합 리뷰에서 공개됩니다.' }),
  },
  {
    code: 'GTO_BASELINE_LIMITED', level: 'info', re: /^휴리스틱 프리플롭 기준표는 .*(투영 참고이며|지원 범위 밖이므로)/,
    render: (m) => ({
      text: m[1] === '투영 참고이며'
        ? '프리플롭 기준표는 6·8·9인 100BB 게임 기준이라, 이 게임의 비교 결과는 참고용이며 점수에서 빠져요.'
        : '프리플롭 기준표는 6·8·9인 100BB 게임만 지원해 이 게임에는 기준표 비교를 제공하지 않아요.',
    }),
  },
  {
    code: 'TRAINING_OFF', level: 'info', re: /^이 세션은 레거시 --game-dir라 training이 꺼져/,
    render: () => ({ text: '이 게임은 학습 기록이 꺼진 예전 방식으로 실행 중이에요.' }),
  },
  {
    code: 'SWEEP_SKIPPED', level: 'info', re: /^profile sweep 안내: 과거 미완료 세션 (\d+)개/,
    render: (m) => {
      const n = count(m[1]);
      return { text: n === null ? '끝나지 않은 과거 게임은 학습 반영에서 건너뛰었어요.' : `끝나지 않은 과거 게임 ${n}개는 학습 반영에서 건너뛰었어요.` };
    },
  },
  {
    code: 'SWEEP_FAILED', level: 'warn', re: /^(?:profile sweep (?:consumer )?실패|solver pending |evaluate pending hand )/,
    render: () => ({ text: '과거 게임 일부를 학습 기록에 반영하지 못했어요.' }),
  },
  {
    code: 'TRAINING_INCOMPLETE', level: 'warn', re: /^학습 평가 미완 (\d+)건/,
    render: (m) => {
      const n = count(m[1]);
      return { text: n === null ? '학습 평가 일부를 끝내지 못했어요.' : `학습 평가 ${n}건을 끝내지 못했어요.` };
    },
  },
  {
    code: 'TRAINING_PUBLISH_HALTED', level: 'warn', re: /^training (?:machine|annotation|retry) publish halt/,
    render: () => ({ text: '학습 결과 게시를 멈췄어요. 게임 진행에는 영향이 없어요.' }),
  },
  {
    code: 'TRAINING_MIGRATION_HALTED', level: 'warn', re: /^training migration halt/,
    render: () => ({ text: '이전 학습 기록을 새 형식으로 옮기지 못해 학습 기록을 멈췄어요.' }),
  },
  {
    code: 'PRACTICE_FOCUS_SKIPPED', level: 'info', re: /^practice-focus 자동 선택을 건너뜁니다/,
    render: () => ({ text: '이번 게임은 연습 초점 자동 선택 없이 진행해요.' }),
  },
];

function classify(raw) {
  if (typeof raw !== 'string') return null;
  for (const rule of RULES) {
    if (rule.exact !== undefined) {
      if (raw === rule.exact) return { rule, ...rule.render() };
      continue;
    }
    const match = rule.re.exec(raw);
    if (match) return { rule, ...rule.render(match) };
  }
  return null;
}

/** `omitted` counts classified items beyond the display cap; `unclassified`
 * counts raw notices no rule recognised.
 * @returns {{items: {code: string, level: string, text: string, count: number}[], unclassified: number, omitted: number}} */
export function projectNotices(rawNotices) {
  const items = [];
  const byKey = new Map();
  let unclassified = 0;
  for (const raw of Array.isArray(rawNotices) ? rawNotices : []) {
    const hit = classify(raw);
    if (!hit) { unclassified += 1; continue; }
    const key = `${hit.rule.code}|${hit.key ?? hit.text}`;
    const existing = byKey.get(key);
    if (existing) { existing.count += 1; continue; }
    const item = { code: hit.rule.code, level: hit.rule.level, text: hit.text, count: 1 };
    byKey.set(key, item);
    items.push(item);
  }
  const rank = { error: 0, warn: 1, info: 2 };
  // Stable: severity first, then first-seen order.
  const ordered = items.map((item, index) => ({ item, index }))
    .sort((a, b) => (rank[a.item.level] - rank[b.item.level]) || (a.index - b.index))
    .map(({ item }) => item);
  return {
    items: ordered.slice(0, MAX_PROJECTED_NOTICES),
    unclassified,
    omitted: Math.max(0, ordered.length - MAX_PROJECTED_NOTICES),
  };
}
