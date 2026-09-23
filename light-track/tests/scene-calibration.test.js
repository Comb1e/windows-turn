import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AnnotationStore } from '../annotation-store.js';
import { AnnotationTraining } from '../annotation-training.js';
import { SceneCalibration } from '../scene-calibration.js';
import { ProfileStore } from '../profile-store.js';
import { LightingServer } from '../lighting-server.js';
import { ImageEstimator } from '../src/image-estimator.js';
import { sceneTransition,sceneReferenceSummary } from '../src/scene-calibration-state.js';
import { featureNames } from '../src/features.js';
import { validateModel } from '../src/model.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const config=JSON.parse(await readFile(join(root,'config.json')));
const settings=JSON.parse(await readFile(join(root,'service-config.json')));
const camera={width:64,height:64,horizontalFovDegrees:60};
function baseModel(){const names=featureNames(config.features);return {version:1,modelId:'baseline',featureVersion:1,featureConfig:config.features,featureNames:names,
  angleRange:[10,120],capture:camera,normalization:{mean:names.map(()=>0),scale:names.map(()=>1)},trees:[[[0,.45,1,2,0],[-1,0,-1,-1,25],[-1,0,-1,-1,95]]],
  filter:config.filter,calibration:{residual95:20,distance95:10,spread95:10},coverage:{device:'test'},validation:{passed:false}};}
function sceneModel(){const base=baseModel();return {version:2,kind:'scene-calibrated-model',modelId:'scene',baseModel:base,baseModelId:base.modelId,capture:camera,angleRange:[10,120],referenceRange:[20,100],referenceCount:3,calibrationFit:{kind:'affine',a:1,b:5},filter:config.filter,calibration:base.calibration};}
function pixels(level=80){return Buffer.from(Array.from({length:64*64*4},(_,i)=>i%4===3?255:level+((i>>2)%2)*30));}

test('calibration workflow preserves actual references and enforces all transitions',()=>{
  let state='Idle';for(const [event,next] of [['START','Collecting'],['FIT','Fitting'],['SUCCESS','Ready'],['RESET','Invalidated'],['START','Collecting']]){state=sceneTransition(state,event);assert.equal(state,next);}
  assert.throws(()=>sceneTransition('Idle','SUCCESS'),/Invalid/);
  assert.equal(sceneReferenceSummary([{angleDeg:20},{angleDeg:20},{angleDeg:50}],config.sceneCalibration).canFit,false);
  assert.equal(sceneReferenceSummary([{angleDeg:20},{angleDeg:30},{angleDeg:39.99}],config.sceneCalibration).canFit,false);
  const result=sceneReferenceSummary([{angleDeg:20.123},{angleDeg:30},{angleDeg:40.123}],config.sceneCalibration);
  assert.equal(result.canFit,true);assert.deepEqual(result.range,[20.123,40.123]);assert.equal(result.count,3);
});

test('v1 models remain valid; mismatched or recursively calibrated profiles are rejected',()=>{
  validateModel(baseModel(),config.features);validateModel(sceneModel(),config.features);
  for(const change of [m=>m.baseModelId='other',m=>m.capture={...camera,width:128},m=>m.calibrationFit.a=NaN,m=>m.referenceCount=2,m=>m.baseModel=sceneModel()]){
    const model=sceneModel();change(model);assert.throws(()=>validateModel(model,config.features));
  }
  assert.throws(()=>validateModel({...sceneModel(),kind:'image-angle-model',promotionPassed:false},config.features),/promotion/);
});

test('image transport keeps only newest pending frame and rejects late responses after reset',async()=>{
  const requests=[],samples=[];let release;
  const fetcher=async(path,options)=>{
    if(path==='/v1/sessions')return {ok:true,json:async()=>({sessionId:'s'})};
    if(options.method==='DELETE')return {ok:true,json:async()=>({})};
    const timestampMs=Number(options.headers['X-Timestamp-Ms']),frameId=Number(options.headers['X-Frame-Id']);requests.push(timestampMs);
    await new Promise(r=>{release=r;});return {ok:true,json:async()=>({sessionId:'s',timestampMs,frameId,valid:true,angleDeg:40,rawAngleDeg:40})};
  };
  const estimator=new ImageEstimator(sceneModel(),config,{fetcher,onSample:s=>samples.push(s)});await estimator.start();
  const frame={...camera,data:pixels()};estimator.update(frame,10);estimator.update(frame,20);estimator.update(frame,30);
  assert.deepEqual(requests,[10]);release();await new Promise(setImmediate);assert.deepEqual(requests,[10,30]);
  estimator.reset();release();await estimator.lifecycle;assert.equal(samples.length,1);assert.equal(estimator.pending,null);
});

