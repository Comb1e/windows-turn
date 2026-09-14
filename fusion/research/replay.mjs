import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { FusionEngine } from '../src/controller.js';
import { errors, temporal } from './metrics.mjs';

export async function replay(data,Adapter){
  if(data.kind!=='fusion-lighting-session'||!data.fusion?.config||!data.adaptationConfig)throw new Error('Use a fusion recording with frozen configuration');
  const config=data.fusion.config;
  const adapter=Adapter.restore(data.adaptationConfig,data.adaptationInitial);
  const engine=new FusionEngine(config),rows=[];let previous=-1;
  for(const record of data.records){
    if(record.modelGeneration!==undefined&&record.modelGeneration!==(data.records[0].modelGeneration??0))throw new Error('Use a separate replay segment per model generation');
    const timestampMs=data.captureStartMs+record.tMs;
    if(!Number.isFinite(timestampMs)||timestampMs<=previous)throw new Error('Recording timestamps must increase');previous=timestampMs;
    if(record.adaptation?.segment!==adapter.segment){adapter.reset(record.adaptation.prior,record.adaptation.origin);adapter.segment=record.adaptation.segment;}
    if(record.usable===false)adapter.suspend('Recorded unusable lighting');
    else if(adapter.state==='SUSPENDED')adapter.reset(record.adaptation.prior,record.adaptation.origin);
    // Score the current prediction BEFORE supplying its keyboard label.
    const adapted=record.usable===false?null:adapter.observe(record.rawAngleDeg,timestampMs,record.settingsKey||'');
    const keyboard=Number.isFinite(record.keyboardAngleDeg)?record.keyboardAngleDeg:null;
    const common={frameId:record.frameId,timestampMs};
    engine.ingest('lighting',{...common,valid:Number.isFinite(adapted),angleDeg:adapted,motion:record.motion,adaptation:adapter.status()});
    engine.ingest('keyboard',{...common,valid:keyboard!==null,angleDeg:keyboard});
    const shown=engine.tick(timestampMs);
    // Independent reference labels score performance; online keyboard teachers do not score themselves.
    const label=record.label?.source==='reference'||record.label?.source==='checkpoint'?record.label:record.externalLabel;
    rows.push({...common,reference:label?.angle??null,referenceSource:label?.source??null,motion:label?.motion??null,checkpoint:label?.checkpoint??null,
      raw:record.rawAngleDeg,adapted,recordedAdapted:record.adaptedAngleDeg,displayed:shown.displayAngleDeg,
      displayValid:shown.measurementAngleDeg!==null,source:shown.source,motionVelocityDegS:shown.motionVelocityDegS,
      displayVelocityDegS:shown.displayVelocityDegS,displaySpeedBoundDegS:shown.displaySpeedBoundDegS});
    if(shown.measurementAngleDeg===null)rows.at(-1).displayed=null;
    if(keyboard!==null&&record.usable!==false&&Number.isFinite(record.rawAngleDeg))adapter.add({frameId:record.frameId,timestampMs,raw:record.rawAngleDeg,features:record.features},keyboard);
  }
  const summary=key=>({...errors(rows,key),...temporal(rows,key)});
  const recorded=[];
  // Actual display samples are joined to reference labels by capture clock, with bounded gaps.
  let j=0;
  for(const out of data.fusion.timeline||[]){
    while(j+1<rows.length&&rows[j+1].timestampMs<out.timestampMs)j++;
    const a=rows[j],b=rows[j+1];if(!a||!b||!Number.isFinite(a.reference)||!Number.isFinite(b.reference)||b.timestampMs-a.timestampMs>250||a.motion!==b.motion||a.referenceSource!==b.referenceSource||a.checkpoint!==b.checkpoint||out.timestampMs<a.timestampMs)continue;
    const reference=a.reference+(b.reference-a.reference)*(out.timestampMs-a.timestampMs)/(b.timestampMs-a.timestampMs);
    recorded.push({...a,...out,reference,displayed:out.measurementAngleDeg===null?null:out.displayAngleDeg});
  }
  return {kind:'fusion-evaluation',version:1,sessionId:data.sessionId,modelId:data.modelId,source:data.source,realDataAcceptancePassed:false,
    rawBrightness:summary('raw'),adaptedBrightness:summary('adapted'),recordedAdaptedBrightness:summary('recordedAdapted'),
    replayDisplay:summary('displayed'),recordedDisplay:{...errors(recorded,'displayed'),...temporal(recorded,'displayed')},
    byAngle:Object.fromEntries([...new Set(rows.filter(r=>Number.isFinite(r.reference)).map(r=>Math.round(r.reference/10)*10))].sort((a,b)=>a-b).map(bin=>[bin,Object.fromEntries(['raw','adapted','displayed'].map(key=>[key,errors(rows.filter(r=>Math.round(r.reference/10)*10===bin),key)]))])),
    speedBoundViolations:rows.filter(r=>Math.abs(r.displayVelocityDegS)>r.displaySpeedBoundDegS+1e-6).length,
    limitations:['Replay admits matched labels after scoring each frame; recorded-live metrics retain real processing delays.',
      'Keyboard adaptation labels are excluded from independent accuracy scores.',
      'Camera/reference synchronization and real end-to-end latency require hardware validation.',
      'Each chase keeps its original 1-second deadline; gaps retain the original deadline; an expired deadline is reported without restarting the countdown.'],rows};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const [input,output,adapterPath]=process.argv.slice(2);if(!input||!output)throw new Error('Usage: npm run replay -- recording.json report.json [path-to-light-track/src/adaptation.js]');
    const {SessionAdapter}=await import(adapterPath?pathToFileURL(resolve(adapterPath)).href:new URL('../../light-track/src/adaptation.js',import.meta.url).href);
    const report=await replay(JSON.parse(await readFile(input,'utf8')),SessionAdapter);
    await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({report:resolve(output),raw:report.rawBrightness,adapted:report.adaptedBrightness,display:report.recordedDisplay},null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
