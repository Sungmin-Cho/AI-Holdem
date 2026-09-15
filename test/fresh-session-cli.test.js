import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseGameLoopArgs} from '../tools/game-loop.js';

test('legacy fresh session requires an explicit resumed decision retry',()=>{
  const parsed=parseGameLoopArgs(['--resume','--retry-decision','d-1-preflop-0','--fresh-session']);
  assert.equal(parsed.freshSession,true);
  assert.equal(parsed.retryDecisionId,'d-1-preflop-0');
  for(const args of [['--fresh-session'],['--resume','--fresh-session'],['--retry-decision','d-1-preflop-0','--fresh-session']]) {
    assert.throws(()=>parseGameLoopArgs(args),{code:'USAGE'});
  }
  assert.notEqual(parseGameLoopArgs(['--resume','--retry-decision','d-1-preflop-0']).freshSession,true);
});