test('late image session startup is released after cancellation',async()=>{
  let release;const deleted=[];
  const estimator=new ImageEstimator(sceneModel(),config,{fetcher:async(path,options)=>{
    if(options.method==='DELETE'){deleted.push(path);return {ok:true,json:async()=>({})};}
    await new Promise(r=>{release=r;});return {ok:true,json:async()=>({sessionId:'late'})};
  }});
  const starting=estimator.start();await new Promise(setImmediate);estimator.reset();release();await starting;await estimator.lifecycle;
  assert.equal(estimator.token,null);assert.deepEqual(deleted,['/v1/sessions/late']);
});

test('real Python worker serves calibrated v1 model and invalidates scene on camera change',async()=>{
  const motionWorker={pending:null,request:async()=>({velocityDegS:null,rotationVector:[.1,0,0]}),close(){}};
  const api=new LightingServer(root,config,settings,null,{motionWorker});
  try {
    const {sessionId}=await api.create({model:sceneModel(),camera});
    const meta={...camera,camera:{deviceId:'camera-a'},frameId:1,timestampMs:0};
    const result=await api.frame(sessionId,meta,pixels());assert.equal(result.angleDeg,30);assert.equal(result.inference.backend,'cpu');
    await assert.rejects(api.frame(sessionId,meta,pixels()),/increase/);
    const invalid=await api.frame(sessionId,{...meta,frameId:2,timestampMs:100,camera:{deviceId:'camera-b'}},pixels());
    assert.equal(invalid.valid,false);assert.equal(invalid.state,'Invalidated');assert.match(invalid.quality.reason,/Camera configuration changed/);
  }finally{api.close();}
});

test('scene fitting publishes immutable profile from a separate annotation group and preserves base',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'scene-profile-'));const c=structuredClone(config);
  c.annotation.directory=join(temporary,'groups');c.annotation.training.directory=join(temporary,'models');
  const store=new AnnotationStore(root,c),training=new AnnotationTraining(root,c,store),profiles=new ProfileStore(root,c,{directory:join(temporary,'profiles')});
  const scenes=new SceneCalibration(root,c,store,training,profiles);const id=randomUUID(),base=baseModel();
  await mkdir(training.path(id),{recursive:true});await writeFile(join(training.path(id),'model.json'),JSON.stringify(base));
  await writeFile(join(training.path(id),'job.json'),JSON.stringify({jobId:id,state:'READY'}));
  try {
    let group=await store.create({device:'test',lighting:'test scene'});
    for(const [level,angle] of [[30,20.12],[100,60],[190,100]]){
      const saved=await store.append(group.groupId,{...camera,source:'camera',camera,revision:group.revision,capturedAt:1000},pixels(level));
      group=await store.label(group.groupId,saved.sampleId,{revision:saved.group.revision,angleDeg:angle,notes:''});
    }
    group=await store.close(group.groupId,group.revision);const before=await readFile(join(store.path(group.groupId),'group.json'));
    const job=await scenes.start({groupId:group.groupId,revision:group.revision,baseJobId:id});
    await assert.rejects(scenes.start({groupId:group.groupId,revision:group.revision,baseJobId:id}),/already fitting/);
    await scenes.jobs.get(job.jobId).done;const status=scenes.status(job.jobId);assert.equal(status.state,'Ready',status.error);
    const saved=await profiles.export(status.profileId);assert.equal(saved.profile.kind,'scene-calibration');
    assert.equal(saved.model.referenceCount,3);assert.equal(saved.references.samples[0].angleDeg,20.12);
    assert.deepEqual(await readFile(join(store.path(group.groupId),'group.json')),before);
    assert.deepEqual(JSON.parse(await readFile(join(training.path(id),'model.json'))),base);
    await profiles.select(status.profileId);assert.equal(await profiles.selected(),status.profileId);
    const bad=await scenes.start({groupId:group.groupId,revision:group.revision-1,baseJobId:id});await scenes.jobs.get(bad.jobId).done;
    assert.equal(scenes.status(bad.jobId).state,'Failed');
    const cancelled=await scenes.start({groupId:group.groupId,revision:group.revision,baseJobId:id});await scenes.cancel(cancelled.jobId);
    assert.equal(scenes.status(cancelled.jobId).state,'Invalidated');assert.equal((await profiles.list()).profiles.length,1);
  }finally{await scenes.close();await training.close();await rm(temporary,{recursive:true,force:true});}
});
