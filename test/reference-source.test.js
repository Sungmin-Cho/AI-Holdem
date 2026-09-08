import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveSessionReference} from '../tools/reference-source.js';
import {LEGACY_REFERENCE_SOURCE,V2_REFERENCE_SOURCE} from '../shared/reference.js';
const dir=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'reference-source-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
test('legacy absence binds v1; new v2 session remains pinned on resume',t=>{
 const a=dir(t),b=dir(t);assert.deepEqual(resolveSessionReference(a),LEGACY_REFERENCE_SOURCE);
 assert.deepEqual(resolveSessionReference(b,{createNew:true,source:V2_REFERENCE_SOURCE}),V2_REFERENCE_SOURCE);
 assert.deepEqual(resolveSessionReference(b),V2_REFERENCE_SOURCE);
 assert.throws(()=>resolveSessionReference(a,{createNew:true,source:V2_REFERENCE_SOURCE}),{code:'REFERENCE_SOURCE_CONFLICT'});
});
test('lost v2 descriptor cannot silently bind v1',t=>{
 const d=dir(t);fs.mkdirSync(path.join(d,'training'));
 fs.writeFileSync(path.join(d,'training','evaluations.jsonl'),JSON.stringify({source:V2_REFERENCE_SOURCE})+'\n');
 assert.throws(()=>resolveSessionReference(d),{code:'REFERENCE_SOURCE_CONFLICT'});
 assert.equal(fs.existsSync(path.join(d,'reference-source.json')),false);
});
test('descriptor rejects symlink, oversize, malformed source',t=>{
 for(const kind of ['symlink','large','forged']){
  const d=dir(t),file=path.join(d,'reference-source.json');
  if(kind==='symlink')fs.symlinkSync('/dev/null',file);
  if(kind==='large')fs.writeFileSync(file,' '.repeat(4097));
  if(kind==='forged')fs.writeFileSync(file,JSON.stringify({schemaVersion:1,source:{...V2_REFERENCE_SOURCE,contentSha256:'0'.repeat(64)}}));
  assert.throws(()=>resolveSessionReference(d),{code:'REFERENCE_SOURCE_INVALID'});
 }
});
