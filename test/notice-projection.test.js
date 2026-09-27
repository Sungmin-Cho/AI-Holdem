import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectNotices, MAX_PROJECTED_NOTICES } from '../tools/notice-projection.js';
import { JEV_ROLL_FORWARD_NOTICE, gtoEvalNotice, unresolvedEvidenceGuidance } from '../tools/game-loop.js';
import { selfOpponentNotices } from '../tools/self-opponents.js';

// Operator notices as the loop actually writes them (game-loop.js coach
// recovery halts, player-runtime probe ladder, profile sweep).
const liveGuidance = unresolvedEvidenceGuidance([{
  handNo: 3, generation: 1, reason: 'STILL_ALIVE',
  evidence: { identity: { pid: 48213 }, legacyScanPids: [48214], hasHandle: true, spawnEvidence: true, sidecar: 'spawned', attributable: true },
}]);
const RECOVERY = [
  ['코치 프로세스가 아직 종료되지 않아 finalize를 중단합니다.', liveGuidance,
    'halt.recovery.commands를 검토하고, 이 게임의 coach CLI 자식이 남아있지 않은지 직접 확인한 뒤 --operator-confirmed 1을 붙여 실행한 뒤 resume하세요.',
    'reasons: STILL_ALIVE'].filter(Boolean).join(' '),
  'persisted 코치 handle identity를 확인할 수 없어 playing owner 교대를 중단합니다. spawn이 실제로 시작됐을 수 있습니다. 이 게임의 coach CLI 자식이 남아있지 않은지 직접 확인한 뒤 halt.recovery.commands를 검토하고 --operator-confirmed 1을 붙여 실행하세요. reasons: IDENTITY_UNAVAILABLE',
  'persisted coach 회수 deadline이 초과돼 finalize를 중단합니다. 다시 resume하세요. reasons: RESUME_RECLAIM_DEADLINE_EXCEEDED',
];
const FORBIDDEN = [/\bpid\b/i, /4821[34]/, /--[a-z]/, /halt\.recovery/, /operator/, /\/Users\//, /\/tmp\//, /reasons:/, /resume하세요/];

test('real coach recovery halts project to fixed copy without PIDs, flags or commands', () => {
  assert.match(RECOVERY[0], /48213/, 'fixture must carry a pid to prove it is stripped');
  const out = projectNotices(RECOVERY);
  assert.deepEqual(out.items.map((item) => item.code), ['COACH_RECOVERY_REQUIRED']);
  assert.equal(out.items[0].count, 3);
  assert.equal(out.unclassified, 0);
  const text = JSON.stringify(out);
  for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, String(pattern));
});

test('unknown notices are counted, never echoed', () => {
  const secret = 'decision-meta dropped: /Users/someone/game/.secret --row-owner abc pid 991';
  const out = projectNotices([secret, 'handReplay conflict hand 4', 42, null]);
  assert.deepEqual(out.items, []);
  assert.equal(out.unclassified, 4);
  assert.doesNotMatch(JSON.stringify(out), /secret|row-owner|991|handReplay/);
});

test('runtime ladder notices map per runtime and only name allowlisted runtimes', () => {
  const out = projectNotices([
    '컨테인먼트 실패(claude/claude-sonnet-5): 도구·MCP 표면이 비어 있지 않습니다.',
    '상위 컨테인먼트 probe 실패(claude/claude-fable-5-1): SPAWN_FAILED',
    'grok 격리 검증 실패(grok/grok-4): GROK_HOME_ESCAPE',
    '상위 모델 probe 실패(codex/gpt-6-astra): 정상 응답 없음',
    '컨테인먼트 실패(evilrt/x): hi',
    '코치·리뷰 상위 모델은 codex로 갈라 씁니다 (플레이어: claude).',
    '상위 모델 런타임이 없습니다 — LLM 코치·리뷰 피드백을 제공할 수 없습니다.',
  ]);
  const byCode = out.items.map((item) => `${item.code}:${item.count}`);
  assert.deepEqual(byCode, [
    'RUNTIME_CONTAINMENT_FAILED:2', 'RUNTIME_CONTAINMENT_FAILED:1', 'RUNTIME_PROBE_FAILED:1',
    'RUNTIME_CONTAINMENT_FAILED:1', 'UPPER_UNAVAILABLE:1', 'UPPER_SPLIT:1',
  ]);
  const text = out.items.map((item) => item.text).join('\n');
  assert.match(text, /claude/);
  assert.match(text, /grok/);
  assert.match(text, /codex/);
  assert.match(text, /일부 런타임/);
  assert.doesNotMatch(text, /evilrt|sonnet|fable|astra|grok-4|SPAWN_FAILED|MCP/);
});

