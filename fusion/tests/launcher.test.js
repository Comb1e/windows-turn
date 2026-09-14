import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { specifications, StackLauncher } from '../src/launcher.js';
const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url)));

test('launcher reuses healthy services and stops only its own children',async()=>{
  const available=new Set(['keyboard']),created=[];
  const launcher=new StackLauncher({...config.startup,shutdownTimeoutMs:100},{log(){},probe:async s=>available.has(s.name),spawnProcess(exe){
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.connected=true;
    child.send=message=>{assert.equal(message.type,'shutdown');queueMicrotask(()=>child.emit('exit',0));};
    child.kill=()=>{throw new Error('Graceful IPC shutdown should suffice');};
    created.push(exe);available.add(exe);return child;
  }});
  const specs=['keyboard','lighting','fusion'].map(name=>({name,exe:name,args:[],ipc:true,url:name}));
  const result=await launcher.start(specs);assert.deepEqual(created,['lighting','fusion']);assert.equal(result[0].owned,false);
  await launcher.stop();assert.ok(launcher.children.every(c=>c.exited));assert.ok(available.has('keyboard'));
});
test('occupied or incompatible services fail without spawning replacements',async()=>{
  const server=createServer((req,res)=>res.end('Different application')).listen(0,'127.0.0.1');await once(server,'listening');
  const launcher=new StackLauncher(config.startup,{log(){},spawnProcess(){throw new Error('Must not spawn');}});
  try{await assert.rejects(launcher.ensure({name:'lighting',url:`http://127.0.0.1:${server.address().port}`,path:'/v1/health',matches:()=>true}),/incompatible/);}
  finally{await new Promise(resolve=>server.close(resolve));}
});
test('one startup command launches all real services and shuts down its own process tree', {timeout:45000},async()=>{
  const reserve=async()=>{const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;return {s,port};};
  const ports=await Promise.all([reserve(),reserve(),reserve()]);
  const directory=await mkdtemp(join(tmpdir(),'fusion-startup-')),path=join(directory,'config.json');
  const temporary={...config,port:ports[2].port,services:{keyboard:`http://127.0.0.1:${ports[0].port}`,lighting:`http://127.0.0.1:${ports[1].port}`}};
  await writeFile(path,JSON.stringify(temporary));await Promise.all(ports.map(p=>new Promise(resolve=>p.s.close(resolve))));
  const child=spawn(process.execPath,['start.js','--config',path],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:''},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  const ended=once(child,'exit');let output='';child.stderr.on('data',chunk=>{output+=chunk;});
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(output||'Readiness timed out')),25000);
      child.once('exit',()=>{clearTimeout(timer);reject(new Error(output||'Launcher exited'));});
      child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('All services ready.')){clearTimeout(timer);resolve();}});
    });
    const health=await (await fetch(`http://localhost:${temporary.port}/api/health`)).json();
    assert.equal(health.services.keyboard.service,'keyboard');assert.equal(health.services.lighting.service,'lighting');
    child.send({type:'shutdown'});const [code]=await ended;assert.equal(code,0,output);
    for(const p of ports)await assert.rejects(fetch(`http://127.0.0.1:${p.port}/v1/health`));
  }finally{if(child.exitCode===null){child.send({type:'shutdown'},()=>{});await ended;}}
});
