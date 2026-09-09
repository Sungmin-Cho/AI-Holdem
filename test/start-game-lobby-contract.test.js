import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('start-game defaults to authenticated lobby while retaining explicit legacy resume',()=>{
 const skill=fs.readFileSync(new URL('../.agents/skills/start-game/SKILL.md',import.meta.url),'utf8');const lobby=skill.slice(skill.indexOf('## L.'),skill.indexOf('## Legacy 직접 실행 참고'));
 assert.match(lobby,/node tools\/app-service\.js/);assert.match(lobby,/엔진 init이나 플레이어·코치 LLM을 호출하지 않는다/);assert.match(lobby,/--setup-file/);assert.match(lobby,/Claude Code=`claude`, Codex=`codex`, Grok=`grok`/);assert.doesNotMatch(lobby,/nohup node tools\/game-loop/);assert.match(skill,/Legacy 직접 실행 참고/);
});
