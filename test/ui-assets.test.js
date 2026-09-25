import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { startServer } from '../server/server.js';
import { startAppService } from '../tools/app-service.js';
import { startDrillServer } from '../tools/drill-server.js';
import { createBrowserWorkspace } from './helpers/learning-browser-fixture.mjs';
import { scanModule } from './helpers/module-scan.mjs';

// Vendored binaries are pinned to the exact upstream bytes recorded when they
// were chosen (unmodified Pretendard subsets keep the OFL reserved-name terms
// satisfied; the QR encoder is the upstream ESM build).
const PINNED = {
  'font-pretendard-400.woff2': '01dd73155fdfab7ce9b25224523e85a96927e21aef97f21957d41f1bfa7e3878',
  'font-pretendard-600.woff2': '4247dc5e260b92640c2cbd0e75091154647b71e1d5884116655e2903468c54cc',
  'font-pretendard-700.woff2': '78eb71c33101ee7d4f8d1b777d193a12d00f8a296e712a8c417cf27abe946397',
  'font-space-grotesk.woff2': '0640890476fc1198ab4de571fb658de443c4d85b66466ec09534a8737ab1ce9d',
  'OFL-pretendard.txt': 'b04538c9abec39a3db75108cf0af0fd9c77032fe8aa2cf38345b4d250e98e38e',
  'OFL-space-grotesk.txt': '18a4de52385f6b988782639d5d0cc1326e5a8c2de9a7f01d7b20d9aedcc60943',
  'vendor-qrcode.js': 'ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0',
};
const publicFile = (name) => new URL(`../server/public/${name}`, import.meta.url);
const sha256 = (name) => crypto.createHash('sha256').update(fs.readFileSync(publicFile(name))).digest('hex');

test('vendored fonts, licences and QR encoder match their pinned upstream bytes', () => {
  for (const [name, digest] of Object.entries(PINNED)) assert.equal(sha256(name), digest, name);
  const fonts = Object.keys(PINNED).filter((name) => name.endsWith('.woff2'));
  const total = fonts.reduce((sum, name) => sum + fs.statSync(publicFile(name)).size, 0);
  assert.ok(total <= 850 * 1024, `font budget exceeded: ${total}`);
  assert.match(fs.readFileSync(publicFile('LICENSE-qrcode.txt'), 'utf8'), /Kazuhiko Arase/);
});

test('the vendored QR module is a plain ESM file the boundary scanner fully resolves', () => {
  const scan = scanModule(fs.readFileSync(publicFile('vendor-qrcode.js'), 'utf8'));
  assert.deepEqual(scan.imports, []);
  assert.deepEqual(scan.unresolved, []);
});

test('shared UI stylesheets load only same-origin resources', () => {
  for (const name of ['design-tokens.css', 'ui-base.css']) {
    const css = fs.readFileSync(publicFile(name), 'utf8');
    assert.doesNotMatch(css, /https?:\/\/|@import/, name);
    for (const match of css.matchAll(/url\(\s*'([^']+)'\s*\)/g)) {
      assert.match(match[1], /^\/[a-z0-9-]+\.woff2$/, `${name}: ${match[1]}`);
      assert.ok(fs.existsSync(publicFile(match[1].slice(1))), match[1]);
    }
  }
});

test('no page or stylesheet pulls resources from another origin', () => {
  // The host listener's CSP would block them anyway, but the relay, public
  // listener and study service send no CSP, so this is the guard for those.
  const dirs = ['../server/public/', '../server/drill-public/'];
  const offenders = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(new URL(dir, import.meta.url))) {
      if (!/\.(html|css)$/.test(name)) continue;
      const text = fs.readFileSync(new URL(dir + name, import.meta.url), 'utf8');
      if (/(src|href)="https?:\/\/|url\(\s*['"]?https?:\/\/|@import/.test(text)) offenders.push(dir + name);
    }
  }
  assert.deepEqual(offenders, []);
});

test('theme boot script is inert without a DOM and accepts only known values', async () => {
  // Importing must not throw in Node (the boundary test imports every server file).
  await import('../server/public/theme-boot.js');
  const source = fs.readFileSync(publicFile('theme-boot.js'), 'utf8');
  assert.match(source, /theme === 'a' \|\| theme === 'c'/);
  assert.match(source, /holdem\.theme\.v1/);
});

test('app, relay and study listeners serve the new assets with correct types', async () => {
  const workspace = createBrowserWorkspace();
  let relay, app, drill;
  try {
    relay = await startServer({ gameDir: workspace.root, port: 0, token: 'ui-assets-fixture' });
    app = await startAppService(workspace.root, { resolver: async () => ({ player: null, upper: null, notices: [] }) });
    drill = await startDrillServer({ storeDir: workspace.root, token: 'ui-assets-drill' });
    const expectations = [
      ['ui-base.css', /text\/css/], ['theme-boot.js', /javascript/], ['card-render.js', /javascript/],
      ['vendor-qrcode.js', /javascript/], ['font-pretendard-400.woff2', /font\/woff2/],
      ['font-space-grotesk.woff2', /font\/woff2/], ['OFL-pretendard.txt', /text\/plain/],
    ];
    for (const origin of [app.origin, `http://127.0.0.1:${relay.port}`]) {
      for (const [name, type] of expectations) {
        const response = await fetch(`${origin}/${name}`);
        assert.equal(response.status, 200, `${origin}/${name}`);
        assert.match(response.headers.get('content-type'), type, `${origin}/${name}`);
        await response.arrayBuffer();
      }
    }
    const font = await fetch(`${app.origin}/font-pretendard-600.woff2`);
    assert.match(font.headers.get('cache-control'), /max-age=86400/);
    assert.equal(Buffer.from(await font.arrayBuffer()).length, fs.statSync(publicFile('font-pretendard-600.woff2')).size);
    const script = await fetch(`${app.origin}/card-render.js`);
    assert.equal(script.headers.get('cache-control'), 'no-store');
    await script.text();
    for (const name of ['ui-base.css', 'theme-boot.js', 'card-render.js', 'font-pretendard-700.woff2']) {
      const response = await fetch(`http://127.0.0.1:${drill.port}/${name}`);
      assert.equal(response.status, 200, `drill ${name}`);
      await response.arrayBuffer();
    }
    for (const name of ['vendor-qrcode.js', 'lobby.js']) {
      assert.equal((await fetch(`http://127.0.0.1:${drill.port}/${name}`)).status, 404, `drill must not serve ${name}`);
    }
  } finally {
    await drill?.close();
    await app?.close();
    await relay?.close();
    workspace.close();
  }
});
