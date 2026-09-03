import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTrainingControl } from '../tools/training-control.js';
import { appendJsonl, readJsonl } from '../tools/training-store.js';
import { evaluationIdOf } from '../training/contracts.js';
import { generateQueue } from '../training/drill-generator.js';
import { writeOpponentNote, readOpponentNotes } from '../tools/training-stores.js';
import { startDrillServer } from '../tools/drill-server.js';
import * as pipeline from '../tools/training-pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EPOCH = 'ab'.repeat(32);

function tmp(prefix = 'holdem-minors-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function evaluationOf(decisionId = 'd-1-preflop-0') {
  return {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch: EPOCH,
      decisionId,
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    decisionId,
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AA',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null }],
    chosen: { action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null },
    bestEvBb: null,
    evLossBb: null,
    grade: 'preferred',
    forced: false,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  };
}

// 1 — owner 검증: stale owner의 authority 변경은 거부된다.
test('an authority owned by one session refuses a write from a stale owner', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, {
    gameEpoch: EPOCH, owner: 'owner-live', handNo: 1, evaluations: [evaluationOf()],
  });

  await assert.rejects(
    () => tc.acceptEvaluations(dir, {
      gameEpoch: EPOCH, owner: 'owner-stale', handNo: 1, evaluations: [evaluationOf('d-2-preflop-0')],
    }),
    { code: 'TRAINING_OWNER_MISMATCH' },
  );
  const auth = createTrainingControl().loadAuthority(dir);
  assert.equal(auth.ownerSessionId, 'owner-live');
  assert.equal(Object.keys(auth.items).length, 1);
});

// 2 — 레거시 `--game-dir`은 training이 꺼진다는 사실을 notice로 남긴다.
test('a legacy --game-dir session says out loud that training is off', async (t) => {
  const { createGameLoop } = await import('../tools/game-loop.js');
  const gameDir = tmp('holdem-minors-legacy-');
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: { port: 0, waitMs: 40, opponentRuntime: 'policy' },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({
    ai: 1, mode: 'cash-training', stackBb: 100, blinds: '50/100', hands: 1, opponentRuntime: 'policy',
  });

  const state = JSON.parse(fs.readFileSync(path.join(gameDir, 'loop-state.json'), 'utf8'));
  assert.ok(
    (state.notices ?? []).some((notice) => /training/i.test(notice) && /--store-dir/.test(notice)),
    `no training-off notice in ${JSON.stringify(state.notices)}`,
  );
});

// 3 — readJsonl은 symlink를 거부한다(O_NOFOLLOW 하드닝의 회귀 가드).
test('readJsonl refuses a symlinked jsonl', () => {
  const dir = tmp();
  const real = path.join(dir, 'real.jsonl');
  const link = path.join(dir, 'link.jsonl');
  fs.writeFileSync(real, `${JSON.stringify({ a: 1 })}\n`);
  fs.symlinkSync(real, link);
  assert.deepEqual(readJsonl(real), [{ a: 1 }]);
  assert.throws(() => readJsonl(link), { code: 'UNSAFE_PATH' });
});

// 4 — 깨진 training authority가 turn 게시를 막아선 안 된다.
test('a corrupt training authority halts training without blocking publication', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'training'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'training', '.training-authority.json'),
    JSON.stringify({ schemaVersion: 99, items: {} }),
  );

  // The publisher asks for an envelope on every turn. Throwing here stops the
  // turn from being published at all, which trades a training outage for a game
  // outage.
  assert.doesNotThrow(() => pipeline.unpublishedEnvelope(dir, { gameEpoch: EPOCH }));
  assert.equal(pipeline.unpublishedEnvelope(dir, { gameEpoch: EPOCH }), null);
  assert.doesNotThrow(() => pipeline.annotationEnvelope(dir, { gameEpoch: EPOCH }));
  assert.equal(pipeline.annotationEnvelope(dir, { gameEpoch: EPOCH }), null);
  // Training itself must still fail loudly for its own consumers.
  assert.throws(
    () => createTrainingControl().loadAuthority(dir),
    { code: 'UNSUPPORTED_TRAINING_AUTHORITY' },
  );
});

// 5 — torn tail은 64KiB 창이 아니라 파일 전체를 역탐색해 복구한다.
test('a torn tail longer than the 64KiB window is recovered, then append and read succeed', () => {
  const dir = tmp();
  const file = path.join(dir, 'events.jsonl');
  const intact = { id: 'first', pad: 'x'.repeat(16) };
  // One complete row, then a torn row larger than the scan window.
  const torn = `${JSON.stringify({ id: 'torn', pad: 'y'.repeat(80 * 1024) })}`;
  fs.writeFileSync(file, `${JSON.stringify(intact)}\n${torn.slice(0, torn.length - 5)}`);

  appendJsonl(file, { id: 'second' });

  const rows = readJsonl(file);
  assert.deepEqual(rows.map((row) => row.id), ['first', 'second']);
});

