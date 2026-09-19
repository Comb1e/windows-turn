import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url)));
async function mock(kind,{sceneVelocity=0}={}){
  const seen=[],anchors=[];let id=0;
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks);
    let result={};res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/health')result={ready:true,modelReady:true,camera:{width:64,height:64},angleRange:[10,44]};
    else if(req.url==='/v1/sessions')result={sessionId:`${kind}-${++id}`};
    else if(req.url.endsWith('/frames')){
      seen.push({bytes,headers:req.headers});const angle=kind==='keyboard'?(bytes[0]===17?25:null):80;
      result={sessionId:`${kind}-${id}`,frameId:Number(req.headers['x-frame-id']),timestampMs:Number(req.headers['x-timestamp-ms']),angleDeg:angle,valid:angle!==null,quality:kind==='keyboard'?{identity:{status:angle===null?'rejected':'accepted',reason:angle===null?'Surface does not identify the laptop':''}}:{},motion:{velocityDegS:sceneVelocity}};
    }else if(req.url.endsWith('/anchors')){anchors.push(JSON.parse(bytes));result={added:true};}
    res.end(JSON.stringify(result));
  }).listen(0,'127.0.0.1');await once(server,'listening');
  return {server,seen,anchors,url:`http://127.0.0.1:${server.address().port}`};
}
async function waitAngle(reader,predicate){
  const decoder=new TextDecoder();let text='';
  for(;;){const {value,done}=await reader.read();if(done)throw new Error('Event stream ended');text+=decoder.decode(value,{stream:true});
    let split;while((split=text.indexOf('\n\n'))>=0){const block=text.slice(0,split);text=text.slice(split+2);if(!block.startsWith('event: angle'))continue;
      const data=JSON.parse(block.split('\ndata: ')[1]);if(predicate(data))return data;}
  }
}
test('coordinator HTTP sends identical RGBA frames and pairs anchors without blocking keyboard output',async()=>{
  const keyboard=await mock('keyboard'),lighting=await mock('lighting',{sceneVelocity:60});
  const directory=await mkdtemp(join(tmpdir(),'hinge-fusion-http-'));
  const path=join(directory,'config.json');await writeFile(path,JSON.stringify({...config,port:0,services:{keyboard:keyboard.url,lighting:lighting.url}}));
  const child=spawn(process.execPath,['server.js','--config',path],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe'],windowsHide:true});
  const ended=once(child,'exit');let reader;
  try{
    const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Coordinator readiness timed out')),5000);
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Coordinator exited'));});child.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/localhost:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
    const json=async(path,data,method='POST')=>{const res=await fetch(url+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(res.status,200,await res.clone().text());return res.json();};
    const session=await json('/api/start',{});assert.equal(session.camera.height,64);
    reader=(await fetch(url+'/api/events',{signal:AbortSignal.timeout(10000)})).body.getReader();
    let id=0;const upload=async level=>{const bytes=Buffer.alloc(64*64*4,level);const timestamp=performance.now();
      const res=await fetch(url+'/api/frames',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Session-Id':session.sessionId,'X-Frame-Id':String(++id),'X-Timestamp-Ms':String(timestamp),'X-Width':'64','X-Height':'64'},body:bytes});assert.equal(res.status,202);};
    await upload(17);const first=await waitAngle(reader,v=>v.authoritative);assert.equal(first.measurementAngleDeg,25);
    // Real HTTP/SSE at the configured 60 Hz: sparse keyboard samples cannot
    // borrow the deliberately conflicting lighting motion between publications.
    for(let i=0;i<4;i++){
      const held=await waitAngle(reader,v=>v.frameId===id&&v.measurementAgeMs>=300);
      assert.equal(held.source,'keyboard');assert.equal(held.targetAngleDeg,25);assert.equal(held.motionSource,'unavailable');
      if(i===3)assert.ok(Math.abs(held.displayAngleDeg-25)<1);
      await upload(17);await waitAngle(reader,v=>v.frameId===id&&v.authoritative);
    }
    const snapshot=await (await fetch(url+'/api/angle')).json();assert.equal(snapshot.targetAngleDeg,25);
    await upload(19);const rejectedFrameId=id;const second=await waitAngle(reader,v=>v.source==='lighting');assert.equal(second.measurementAngleDeg,80);
    assert.equal(second.motionSource,'scene');
    await upload(17);const reacquired=await waitAngle(reader,v=>v.frameId===id&&v.authoritative);
    assert.equal(reacquired.targetAngleDeg,25);assert.equal(reacquired.motionSource,'unavailable');
    assert.ok(keyboard.seen.length>=2);assert.ok(lighting.seen.length>=2);
    for(const frame of keyboard.seen){const other=lighting.seen.find(f=>f.headers['x-frame-id']===frame.headers['x-frame-id']);assert.ok(other);assert.deepEqual(other.bytes,frame.bytes);assert.equal(other.headers['x-timestamp-ms'],frame.headers['x-timestamp-ms']);}
    assert.deepEqual(lighting.anchors[0],{frameId:1,angleDeg:25,source:'keyboard'});
    assert.ok(lighting.anchors.every(anchor=>anchor.frameId!==rejectedFrameId),'Identity-rejected frames must never create adaptation anchors');
    assert.equal((await fetch(url+'/keyboard/config.json')).status,404);
    await json('/api/stop',{sessionId:session.sessionId});
  }finally{await reader?.cancel().catch(()=>{});child.kill();await ended;await Promise.all([keyboard,lighting].map(m=>new Promise(resolve=>m.server.close(resolve))));}
});
