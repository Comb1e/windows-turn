import { readFile,writeFile } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { LightingServer } from '../lighting-server.js';
import { trainingPython } from '../training-runtime.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const [modelPath,groupPath,outputPath,secondsText='60']=process.argv.slice(2);
if(!outputPath)throw new Error('Usage: node research/scene_live_smoke.mjs <model> <group.json> <report.json> [seconds]');
const config=JSON.parse(await readFile(join(root,'config.json'))),settings=JSON.parse(await readFile(join(root,'service-config.json')));
const model=JSON.parse(await readFile(modelPath)),group=JSON.parse(await readFile(groupPath)),sample=group.samples[0];
const imagePath=resolve(dirname(groupPath),sample.image);
const bytes=execFileSync(trainingPython(root),['-c','import cv2,sys; a=cv2.imread(sys.argv[1],cv2.IMREAD_UNCHANGED); a=cv2.cvtColor(a,cv2.COLOR_BGRA2RGBA if a.shape[2]==4 else cv2.COLOR_BGR2RGBA); sys.stdout.buffer.write(a.tobytes())',imagePath],{maxBuffer:config.annotation.maxPixels*4+1024});
const api=new LightingServer(root,config,settings,model);const frames=[];let session;
try{
  session=await api.create({camera:model.capture,initialization:'model-output'});
  let sequence=0;
  const process=async()=>{
    const timestamp=performance.now();const result=await api.frame(session.sessionId,{...model.capture,camera:sample.camera,frameId:++sequence,timestampMs:timestamp},bytes);
    return {elapsedMs:performance.now()-timestamp,processingMs:result.inference.processingMs,backend:result.inference.backend,valid:result.valid,angle:result.angleDeg};
  };
  for(let i=0;i<5;i++)await process();console.log('Image service warm; beginning timed 15 Hz run.');
  const start=performance.now(),seconds=Number(secondsText);let missed=0,slot=0;
  while(performance.now()-start<seconds*1000){
    frames.push(await process());slot++;
    // Absolute deadlines avoid accumulating Windows timer rounding on every frame.
    const remaining=start+slot*1000/config.processing.fps-performance.now();if(remaining>0)await pause(remaining);else missed++;
  }
  const values=frames.map(f=>f.elapsedMs).sort((a,b)=>a-b);const quantile=p=>values[Math.min(values.length-1,Math.floor(values.length*p))];
  const report={kind:'local-image-service-smoke',input:'saved annotated still; no physical-motion accuracy claim',camera:model.capture,
    backend:frames[0].backend,seconds:(performance.now()-start)/1000,frames:frames.length,valid:frames.filter(f=>f.valid).length,
    achievedFps:frames.length/((performance.now()-start)/1000),
    p50Ms:quantile(.5),p95Ms:quantile(.95),maxMs:values.at(-1),missedSlots:missed,maxInFlight:1,queuedFrames:0,frameTimesMs:frames.map(f=>f.elapsedMs)};
  await writeFile(outputPath,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,frameTimesMs:undefined},null,2));
}finally{api.close();}
