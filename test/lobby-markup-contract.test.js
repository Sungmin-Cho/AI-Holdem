import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = name => fs.readFileSync(new URL(`../server/public/${name}`,import.meta.url),'utf8');
test('unverifiable recovery exposes a guarded end action and confirms error restart',()=>{
  const html=read('lobby.html'),js=read('lobby.js');
  assert.match(html,/id="result-end" hidden/);
  assert.match(js,/BAD_PLAYER_RECOVERY:/);
  assert.match(js,/recoveryExit\?\.mode === 'finalize'/);
  assert.match(js,/\$\("result-end"\)\.disabled = busy/);
  assert.match(js,/\$\("result-restart"\)\.onclick = \(\) => snapshot\.state === 'error' \? confirm/);
});
test('fresh retry has a separate confirmation explaining seat memory loss',()=>{
  const html=read('lobby.html'),js=read('lobby.js');
  for(const id of ['retry-fresh-session','fresh-session-dialog','fresh-session-yes','fresh-session-no']) assert.match(html,new RegExp(`id="${id}"`));
  for(const text of ['대화 기억','페르소나 카드·칩·핸드 기록은 유지','교정 안내 없이']) assert.ok(html.includes(text));
  assert.match(js,/freshSession:\s*true/);
  assert.match(js,/freshSessionAvailable/);
  assert.match(js,/freshSessionAuthorized/);
  assert.match(js,/RETRY_NOT_APPLIED:/);
  assert.match(js,/재시도를 다시 선택/);
});