// 6 — 클라이언트 병합: 같은 evaluationId에 다른 digest가 오면 기존을 유지한다.
test('a machine item with a conflicting digest never replaces the one already shown', async () => {
  const { mergeTrainingItem } = await import('../server/public/training-format.js');
  const existing = { evaluationId: 'e1', payloadSha256: 'a'.repeat(64), grade: 'preferred' };

  assert.equal(mergeTrainingItem(existing, { ...existing }), existing, 'same digest is a no-op');
  const conflicting = { evaluationId: 'e1', payloadSha256: 'b'.repeat(64), grade: 'off-policy' };
  assert.equal(
    mergeTrainingItem(existing, conflicting),
    existing,
    'a set-once digest cannot be rewritten by a later publish',
  );
  assert.equal(mergeTrainingItem(undefined, conflicting), conflicting, 'a first item is taken');
});

// 7 — drill 토큰은 헤더 전용. query token은 401.
test('the drill server refuses a token passed in the query string', async () => {
  const storeDir = tmp('holdem-minors-drill-');
  const started = await startDrillServer({ storeDir, port: 0, token: 'tok' });
  try {
    const viaQuery = await fetch(`http://127.0.0.1:${started.port}/api/drill/state?token=tok`);
    assert.equal(viaQuery.status, 401, 'a query-string token must not authenticate');

    const viaHeader = await fetch(`http://127.0.0.1:${started.port}/api/drill/state`, {
      headers: { 'x-drill-token': 'tok' },
    });
    assert.notEqual(viaHeader.status, 401);
  } finally {
    await started.close();
  }
});

// 8 — leak 모드 spot 매핑은 두 갈래 하드코딩이 아니라 leak id에서 유도된다.
test('leak drills derive their spot and hand from the leak, not from a two-branch default', () => {
  const build = (id) => generateQueue({ mode: 'leak', profile: { leaks: [{ id }] } })[0].prompt;

  const co = build('preflop.rfi.CO');
  const sb = build('preflop.rfi.SB');
  const defense = build('preflop.bbDefense.vs-BTN');

  assert.match(co.spotKey, /co/, `CO leak mapped to ${co.spotKey}`);
  assert.match(sb.spotKey, /sb/, `SB leak mapped to ${sb.spotKey}`);
  assert.notEqual(co.spotKey, sb.spotKey, 'different leaks must not collapse to one spot');
  assert.match(defense.spotKey, /bb-vs/, `defense leak mapped to ${defense.spotKey}`);

  const hands = new Set([co.handClass, sb.handClass, defense.handClass]);
  assert.ok(hands.size > 1, `every leak drilled the same hand: ${[...hands]}`);
});

// 9 — provider version은 데이터셋에서 온다. 하드코딩 상수가 남아 있으면 안 된다.
test('the drill provider version comes from the dataset, with no hardcoded constant left', async () => {
  const { loadPreflopDataset } = await import('../tools/preflop-dataset.js');
  const { data } = loadPreflopDataset();
  const source = fs.readFileSync(path.join(ROOT, 'tools/drill-cli.js'), 'utf8');

  assert.equal(
    /providerVersion:\s*'\d+\.\d+\.\d+'/.test(source),
    false,
    'drill-cli still pins a provider version by hand',
  );
  assert.equal(
    /version:\s*'\d+\.\d+\.\d+'/.test(source),
    false,
    'drill-cli still pins a source version by hand',
  );
  assert.match(data.version, /^\d+\.\d+\.\d+$/);
});

// 10 — 노트의 writtenAt은 서버 시각이다. 입력값은 무시한다.
test('an opponent note is stamped by the server, not by its author', async () => {
  const storeDir = tmp('holdem-minors-notes-');
  await writeOpponentNote(storeDir, {
    opponentId: 'p1',
    text: 'note',
    writtenAt: '1999-01-01T00:00:00.000Z',
  });

  const [note] = readOpponentNotes(storeDir);
  assert.notEqual(note.writtenAt, '1999-01-01T00:00:00.000Z', 'the supplied timestamp was trusted');
  assert.ok(Date.now() - Date.parse(note.writtenAt) < 60_000, `stale stamp ${note.writtenAt}`);
});

// 11 — solver 자식의 ps 폴링 간격은 250ms다.
test('the solver child is polled every 250ms, not every 50ms', async () => {
  const { SOLVER_POLL_MS } = await import('../tools/solver-runtime.js');
  assert.equal(SOLVER_POLL_MS, 250);
  const source = fs.readFileSync(path.join(ROOT, 'tools/solver-runtime.js'), 'utf8');
  assert.match(source, /setInterval\([^)]*SOLVER_POLL_MS\)/s, 'the interval must use the constant');
});

// 12 — SOLVER_BUSY 단언은 조건부여선 안 된다.
test('the live-child SOLVER_BUSY assertion is not wrapped in a conditional', () => {
  const source = fs.readFileSync(path.join(ROOT, 'test/solver-runtime.test.js'), 'utf8');
  assert.equal(
    /if\s*\(\s*hasLiveSolverChild\(\)\s*\)\s*\{/.test(source),
    false,
    'a conditional assertion silently passes when the child is not up yet',
  );
});
