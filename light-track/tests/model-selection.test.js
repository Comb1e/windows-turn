import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { annotationModels, validateLightingArtifact, readLightingFile } from '../src/model-selection.js';
import { featureNames } from '../src/features.js';

const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url)));
const oldId='00000000-0000-4000-8000-000000000001',newId='00000000-0000-4000-8000-000000000002',freshId='00000000-0000-4000-8000-000000000003';
const job=(jobId,completedAt,state='READY')=>({jobId,state,createdAt:'2026-09-01T00:00:00Z',completedAt,coverage:{device:'laptop',screenshots:11}});
function model(angle,capture=config.camera) {
  const names=featureNames(config.features);
  return {version:1,featureVersion:1,trainingMode:'screenshot-groups',featureNames:names,featureConfig:config.features,
    normalization:{mean:names.map(()=>0),scale:names.map(()=>1)},angleRange:[10,120],trees:[[[-1,0,-1,-1,angle]]],
    filter:config.filter,calibration:{residual95:5,distance95:100,spread95:1},validation:{passed:false},capture,coverage:{device:'laptop'}};
}

test('annotation defaults use the newest successful completion, excluding failed, pending and malformed entries',()=>{
  const jobs=[job(oldId,'2026-09-15T11:00:00Z'),job(freshId,'2026-09-17T10:00:00Z','FAILED'),
    job(newId,'2026-09-16T11:00:00Z'),job('pending','2026-09-18T00:00:00Z','RUNNING'),job('../../config','2026-09-19T00:00:00Z')];
  jobs[0].createdAt='2026-09-16T12:00:00Z';
  assert.deepEqual(annotationModels(jobs).map(m=>m.id),[newId,oldId]);
  assert.equal(annotationModels(jobs)[0].url,`/annotations/api/training/${newId}/model`);
  assert.deepEqual(annotationModels([]),[]);
});

test('local model files validate feature schema, capture geometry and configured size before use',async()=>{
  const valid=model(42), text=JSON.stringify(valid);
  assert.equal((await readLightingFile({size:text.length,text:async()=>text},config)).trees[0][0][4],42);
  await assert.rejects(readLightingFile({size:config.modelSelection.maxBytes+1,text:async()=>{throw new Error('Must not read oversized file');}},config),/exceeds/);
  await assert.rejects(readLightingFile({size:10,text:async()=>'{broken'},config),/JSON|property/);
  assert.throws(()=>validateLightingArtifact({...valid,featureVersion:999},config),/feature schema/);
  assert.throws(()=>validateLightingArtifact({...valid,capture:{...config.camera,width:0}},config),/camera settings/);
});

