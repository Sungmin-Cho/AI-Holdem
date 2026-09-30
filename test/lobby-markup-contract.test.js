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
test('online session fieldset and join page are pinned',()=>{
  const html=read('lobby.html'), join=read('join.html'), app=read('app.js'), action=read('action-controller.js'), lobby=read('lobby.js'), joinJs=read('join.js');
  assert.match(html,/id="online-session"/);
  assert.ok(html.includes('이 링크는 암호화되지 않습니다'));
  assert.match(html,/name="totalSeats"/);
  assert.match(join,/id="join-form"/);
  assert.match(join,/id="join-code"/);
  assert.equal(app.includes('crypto.randomUUID'), false);
  assert.equal(action.includes('crypto.randomUUID'), false);
  assert.equal(lobby.includes('crypto.randomUUID'), false);
  assert.equal(joinJs.includes('crypto.randomUUID'), false);
  assert.match(app,/function legacyGameEpoch/);
  assert.match(lobby, /snapshot\?\.room/);
  assert.match(lobby, /setup\.totalSeats/);
  assert.equal((app.match(/crypto\.subtle/g) || []).length, 1);
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

test('new lobby games explicitly select normal pace with four Korean labels', () => {
  const html=read('lobby.html'),js=read('lobby.js');
  assert.match(html, /<select name="pace">/);
  for(const [value,label] of [['instant','즉시'],['fast','빠름'],['normal','보통'],['slow','느림']]) {
    assert.match(html,new RegExp(`<option value="${value}"[^>]*>${label}</option>`));
  }
  assert.match(html, /<option value="normal" selected>/);
  assert.match(js, /"pace",/);
});
