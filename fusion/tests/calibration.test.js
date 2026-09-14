import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SweepCalibration } from '../src/calibration.js';
import { sweep } from '../research/sweep-fixture.mjs';
const config=JSON.parse(readFileSync(new URL('../config.json',import.meta.url))).calibration;


test('sweep accepts distinct small endpoints and a full opening/closing pass',()=>{
  const {cal}=sweep();assert.equal(cal.state,'TRAINING',cal.reason);
  assert.equal(cal.events.start.angleDeg,18);assert.equal(cal.events.end.angleDeg,21);
  assert.ok(Math.abs(cal.referenceSpeed-10)<.01);assert.equal(cal.export().kind,'fusion-sweep-calibration');
  assert.ok(cal.samples.some(s=>s.angleDeg===23));
});
test('pace mismatch requires retry and missing visual motion never proves a stop',()=>{
  const fast=sweep({hiddenSpeed:16}).cal;assert.equal(fast.state,'RETRY');assert.match(fast.reason,/Opening pace/);
  const close=sweep({closeSpeed:16}).cal;assert.equal(close.state,'RETRY');assert.match(close.reason,/Closing pace/);
  assert.equal(sweep({motion:false}).cal.state,'OPENING');
  assert.equal(sweep({motion:false,manual:true}).cal.state,'TRAINING');
});
test('capture gaps, environment changes, and mismatched labels fail safely',()=>{
  const cal=new SweepCalibration(config);
  const k={frameId:1,timestampMs:0,valid:true,angleDeg:20};cal.push(k,{...k,motion:{}});
  assert.throws(()=>cal.push({...k,frameId:2},{...k,frameId:3}),/identical/);
  cal.push({...k,frameId:2,timestampMs:600},{...k,frameId:2,timestampMs:600});assert.equal(cal.state,'RETRY');
  const changed=new SweepCalibration(config);changed.push(k,{...k,environmentChange:'camera'});assert.equal(changed.state,'RETRY');
});