test('live page defaults to newest annotation, switches safely, refreshes, and opens local model files without a restart',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8'), elements=new Map();
  let jobs=[job(oldId,'2026-09-15T00:00:00Z'),job(newId,'2026-09-16T00:00:00Z')],animation,now=0,requests=[],cameraRequests=[];
  const models=new Map([[oldId,model(25,{width:640,height:360,horizontalFovDegrees:65})],[newId,model(75)],[freshId,model(95)]]);
  class Element {
    constructor(){Object.assign(this,{value:'',textContent:'',hidden:false,disabled:false,checked:false,listeners:{},style:{},classList:{toggle(){}},parentElement:{style:{}},files:[],options:[]});}
    addEventListener(name,fn){this.listeners[name]=fn;} setAttribute(){} replaceChildren(...options){this.options=options;}
    click(){return this.listeners.click?.();} get valueAsNumber(){return this.value===''?NaN:Number(this.value);}
    async play(){} getContext(){return context;}
  }
  const context={clearRect(){},drawImage(){},save(){},restore(){},scale(){},beginPath(){},arc(){},stroke(){},strokeRect(){},
    getImageData(x,y,width,height){return {width,height,data:new Uint8ClampedArray(width*height*4).fill(100)};}};
  for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],new Element());
  const $=id=>elements.get(id), video=$('video'); Object.assign(video,{videoWidth:640,videoHeight:480,readyState:2,currentTime:0});
  const track={getSettings:()=>({width:video.videoWidth,height:video.videoHeight}),stop(){},addEventListener(){}};
  const replacements={document:{hidden:false,getElementById:$,createElement:()=>new Element(),addEventListener(){}},window:{addEventListener(){}},
    performance:{now:()=>now,timeOrigin:0},Option:class {constructor(label,value){this.label=label;this.value=value;}},
    navigator:{mediaDevices:{getUserMedia:async constraints=>{cameraRequests.push(constraints);video.videoWidth=constraints.video.width.exact;video.videoHeight=constraints.video.height.exact;return {getVideoTracks:()=>[track],getTracks:()=>[track]};},enumerateDevices:async()=>[]}},
    requestAnimationFrame:fn=>{animation=fn;return 1;},cancelAnimationFrame:()=>{animation=null;},setInterval:()=>1,setTimeout:()=>1,
    fetch:async (url,options={})=>{
      requests.push(url);let data,status=200;
      if(url==='config.json')data=config;
      else if(url==='runtime-config.json')data={showVideo:false,geometricTracking:true};
      else if(url==='/annotations/api/training')data=jobs;
      else if(url==='model.json')data=model(60);
      else if(url==='/v1/sessions')data={sessionId:'image-session'};
      else if(url==='/v1/sessions/image-session/frames')data={sessionId:'image-session',frameId:Number(options.headers['X-Frame-Id']),timestampMs:Number(options.headers['X-Timestamp-Ms']),angleDeg:65,rawAngleDeg:65,valid:true,inference:{backend:'cuda',processingMs:10}};
      else if(url==='/v1/sessions/image-session'&&options.method==='DELETE')data={stopped:true};
      else {const id=url.split('/').at(-2);data=models.get(id);if(!data)status=404;}
      return {ok:status===200,status,json:async()=>structuredClone(data)};
    },
  };
  const originals=Object.fromEntries(Object.keys(replacements).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const settle=()=>new Promise(setImmediate), choose=async value=>{$('model-choice').value=value;await $('model-choice').listeners.change();};
  const frame=()=>{now+=100;video.currentTime+=.1;animation(now);};
  try {
    for(const [key,value] of Object.entries(replacements))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    await import('../src/app.js?model-selection');await settle();
    assert.equal($('model-choice').value,'latest');assert.equal(elements.has('estimation-method'),false);
    assert.equal(requests.at(-1),`/annotations/api/training/${newId}/model`);
    await $('start').click();frame();assert.equal($('angle').textContent,'75.0°');assert.equal($('model-choice').disabled,true);
    assert.equal($('model-file').disabled,true);assert.equal($('refresh-models').disabled,true);
    $('stop').click();await choose(oldId);assert.equal($('angle').textContent,'—');
    await $('start').click();assert.equal(cameraRequests.at(-1).video.height.exact,360);frame();assert.equal($('angle').textContent,'25.0°');$('stop').click();
    jobs.push(job(freshId,'2026-09-17T00:00:00Z'));await $('refresh-models').click();assert.equal($('model-choice').value,oldId);
    await choose('latest');await $('start').click();frame();assert.equal($('angle').textContent,'95.0°');$('stop').click();
    const previousRequests=requests.length, uploaded=JSON.stringify(model(42));
    $('model-file').files=[{name:'my-model.json',size:uploaded.length,text:async()=>uploaded}];await $('model-file').listeners.change();
    assert.equal(requests.length,previousRequests);assert.equal($('model-choice').value,'file');
    await $('start').click();frame();assert.equal($('angle').textContent,'42.0°');$('stop').click();
    $('model-file').files=[{name:'invalid.json',size:2,text:async()=>'{}'}];await $('model-file').listeners.change();
    assert.match($('model-status').textContent,/feature schema/);assert.equal($('model-choice').value,'file');
    await $('start').click();frame();assert.equal($('angle').textContent,'42.0°');$('stop').click();
    models.set(freshId,{});await choose('latest');assert.match($('model-status').textContent,/feature schema/);
    assert.equal($('model-choice').value,'file');models.set(freshId,model(95));
    // A fresh page selects latest again, even after a manual choice in the old page.
    await import('../src/app.js?model-selection-reload');await settle();assert.equal($('model-choice').value,'latest');
    await $('start').click();frame();assert.equal($('angle').textContent,'95.0°');$('stop').click();
    const base={...model(60),modelId:'image-base'};
    const scene={version:2,kind:'scene-calibrated-model',modelId:'scene',baseModelId:base.modelId,baseModel:base,capture:base.capture,
      angleRange:base.angleRange,referenceRange:[20,100],referenceCount:3,calibrationFit:{kind:'affine',a:1,b:5},filter:base.filter,calibration:base.calibration};
    const serialized=JSON.stringify(scene);$('model-file').files=[{name:'scene.json',size:serialized.length,text:async()=>serialized}];
    await $('model-file').listeners.change();await $('start').click();await settle();frame();await settle();
    assert.equal($('angle').textContent,'65.0°');assert.match($('raw-angle').textContent,/cuda.*10\.0 ms/);
    $('toggle-video').click();frame();await settle();assert.equal($('angle').textContent,'65.0°');
    $('stop').click();await settle();assert.equal($('angle').textContent,'—');
  } finally {
    for(const [key,descriptor] of Object.entries(originals)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  }
});
