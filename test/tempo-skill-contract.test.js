import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function section4c(skill) {
  const start = skill.indexOf('### 4c. 핸드 종료');
  const end = skill.indexOf('## 5. 코칭');
  assert.ok(start >= 0 && end > start, 'SKILL.md에 4c 구간이 없다');
  return skill.slice(start, end);
}

function frontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, 'frontmatter가 없다');
  return m[1];
}

test('4c archivePending 구간: resume-check만, new-hand 금지, 한 번만', () => {
  const text = section4c(read('.agents/skills/start-game/SKILL.md'));
  const start = text.indexOf('archivePending');
  const parallel = text.indexOf('병렬 턴');
  assert.ok(start >= 0 && parallel > start);
  const archive = text.slice(start, parallel);
  assert.match(archive, /이 턴은 resume-check만/);
  assert.match(archive, /repair_failed/);
  assert.match(archive, /new-hand 금지/);
  assert.match(archive, /다시 치지 않는다|두 번 치지 않는다/);
  assert.equal(/step --new-hand/.test(archive), false);
});

test('4c 병렬 턴: 코치가 hand/stats를 치고 new-hand는 이 구간에만 있다', () => {
  const text = section4c(read('.agents/skills/start-game/SKILL.md'));
  const parallel = text.slice(text.indexOf('병렬 턴'));
  assert.match(parallel, /같은 턴/);
  assert.match(parallel, /step --new-hand/);
  assert.match(parallel, /hand <n> --redacted|hand --redacted/);
  assert.match(parallel, /cli\.js stats|engine\/cli\.js stats/);
});

test('4c gameOver 구간: 코치는 하고 new-hand는 안 한다', () => {
  const text = section4c(read('.agents/skills/start-game/SKILL.md'));
  const go = text.slice(Math.max(0, text.indexOf('gameOver')));
  assert.match(go, /§6/);
  assert.match(go, /new-hand를 치지 않는다|new-hand를 치지 않/);
});

test('4c: 작별 20초 워치독이 없고 talk-from만 쓴다', () => {
  const text = section4c(read('.agents/skills/start-game/SKILL.md'));
  assert.equal(text.includes('작별 멘트 한 줄 요청(최선 노력, 20초)'), false);
  assert.match(text, /이 턴에서 기다리지 않는다/);
  assert.match(text, /--talk-from/);
  assert.equal(/작별[\s\S]{0,80}--narration/.test(text), false);
});

test('§5는 딜러가 coach용 hand/stats/snapshot curl을 치지 않는다', () => {
  const skill = read('.agents/skills/start-game/SKILL.md');
  const start = skill.indexOf('## 5. 코칭');
  const end = skill.indexOf('## 6. 종료');
  const s5 = skill.slice(start, end);
  assert.match(s5, /handNo/);
  assert.match(s5, /practiceFocus/);
  assert.match(s5, /coach-meta/);
  assert.match(s5, /hand <n> --redacted|hand --redacted/);
  assert.equal(/과폴드 허용은 자격이 실제로 성립할 때만 예약한다/.test(s5), false);
});

test('스킬은 spawn_subagent에 model이 없다고 말하지 않고 grok-4.6을 명시한다', () => {
  const skill = read('.agents/skills/start-game/SKILL.md');
  assert.equal(/파라미터에는 model이 없다|model 파라미터가 없다/.test(skill), false);
  assert.match(skill, /subagent_type:"holdem-player"|subagent_type: "holdem-player"/);
  assert.match(skill, /model:"grok-4\.6"|model: "grok-4\.6"/);
  assert.match(skill, /Bash 최대 1회|백그라운드 스폰은 같은 턴/);
});

test('Grok holdem-player 정의는 grok-4.6 low이며 SendMessage가 없다', () => {
  const raw = read('.grok/agents/holdem-player.md');
  const fm = frontmatter(raw);
  assert.match(fm, /^name:\s*holdem-player\s*$/m);
  assert.match(fm, /^model:\s*grok-4\.6\s*$/m);
  assert.match(fm, /^reasoning_effort:\s*low\s*$/m);
  assert.match(fm, /^agents_md:\s*false\s*$/m);
  assert.equal(/\bmodel:\s*inherit\b/.test(raw), false);
  assert.equal(/\bmodel:\s*haiku\b/.test(raw), false);
  assert.equal(/SendMessage/.test(raw), false);
  assert.equal(/ToolSearch/.test(raw), false);
});
