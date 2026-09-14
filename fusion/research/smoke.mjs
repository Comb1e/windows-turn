// Runs all three real services on temporary ports with synthetic frames.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('..',import.meta.url)),workspace=resolve(root,'..'),output=join(root,'data','smoke');
await mkdir(output,{recursive:true});
const children=[];
function spawnProcess(exe,args,cwd,env={}){
  const child=spawn(exe,args,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe'],windowsHide:true});
  const ended=once(child,'exit');children.push({child,ended});let stderr='';child.stderr.on('data',v=>{stderr+=v;});
  return {child,ended,error:()=>stderr};
}
async function ready(exe,args,cwd,env){
  const process=spawnProcess(exe,args,cwd,env);
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Readiness timeout: ${process.error()}`)),20000);
    process.child.once('error',error=>{clearTimeout(timer);reject(error);});process.child.once('exit',()=>{clearTimeout(timer);reject(new Error(process.error()||'Service exited'));});
    process.child.stdout.on('data',value=>{const match=String(value).match(/http:\/\/(?:localhost|127\.0\.0\.1):\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
  return url;
}
try{
  const python=process.env.KEYBOARD_PYTHON||join(workspace,'keyboard','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const generator=spawnProcess(python,[join(root,'research','make_smoke_fixture.py'),output],workspace);
  const [code]=await generator.ended;if(code!==0)throw new Error(generator.error());
  const lightConfig=JSON.parse(await readFile(join(workspace,'light-track','config.json')));
  const {featureNames}=await import(new URL('../../light-track/src/features.js',import.meta.url));const names=featureNames(lightConfig.features);
  const model={version:1,featureVersion:1,featureConfig:lightConfig.features,featureNames:names,angleRange:[10,120],
    normalization:{mean:names.map(()=>0),scale:names.map(()=>1)},trees:[[[-1,0,-1,-1,80]]],filter:lightConfig.filter,
    calibration:{residual95:30,distance95:100,spread95:10},validation:{passed:false,realData:false},coverage:{synthetic:true}};
  await writeFile(join(output,'lighting-model.json'),JSON.stringify(model));
  const keyboard=await ready(python,['-m','keyboard_hinge','--config',join(output,'keyboard-config.json'),'serve','--port','0','--model',join(output,'keyboard-model.json')],join(workspace,'keyboard'));
  const lighting=await ready(process.execPath,['server.js','--model',join(output,'lighting-model.json')],join(workspace,'light-track'),{PORT:'0'});
  const config=JSON.parse(await readFile(join(root,'config.json')));config.port=0;config.services={keyboard,lighting};
  await writeFile(join(output,'fusion-config.json'),JSON.stringify(config));
  const fusion=await ready(process.execPath,['server.js','--config',join(output,'fusion-config.json')],root);
  const call=async(path,data,method='POST')=>{const response=await fetch(fusion+path,{method,headers:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(data)});
    const body=await response.json();assert.ok(response.ok,JSON.stringify(body));return body;};
  const session=await call('/api/start',{profileId:null});const sid=session.sessionId;let frameId=0;
  const hidden=await readFile(join(output,'hidden.rgba')),visible=await readFile(join(output,'visible.rgba'));
  const feed=async(bytes,count)=>{for(let i=0;i<count;i++){
    const response=await fetch(fusion+'/api/frames',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Session-Id':sid,'X-Frame-Id':String(++frameId),
      'X-Timestamp-Ms':String(performance.now()),'X-Width':'640','X-Height':'480'},body:bytes});assert.equal(response.status,202);
    await new Promise(resolve=>setTimeout(resolve,80));
  }};
  await feed(hidden,40);const initial=await call('/api/angle',null,'GET');assert.equal(initial.source,'lighting');assert.equal(initial.measurementAngleDeg,80);
  await call('/api/recording',{sessionId:sid,timestampMs:performance.now(),epochMs:Date.now(),metadata:{device:'SYNTHETIC-SOFTWARE-SMOKE',location:'synthetic',position:'fixed',lighting:'rendered',display:'none'}});
  await call('/api/checkpoint',{sessionId:sid,timestampMs:performance.now(),angleDeg:25});
  await feed(visible,35);const key=await call('/api/angle',null,'GET');assert.equal(key.source,'keyboard');assert.ok(Math.abs(key.measurementAngleDeg-25)<.5);
  await feed(hidden,12);const fallback=await call('/api/angle',null,'GET');assert.equal(fallback.source,'lighting');assert.ok(Math.abs(fallback.measurementAngleDeg-25)<1);
  await call('/api/recording',{sessionId:sid},'DELETE');
  const recording=await call('/api/recording',null,'GET');recording.source='synthetic';await writeFile(join(output,'recording.json'),JSON.stringify(recording));
  assert.ok(recording.records.some(r=>r.label?.source==='keyboard'));assert.ok(recording.fusion.timeline.length>0);
  const {replay}=await import('./replay.mjs');const {SessionAdapter}=await import(new URL('../../light-track/src/adaptation.js',import.meta.url));
  const report=await replay(recording,SessionAdapter);await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
  assert.equal(report.speedBoundViolations,0);
  await call('/api/stop',{sessionId:sid});
  console.log(JSON.stringify({initialAngle:initial.measurementAngleDeg,keyboardAngle:key.measurementAngleDeg,fallbackAngle:fallback.measurementAngleDeg,
    anchors:fallback.adaptation.anchorCount,recordedFrames:recording.records.length,displaySamples:recording.fusion.timeline.length,
    speedBoundViolations:report.speedBoundViolations,hardwareAccuracyValidated:false,output},null,2));
}finally{
  for(const {child} of children.reverse())if(child.exitCode===null)child.kill();
  await Promise.allSettled(children.map(p=>p.ended));
}
