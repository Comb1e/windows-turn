import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProfileStore } from '../profile-store.js';
import { LightingServer } from '../lighting-server.js';
import { featureNames } from '../src/features.js';
const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url)));
const settings=JSON.parse(await readFile(new URL('../service-config.json',import.meta.url)));
const camera={width:64,height:64,horizontalFovDegrees:60};
function model(capture=camera){const n=featureNames(config.features).length;return {version:1,featureVersion:1,featureConfig:config.features,featureNames:featureNames(config.features),angleRange:[10,120],capture,
  modelId:'test-model',normalization:{mean:Array(n).fill(0),scale:Array(n).fill(1)},trees:[[[-1,0,-1,-1,80]]],filter:config.filter,calibration:{residual95:5,distance95:100,spread95:2},validation:{passed:false}};}
async function setup(){
  const root=await mkdtemp(join(tmpdir(),'hinge-profiles-')),store=new ProfileStore(root,config),id=randomUUID();
  await mkdir(store.path(id),{recursive:true});
  await writeFile(join(store.path(id),'profile.json'),JSON.stringify({profileId:id,createdAt:new Date().toISOString(),name:'Test',capture:camera,coverage:[18,120]}));
  await writeFile(join(store.path(id),'model.json'),JSON.stringify(model()));return {root,store,id};
}
test('selection persists, published profiles are immutable, and private paths cannot be selected',async()=>{
  const {root,store,id}=await setup(),before=await readFile(join(store.path(id),'model.json'));
  await store.select(id);assert.equal(await new ProfileStore(root,config).selected(),id);
  assert.equal((await store.list()).profiles.length,1);await assert.rejects(store.get('../config'),/Invalid profile/);
  assert.deepEqual(await readFile(join(store.path(id),'model.json')),before);
});

test('existing sweep artifacts remain readable and exportable without a training entry point',async()=>{
  const {store,id}=await setup();
  for(const name of ['recording','sweep','report','parity'])
    await writeFile(join(store.path(id),name+'.json'),JSON.stringify({savedArtifact:name}));
  const before=await readFile(join(store.path(id),'model.json'));
  const exported=await store.export(id);
  assert.equal(exported.model.modelId,'test-model');
  assert.equal(exported.sweep.savedArtifact,'sweep');
  assert.equal(store.train,undefined);
  assert.deepEqual(await readFile(join(store.path(id),'model.json')),before);
});
test('feature-only sessions ignore incompatible CLI models and profile activation is frame-bound',async()=>{
  const {root,id}=await setup();let resetCount=0;
  const worker={pending:null,request:async command=>{if(command==='reset')resetCount++;return {};},close(){}};
  const api=new LightingServer(root,config,settings,model({...camera,height:100}),{motionWorker:worker});
  const {sessionId}=await api.create({camera,mode:'features-only',initialization:'model-output'});
  assert.equal(api.session.model,null);
  const bytes=Buffer.alloc(64*64*4);for(let i=0;i<bytes.length;i+=4){bytes[i]=bytes[i+1]=bytes[i+2]=100+(i%8)*10;bytes[i+3]=255;}
  let frame=await api.frame(sessionId,{...camera,camera,frameId:1,timestampMs:0},bytes);assert.equal(frame.rawAngleDeg,null);
  api.session.pendingProfile={model:(await api.profiles.get(id)).model,profileId:id};
  frame=await api.frame(sessionId,{...camera,camera,frameId:2,timestampMs:100},bytes);
  assert.equal(frame.angleDeg,80);assert.equal(frame.modelGeneration,1);assert.equal(frame.profileId,id);assert.ok(resetCount>=2);
  assert.throws(()=>api.anchor(sessionId,{frameId:1,source:'keyboard',angleDeg:25}),/cached matching/);
  api.close();
});
