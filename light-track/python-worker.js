import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Shared process transport for image prediction and relative motion.
// A timed-out request keeps its slot until the worker responds.
export class PythonWorker {
  constructor(root, config, python, workerScript) {
    this.config=config.tracking; this.root=root;
    const bundled=join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    this.python=python || process.env.LIGHT_TRACK_PYTHON || (existsSync(bundled)?bundled:'python');
    this.workerScript=workerScript;
    this.id=0; this.pending=null; this.worker=null; this.failure=null;
  }
  start() {
    if(this.ready) return this.ready;
    this.ready=new Promise((resolve,reject)=>{
      const child=this.worker=spawn(this.python,['-u',join(this.root,'research',this.workerScript)],{cwd:this.root,stdio:['pipe','pipe','pipe'],windowsHide:true});
      const timer=setTimeout(()=>{this.failure='Python worker startup timed out. Check Python dependencies and restart the server.';reject(new Error(this.failure));},this.config.workerTimeoutMs);
      let stderr='';
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-3000);});
      const fail=error=>{
        clearTimeout(timer); this.failure=error.message;
        reject(error);
        if(this.pending) {clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}
      };
      child.on('error',()=>fail(new Error('Could not launch local Python. Install requirements.txt or set LIGHT_TRACK_PYTHON.')));
      child.stdin.on('error',()=>fail(new Error('Python worker input disconnected. Restart the server.')));
      child.on('exit',()=>fail(new Error(`Python worker exited. Install requirements.txt and restart the server. ${stderr.trim()}`)));
      createInterface({input:child.stdout}).on('line',line=>{
        try {
          const response=JSON.parse(line);
          if(response.ready) {clearTimeout(timer);resolve();return;}
          const pending=this.pending;
          if(!pending || pending.id!==response.id) return;
          clearTimeout(pending.timer); this.pending=null;
          if(response.error) pending.reject(new Error(response.error));
          else pending.resolve(response.result);
        } catch {fail(new Error('Python worker returned an invalid response.'));}
      });
    });
    return this.ready;
  }
  async request(command,data) {
    await this.start();
    if(this.failure) throw new Error(this.failure);
    if(this.pending) throw Object.assign(new Error('Python worker busy; skip this frame.'),{status:409});
    return new Promise((resolve,reject)=>{
      const id=++this.id;
      const timer=setTimeout(()=>{
        // Keep the slot occupied until the actual response arrives. A timeout
        // must not allow another request to overtake the outstanding command.
        reject(new Error('Python worker processing timed out. Waiting for the worker to finish.'));
      },this.config.workerTimeoutMs);
      this.pending={id,resolve,reject,timer};
      this.worker.stdin.write(JSON.stringify({id,command,data})+'\n');
    });
  }
  close() {
    if(this.pending) {clearTimeout(this.pending.timer);this.pending.reject(new Error('Server stopped.'));this.pending=null;}
    this.worker?.stdin.end();
    this.worker?.kill();
  }
}
