import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { temporal } from './metrics.mjs';
import { DisplayController } from '../src/controller.js';
const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url)));

export function validateController(){
  const scenarios=[];
  function run(name,initial,sample,duration=16000){
    const c=new DisplayController({...config.display,initialAngle:initial}),rows=[],corrections=[];let last=null;
    for(let t=0;t<=duration;t+=10){
      const input=sample(t),r=c.update(input.angle,input.velocity,t,{timestampMs:t,key:Math.floor(t/70)});
      rows.push({tMs:t,reference:input.reference??input.angle,physicalVelocity:input.velocity,...r});
      if(r.lastCorrection&&r.lastCorrection!==last){last=r.lastCorrection;corrections.push(last);}
    }
    const resting=rows.filter(r=>r.tMs>duration-2000&&r.physicalVelocity===0);
    const errors=resting.map(r=>r.displayAngleDeg-r.reference),mean=errors.reduce((a,b)=>a+b,0)/Math.max(1,errors.length);
    const summary={name,corrections,deadlineMisses:corrections.filter(r=>!r.completed).length,
      maxCorrectionMs:Math.max(0,...corrections.map(r=>r.ended-r.start)),
      finalErrorDeg:Math.abs(rows.at(-1).displayAngleDeg-rows.at(-1).reference),
      finalRestJitterRms:errors.length?Math.sqrt(errors.reduce((a,e)=>a+(e-mean)**2,0)/errors.length):null,
      ordinaryMotionDelaySeconds:temporal(rows.map(r=>({...r,timestampMs:r.tMs,motion:r.physicalVelocity===0?'stationary':'moving',referenceSource:'reference'})),'displayAngleDeg').motionDelayP95Seconds,
      maxDisplaySpeed:Math.max(...rows.map(r=>Math.abs(r.displayVelocityDegS)))};
    scenarios.push({summary,rows});
  }
  for(const gap of [1.1,2,10,30,70,110])run(`stationary-${gap}`,120-gap,()=>({angle:120,velocity:0}));
  run('late-source-switches',30,t=>({angle:t<config.display.deadlineMs*.7?110:t<config.display.deadlineMs*.85?20:80,velocity:0}));
  run('slow-motion-reversal',30,t=>t<4000?{angle:30+t*.005,velocity:5}:t<8000?{angle:50-(t-4000)*.005,velocity:-5}:{angle:30,velocity:0});
  run('fast-motion-reversal',30,t=>t<3000?{angle:30+t*.02,velocity:20}:t<6000?{angle:90-(t-3000)*.02,velocity:-20}:{angle:30,velocity:0});
  run('stationary-jitter',50,t=>({angle:50+.2*Math.sin(t*.019)+.1*Math.sin(t*.047),reference:50,velocity:0}));
  return {kind:'synthetic-controller-validation',config:config.display,hardwareValidated:false,scenarios};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const destination=resolve(process.argv[2]||'data/controller-validation');await mkdir(destination,{recursive:true});
  const report=validateController();await writeFile(resolve(destination,'report.json'),JSON.stringify(report));
  console.log(JSON.stringify(report.scenarios.map(s=>s.summary),null,2));
  if(report.scenarios.some(s=>s.summary.deadlineMisses||s.summary.maxCorrectionMs>config.display.deadlineMs||s.summary.finalErrorDeg>1))process.exitCode=1;
}
