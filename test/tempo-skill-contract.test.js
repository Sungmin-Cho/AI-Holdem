// 문면 계약 — 사이드카 구조(스펙 §7·D10)를 딜러가 읽는 문서 쪽에서 고정한다.
// 코드가 옳아도 절차 문서가 옛 딜러 루프를 가리키면 게임이 다시 딜러 세션을 탄다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = '.agents/skills/start-game/SKILL.md';

// 마크다운 강조는 계약이 아니다. 백틱을 걷어낸 문면으로 단언해야 `--talk` 같은 잔재도
// 코드 스팬 안에 숨지 못하고, 산문 계약이 강조 표기 변경으로 깨지지도 않는다.
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replaceAll('`', '');
}

function frontmatter(raw) {
  const matched = raw.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(matched, 'frontmatter가 없다');
  return matched[1];
}

// `## …` 한 절만 잘라 낸다. 절 안에서만 성립하는 계약을 문서 전체 검색으로 흐리지 않기 위해서다.
function section(raw, heading) {
  const start = raw.indexOf(heading);
  assert.ok(start >= 0, `SKILL.md에 ${heading} 절이 없다`);
  const next = raw.indexOf('\n## ', start + heading.length);
  return raw.slice(start, next < 0 ? raw.length : next);
}

test('스킬 frontmatter는 그대로다 — 슬래시 명령 인식의 계약', () => {
  const fm = frontmatter(read(SKILL));
  assert.match(fm, /^name:\s*start-game\s*$/m);
  assert.match(fm, /^description:\s*.*홀덤.*$/m);
  assert.match(fm, /^\s+argument-hint:\s*"\[AI수 1~8\] \| resume/m);
  assert.match(fm, /^\s+user-invocable:\s*true\s*$/m);
});

test('스킬: 사이드카 기동 문면과 폴링 종료 조건 3가지가 있다', () => {
  const skill = read(SKILL);
  assert.match(skill, /node tools\/game-loop\.js --store-dir game --ai/);
  assert.doesNotMatch(skill, /node tools\/game-loop\.js --game-dir game/);
  assert.match(skill, /--player-runtime/);
  // 폴링 종료 조건 셋 — 벽시계가 아니다.
  assert.match(skill, /halt/);
  assert.match(skill, /phase가 bootstrap을 지남|phase가 bootstrap을 벗어/);
  assert.match(skill, /pid 사망|pid가 사망|pid가 죽/);
  assert.ok(!skill.includes('--talk'), 'talk 배선이 남아 있다');
  assert.ok(!skill.includes('SendMessage'), 'SendMessage 회신 경로가 남아 있다');
  assert.ok(!skill.includes('reply-channel'), 'reply-channel이 남아 있다');
  assert.match(skill, /loopPidAlive/); // 사전 점검 동격 + attach 분기
  assert.match(skill, /attach/i);
  assert.match(skill, /repair_failed/); // 정지 안내가 남아 있다 (사이드카 소관 명시)
  // 호스트 → --player-runtime 매핑 3종이 문면에 있다 (스펙 §7 캐리어)
  for (const pair of ['Claude Code=claude', 'Codex=codex', 'Grok=grok']) {
    assert.ok(skill.includes(pair), pair);
  }
});

test('사전 점검: node ≥ 20, 영구 세션, 잔여 게임 판정은 두 pid 동격', () => {
  const pre = section(read(SKILL), '## 1. 사전 점검');
  assert.match(pre, /node --version/);
  assert.match(pre, /20/);
  assert.match(pre, /\.session-store\/sessions/);
  assert.match(pre, /이동·복사·삭제되지 않는다/);
  assert.match(pre, /resume-check/);
  assert.match(pre, /--lock-dir game/);
  assert.match(pre, /serverPidAlive/);
  assert.match(pre, /loopPidAlive/);
  assert.match(pre, /동격/);
  assert.match(pre, /사용자에게 묻는다|사용자에게 물어/);
});

test('시작: 활성 게임은 --force 없이는 ACTIVE_GAME이고 init·서버 기동은 딜러가 하지 않는다', () => {
  const start = section(read(SKILL), '## 2. 시작');
  assert.match(start, /ACTIVE_GAME/);
  assert.match(start, /--force/);
  assert.match(start, /loop-state\.json/);
  assert.match(start, /resume-check/);
  assert.match(start, /loopPidAlive:false/);
  assert.match(start, /SESSION_DIR/);
  assert.match(start, /archivedTo.*사용하지 않는다/);
  assert.match(start, /notices/);
  assert.match(start, /open "http:\/\/127\.0\.0\.1:/);
  // 부트스트랩은 사이드카 소관 — 딜러가 init·서버를 직접 띄우지 않는다.
  assert.equal(/node engine\/cli\.js init/.test(start), false, '딜러가 init을 직접 부른다');
  assert.equal(/node server\/server\.js/.test(start), false, '딜러가 서버를 직접 띄운다');
});

test('스킬에 옛 딜러 루프 문면이 남아 있지 않다', () => {
  const skill = read(SKILL);
  for (const gone of [
    '--new-hand',
    '--force-default',
    '--wait-only',
    '--expect-version',
    '--view-only',
    'watch-accept',
    'spawn_subagent',
    'subagent_type',
    'holdem-player',
  ]) {
    assert.equal(skill.includes(gone), false, `옛 루프 문면 잔존: ${gone}`);
  }
  const rollbackAt = skill.indexOf('## 6. 중단');
  assert.ok(rollbackAt > 0);
  assert.equal(skill.slice(0, rollbackAt).includes('.turn.json'), false,
    'rollback 밖에 수동 turn envelope 문면이 남아 있다');
  assert.match(skill, /개입하지 않는다|개입은 없다/);
});

test('게임 중: 상태 질의는 loop-state 읽기 한 번이고 딜러 라운드는 0이다', () => {
  const during = section(read(SKILL), '## 3. 게임 중');
  assert.match(during, /loop-state\.json/);
  assert.match(during, /metrics/);
  assert.match(during, /0회|0라운드|라운드 0/);
});

test('종료 보고: done·halt 분기와 세 halt 코드의 사용자 안내가 있다', () => {
  const done = section(read(SKILL), '## 4. 종료 보고');
  assert.match(done, /phase가 done/);
  assert.match(done, /finishedAt/);
  assert.match(done, /halt/);
  for (const code of ['REVIEW_FAILED', 'repair_failed', 'NO_PLAYER_RUNTIME']) {
    assert.ok(done.includes(code), `종료 보고에 ${code} 안내가 없다`);
  }
  assert.match(done, /review\.md/);
});

test('resume: loopPidAlive가 참이면 attach, 거짓일 때만 --resume 기동', () => {
  const resume = section(read(SKILL), '## 5. resume');
  assert.match(resume, /loopPidAlive/);
  assert.match(resume, /attach/i);
  assert.match(resume, /다시 띄우지 않는다|재기동하지 않는다|스폰하지 않는다/);
  // 거짓일 때의 기동은 --ai 대신 --resume이다.
  assert.match(resume, /node tools\/game-loop\.js --store-dir game --resume/);
});

test('중단·롤백: 정지 → 미해소 게시 해소 → revert 3단계가 순서대로 있다', () => {
  const stop = section(read(SKILL), '## 6. 중단');
  const first = stop.search(/SIGTERM/);
  const second = stop.search(/--retry/);
  const third = stop.search(/git revert/);
  assert.ok(first >= 0 && second > first && third > second,
    `롤백 3단계 순서가 아니다: ${first}/${second}/${third}`);
  assert.match(stop, /identity|pid\+startTime/i);
  assert.match(stop, /pending Q|publishQueue|코치 pending/);
  assert.match(stop, /node server\/server\.js/);
  assert.match(stop, /port.*sessionToken|sessionToken.*port/);
  assert.match(stop, /\{"ok":true\}/);
  assert.match(stop, /quiescent|정지 확인이 끝난/);
  // 종료 정리 실패는 같은 프로세스에서 재시도되지 않는다 — 새 --resume이 복구 경로다.
  assert.match(stop, /cleanupFailedAt|정리 실패/);
  assert.match(stop, /새 .*--resume|--resume.*새로/);
  assert.match(stop, /end --result abort/);
});

test('호스트 표: 기동 문면은 공통이고 갈리는 것은 --player-runtime과 종료 인지뿐', () => {
  const hosts = section(read(SKILL), '## 7. 호스트');
  for (const pair of ['Claude Code=claude', 'Codex=codex', 'Grok=grok']) {
    assert.ok(hosts.includes(pair), pair);
  }
  assert.match(hosts, /run_in_background/);
  assert.match(hosts, /loop-state/);
});

test('플레이어 프롬프트 정본: talk 규약이 없고 JSON 한 줄 회신만 있다', () => {
  const prompt = read('tools/player-prompt.md');
  assert.ok(!prompt.includes('talk'));
  assert.match(prompt, /JSON 한 줄/);
  assert.ok(!prompt.includes('SendMessage'));
});

test('호스트 에이전트 정의 파일이 없다', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, '.claude/agents/holdem-player.md')));
  assert.ok(!fs.existsSync(path.join(ROOT, '.grok/agents/holdem-player.md')));
});

