import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile,writeFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executable=process.argv[2];
assert.ok(executable,'Pass the native Fusion probe executable');
async function probe(url){
  const child=spawn(executable,[url],{stdio:['pipe','pipe','inherit'],windowsHide:true});
  const ended=once(child,'exit');
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value,'ready');
  return {
    async sample(){child.stdin.write('sample\n');const line=await lines.next();assert.ok(!line.done,'Native probe exited');return JSON.parse(line.value);},
    async until(predicate,reason,timeout=3000){
      const end=performance.now()+timeout;let last;
      do{last=await this.sample();if(predicate(last))return last;await delay(20);}while(performance.now()<end);
      assert.fail(`${reason}: ${JSON.stringify(last)}`);
    },
    async close(){child.stdin.end('quit\n');const [code]=await ended;assert.equal(code,0);}
  };
}
const angle=(sessionId,timestampMs,displayAngleDeg,controllerState='TRACKING')=>({
  sessionId,timestampMs,displayAngleDeg,displayVelocityDegS:0,controllerState
});
async function fixture(snapshot={sessionId:null,displayAngleDeg:null,state:'STOPPED'},{heartbeat=true,port=0}={}){
  const streams=new Set();let requests=0,fragmenting=false;
  const server=createServer((req,res)=>{
    if(req.url==='/api/angle'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(snapshot));}
    else if(req.url==='/api/events'){
      ++requests;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': connected\n\n');
      streams.add(res);req.on('close',()=>streams.delete(res));
    }else{res.writeHead(404);res.end();}
  }).listen(port,'127.0.0.1');await once(server,'listening');
  const timer=heartbeat?setInterval(()=>{if(!fragmenting)for(const res of streams)res.write(': keepalive\n\n');},50):null;
  return {
    url:`http://127.0.0.1:${server.address().port}`,
    port:server.address().port,
    set snapshot(value){snapshot=value;},
    async ready(){for(let i=0;i<150&&!streams.size;++i)await delay(20);assert.ok(streams.size,'SSE subscription missing');},
    event(event,data){for(const res of streams)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);},
    raw(text){for(const res of streams)res.write(text);},
    async fragmented(text,split){
      // A comment is a separate SSE message and cannot be inserted inside JSON.
      fragmenting=true;
      try{this.raw(text.slice(0,split));await delay(30);this.raw(text.slice(split));}
      finally{fragmenting=false;}
    },
    end(){for(const res of streams)res.end();},
    get requests(){return requests;},
    async close(){clearInterval(timer);for(const res of streams)res.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  };
}

test('native Fusion worker delivers a small SSE angle before the stream sends another byte',async()=>{
  const server=await fixture(undefined,{heartbeat:false}),client=await probe(server.url);
  try{
    await server.ready();server.event('angle',angle('first',1,72));
    await client.until(s=>s.valid&&s.fresh&&s.angle===72,'Small live angle was buffered or lost',700);
  }finally{await server.close();await client.close();}
});

test('snapshot establishes connection status; silence and stale controller output never report fresh',async()=>{
  const server=await fixture(angle('live',1,110)),client=await probe(server.url);
  try{
    await client.until(s=>s.valid&&s.fresh&&s.angle===110&&s.status.includes('live angle'),'Snapshot was not shown');
    await client.until(s=>s.valid&&!s.fresh&&s.status.includes('stale'),'Silent angle never became stale');
    server.event('angle',angle('live',2,110,'STALE'));
    await client.until(s=>s.timestampMs===2&&!s.fresh,'Controller stale state was ignored');
    // A complete event can span HTTP chunks, including in the JSON payload.
    const event=`event: angle\r\ndata: ${JSON.stringify(angle('live',3,10))}\r\n\r\n`;
    await server.fragmented(event,30);
    await client.until(s=>s.fresh&&s.angle===10,'Fragmented boundary angle lost or remapped');
    server.event('angle',angle('live',4,120));
    await client.until(s=>s.fresh&&s.angle===120,'Upper boundary angle rejected');
  }finally{await server.close();await client.close();}
});

test('invalid/reordered samples and retired sessions cannot replace a newer angle, including after reconnect',async()=>{
  const server=await fixture(angle('old',100,90)),client=await probe(server.url);
  try{
    await server.ready();await client.until(s=>s.fresh&&s.session==='old','Initial session missing');
    server.event('angle',angle('new',1,70));await client.until(s=>s.session==='new'&&s.angle===70,'New session rejected');
    server.event('angle',angle('new',0,30));server.event('angle',angle('old',101,40));
    server.event('angle',angle('new',2,181));await delay(40);
    let current=await client.sample();assert.equal(current.angle,70);assert.equal(current.timestampMs,1);assert.equal(current.fresh,false);
    server.snapshot=angle('old',200,40);const count=server.requests;server.end();
    await client.until(s=>server.requests>count&&s.session==='new','Stream EOF did not reconnect');
    server.event('angle',angle('old',201,40));await delay(40);assert.equal((await client.sample()).angle,70);
    server.event('angle',angle('new',3,60));await client.until(s=>s.fresh&&s.angle===60,'Reconnect did not resume');
    server.event('stopped',{});await client.until(s=>!s.fresh&&s.status.includes('start camera'),'Stop was not shown');
    server.event('angle',angle('new',4,20));await delay(40);assert.equal((await client.sample()).angle,60);
    server.event('angle',angle('restart',1,85));await client.until(s=>s.fresh&&s.angle===85,'Restarted camera failed');
  }finally{await server.close();await client.close();}
});

