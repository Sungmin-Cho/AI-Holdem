import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { formatPlayReport } from '../server/drill-public/study-format.js';
import { buildPlayReport, emptyGameSummary, playReportView } from '../training/play-report.js';

function response(mutate = () => {}) {
  const game = emptyGameSummary({ gameId: 'g', savedAt: '2026-11-01T00:00:00.000Z' });
  game.hands = 40; game.heroHands = 40;
  game.table['5-6'] = { hands: 40, vpip: 14, pfr: 8 };
  game.checks.shortEntries = 6; game.checks.shortNonAllIn = [3, 9];
  mutate(game);
  const report = buildPlayReport([game]);
  return { ok: true, httpStatus: 200, report, view: playReportView(report) };
}

test('the study room shows the report the service sends', () => {
  const shown = formatPlayReport(response());
  assert.equal(shown.empty, false);
  assert.equal(shown.scope, '최근 1게임에서 내가 받은 40핸드 기준(전체 1게임)');
  assert.deepEqual(shown.focus.map((item) => item.title), ['10BB 이하에서 올인이 아닌 진입']);
  assert.deepEqual(shown.sections.map((section) => section.title), ['플레이 빈도', '결정 점검', '게임별 추이']);
  assert.ok(shown.sections[0].rows.every((row) => typeof row.label === 'string' && typeof row.value === 'string'));
});

test('an older service, a failure or a malformed answer shows nothing', () => {
  assert.equal(formatPlayReport({ ok: false, httpStatus: 404, code: 'NOT_FOUND' }), null);
  assert.equal(formatPlayReport({ ok: false, httpStatus: 500, code: 'ERROR' }), null);
  assert.equal(formatPlayReport(null), null);
  assert.equal(formatPlayReport({ ok: true, report: {}, view: { focus: [], sections: [] } }), null);
  assert.equal(formatPlayReport({ ok: true, report: { scope: { heroHands: 3 } }, view: { focus: [] } }), null);
});

test('no hands yet, partial reads and text bounds', () => {
  const empty = formatPlayReport({ ok: true, report: buildPlayReport([]), view: playReportView(buildPlayReport([])) });
  assert.deepEqual(empty, { empty: true, scope: '끝난 핸드가 쌓이면 여기에 플레이 리포트가 보입니다.', focus: [], sections: [] });
  const partial = response();
  Object.assign(partial.report.scope, { unreadableGames: 1, unreadableHands: 2, truncated: true, biasedHands: 4 });
  assert.equal(formatPlayReport(partial).scope,
    '최근 1게임에서 내가 받은 40핸드 기준(전체 1게임) · 읽지 못한 기록: 게임 1 · 핸드 2 · 기록이 많아 일부만 읽었습니다 · 유리한 딜 4핸드 제외');
  const hostile = response();
  hostile.view.focus = [{ title: 'x'.repeat(500), detail: 5 }, { title: 7 }];
  hostile.view.sections = [{ title: 'a', note: null, rows: [{ label: 'l'.repeat(999), value: {} }, { label: 3 }] }, { title: 'empty', rows: [] }];
  const cut = formatPlayReport(hostile);
  assert.deepEqual(cut.focus, [{ title: 'x'.repeat(80), detail: '' }]);
  assert.deepEqual(cut.sections, [{ title: 'a', note: '', rows: [{ label: 'l'.repeat(120), value: '' }] }]);
});

test('the page has a place for the report and asks for it apart from the summary', () => {
  const html = fs.readFileSync(new URL('../server/drill-public/drill.html', import.meta.url), 'utf8');
  for (const id of ['play-report', 'play-report-scope', 'play-report-retry', 'play-report-focus', 'play-report-sections']) {
    assert.equal(html.split(`id="${id}"`).length, 2, id);
  }
  assert.match(html, /<section id="play-report"[^>]* hidden>/, 'hidden until the service answers');
  const script = fs.readFileSync(new URL('../server/drill-public/drill.js', import.meta.url), 'utf8');
  assert.match(script, /api\('\/api\/report'\)/);
  assert.match(script, /missing = response\.httpStatus === 404/);
});
