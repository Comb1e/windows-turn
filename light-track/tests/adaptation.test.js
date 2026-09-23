import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SessionAdapter } from '../src/adaptation.js';
const c=JSON.parse(readFileSync(new URL('../service-config.json',import.meta.url))).adaptation;
const sample=(i,raw,t=i*600)=>({frameId:i,raw,timestampMs:t,features:[raw],summary:{mean:raw/120}});
test('startup offset waits for exposure settling and records an assumed prior',()=>{
  const a=new SessionAdapter(c);
  assert.equal(a.observe(80,0,'same'),null);assert.equal(a.observe(80,999,'same'),null);
  assert.equal(a.observe(80,1000,'same'),120);assert.equal(a.a,1);assert.equal(a.b,40);
  assert.equal(a.status().origin,'assumed-start');assert.equal(a.status().provisional,true);
  const unsettled=new SessionAdapter(c);for(let t=0;t<3000;t+=500)assert.equal(unsettled.observe(80,t,String(t)),null);
  assert.equal(unsettled.observe(80,3000,'changed'),120);assert.equal(unsettled.bootstrap.settled,false);
});
test('keyboard corrects a wrong startup and sufficient diverse pairs identify affine transfer',()=>{
  const a=new SessionAdapter(c);a.observe(80,0,'same');a.observe(80,1000,'same');
  a.add(sample(1,55,1100),20);assert.equal(a.state,'OFFSET_ADAPTED');assert.ok(Math.abs(a.a*55+a.b-20)<1);
  for(const [i,z,y] of [[2,60,30],[3,65,40],[4,57.5,25],[5,62.5,35]])a.add(sample(i,z,1100+i*600),y);
  assert.equal(a.state,'AFFINE_ADAPTED');assert.ok(Math.abs(a.a-2)<.15);assert.ok(Math.abs(a.a*62+a.b-34)<1);
  const version=a.version;a.fit(a.lastFit+100);assert.equal(a.version,version);
});
test('collapsed predictions never claim an affine fit and anchors remain bounded and deduplicated',()=>{
  const a=new SessionAdapter(c);for(let i=0;i<400;i++)a.add(sample(i,70),10+(i%30));
  assert.equal(a.state,'OFFSET_ADAPTED');assert.equal(a.a,1);assert.equal(a.anchors.length,c.maxAnchors);
  const last=a.anchors.at(-1);assert.equal(a.add(last,last.angle),false);
  assert.ok(a.export().anchors.every(p=>p.source==='keyboard'));
});
test('environment reset retains a provisional carried angle and clears only temporary data',()=>{
  const a=new SessionAdapter(c);a.add(sample(1,80),30);a.observe(80,1000,'same');
  a.suspend('new room');assert.equal(a.observe(75,1500,'same'),null);
  a.reset(32);assert.equal(a.anchors.length,0);assert.equal(a.origin,'carried-estimate');
  a.observe(75,2000,'same');assert.equal(a.observe(75,3000,'same'),32);
});
