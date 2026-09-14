import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function specifications(config,root,configPath,{model,python}={}){
  const settings=config.startup;
  const keyboardRoot=resolve(root,settings.keyboardDirectory),lightingRoot=resolve(root,settings.lightingDirectory);
  const localPort=url=>{
    const u=new URL(url);
    if(u.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!Number(u.port))throw new Error('Startup requires explicit local HTTP service ports');
    return u.port;
  };
  const keyboardPython=python||process.env.KEYBOARD_PYTHON||join(keyboardRoot,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(!existsSync(keyboardPython))throw new Error(`Keyboard Python not found at ${keyboardPython}. Set KEYBOARD_PYTHON to its executable.`);
  const port=Number(process.env.PORT||config.port);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Choose a fixed Fusion port between 1 and 65535 for the launcher');
  const environment={...process.env};delete environment.PORT;
  return [
    {name:'keyboard',url:config.services.keyboard,path:'/v1/health',exe:keyboardPython,cwd:keyboardRoot,
      args:['-m','keyboard_hinge','serve','--port',localPort(config.services.keyboard)],env:environment,
      matches:value=>value.service==='keyboard'&&value.ready&&value.version===1},
    {name:'lighting',url:config.services.lighting,path:'/v1/health',exe:process.execPath,cwd:lightingRoot,ipc:true,
      args:['server.js',...(model?['--model',resolve(root,model)]:[])],env:{...environment,PORT:localPort(config.services.lighting)},
      matches:value=>value.service==='lighting'&&value.ready&&value.version===1},
    {name:'fusion',url:`http://localhost:${port}`,path:'/api/health',exe:process.execPath,cwd:root,ipc:true,
      args:['server.js','--config',configPath],env:{...environment,PORT:String(port)},
      matches:value=>value.service==='fusion'&&value.version===1&&Object.entries(config.services).every(([key,url])=>value.config?.services?.[key]===url)}
  ];
}

/** Own only processes created here. Existing healthy services remain independent. */
export class StackLauncher {
  constructor(settings,{log=console.log,spawnProcess=spawn,probe,onStopped=()=>{}}={}){
    this.c=settings;this.log=log;this.spawn=spawnProcess;this.probeOverride=probe;this.onStopped=onStopped;this.children=[];this.stopping=false;
  }
  async probe(spec){
    if(this.probeOverride)return this.probeOverride(spec);
    let response;
    try{response=await fetch(new URL(spec.path,spec.url),{signal:AbortSignal.timeout(this.c.probeTimeoutMs)});}
    catch(error){
      if(error.cause?.code==='ECONNREFUSED'||error.cause?.errors?.every(e=>e.code==='ECONNREFUSED'))return false;
      throw new Error(`${spec.name}: cannot check ${spec.url}: ${error.message}`);
    }
    const value=await response.json().catch(()=>null);
    if(!response.ok||!value||!spec.matches(value))throw new Error(`${spec.url} is occupied by an incompatible service. Stop or reconfigure that service.`);
    return true;
  }
  async ensure(spec){
    if(await this.probe(spec)){this.log(`Using existing ${spec.name} service at ${spec.url}`);return {name:spec.name,owned:false,url:spec.url};}
    if(this.stopping)throw new Error('Startup cancelled');
    const child=this.spawn(spec.exe,spec.args,{cwd:spec.cwd,env:spec.env,stdio:['ignore','pipe','pipe',...(spec.ipc?['ipc']:[])],windowsHide:true});
    const entry={spec,child,exited:false,error:null};this.children.push(entry);
    entry.done=new Promise(resolve=>{
      child.once('error',error=>{entry.error=error;entry.exited=true;resolve();});
      child.once('exit',(code,signal)=>{
        entry.exited=true;resolve();
        if(this.ready&&!this.stopping){this.log(`${spec.name} exited (${code??signal}); stopping services started by this launcher.`);this.failed=true;void this.stop();}
      });
    });
    child.stdout.on('data',chunk=>this.log(`[${spec.name}] ${String(chunk).trimEnd()}`));
    child.stderr.on('data',chunk=>{entry.stderr=(entry.stderr||'').concat(String(chunk)).slice(-3000);this.log(`[${spec.name}] ${String(chunk).trimEnd()}`);});
    const deadline=Date.now()+this.c.readyTimeoutMs;let pause=this.c.initialProbeMs;
    for(;;){
      if(entry.exited)throw new Error(`${spec.name} failed to start: ${entry.error?.message||entry.stderr||'process exited'}`);
      if(this.stopping)throw new Error('Startup cancelled');
      if(await this.probe(spec))return {name:spec.name,owned:true,url:spec.url};
      if(Date.now()>=deadline)throw new Error(`${spec.name} did not become ready within ${this.c.readyTimeoutMs/1000} seconds`);
      await delay(pause);pause=Math.min(this.c.maxProbeMs,pause*2);
    }
  }
  async start(specs){
    try{
      // A running coordinator can own active sessions. Validate it before starting dependencies.
      const existingFusion=await this.probe(specs[2]);
      const dependencies=await Promise.allSettled(specs.slice(0,2).map(spec=>this.ensure(spec)));
      const failed=dependencies.find(r=>r.status==='rejected');if(failed)throw failed.reason;
      const fusion=existingFusion?{name:'fusion',owned:false,url:specs[2].url}:await this.ensure(specs[2]);
      this.ready=true;this.log(`All services ready. Open ${fusion.url}`);
      return [...dependencies.map(r=>r.value),fusion];
    }catch(error){await this.stop();throw error;}
  }
  stop(){
    if(this.shutdown)return this.shutdown;
    this.stopping=true;
    this.shutdown=(async()=>{
      for(const entry of [...this.children].reverse()){
        if(entry.exited)continue;
        if(entry.spec.ipc&&entry.child.connected)entry.child.send({type:'shutdown'},()=>{});
        else entry.child.kill('SIGTERM');
        const controller=new AbortController();
        await Promise.race([entry.done,delay(this.c.shutdownTimeoutMs,null,{signal:controller.signal}).then(()=>{
          if(!entry.exited)entry.child.kill('SIGKILL');
        }).catch(()=>{})]);controller.abort();
        await entry.done;
      }
      this.onStopped(this.failed===true);
    })();return this.shutdown;
  }
}
