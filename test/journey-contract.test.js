import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const journeys = fs.readdirSync(new URL('./browser/', import.meta.url)).filter(name => name.endsWith('-journey.mjs'));
test('all seven required browser journeys exist', () => {
  const required = ['fresh-session', 'learning', 'lobby-session', 'multiplayer', 'recovery-exit', 'spectator', 'ui-presentation'];
  for (const name of required) assert.ok(journeys.includes(`${name}-journey.mjs`), `${name} journey is missing`);
});
for (const name of journeys) {
  test(`${name}: required checks and executable self-test controls`, async () => {
    const module = await import(`./browser/${name}`);
    const required = module.requiredJourneyChecks;
    assert.ok(Array.isArray(required) && required.length > 0);
    assert.equal(new Set(required).size, required.length);
    const source = fs.readFileSync(new URL(`./browser/${name}`, import.meta.url), 'utf8');
    assert.match(source, /selfTestJourney\(requiredJourneyChecks/);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const run = (...args) => spawnSync(process.execPath, [`test/browser/${name}`, '--self-test', ...args], { env, encoding: 'utf8', timeout: 30000 });
    const control = run();
    assert.equal(control.status, 0, control.error?.message || control.stderr);
    for (const check of required.slice(0, 1)) {
      const omitted = run('--omit', check);
      assert.notEqual(omitted.status, 0);
      assert.ok(omitted.stderr.includes(`MISSING_REQUIRED_CHECKS: ${check}`), omitted.stderr);
    }
    if (name === 'learning-journey.mjs') {
      assert.match(source, /else if \(direct[^]*finishJourney\(\{ required: requiredJourneyChecks, recorded: result.checks.map/);
    } else {
      assert.match(source, /\n  }\n  finishJourney\(\{ required: requiredJourneyChecks, recorded: checks, failure }\);\n}/);
    }
  });
}
test('shared completion prioritizes the original failure and rejects omissions', async () => {
  const { finishJourney } = await import('./browser/journey-exit.mjs');
  assert.doesNotThrow(() => finishJourney({ required: ['a'], recorded: ['a'] }));
  assert.throws(() => finishJourney({ required: ['a', 'b'], recorded: ['a'] }), /MISSING_REQUIRED_CHECKS: b/);
  const failure = new Error('original failure');
  assert.throws(() => finishJourney({ required: ['a'], recorded: [], failure }), error => error === failure);
});
test('UI browser CI executes every journey', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  const browserJob = workflow.split('  ui-browser:')[1].split(/\n  [a-z][\w-]*:/)[0];
  const scripts = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).scripts;
  const runLines = browserJob.split('\n').filter(line => /^        run: /.test(line)).join('\n');
  const expanded = runLines.replace(/npm run ([\w:]+)/g, (_, name) => scripts[name] || '');
  assert.doesNotMatch(browserJob, /continue-on-error:/);
  const conditions = browserJob.split('\n').filter(line => /\bif:/.test(line));
  assert.deepEqual(conditions.map(line => line.trim()), ['if: always()']);
  for (const line of expanded.split('\n').filter(line => line.includes('test/browser/'))) {
    assert.doesNotMatch(line, /\|\||;/, 'journey failures must propagate');
  }
  assert.match(browserJob, /mkdir -p "\$GITHUB_WORKSPACE\/game"/);
  assert.match(browserJob, /--user-store-dir "\$GITHUB_WORKSPACE\/game"/);
  for (const name of journeys) assert.ok(expanded.split('\n').some(line => line.trim().startsWith(`run: node test/browser/${name} `)), `${name} absent from browser CI`);
});

test('cleanup runs every step and preserves the original error', async () => {
  const { cleanupJourney } = await import('./browser/journey-exit.mjs');
  const original = new Error('original');
  const closed = [];
  const steps = [() => { closed.push('app'); throw new Error('close'); },
    () => { closed.push('study'); throw new Error('stop'); }, () => { closed.push('workspace'); }];
  const result = await cleanupJourney({ steps, failure: original });
  assert.equal(result.failure, original);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(closed, ['app', 'study', 'workspace']);
  const first = await cleanupJourney({ steps });
  assert.equal(first.failure.message, 'close');
});

test('self-test rejects unknown or missing omitted checks', async () => {
  const { selfTestJourney } = await import('./browser/journey-exit.mjs');
  assert.throws(() => selfTestJourney(['a'], ['--self-test','--omit']), /UNKNOWN_REQUIRED_CHECK/);
  assert.throws(() => selfTestJourney(['a'], ['--self-test','--omit','b']), /UNKNOWN_REQUIRED_CHECK/);
  assert.equal(selfTestJourney(['a'], []), false);
});