test('service can start after the renderer and recover on the same port after disconnection',async()=>{
  let server=await fixture();const {url,port}=server;await server.close();
  const client=await probe(url);
  try{
    await client.until(s=>s.status.includes('reconnecting'),'Unavailable service not reported');
    server=await fixture(angle('first',10,80),{port});
    await client.until(s=>s.fresh&&s.angle===80,'Service start failed',6000);
    await server.close();server=null;
    await client.until(s=>!s.fresh&&s.status.includes('reconnecting')&&s.angle===80,'Disconnect did not hold angle');
    server=await fixture(angle('second',1,50),{port});
    await client.until(s=>s.fresh&&s.angle===50&&s.session==='second','Service restart failed',6000);
  }finally{await server?.close();await client.close();}
});

// Use the real Fusion coordinator and controller. Only its two independent
// measurement services and camera RGBA uploads are simulated.
async function realFusion(){
  const config=JSON.parse(await readFile(new URL('../../fusion/config.json',import.meta.url)));
  const services=[];let child,ended,directory;
  const close=async()=>{
    if(child){child.send({type:'shutdown'});await ended;}
    for(const server of services){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(directory)await rm(directory,{recursive:true,force:true});
  };
  try{
    for(const kind of ['keyboard','lighting']){
      let id=0;const server=createServer(async(req,res)=>{
        for await(const unused of req){} // Drain the same RGBA upload used by the coordinator.
        let value={};
        if(req.url==='/v1/health')value={ready:true,modelReady:true,camera:{width:64,height:64},angleRange:[10,120]};
        else if(req.url==='/v1/sessions')value={sessionId:`${kind}-${++id}`};
        else if(req.url.endsWith('/frames'))value={sessionId:`${kind}-${id}`,valid:true,angleDeg:70,
          frameId:Number(req.headers['x-frame-id']),timestampMs:Number(req.headers['x-timestamp-ms']),motion:{velocityDegS:0}};
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
      }).listen(0,'127.0.0.1');await once(server,'listening');services.push(server);
      config.services[kind]=`http://127.0.0.1:${server.address().port}`;
    }
    config.port=0;directory=await mkdtemp(join(tmpdir(),'hinge-native-fusion-'));
    const path=join(directory,'config.json');await writeFile(path,JSON.stringify(config));
    child=spawn(process.execPath,['server.js','--config',path],{cwd:new URL('../../fusion/',import.meta.url),
      env:{...process.env,PORT:'0'},stdio:['ignore','pipe','inherit','ipc'],windowsHide:true});
    ended=once(child,'exit');
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    const url=(await lines.next()).value.match(/http:\/\/localhost:\d+/)[0].replace('localhost','127.0.0.1');
    const api=async(path,data)=>{
      const response=await fetch(url+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
      assert.equal(response.status,200);return response.json();
    };
    let frame=0;
    return {url,api,close,async upload(session){
      const response=await fetch(url+'/api/frames',{method:'POST',headers:{'Content-Type':'application/octet-stream',
        'X-Session-Id':session.sessionId,'X-Frame-Id':String(++frame),'X-Timestamp-Ms':String(performance.now()),'X-Width':'64','X-Height':'64'},body:Buffer.alloc(64*64*4)});
      assert.equal(response.status,202);
    }};
  }catch(error){await close();throw error;}
}

test('native renderer follows actual Fusion camera start, displayed motion, stale data, stop and restart',async()=>{
  const fusion=await realFusion(),client=await probe(fusion.url);
  try{
    await client.until(s=>!s.valid&&s.status.includes('start camera'),'Camera-stopped connection not recognized');
    let session=await fusion.api('/api/start',{});
    // Stay idle longer than the receive timeout before the first frame arrives.
    await delay(1300);await fusion.upload(session);
    const first=await client.until(s=>s.valid&&s.fresh&&s.session===session.sessionId,'Actual Fusion angle missing',5000);
    assert.ok(first.angle>=70&&first.angle<=120);
    for(let i=0;i<6;++i){await delay(50);await fusion.upload(session);}
    await client.until(s=>s.fresh&&s.angle<first.angle,'Displayed motion never reached native renderer');
    await client.until(s=>s.valid&&!s.fresh&&s.status.includes('stale'),'Actual stale controller state ignored',4000);
    await fusion.api('/api/stop',{sessionId:session.sessionId});
    await client.until(s=>!s.fresh&&s.status.includes('start camera'),'Actual camera stop missed');
    session=await fusion.api('/api/start',{});await fusion.upload(session);
    await client.until(s=>s.fresh&&s.session===session.sessionId,'Actual restarted camera rejected',5000);
    // Starting a second native client after the camera is active must also work.
    const late=await probe(fusion.url);
    try{await late.until(s=>s.fresh&&s.session===session.sessionId,'Already-running camera snapshot missed');}
    finally{await late.close();}
    await fusion.api('/api/stop',{sessionId:session.sessionId});
  }finally{await fusion.close();await client.close();}
});
