import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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
  assert.deepEqual(empty, { empty: true, retry: false, scope: '끝난 핸드가 쌓이면 여기에 플레이 리포트가 보입니다.', focus: [], sections: [],
    progress: '비교 가능한 핸드 0 / 200 (6인 · 100BB · 정책 v3)' });
  // Nothing could be read (a cut scan, a store too large to list): not an empty store, and worth another try.
  const unread = { ok: true, report: buildPlayReport([], { truncated: true, unreadable: { games: 2, hands: 0 } }), view: { focus: [], sections: [] } };
  assert.deepEqual(formatPlayReport(unread), { empty: true, retry: true, focus: [], sections: [], progress: '',
    scope: '플레이 기록을 리포트에 담지 못했습니다 · 읽지 못한 기록: 게임 2 · 핸드 0 · 기록이 많아 일부만 읽었습니다' });
  assert.equal(formatPlayReport(response()).retry, false);
  // Every finished hand was dealt with the favourable-deal option: say so instead of "no hands yet".
  const biased = emptyGameSummary({ gameId: 'b', savedAt: '2026-11-02T00:00:00.000Z' });
  biased.hands = 12; biased.biasedHands = 12;
  const onlyBiased = buildPlayReport([biased]);
  assert.equal(onlyBiased.scope.biasedHands, 12);
  assert.deepEqual(formatPlayReport({ ok: true, report: onlyBiased, view: playReportView(onlyBiased) }), { empty: true, retry: false, focus: [], sections: [],
    progress: '비교 가능한 핸드 0 / 200 (6인 · 100BB · 정책 v3)',
    scope: '끝난 12핸드가 모두 유리한 딜이라 리포트에서 뺐습니다. 유리한 딜을 끈 게임의 핸드가 쌓이면 여기에 보입니다.' });
  // Unread records take precedence over the favourable-deal explanation, and offer another read.
  const both = buildPlayReport([biased], { truncated: true, unreadable: { games: 1, hands: 0 } });
  assert.deepEqual(formatPlayReport({ ok: true, report: both, view: playReportView(both) }), { empty: true, retry: true, focus: [], sections: [],
    progress: '비교 가능한 핸드 0 / 200 (6인 · 100BB · 정책 v3) · 읽지 못한 기록이 있어 실제보다 적을 수 있습니다',
    scope: '플레이 기록을 리포트에 담지 못했습니다 · 읽지 못한 기록: 게임 1 · 핸드 0 · 기록이 많아 일부만 읽었습니다 · 유리한 딜 12핸드 제외' });
  // Beside ordinary games the excluded hands of such a game are still counted.
  const mixed = response();
  const withBiased = buildPlayReport([biased, ...[emptyGameSummary({ gameId: 'g' })].map((game) => { game.hands = 5; game.heroHands = 5; return game; })]);
  assert.equal(withBiased.scope.biasedHands, 12);
  assert.equal(mixed.report.scope.biasedHands, 0);
  const partial = response();
  Object.assign(partial.report.scope, { unreadableGames: 1, unreadableHands: 2, truncated: true, biasedHands: 4 });
  assert.equal(formatPlayReport(partial).scope,
    '최근 1게임에서 내가 받은 40핸드 기준(전체 1게임) · 읽지 못한 기록: 게임 1 · 핸드 2 · 기록이 많아 일부만 읽었습니다 · 유리한 딜 4핸드 제외');
  const hostile = response();
  hostile.view.focus = [{ title: 'x'.repeat(500), detail: 5 }, { title: 7 }];
  hostile.view.sections = [{ title: 'a', note: null, rows: [{ label: 'l'.repeat(999), value: {} }, { label: 3 }] }, { title: 'empty', rows: [] }];
  const cut = formatPlayReport(hostile);
  assert.deepEqual(cut.focus, [{ title: 'x'.repeat(80), detail: '' }]);
  assert.equal(cut.retry, false);
  assert.deepEqual(cut.sections, [{ title: 'a', note: '', rows: [{ label: 'l'.repeat(120), value: '' }] }]);
});

test('the comparable-hand progress line rides along, and an older service simply has none', () => {
  const shown = formatPlayReport(response());
  assert.equal(shown.progress, '비교 가능한 핸드 0 / 200 (6인 · 100BB · 정책 v3)');
  // A study service started before this change sends the same report without the line.
  const old = response();
  delete old.view.progress;
  delete old.report.results.progress;
  const formatted = formatPlayReport(old);
  assert.equal(formatted.progress, '');
  assert.deepEqual({ ...formatted, progress: undefined }, { ...shown, progress: undefined });
  const oldEmpty = { ok: true, report: buildPlayReport([]), view: { focus: [], sections: [] } };
  assert.equal(formatPlayReport(oldEmpty).progress, '');
  // Bounded and typed like every other line.
  const long = response();
  long.view.progress = 'p'.repeat(500);
  assert.equal(formatPlayReport(long).progress, 'p'.repeat(200));
  long.view.progress = { text: 'x' };
  assert.equal(formatPlayReport(long).progress, '');
  const html = fs.readFileSync(new URL('../server/drill-public/drill.html', import.meta.url), 'utf8');
  assert.equal(html.includes('play-report-progress'), false, 'the line is built by the script: the page file is unchanged');
});

test('the study page builds the progress line once under the scope line, refreshes it and clears it', async () => {
  const script = fs.readFileSync(new URL('../server/drill-public/drill.js', import.meta.url), 'utf8');
  const body = script.slice(script.indexOf('  async function refreshReport()'), script.indexOf('  function paintTrends('));
  const nodes = new Map();
  const byId = new Map();
  let inserted = 0;
  const make = (tag = 'div') => ({ tag, id: '', hidden: false, textContent: '', className: '', children: [], open: false,
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
    after(next) { inserted += 1; this.next = next; if (next.id) byId.set(next.id, next); } });
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); };
  let answer = () => response();
  const context = { $, formatPlayReport, api: async () => answer(),
    node: (tag, text, cls) => Object.assign(make(tag), { textContent: text, className: cls ?? '' }),
    document: { getElementById: (id) => byId.get(id) ?? null } };
  vm.createContext(context);
  vm.runInContext(body, context);
  await context.refreshReport();
  const line = $('play-report-scope').next;
  assert.equal(line.id, 'play-report-progress');
  assert.equal(line.className, 'assessments-note report-progress');
  assert.equal(line.textContent, '비교 가능한 핸드 0 / 200 (6인 · 100BB · 정책 v3)');
  assert.equal(line.hidden, false);
  // A later answer rewrites the same paragraph; nothing is added twice.
  answer = () => { const next = response(); next.view.progress = '비교 가능한 핸드 50 / 200 (6인 · 100BB · 정책 v3)'; return next; };
  await context.refreshReport();
  assert.equal(inserted, 1);
  assert.equal(line.textContent, '비교 가능한 핸드 50 / 200 (6인 · 100BB · 정책 v3)');
  // A failed read, an older service without the line, a missing route: the old value does not stay.
  for (const next of [() => { throw new Error('offline'); }, () => { const old = response(); delete old.view.progress; return old; },
    () => ({ ok: false, httpStatus: 404, code: 'NOT_FOUND' })]) {
    answer = () => response();
    await context.refreshReport();
    assert.equal(line.hidden, false);
    answer = next;
    await context.refreshReport();
    assert.equal(line.textContent, '');
    assert.equal(line.hidden, true);
  }
  assert.equal(inserted, 1);
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
  assert.match(script, /\$\('play-report-retry'\)\.hidden = missing \|\| \(formatted !== null && !formatted\.retry\);/);
});
