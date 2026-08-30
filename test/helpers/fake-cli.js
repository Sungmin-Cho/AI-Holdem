#!/usr/bin/env node
// 테스트 전용 가짜 LLM CLI. 실제 모델·네트워크를 절대 부르지 않는다.
//
// 동작: stdin 전문을 읽고 `FAKE_CLI_SCRIPT`(JSON)의 매처에서 응답을 골라 stdout에 쓴다.
//   { matchers: [{ includes?, argvIncludes?, reply, delayMs?, exitCode?, stderr?,
//                  ignoreTerm?, echoCanary?, orphanMs? }],
//     default: { reply, … } }
//   - `includes`는 stdin 전문에서, `argvIncludes`는 argv 원소에서 찾는다(둘 다 있으면 AND).
//   - 첫 매치가 이긴다. 매치가 없으면 `default`.
//   - `ignoreTerm`이면 SIGTERM을 삼킨다 — 단계적 종료(TERM→KILL) 계약 테스트용.
//   - `echoCanary`면 stdin에서 절대 경로를 찾아 그 파일 내용을 reply 뒤에 붙인다 —
//     어댑터가 스스로 만든 fresh 센티널을 테스트가 몰라도 유출 CLI를 흉내 낼 수 있다.
//   - `orphanMs`면 stdout/stderr를 상속한 detached 후손을 그 시간만큼 살려 두고 즉시
//     exit 0 한다 — 직계 exit 뒤에도 stdio close가 열려 있는 경우의 계약 테스트용.
//     후손 pid는 `{orphanPid}` 한 줄로 로그에 남긴다(테스트가 정리한다).
// 기록: 매 호출을 `FAKE_CLI_LOG`(JSONL)에 append한다 — argv·stdin·cwd·env **키 목록**·pid.
//   env는 값이 아니라 키만 남긴다(자격 값은 로그에 절대 쓰지 않는다). 세션 플래그
//   (`--session-id`/`--resume`)도 argv에 받은 그대로 들어가므로 테스트가 이 로그로 단언한다.
// 기록은 지연(delayMs)보다 **먼저** 한다 — 타임아웃으로 죽는 호출도 로그에 남아야 한다.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

// `node --test`는 test/ 아래 모든 .js를 테스트 파일로 실행한다. 스크립트 env 없이
// 발견-실행된 경우 stdin EOF를 기다리면 전체 스위트가 멈추므로, stdin을 읽기 전에
// 빈 파일처럼 즉시 끝낸다. 진짜 fake CLI 호출은 항상 FAKE_CLI_SCRIPT를 갖는다.
if (!process.env.FAKE_CLI_SCRIPT) process.exit(0);

const argv = process.argv.slice(2);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readScript() {
  return JSON.parse(fs.readFileSync(process.env.FAKE_CLI_SCRIPT, 'utf8'));
}

const stdin = readStdin();
const script = readScript();

if (process.env.FAKE_CLI_LOG) {
  fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({
    argv,
    stdin,
    cwd: process.cwd(),
    envKeys: Object.keys(process.env).sort(),
    pid: process.pid,
  })}\n`);
}

function matches(m) {
  if (m.includes != null && !stdin.includes(m.includes)) return false;
  if (m.argvIncludes != null && !argv.includes(m.argvIncludes)) return false;
  return true;
}

const chosen = (script.matchers ?? []).find(matches) ?? script.default ?? { reply: '' };

if (chosen.ignoreTerm) process.on('SIGTERM', () => { /* 종료 사다리가 SIGKILL까지 가야 한다 */ });

if (chosen.orphanMs) {
  const orphan = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${Number(chosen.orphanMs)})`], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  orphan.unref();
  if (process.env.FAKE_CLI_LOG) {
    fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ orphanPid: orphan.pid })}\n`);
  }
}

function canaryContent() {
  const match = stdin.match(/\/[^\s'"]+/);
  if (!match) return '';
  try {
    return fs.readFileSync(match[0], 'utf8');
  } catch {
    return '';
  }
}

function respond() {
  if (chosen.stderr) process.stderr.write(String(chosen.stderr));
  if (chosen.reply != null) process.stdout.write(String(chosen.reply));
  if (chosen.echoCanary) process.stdout.write(canaryContent());
  process.exit(chosen.exitCode ?? 0);
}

if (chosen.delayMs) setTimeout(respond, chosen.delayMs);
else respond();
