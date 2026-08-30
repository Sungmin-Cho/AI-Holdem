// 사이드카가 실제로 잇는 자식 프로세스 시퀀스의 통합 계약이다:
//   engine/cli.js step … → .turn.json → tools/publish.js --from … --wait → 다음 step …
// tools/game-loop.js는 이 왕복을 execFile 인자 배열로(셸 미경유) 돌리고, publish stdout의
// next·stateVersion만 보고 다음 자식 argv를 만든다. 여기서 검증하는 것은 그 이음매다 —
// step이 다음 행동자 요약을 자족적으로 주는가, publish가 public 필터를 지키는가,
// stateVersion이 다음 --expect-version으로 그대로 이어지는가.
// 단위 테스트가 각 조각을 보장해도 왕복이 막히는 자리는 여기서만 드러난다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startServer } from '../server/server.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'engine/cli.js');
const TOOL = path.join(ROOT, 'tools/publish.js');

function tmpGame() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-turn-'));
}

// 사이드카의 runCli/runPublish와 같은 형태 — 셸을 거치지 않는 인자 배열 자식 호출.
async function node(args) {
  const { stdout } = await execFileAsync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(stdout.trim());
}

// step envelope는 사이드카가 `<gameDir>/.turn.json`에 원자 기록하고 publish가 --from으로 읽는다.
// 자식 argv에는 항상 --game-dir이 붙는다(기본 game/에 기대지 않는다).
async function turn(dir, stepArgs, publishArgs = []) {
  const envelope = await node([CLI, 'step', ...stepArgs, '--game-dir', dir]);
  fs.writeFileSync(path.join(dir, '.turn.json'), JSON.stringify(envelope));
  return node([TOOL, '--from', path.join(dir, '.turn.json'), '--game-dir', dir, ...publishArgs]);
}

// publish만 — step을 끼우지 않는다(사용자 대기 반복 경로).
async function publishOnly(dir, publishArgs) {
  return node([TOOL, '--from', path.join(dir, '.turn.json'), '--game-dir', dir, ...publishArgs]);
}

// 플레이어 런타임이 하는 일: 받은 message만 읽고 합법 액션 하나를 고른다. 요약이 자족적이지
// 않으면 여기서 파싱이 깨지므로, 이 파서 자체가 자족성 검증이다.
function decideFromMessage(message) {
  const numbers = /canCheck=(true|false) callAmount=(\d+) canRaise=(true|false) minRaiseTo=(\d+) maxRaiseTo=(\d+)/.exec(message);
  if (!numbers) throw new Error(`요약에서 legal 수치를 읽지 못했다:\n${message}`);
  const decisionId = /decisionId: (\S+)/.exec(message)?.[1];
  if (!decisionId) throw new Error('요약에 decisionId가 없다');
  return { decisionId, action: numbers[1] === 'true' ? 'check' : 'call' };
}

