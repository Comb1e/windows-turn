import test from 'node:test';
import assert from 'node:assert/strict';
import { trajectory, roots, evaluate } from '../src/trajectory.js';
import { DisplayController } from '../src/controller.js';
import { readFileSync } from 'node:fs';
const config=JSON.parse(readFileSync(new URL('../config.json',import.meta.url))).display;

test('septic matches all four boundary derivatives and analytical peaks bound sampled extrema',()=>{
  const start=[30,8,-3,2],end=[90,-2,1,-3],p=trajectory(start,end,4);
  for(let i=0;i<4;i++){assert.ok(Math.abs(p.at(0)[i]-start[i])<1e-8);assert.ok(Math.abs(p.at(4)[i]-end[i])<1e-8);}
  const peaks=p.peaks(5);
  for(let t=0;t<=4;t+=.003){const v=p.at(t);for(let i=0;i<3;i++)assert.ok(Math.abs(v[i+1]-(i===0?5:0))<=peaks[i]+1e-7);}
  for(const x of roots([.04,-.4,1]))assert.ok(Math.abs(evaluate([.04,-.4,1],x))<1e-8);
});
test('stationary discrepancies complete within one second without a final snap',()=>{
  for(const gap of [1.1,2,10,30,70,110]){
    const c=new DisplayController({...config,initialAngle:120-gap});let previous=c.angle,maxStep=0;
    for(let t=0;t<=config.deadlineMs;t+=20){const r=c.update(120,0,t,{timestampMs:t,key:t});maxStep=Math.max(maxStep,Math.abs(r.displayAngleDeg-previous));previous=r.displayAngleDeg;}
    assert.ok(Math.abs(c.angle-120)<=1,`gap ${gap}`);assert.equal(c.lastChase.completed,true);
    assert.ok(c.lastChase.ended-c.lastChase.start<=config.deadlineMs);assert.ok(maxStep<gap*.1,`gap ${gap}: ${maxStep}`);assert.ok(Math.abs(c.state[1])<.01);
  }
});
test('late retargets preserve C3 state and the original deadline; model changes never create physical velocity',()=>{
  const c=new DisplayController({...config,initialAngle:30});let deadline=null;
  for(let t=0;t<=config.deadlineMs;t+=20){
    const target=t<700?110:t<850?20:80;
    const predicted=c.sample(t);
    const r=c.update(target,0,t,{timestampMs:t,key:t<700?'light1':t<850?'keyboard':'light2'});
    if(t===0)deadline=r.correctionDeadlineMs;
    if(c.chase)assert.equal(c.chase.deadline,deadline);
    if([700,860].includes(t))for(let i=0;i<4;i++)assert.ok(Math.abs(c.state[i]-predicted[i])<1e-7);
    assert.equal(r.motionVelocityDegS,0);
  }
  assert.ok(Math.abs(c.angle-80)<=1);assert.equal(c.lastChase.completed,true);
});
test('stale gaps retain position and the original countdown',()=>{
  const c=new DisplayController({...config,initialAngle:30});c.update(100,0,0);c.update(100,0,100);
  const deadline=c.chase.deadline,before=c.angle,r=c.update(null,null,601);
  assert.equal(r.displayAngleDeg,before);assert.equal(r.controllerState,'STALE');assert.equal(r.correctionDeadlineMs,deadline);
  assert.equal(c.update(100,0,620).correctionDeadlineMs,deadline);
});
test('physical motion changes preserve displayed position through jerk and follow ordinary motion promptly',()=>{
  const c=new DisplayController({...config,initialAngle:30});let angle=30;
  for(let t=0;t<=9000;t+=10){
    const motion=t<2500?15:t<5000?-15:0;angle+=t?motion*.01:0;
    const before=c.sample(t);c.update(angle,motion,t,{timestampMs:t});
    if([2500,5000].includes(t))for(let i=0;i<4;i++)assert.ok(Math.abs(before[i]-c.state[i])<1e-6);
    if(t===2000)assert.ok(Math.abs(c.angle-angle)<1);
  }
  assert.ok(Math.abs(c.angle-angle)<.1);
});
test('stationary target with frequent brief dropouts converges without restarting its countdown',()=>{
  const c=new DisplayController({...config,initialAngle:120}),deadlines=new Set();let result;
  for(let t=0;t<=config.deadlineMs;t+=20){
    const missing=t%400>=300;
    result=c.update(missing?null:25+.08*Math.sin(t*.019),0,t);
    if(result.correctionDeadlineMs!==null)deadlines.add(result.correctionDeadlineMs);
    if(t===500)assert.ok(c.angle<80,'The display must make visible progress while stationary');
    if(missing)assert.equal(result.displayTargetHeld,true);
  }
  assert.equal(deadlines.size,1);assert.ok(Math.abs(c.angle-25)<1);assert.equal(result.lastCorrection.completed,true);
});
test('expired gaps are reported once without a new one-second countdown on recovery',()=>{
  const c=new DisplayController({...config,initialAngle:120});c.update(25,0,0);const deadline=c.chase.deadline;
  c.update(null,0,12000);assert.equal(c.snapshot().correctionOverdue,true);
  for(let t=12020;t<=16000;t+=20){const r=c.update(25,0,t);if(r.correctionDeadlineMs!==null)assert.equal(r.correctionDeadlineMs,deadline);}
  assert.ok(Math.abs(c.angle-25)<1);assert.equal(c.lastChase.deadlineMet,false);
});
