import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { infer } from '../../light-track/src/model.js';
import { LightingServer } from '../../light-track/lighting-server.js';
import { sweep } from '../research/sweep-fixture.mjs';

test('Fusion sweep trains through Light Track, saves a profile and restores it in a new session', {timeout:90000},async()=>{
  const root=fileURLToPath(new URL('../../light-track/',import.meta.url));
  const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url)));
  const lightConfig=JSON.parse(await readFile(join(root,'config.json'))),settings=JSON.parse(await readFile(join(root,'service-config.json')));
  const keyboardModel={modelId:'keyboard-fixture',angleRange:[10,46]};
  const temporary=await mkdtemp(join(tmpdir(),'fusion-sweep-api-')),rows=new Map();let keyboardSession=0,currentMotion={};
  const worker={pending:null,request:async command=>command==='reset'?{}:currentMotion,close(){}};
  const light=new LightingServer(root,lightConfig,{...settings,maxBodyBytes:640*480*4+100,profiles:{...settings.profiles,directory:join(temporary,'profiles')}},null,{motionWorker:worker});
  const lighting=createServer((req,res)=>light.handle(req,res)).listen(0,'127.0.0.1');await once(lighting,'listening');
  const keyboard=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    let result={};
    if(req.url==='/v1/health')result={ready:true,camera:config.camera,...keyboardModel};
    else if(req.url==='/v1/sessions')result={sessionId:'keyboard-'+(++keyboardSession),...keyboardModel};
    else if(req.url.endsWith('/frames')){const id=Number(req.headers['x-frame-id']),row=rows.get(id);result={...row.keyboard,sessionId:'keyboard-'+keyboardSession,quality:{}};}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
  }).listen(0,'127.0.0.1');await once(keyboard,'listening');
  config.port=0;config.services={keyboard:`http://127.0.0.1:${keyboard.address().port}`,lighting:`http://127.0.0.1:${lighting.address().port}`};config.calibration.jobPollMs=50;
  const configFile=join(temporary,'config.json');await writeFile(configFile,JSON.stringify(config));
  const child=spawn(process.execPath,['server.js','--config',configFile],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe'],windowsHide:true});
  const ended=once(child,'exit');let reader,session,output='';child.stderr.on('data',chunk=>{output+=chunk;});
  try{
    const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Fusion startup timeout: '+output)),5000);child.stdout.on('data',chunk=>{const m=String(chunk).match(/http:\/\/localhost:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});});
    const api=async(path,data,method='POST')=>{const res=await fetch(url+path,{method,headers:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify({sessionId:session?.sessionId,...data})});assert.equal(res.status,200,await res.clone().text());return res.json();};
    reader=(await fetch(url+'/api/events',{signal:AbortSignal.timeout(85000)})).body.getReader();let buffer='';const decoder=new TextDecoder();
    async function event(predicate){for(;;){let split;while((split=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,split);buffer=buffer.slice(split+2);const match=block.match(/^event: (.+)\ndata: (.+)$/);if(match){const value=JSON.parse(match[2]);if(predicate(match[1],value))return value;}}const {value,done}=await reader.read();if(done)throw new Error('Event stream ended');buffer+=decoder.decode(value,{stream:true});}}
    async function upload(row){
      rows.set(row.keyboard.frameId,row);currentMotion=row.lighting.motion;
      const bytes=Buffer.alloc(640*480*4),base=Math.round(40+row.angle);
      for(let i=0;i<bytes.length;i+=4){const v=base+(i%8?25:0);bytes[i]=bytes[i+1]=bytes[i+2]=v;bytes[i+3]=255;}
      const res=await fetch(url+'/api/frames',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Session-Id':session.sessionId,
        'X-Frame-Id':String(row.keyboard.frameId),'X-Timestamp-Ms':String(row.keyboard.timestampMs),'X-Width':'640','X-Height':'480'},body:bytes});assert.equal(res.status,202,await res.text());
      const seen=new Set();await event((type,v)=>{if(type==='service'&&v.result.frameId===row.keyboard.frameId)seen.add(v.kind);return seen.size===2;});
    }
    session=await api('/api/start',{});
    await upload({angle:18,keyboard:{frameId:0,timestampMs:0,angleDeg:18,valid:true},lighting:{motion:{}}});
    await api('/api/calibration',{metadata:{device:'synthetic-test-laptop',location:'software-fixture',position:'desk',lighting:'synthetic',display:'fixed',name:'Software fixture only'}});
    const frames=sweep({keyboardMax:46}).frames;
    for(const input of frames){
      const row=structuredClone(input);row.keyboard.timestampMs+=100;row.lighting.motion.fromTimestampMs+=100;
      await upload(row);if(row.state==='TRAINING')break;
    }
    const ready=await event((type,v)=>type==='calibration'&&['READY','RETRY'].includes(v.state));assert.equal(ready.state,'READY',ready.reason);
    const profiles=await api('/api/profiles',null,'GET');assert.equal(profiles.profiles.length,1);assert.equal(profiles.selectedProfileId,ready.job.profileId);
    const exported=await api(`/api/profiles/${ready.job.profileId}/export`,null,'GET');
    for(let i=0;i<exported.parity.features.length;i++)assert.ok(Math.abs(infer(exported.model,exported.parity.features[i]).raw-exported.parity.predictions[i])<1e-8);
    assert.equal(exported.model.trainingMode,'provisional-sweep');assert.equal(exported.model.validation.passed,false);
    assert.ok(exported.profile.coverage[0]<25);assert.equal(exported.profile.coverage[1],120);assert.ok(exported.recording.fusion);
    assert.ok(exported.recording.records.some(r=>r.label?.source==='constant-speed-inferred'));
    assert.deepEqual(exported.sweep.keyboardModel,keyboardModel);
    assert.deepEqual(exported.recording.keyboardModel,keyboardModel);
    assert.deepEqual(exported.profile.keyboardLabelValidation,exported.report.keyboardLabelValidation);
    assert.deepEqual(exported.profile.keyboardLabelValidation.angleRange,[10,46]);
    assert.equal(exported.profile.keyboardLabelValidation.modelId,keyboardModel.modelId);
    for(const row of frames.filter(r=>r.keyboard.valid&&r.keyboard.angleDeg>44)){
      const record=exported.recording.records.find(r=>r.frameId===row.keyboard.frameId);
      assert.equal(record.label.source,'keyboard');assert.equal(record.label.angle,row.keyboard.angleDeg);
    }
    await api('/api/stop',{});session=await api('/api/start',{});assert.equal(session.profileId,ready.job.profileId);
    await upload({angle:20,keyboard:{frameId:0,timestampMs:0,angleDeg:20,valid:true},lighting:{motion:{}}});
    assert.equal(light.session.profileId,ready.job.profileId);assert.equal(light.session.adapter.origin,'model-output');
    await api('/api/stop',{});
  }finally{await reader?.cancel().catch(()=>{});child.kill();await ended;light.close();await Promise.all([lighting,keyboard].map(s=>new Promise(resolve=>s.close(resolve))));}
});
