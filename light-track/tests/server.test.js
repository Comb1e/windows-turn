import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function start(args) {
  const processHandle=spawn(process.execPath,['server.js',...args],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
  const ended=once(processHandle,'exit');
  try {
    const url=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Server did not start')),5000);
      processHandle.once('error',error=>{clearTimeout(timer);reject(error);});
      processHandle.once('exit',()=>{clearTimeout(timer);reject(new Error('Server exited before readiness'));});
      processHandle.stdout.on('data',data=>{const match=String(data).match(/http:\/\/localhost:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
    });
    return {url,close:async()=>{processHandle.kill();await ended;}};
  } catch(error) {processHandle.kill();await ended;throw error;}
}
test('CLI serves only the selected model and preserves preview choices',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'light-track-test-'));
  await writeFile(join(directory,'model.json'),JSON.stringify({test:true}));
  let server;
  try {
    server=await start(['--no-video','--model',join(directory,'model.json')]);
    assert.equal((await (await fetch(server.url+'/runtime-config.json')).json()).showVideo,false);
    assert.deepEqual(await (await fetch(server.url+'/model.json')).json(),{test:true});
    assert.equal((await fetch(server.url+'/data/session.json')).status,404);
    assert.equal((await fetch(server.url+'/package.json')).status,404);
    assert.equal((await fetch(server.url+'/src/features.js')).status,200);
    assert.equal((await fetch(server.url+'/annotate')).status,200);
    assert.equal((await fetch(server.url+'/src/annotation-app.js')).status,200);
    assert.equal((await fetch(server.url+'/annotation.css')).status,200);
    assert.deepEqual((await (await fetch(server.url+'/config.json')).json()).camera,{width:640,height:480,horizontalFovDegrees:60});
    await server.close();server=null;
    server=await start(['--no-video','--video']);
    assert.equal((await (await fetch(server.url+'/runtime-config.json')).json()).showVideo,true);
    assert.equal((await fetch(server.url+'/model.json')).status,404);
  } finally {if(server)await server.close();await rm(directory,{recursive:true,force:true});}
});

test('removed geometry entry points cannot acquire a camera or launch a worker',async()=>{
  const server=await start([]);
  try{
    for(const route of ['start','frame','stop'])for(const method of ['GET','POST']){
      const response=await fetch(server.url+'/tracking/'+route,{method});
      assert.equal(response.status,410);assert.match((await response.json()).error,/screenshot annotations/);
    }
    for(const name of ['collection','recording','geometry','reflection'])assert.equal((await fetch(server.url+'/src/'+name+'.js')).status,404);
    assert.equal((await fetch(server.url+'/annotations/api/groups')).status,200);
  }finally{await server.close();}
});