test('severity orders items (error, warn, info) and repeated coach fallbacks collapse', () => {
  const out = projectNotices([
    '상위 모델 런타임이 없어 핸드 1은 고정 코치 문구로 대체합니다.',
    '핸드 2 코치 교체 예산(5초)이 남지 않아 고정 문구로 대체합니다.',
    '핸드 3 코치 파이프라인 오류: COACH_TIMEOUT',
    '학습 평가 미완 2건',
    '종합 리뷰 생성을 완료하지 못했습니다(REVIEW_TIMEOUT). 게임 상태와 코치 노트는 그대로 남습니다.',
  ]);
  assert.deepEqual(out.items.map((item) => [item.code, item.level, item.count]), [
    ['REVIEW_FAILED', 'error', 1], ['TRAINING_INCOMPLETE', 'warn', 1], ['COACH_FALLBACK', 'info', 3],
  ]);
  assert.match(out.items[1].text, /2건/);
  assert.doesNotMatch(JSON.stringify(out), /REVIEW_TIMEOUT|COACH_TIMEOUT/);
});

test('known product notices from their real builders are classified', () => {
  const gto = gtoEvalNotice({ mode: 'cash-training', aiCount: 3, humanCount: 1, startStackBb: 100 });
  const gtoNear = gtoEvalNotice({ mode: 'cash-training', aiCount: 5, humanCount: 1, startStackBb: 90 });
  const self = selfOpponentNotices({ assigned: { mirror: true, exploiter: true }, sources: [{ hands: 40 }], targets: [1, 2] });
  const out = projectNotices([JEV_ROLL_FORWARD_NOTICE, gto, gtoNear, ...self,
    'policy roll-forward 2.0.0→2.1.0: h2,h3',
    'profile sweep 안내: 과거 미완료 세션 3개를 안전하게 건너뛰었습니다 (SESSION_NOT_TERMINAL). 상세는 loop.log를 확인하세요.',
    'exploit 평가를 남기지 못한 결정 2건 (상대 정책 없음 또는 평가 불가).',
    'training machine publish halt: TRAINING_MARK_FAILED',
  ]);
  assert.deepEqual(out.items.map((item) => item.code).sort(), [
    'EXPLOIT_EVAL_PARTIAL', 'GTO_BASELINE_LIMITED', 'GTO_BASELINE_LIMITED', 'JEV_ROLLED_FORWARD',
    'POLICY_ROLLED_FORWARD', 'SELF_EXPLOITER_SEATED', 'SELF_MIRROR_SEATED', 'SWEEP_SKIPPED', 'TRAINING_PUBLISH_HALTED',
  ]);
  assert.equal(out.unclassified, 0);
  const gtoTexts = out.items.filter((item) => item.code === 'GTO_BASELINE_LIMITED').map((item) => item.text);
  assert.equal(new Set(gtoTexts).size, 2, 'unsupported and near-range GTO notices keep distinct copy');
  assert.doesNotMatch(JSON.stringify(out), /loop\.log|SESSION_NOT_TERMINAL|TRAINING_MARK_FAILED|h2,h3/);
});

test('the projection mirrors the loop JEV notice constant exactly', () => {
  const source = fs.readFileSync(new URL('../tools/notice-projection.js', import.meta.url), 'utf8');
  assert.ok(source.includes(`'${JEV_ROLL_FORWARD_NOTICE}'`));
});

test('items are capped; the remainder is reported as omitted', () => {
  const raw = Array.from({ length: 14 }, (_, i) => `컨테인먼트 실패(${['claude', 'codex', 'grok'][i % 3]}/m): x`)
    .concat(['적격 플레이어 런타임이 없습니다 — 게임을 시작하지 않습니다.', '상위 모델 런타임이 없습니다 — x',
      'LLM 종합 리뷰를 제공할 수 없어 이번 세션의 관찰 기록으로 기계 리뷰를 작성했습니다.', '학습 평가 미완 1건',
      'training migration halt: X', 'profile sweep 실패: X', 'exploit 평가 실패: X', 'policy roll-forward a→b: c',
      '이 세션은 레거시 --game-dir라 training이 꺼져 있습니다.', 'practice-focus 자동 선택을 건너뜁니다: UNSAFE_PATH']);
  const out = projectNotices(raw);
  assert.equal(out.items.length, MAX_PROJECTED_NOTICES);
  assert.equal(out.items[0].code, 'PLAYER_UNAVAILABLE');
  assert.equal(out.unclassified, 0);
  assert.equal(out.items.length + out.omitted, 13);
  assert.doesNotMatch(JSON.stringify(out), /--game-dir|UNSAFE_PATH/);
});

test('missing or malformed input projects to an empty result', () => {
  for (const input of [undefined, null, 'x', {}]) {
    assert.deepEqual(projectNotices(input), { items: [], unclassified: 0, omitted: 0 });
  }
});
