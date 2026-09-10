import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {shardFiles} from './helpers/ci-shards.mjs';
import {requiredJourneyChecks} from './browser/lobby-session-journey.mjs';
test('release wires real browser and Windows lifecycle checks',()=>{
 const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url)));
 assert.match(pkg.scripts['test:lobby:browser'],/lobby-session-journey/);
 for(const name of ['app-service','app-command-store','app-server-security','session-controls'])assert.ok(pkg.scripts['test:lobby:windows'].includes(`test/${name}.test.js`));
 const rest=shardFiles('rest',fileURLToPath(new URL('.',import.meta.url)));
 for(const name of ['app-service','app-command-store','app-server-security','session-controls'])assert.ok(rest.some(file=>file.endsWith(`${name}.test.js`)));
 assert.match(fs.readFileSync(new URL('../.github/workflows/test.yml',import.meta.url),'utf8'),/run: npm run test:ci:windows -- \$\{\{ matrix.shard \}\}/);
 for(const name of ['pause-resume','restart-new-id','abort-summary','completed-review-reload','owned-cleanup'])assert.ok(requiredJourneyChecks.includes(name));
});
