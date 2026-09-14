import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DisplayController, FusionEngine, robustVelocity } from '../src/controller.js';
const config=JSON.parse(readFileSync(new URL('../config.json',import.meta.url)));
const result=(angleDeg,timestampMs,extra={})=>({angleDeg,timestampMs,frameId:timestampMs,valid:angleDeg!==null,...extra});
test('keyboard is authoritative regardless of disagreement, with loss grace and stale handling',()=>{
  const e=new FusionEngine(config);e.ingest('lighting',result(110,0));e.ingest('keyboard',result(30,0,{quality:{confidence:0.01}}));
  let out=e.tick(0);assert.equal(out.measurementAngleDeg,30);assert.equal(out.authoritative,true);assert.equal(out.displayAngleDeg,120);
  e.ingest('keyboard',result(null,100));out=e.tick(150);assert.equal(out.state,'KEYBOARD_GRACE');assert.equal(out.measurementAgeMs,150);
  out=e.tick(201);assert.equal(out.measurementAngleDeg,110);assert.equal(out.source,'lighting');
  const shown=e.tick(500).displayAngleDeg;out=e.tick(501);assert.equal(out.measurementAngleDeg,null);assert.equal(out.displayAngleDeg,shown);
  e.ingest('keyboard',result(35,600));out=e.tick(600);assert.equal(out.measurementAngleDeg,35);assert.ok(Math.abs(out.displayAngleDeg-shown)<1);
});
test('source/model jumps never create angular velocity and obsolete replies cannot replace current data',()=>{
  const e=new FusionEngine(config);e.ingest('lighting',result(120,0,{motion:{velocityDegS:0}}));e.tick(0);
  e.ingest('lighting',result(40,100,{motion:{velocityDegS:0},adaptation:{version:5}}));
  let out=e.tick(100);assert.equal(out.motionVelocityDegS,0);assert.ok(Math.abs(out.displayVelocityDegS)<=1);
  e.ingest('keyboard',result(20,200));out=e.tick(200);assert.equal(out.motionVelocityDegS,0);assert.equal(out.measurementAngleDeg,20);
  assert.equal(e.ingest('keyboard',result(44,150)),false);assert.equal(e.tick(210).measurementAngleDeg,20);
});
test('keyboard velocity uses only contiguous keyboard observations',()=>{
  const samples=[0,60,120,180,240].map(t=>result(20+t*.02,t));
  assert.ok(Math.abs(robustVelocity(samples,config.selection)-20)<1e-8);
  const e=new FusionEngine(config);for(const s of samples)e.ingest('keyboard',s);
  assert.equal(e.tick(240).motionSource,'keyboard');
  e.ingest('keyboard',result(null,300));e.ingest('keyboard',result(44,350));assert.equal(e.tick(350).motionSource,'unavailable');
});
test('controller stays within its planned peaks during mismatch, reversal, rest, and irregular frames',()=>{
  for(const gap of [2,8,30]){
    const c=new DisplayController({...config.display,initialAngle:50-gap});let target=50,previous=c.angle;
    c.update(target,0,0);
    for(let i=1;i<=1200;i++){
      const velocity=i<250?20:i<500?-20:0;target=Math.min(110,Math.max(10,target+velocity*.008));
      const out=c.update(target,velocity,i*8);
      assert.ok(Math.abs(out.displayVelocityDegS)<=out.displaySpeedBoundDegS+1e-9);
      assert.ok(Math.abs(out.displayAngleDeg-previous)<1);previous=out.displayAngleDeg;
    }
    const rest=new DisplayController({...config.display,initialAngle:40});rest.update(48,0,0);
    let t=0;for(let i=0;i<500;i++){t+=i%3===0?17:31;const out=rest.update(48,0,t);assert.ok(Math.abs(out.displayVelocityDegS)<=out.displaySpeedBoundDegS+1e-9);assert.ok(out.displayAngleDeg<=48.001);}
    assert.ok(Math.abs(rest.angle-48)<.01);
  }
});
test('a stale time gap freezes position and future samples resume continuously',()=>{
  const c=new DisplayController({...config.display,initialAngle:60});c.update(70,20,0);c.update(70,20,100);const previous=c.angle;
  assert.equal(c.update(100,100,2000).displayAngleDeg,previous);
  assert.ok(c.update(100,0,2016).displayAngleDeg-previous<.02);
});
test('unavailable raw measurements do not restart a stationary display correction',()=>{
  const e=new FusionEngine(config),deadlines=new Set();let out;
  for(let t=0;t<=config.display.deadlineMs;t+=20){
    const visible=t%400<160;
    e.ingest('keyboard',result(visible?25:null,t));
    e.ingest('lighting',result(null,t));out=e.tick(t);
    if(out.correctionDeadlineMs!==null)deadlines.add(out.correctionDeadlineMs);
    if(!visible&&t%400>340){assert.equal(out.measurementAngleDeg,null);assert.equal(out.displayTargetHeld,true);}
  }
  assert.equal(deadlines.size,1);assert.ok(Math.abs(out.displayAngleDeg-25)<1);
});
