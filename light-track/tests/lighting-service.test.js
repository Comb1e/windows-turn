import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { LightingServer } from '../lighting-server.js';
import { featureNames } from '../src/features.js';
const config=JSON.parse(readFileSync(new URL('../config.json',import.meta.url)));
const settings=JSON.parse(readFileSync(new URL('../service-config.json',import.meta.url)));
const camera={width:64,height:64,horizontalFovDegrees:60};
function model(){const n=featureNames(config.features).length;return {version:1,featureVersion:1,featureConfig:config.features,featureNames:featureNames(config.features),angleRange:[10,120],normalization:{mean:Array(n).fill(0),scale:Array(n).fill(1)},trees:[[[-1,0,-1,-1,80]]],filter:config.filter,calibration:{residual95:3,distance95:100,spread95:2},validation:{passed:false}};}
const worker=()=>({pending:null,request:async command=>command==='reset'?{}:{velocityDegS:2,quality:'calibrated-motion',rotationVector:[.02,0,0]},close(){}});
function rgba(level=100){const b=Buffer.alloc(64*64*4);for(let i=0;i<b.length;i+=4){const v=level+((i/4)%2)*40;b[i]=v;b[i+1]=v;b[i+2]=v;b[i+3]=255;}return b;}
test('frame inference pairs anchors exactly and never differentiates adaptation changes',async()=>{
  const m=model(),snapshot=JSON.stringify(m),api=new LightingServer('.',config,settings,m,{motionWorker:worker()});
  const {sessionId}=await api.create({camera});
  await assert.rejects(api.create({camera}),/owns/);
  const frame=(i,t,bytes=rgba())=>api.frame(sessionId,{...camera,camera,frameId:i,timestampMs:t},bytes);
  assert.equal((await frame(1,0)).angleDeg,null);
  const ready=await frame(2,1000);assert.equal(ready.angleDeg,120);
  assert.throws(()=>api.anchor(sessionId,{frameId:99,angleDeg:30,source:'keyboard'}),/matching/);
  assert.throws(()=>api.anchor(sessionId,{frameId:2,angleDeg:30,source:'display'}),/provenance/);
  api.anchor(sessionId,{frameId:2,angleDeg:30,source:'keyboard'});
  const adapted=await frame(3,1100);assert.ok(Math.abs(adapted.angleDeg-30)<1);assert.equal(adapted.motion.velocityDegS,2);
  assert.equal(JSON.stringify(m),snapshot);
  await assert.rejects(frame(3,1200),/increase/);
  await assert.rejects(frame(4,1200,rgba().subarray(4)),/byte count/);
  const dark=await frame(4,1200,Buffer.alloc(64*64*4));assert.equal(dark.valid,false);assert.equal(dark.state,'SUSPENDED');
  const recovered=await frame(5,1300);assert.equal(recovered.adaptation.origin,'carried-estimate');
  assert.equal(recovered.adaptation.anchorCount,0);
  api.close();
});
test('motion deadline does not prevent a brightness response or permit another worker request',async()=>{
  let release;const w=worker();let calls=0;
  w.request=async command=>{if(command==='reset')return {};calls++;w.pending={};return new Promise(resolve=>{release=()=>{w.pending=null;resolve({velocityDegS:0});};});};
  const api=new LightingServer('.',config,{...settings,motionDeadlineMs:10},model(),{motionWorker:w});const {sessionId}=await api.create({camera});
  const first=await api.frame(sessionId,{...camera,camera,frameId:1,timestampMs:0},rgba());assert.equal(first.motion.velocityDegS,null);
  await api.frame(sessionId,{...camera,camera,frameId:2,timestampMs:1000},rgba());assert.equal(calls,1);release();api.close();
});
test('HTTP API rejects retired training paths while inference and exact-frame anchors remain available',async()=>{
  const api=new LightingServer('.',config,settings,null,{motionWorker:worker()});
  const server=createServer((req,res)=>api.handle(req,res)).listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,data,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:Buffer.isBuffer(data)?data:JSON.stringify(data)});
  try{
    const health=await (await fetch(base+'/v1/health')).json();assert.equal(health.modelReady,false);
    const {sessionId}=await (await post('/v1/sessions',{camera})).json();const path=`/v1/sessions/${sessionId}`;
    for(const route of ['recording','checkpoint','reference','training'])for(const method of ['GET','POST','DELETE']){
      const response=await fetch(base+path+'/'+route,{method,body:method==='POST'?'{}':undefined});
      assert.equal(response.status,410);assert.match((await response.json()).error,/photo annotations/);
    }
    assert.equal((await fetch(base+'/v1/jobs/00000000-0000-4000-8000-000000000000')).status,410);
    const result=await (await post(path+'/frames',rgba(),{'Content-Type':'application/octet-stream','X-Frame-Id':'1','X-Timestamp-Ms':'100','X-Width':'64','X-Height':'64'})).json();
    assert.equal(result.valid,false);assert.equal(result.features.length,499);
    assert.equal((await post(path+'/anchors',{frameId:1,angleDeg:30,source:'keyboard'})).status,200);
    assert.equal(api.session.collection,undefined);
    assert.equal((await post(path+'/anchors',{frameId:1,angleDeg:30,source:'keyboard'},{Origin:'https://example.com'})).status,403);
    await fetch(base+path,{method:'DELETE'});assert.equal((await post(path+'/anchors',{frameId:1,angleDeg:30,source:'keyboard'})).status,409);
  }finally{api.close();await new Promise(resolve=>server.close(resolve));}
});
test('source capture binding includes field of view and rejects a mismatched coordinator',async()=>{
  const m=model();m.capture={...camera,horizontalFovDegrees:65};
  const api=new LightingServer('.',config,settings,m,{motionWorker:worker()});
  await assert.rejects(api.create({camera}),/source calibration/);
  await api.create({camera:{...camera,horizontalFovDegrees:65}});api.close();
});

test('uncalibrated service uses its own camera defaults and calibration takes precedence',async()=>{
  const api=new LightingServer('.',config,settings,null,{motionWorker:worker()});
  const started=await api.create({});
  assert.deepEqual(started.camera,{width:640,height:480,horizontalFovDegrees:60});api.close();
  const m=model();m.capture={width:640,height:360,horizontalFovDegrees:65};
  const calibrated=new LightingServer('.',config,settings,m,{motionWorker:worker()});
  assert.deepEqual((await calibrated.create({})).camera,m.capture);calibrated.close();
});

test('screenshot models initialize from measured output and support captured angles beyond the legacy guide',async()=>{
  const m=model();m.trainingMode='screenshot-groups';m.angleRange=[0,145];m.trees=[[[-1,0,-1,-1,137.25]]];
  const api=new LightingServer('.',config,settings,m,{motionWorker:worker()});
  const {sessionId}=await api.create({camera});
  const result=await api.frame(sessionId,{...camera,camera,frameId:1,timestampMs:0},rgba());
  assert.equal(result.rawAngleDeg,137.25);assert.equal(result.angleDeg,137.25);assert.equal(result.valid,true);api.close();
});