test('README: 사이드카 소유·런타임 어댑터·loopPidAlive·metrics·스모크 체크리스트', () => {
  const readme = read('README.md');
  assert.match(readme, /tools\/game-loop\.js/);
  assert.match(readme, /tools\/player-runtime\.js/);
  assert.match(readme, /tools\/player-prompt\.md/);
  assert.match(readme, /loop-state\.json/);
  assert.match(readme, /loopPidAlive/);
  assert.match(readme, /metrics/);
  assert.match(readme, /finalizing/);
  assert.match(readme, /review_published/);
  assert.match(readme, /phase:\s*"done"/);
  assert.match(readme, /SIGTERM.*정상 프로세스 정리/);
  assert.match(readme, /컨테인먼트/);
  assert.equal(readme.includes('holdem-player.md'), false, 'README가 삭제된 에이전트 정의를 가리킨다');
});

test('AGENTS: 사이드카가 루프를 소유하고 호스트 플레이어 정의는 없다', () => {
  const agents = read('AGENTS.md');
  assert.match(agents, /사이드카/);
  assert.match(agents, /tools\/game-loop\.js/);
  assert.match(agents, /\.agents\/skills\/start-game\/SKILL\.md/);
  assert.match(agents, /--player-runtime/);
  assert.equal(agents.includes('holdem-player.md'), false, 'AGENTS가 삭제된 에이전트 정의를 가리킨다');
  // 옛 호스트 스폰 경로를 지시하는 문면이 남아 있으면 안 된다(부재 선언은 유지해도 된다).
  assert.equal(
    /지속 명명 서브에이전트|서브에이전트로 (게임을 )?(돌린다|스폰)|서브에이전트를 스폰/.test(agents),
    false,
    '호스트 서브에이전트 스폰 지시가 남아 있다',
  );
});
