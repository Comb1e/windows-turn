import test from 'node:test';
import assert from 'node:assert/strict';
import { errors, temporal } from '../research/metrics.mjs';
test('missing readings reduce coverage rather than count as zero errors',()=>{
  const r=errors([{reference:20,angle:21},{reference:30,angle:null}],'angle');assert.equal(r.coverage,.5);assert.equal(r.meanAbsoluteError,1);assert.equal(r.within5IncludingMissing,.5);
});
test('moving delay requires synchronized reference segments; stationary jitter excludes constant bias',()=>{
  const moving=Array.from({length:60},(_,i)=>({timestampMs:i*100,reference:20+i,angle:20+Math.max(0,i-3),motion:'moving',referenceSource:'reference'}));
  assert.equal(temporal(moving,'angle').motionDelayP95Seconds,.3);
  assert.equal(temporal(moving.map(r=>({...r,referenceSource:'keyboard'})),'angle').motionDelayP95Seconds,null);
  const hold=moving.map(r=>({...r,reference:40,angle:48,motion:'stationary',referenceSource:'checkpoint'}));assert.equal(temporal(hold,'angle').stationaryJitterRms,0);
});