async function pressUser(port, token, decisionId) {
  for (let i = 0; i < 200; i += 1) {
    const snap = await (await fetch(`http://127.0.0.1:${port}/api/snapshot?token=${token}`)).json();
    if (snap.view?.legal?.decisionId === decisionId) {
      const { canCheck } = snap.view.legal;
      await fetch(`http://127.0.0.1:${port}/api/action?token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisionId, action: canCheck ? 'check' : 'call' }),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('사용자 뷰가 게시되지 않았습니다');
}

test('턴 계약: step→publish 시퀀스만으로 두 핸드가 끝까지 돌아간다', async () => {
  const dir = tmpGame();
  const init = await node([CLI, 'init', '--ai', '2', '--stack', '400', '--game-dir', dir]);
  const token = init.sessionToken;
  const started = await startServer({ gameDir: dir, port: 0, token });

  try {
    let handsPlayed = 0;
    let coachPublished = 0;
    let sawAiTurn = false;
    let sawUserTurn = false;

    while (handsPlayed < 2) {
      let out = await turn(dir, ['--new-hand'], ['--wait', '--wait-ms', '400']);
      handsPlayed += 1;
      assert.equal(typeof out.stateVersion, 'number', 'publish가 stateVersion을 주지 않았다');
      assert.equal(out.handNo, handsPlayed);

      for (let guard = 0; guard < 200 && !out.handOver; guard += 1) {
        const { next, stateVersion } = out;
        assert.ok(next, '핸드가 안 끝났는데 next가 없다');

        if (next.kind === 'user') {
          sawUserTurn = true;
          let action = out.userAction;
          if (!action || action.timeout) {
            const press = pressUser(started.port, token, next.decisionId);
            const waited = await publishOnly(dir, ['--wait-only', '--wait-ms', '10000']);
            await press;
            action = waited.userAction;
          }
          assert.ok(action && !action.timeout, '사용자 액션을 받지 못했다');
          const args = ['user', action.action];
          if (action.amount != null) args.push(String(action.amount));
          // publish가 준 stateVersion이 그대로 다음 step의 --expect-version이 되어야 한다.
          out = await turn(dir, [...args, '--expect-version', String(stateVersion)], ['--wait', '--wait-ms', '400']);
        } else {
          sawAiTurn = true;
          const rawStep = JSON.parse(fs.readFileSync(path.join(dir, '.turn.json'), 'utf8'));
          // 어댑터에 stdin으로 넘어가는 것이 이 문자열이다 — publish는 아무것도 덧붙이지 않는다.
          assert.equal(next.message, rawStep.next.summary);
          // 사이드카는 legal을 따로 부르지 않는다 — 플레이어처럼 message만으로 결정한다.
          const decided = decideFromMessage(next.message);
          assert.equal(decided.decisionId, next.decisionId, '요약의 decisionId가 next와 다르다');
          out = await turn(
            dir,
            [next.toAct, decided.action, '--expect-version', String(stateVersion)],
            ['--wait', '--wait-ms', '400'],
          );
        }
      }

      // 코치 파이프라인은 비차단 — 결과가 도착한 뒤 별도 envelope로 게시된다.
      fs.writeFileSync(path.join(dir, '.coach.json'), JSON.stringify({
        coach: [{ handNo: out.handNo ?? handsPlayed, text: '팟 오즈를 보라.' }],
      }));
      await node([TOOL, '--from', path.join(dir, '.coach.json'), '--game-dir', dir]);
      coachPublished += 1;

      if (out.gameOver) break;
    }

    assert.ok(sawAiTurn, 'AI 차례가 한 번도 없었다');
    assert.ok(sawUserTurn, '사용자 차례가 한 번도 없었다');

    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8'));
    assert.equal(snap.coach.length, coachPublished, '코치 노트가 유실됐다');
    assert.equal(snap.log.some((entry) => entry.type === 'deal_hole'), false, 'deal_hole이 게시됐다');
    assert.equal(snap.log.some((entry) => entry.visibility && entry.visibility !== 'public'), false);
    assert.equal(snap.log.some((entry) => entry.type === 'talk'), false, 'talk 항목이 게시됐다');
    assert.ok(snap.history.every((entry) => entry.at), 'at 타임스탬프 누락');

    // 핸드별 구간에서 그 핸드의 비공개 홀카드가 보이면 안 된다.
    const segments = [];
    for (const entry of snap.log) {
      if (entry.type === 'hand_start') segments.push({ handNo: entry.handNo, text: '' });
      if (segments.length) segments.at(-1).text += JSON.stringify(entry);
    }
    for (const segment of segments) {
      const file = path.join(dir, 'hands', `hand-${String(segment.handNo).padStart(4, '0')}.json`);
      if (!fs.existsSync(file)) continue;
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      const publicCards = new Set([...(record.board ?? []), ...(record.showdown?.reveals ?? []).flatMap((r) => r.cards)]);
      for (const [pid, cards] of Object.entries(record.holes ?? {})) {
        if (pid === 'user') continue;
        for (const card of cards) {
          if (publicCards.has(card)) continue;
          assert.equal(segment.text.includes(`"${card}"`), false, `핸드 ${segment.handNo} ${pid} 홀카드 ${card} 유출`);
        }
      }
    }

    // 재진입 체크리스트 3: 인자 없는 step + --view-only 재게시는 로그를 늘리지 않는다.
    const before = snap.log.length;
    await turn(dir, [], ['--view-only']);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8'));
    assert.equal(after.log.length, before, 'view-only 재게시가 로그를 늘렸다');
  } finally {
    await started.close();
  }
});

test('턴 계약: 3핸드 proof-bearing coach가 Published ∪ Pending = 1..sample', async () => {
  const { createCoachControl } = await import('../tools/coach-control.js');
  const dir = tmpGame();
  const init = await node([CLI, 'init', '--ai', '2', '--stack', '2000', '--game-dir', dir]);
  const token = init.sessionToken;
  const started = await startServer({ gameDir: dir, port: 0, token });
  const owner = '11111111-1111-4111-8111-111111111111';
  const cc = createCoachControl();
  const snapshotFile = path.join(dir, 'ui-snapshot.json');
  const statsFile = path.join(dir, 'stats.json');

  try {
    let handsPlayed = 0;
    while (handsPlayed < 3) {
      let out = await turn(dir, ['--new-hand'], ['--wait', '--wait-ms', '400']);
      handsPlayed += 1;
      for (let guard = 0; guard < 200 && !out.handOver; guard += 1) {
        const { next, stateVersion } = out;
        if (next.kind === 'user') {
          let action = out.userAction;
          if (!action || action.timeout) {
            const press = pressUser(started.port, token, next.decisionId);
            const waited = await publishOnly(dir, ['--wait-only', '--wait-ms', '10000']);
            await press;
            action = waited.userAction;
          }
          const args = ['user', action.action];
          if (action.amount != null) args.push(String(action.amount));
          out = await turn(dir, [...args, '--expect-version', String(stateVersion)], ['--wait', '--wait-ms', '400']);
        } else {
          const decided = decideFromMessage(next.message);
          out = await turn(
            dir,
            [next.toAct, decided.action, '--expect-version', String(stateVersion)],
            ['--wait', '--wait-ms', '400'],
          );
        }
      }

      // 사이드카 코치 파이프라인 순서: stats 캡처가 reserve(begin-owner)보다 앞이다.
      const stats = await node([CLI, 'stats', '--game-dir', dir]);
      fs.writeFileSync(statsFile, JSON.stringify(stats));
      const begun = await cc.beginOwner({
        gameDir: dir, owner, completed: handsPlayed, statsFile, snapshotFile,
      });
      const desc = begun.descriptors.find((row) => row.handNo === handsPlayed);
      assert.ok(desc, `hand ${handsPlayed} descriptor 없음 ${JSON.stringify(begun)}`);
      fs.writeFileSync(desc.exactResultPath, JSON.stringify({
        handNo: handsPlayed,
        text: handsPlayed === 1
          ? '프리플랍 폴드는 포지션 대비 무난합니다.'
          : `핸드 ${handsPlayed}의 핵심 결정은 타당합니다.`,
      }));
      const accepted = await cc.accept({
        gameDir: dir, owner, handNo: handsPlayed, generation: desc.generation,
      });
      assert.equal(accepted.ok, true);
      await node([TOOL, '--from', desc.exactEnvelopePath, '--game-dir', dir]);
      if (out.gameOver) break;
    }

    const completeness = cc.completeness(dir, handsPlayed);
    assert.equal(completeness.ok, true, JSON.stringify(completeness));
    assert.deepEqual(completeness.publishedSealHandNos, Array.from({ length: handsPlayed }, (_, i) => i + 1));
    assert.equal(completeness.pending.length, 0);
    const snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    assert.equal(snap.coach.length, handsPlayed);
    for (const note of snap.coach) {
      assert.ok(note.text.trim().length > 0);
      assert.ok(note.coachProof);
    }
  } finally {
    await started.close();
  }
});
