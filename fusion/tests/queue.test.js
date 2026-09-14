import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestQueue, ServiceClient } from '../src/service-client.js';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('slow processing retains only the newest waiting frame and other queues progress',async()=>{
  let release;const seen=[],other=[];
  const a=new LatestQueue(async n=>{seen.push(n);if(n===1)await new Promise(resolve=>{release=resolve;});});
  const b=new LatestQueue(async n=>{other.push(n);});
  a.push(1);await turn();a.push(2);a.push(3);a.push(4);b.push(1);await turn();
  assert.deepEqual(seen,[1]);assert.deepEqual(other,[1]);assert.equal(a.dropped,2);
  release();await turn();await turn();assert.deepEqual(seen,[1,4]);a.close();a.push(5);await turn();assert.deepEqual(seen,[1,4]);
});
test('closing a queue prevents obsolete pending operations from starting',async()=>{
  let release;const seen=[];const q=new LatestQueue(async n=>{seen.push(n);await new Promise(resolve=>{release=resolve;});});
  q.push(1);await turn();q.push(2);q.close();release();await turn();assert.deepEqual(seen,[1]);
});
