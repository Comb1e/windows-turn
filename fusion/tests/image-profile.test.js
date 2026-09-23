import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile,writeFile,mkdir,mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { LightingServer } from '../../light-track/lighting-server.js';
import { featureNames } from '../../light-track/src/features.js';

test('Fusion selects a scene image profile, receives worker angles, and preserves keyboard target priority',{timeout:30000},async()=>{
  const root=fileURLToPath(new URL('../../light-track/',import.meta.url)),temporary=await mkdtemp(join(tmpdir(),'fusion-image-profile-'));
  const lightConfig=JSON.parse(await readFile(join(root,'config.json'))),settings=JSON.parse(await readFile(join(root,'service-config.json')));
  const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url)));config.camera={...config.camera,width:64,height:64};
  const camera={width:64,height:64,horizontalFovDegrees:60},names=featureNames(lightConfig.features);
  const base={version:1,modelId:'fixture-base',featureVersion:1,trainingMode:'screenshot-groups',featureNames:names,featureConfig:lightConfig.features,
    capture:camera,angleRange:[10,120],normalization:{mean:names.map(()=>0),scale:names.map(()=>1)},trees:[[[-1,0,-1,-1,75]]],
    filter:lightConfig.filter,calibration:{residual95:20,distance95:10,spread95:10},validation:{passed:false}};
  const model={version:2,kind:'scene-calibrated-model',modelId:'fixture-scene',baseModel:base,baseModelId:base.modelId,capture:camera,
    angleRange:[10,120],referenceRange:[20,100],referenceCount:3,calibrationFit:{kind:'affine',a:1,b:5},filter:base.filter,calibration:base.calibration};
  const profileId='00000000-0000-4000-8000-000000000014',directory=join(temporary,'profiles',profileId);await mkdir(directory,{recursive:true});
  for(const [name,data] of Object.entries({model,profile:{profileId,kind:'scene-calibration',name:'Test image scene',createdAt:new Date().toISOString(),metadata:{device:'test',location:'fixture'},capture:camera,coverage:[20,100]},references:{fixture:true},report:{fixture:true}}))await writeFile(join(directory,name+'.json'),JSON.stringify(data));
  const motion={pending:null,request:async()=>({velocityDegS:0,rotationVector:[0,0,0]}),close(){}};
  const light=new LightingServer(root,lightConfig,{...settings,profiles:{directory:join(temporary,'profiles')}},null,{motionWorker:motion});
  const lighting=createServer((req,res)=>light.handle(req,res)).listen(0,'127.0.0.1');await once(lighting,'listening');
  let keyboardVisible=false;
  const keyboard=createServer(async(req,res)=>{
    for await(const chunk of req){}let result={};
    if(req.url==='/v1/health')result={ready:true,camera,angleRange:[10,46],modelId:'keyboard-fixture'};
    else if(req.url==='/v1/sessions')result={sessionId:'keyboard-session',camera,angleRange:[10,46],modelId:'keyboard-fixture'};
    else if(req.url.endsWith('/frames'))result={sessionId:'keyboard-session',frameId:Number(req.headers['x-frame-id']),timestampMs:Number(req.headers['x-timestamp-ms']),valid:keyboardVisible,angleDeg:keyboardVisible?25:null,quality:{}};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
  }).listen(0,'127.0.0.1');await once(keyboard,'listening');
  config.port=0;config.services={keyboard:`http://127.0.0.1:${keyboard.address().port}`,lighting:`http://127.0.0.1:${lighting.address().port}`};
  const path=join(temporary,'config.json');await writeFile(path,JSON.stringify(config));
  const child=spawn(process.execPath,['server.js','--config',path],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe'],windowsHide:true});
  const ended=once(child,'exit');let reader,session;let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
  try{
    const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Fusion readiness timeout: '+errors)),5000);child.stdout.on('data',chunk=>{const found=String(chunk).match(/http:\/\/localhost:\d+/);if(found){clearTimeout(timer);resolve(found[0]);}});});
    const api=async(path,data,method='POST')=>{const response=await fetch(url+path,{method,headers:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify({...data,sessionId:session?.sessionId})});assert.equal(response.status,200,await response.clone().text());return response.json();};
    const profiles=await api('/api/profiles',null,'GET');assert.equal(profiles.profiles[0].profileId,profileId);
    await api('/api/profile',{profileId});session=await api('/api/start',{});assert.equal(session.profileId,profileId);
    reader=(await fetch(url+'/api/events',{signal:AbortSignal.timeout(20000)})).body.getReader();let buffer='';const decoder=new TextDecoder();
    async function event(predicate){for(;;){let split;while((split=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,split);buffer=buffer.slice(split+2);const match=block.match(/^event: (.+)\ndata: (.+)$/);if(match){const value=JSON.parse(match[2]);if(predicate(match[1],value))return value;}}const result=await reader.read();if(result.done)throw new Error('SSE ended');buffer+=decoder.decode(result.value,{stream:true});}}
    let id=0;const bytes=Buffer.from(Array.from({length:64*64*4},(_,i)=>i%4===3?255:80+((i>>2)%2)*50));
    async function upload(){const response=await fetch(url+'/api/frames',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Session-Id':session.sessionId,'X-Frame-Id':String(++id),'X-Timestamp-Ms':String(performance.now()),'X-Width':'64','X-Height':'64'},body:bytes});assert.equal(response.status,202);}
    await upload();const received=await event((type,v)=>type==='service'&&v.kind==='lighting');assert.equal(received.result.rawAngleDeg,80);assert.equal(received.result.inference.backend,'cpu');
    await upload();const fallback=await event((type,v)=>type==='angle'&&v.source==='lighting'&&v.frameId===id);assert.equal(fallback.measurementAngleDeg,80);
    keyboardVisible=true;await upload();const authoritative=await event((type,v)=>type==='angle'&&v.authoritative&&v.frameId===id);
    assert.equal(authoritative.targetAngleDeg,25);assert.equal(authoritative.measurementAngleDeg,25);
    const exported=await api(`/api/profiles/${profileId}/export`,null,'GET');assert.equal(exported.profile.kind,'scene-calibration');assert.equal(exported.model.version,2);
    await api('/api/stop',{});
  }finally{await reader?.cancel().catch(()=>{});child.kill();await ended;light.close();await Promise.all([lighting,keyboard].map(s=>new Promise(r=>s.close(r))));await rm(temporary,{recursive:true,force:true});}
});
