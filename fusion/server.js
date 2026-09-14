import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SweepCalibration } from './src/calibration.js';
import { FusionEngine } from './src/controller.js';
import { LatestQueue, ServiceClient, requestJson } from './src/service-client.js';

const root=fileURLToPath(new URL('.',import.meta.url));
const args=process.argv.slice(2);
if(args.length && (args.length!==2||args[0]!=='--config'))throw new Error('Usage: node server.js [--config path]');
const config=JSON.parse(await readFile(args.length?resolve(args[1]):resolve(root,'config.json'),'utf8'));
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>config.network.maxBodyBytes)fail('Request too large',413);chunks.push(chunk);}return Buffer.concat(chunks);}
const json=async req=>JSON.parse((await body(req)).toString()||'{}');
let session=null,latest=null;
const listeners=new Set();
function broadcast(event,data){const line=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;for(const res of listeners){if(!res.write(line)){res.end();listeners.delete(res);}}}
async function health(){
  const statuses=await Promise.all(Object.entries(config.services).map(async([name,url])=>{
    try{return [name,await requestJson(url,'/v1/health',{timeoutMs:config.network.healthTimeoutMs})];}
    catch(error){return [name,{ready:false,error:error.message}];}
  }));return Object.fromEntries(statuses);
}
function accept(s,kind,result){
  if(session!==s)return;
  s.errors[kind]=null;if(!s.engine.ingest(kind,result))return;
  const pair=s.pairs.get(result.frameId)||{};pair[kind]=result;s.pairs.set(result.frameId,pair);
  while(s.pairs.size>config.network.pairCacheSize)s.pairs.delete(s.pairs.keys().next().value);
  if(pair.keyboard?.valid&&pair.lighting&&!pair.anchored&&pair.keyboard.timestampMs===pair.lighting.timestampMs){
    pair.anchored=true;s.anchors.push({frameId:result.frameId,angleDeg:pair.keyboard.angleDeg,source:'keyboard',
      ...(pair.lighting.modelGeneration===undefined?{}:{modelGeneration:pair.lighting.modelGeneration})});
  }
  if(pair.keyboard&&pair.lighting&&!pair.calibrated&&pair.keyboard.timestampMs===pair.lighting.timestampMs){
    pair.calibrated=true;if(s.calibration?.active()){s.calibration.push(pair.keyboard,pair.lighting);void calibrationProgress(s);}
  }
  const {features,...summary}=result;
  broadcast('service',{sessionId:s.id,kind,result:summary});
}
function start(camera,lightingOptions={}){
  const s={id:randomUUID(),camera,engine:new FusionEngine(config),pairs:new Map(),errors:{},clockOffset:null,lastFrame:-1,lastTimestamp:-1,
    timeline:[],recording:false,clients:{},lastPublish:0,activity:Date.now()};
  for(const kind of ['keyboard','lighting'])s.clients[kind]=new ServiceClient(kind,config.services[kind],camera,config.network,
    result=>accept(s,kind,result),error=>{if(session===s){s.errors[kind]=error.message;s.engine.invalidate(kind);}},kind==='lighting'?lightingOptions:{});
  s.anchors=new LatestQueue(anchor=>s.clients.lighting.call('anchors',anchor),error=>{s.anchorError=error.message;});
  session=s;latest=null;return s;
}
async function stop(){const s=session;session=null;latest=null;if(s){clearTimeout(s.trainingTimer);if(s.trainingJob?.state==='RUNNING')await requestJson(config.services.lighting,`/v1/jobs/${s.trainingJob.jobId}`,{method:'DELETE'}).catch(()=>{});s.anchors.close();await Promise.allSettled(Object.values(s.clients).map(client=>client.close()));}broadcast('stopped',{});}

async function calibrationProgress(s){
  if(session!==s||!s.calibration)return;
  const cal=s.calibration;
  broadcast('calibration',{sessionId:s.id,...cal.status(),job:s.trainingJob??null});
  if(cal.state==='RETRY'&&s.recording){s.recording=false;await s.clients.lighting.call('recording',{},'DELETE').catch(()=>{});}
  if(cal.state!=='TRAINING'||s.trainingStarted)return;
  s.trainingStarted=true;
  try{
    s.recording=false;await s.clients.lighting.call('recording',{},'DELETE');
    if(session!==s)return;
    const job=await s.clients.lighting.call('training',{sweep:{...cal.export(),fusion:{version:2,config,camera:s.camera,timeline:s.timeline}}});s.trainingJob=job;
    if(session!==s||s.calibration!==cal||cal.state!=='TRAINING'){
      await requestJson(config.services.lighting,`/v1/jobs/${job.jobId}`,{method:'DELETE'}).catch(()=>{});return;
    }
    const poll=async()=>{
      if(session!==s||s.calibration!==cal||cal.state!=='TRAINING')return;
      try{
        const status=await requestJson(config.services.lighting,`/v1/jobs/${job.jobId}`);
        if(session!==s||s.calibration!==cal||cal.state!=='TRAINING')return;
        s.trainingJob=status;
        if(status.state==='READY'){
          await s.clients.lighting.activate(status.profileId);s.engine.invalidate('lighting');
          cal.state='READY';s.profileId=status.profileId;s.trainingTimer=null;
        }else if(status.state==='FAILED'||status.state==='CANCELLED')cal.fail(status.error||'Training cancelled');
        else s.trainingTimer=setTimeout(poll,config.calibration.jobPollMs);
      }catch(error){cal.fail(error.message);}
      broadcast('calibration',{sessionId:s.id,...cal.status(),job:s.trainingJob});
    };
    s.trainingTimer=setTimeout(poll,config.calibration.jobPollMs);
  }catch(error){cal.fail(error.message);broadcast('calibration',{sessionId:s.id,...cal.status()});}
}

const interval=setInterval(()=>{
  const s=session;if(!s||s.clockOffset===null)return;
  const now=performance.now()-s.clockOffset;
  if(s.calibration?.active()&&s.calibration.last&&now-s.calibration.last.timestampMs>config.calibration.maxGapMs){s.calibration.fail('Camera or service stopped producing matched frames.');void calibrationProgress(s);}
  latest={sessionId:s.id,...s.engine.tick(now),services:{keyboard:s.errors.keyboard??null,lighting:s.errors.lighting??null},
    profileId:s.profileId??null,calibration:s.calibration?.status()??null,droppedFrames:Object.fromEntries(Object.entries(s.clients).map(([kind,client])=>[kind,client.queue.dropped]))};
  if(s.recording){
    if(s.timeline.length<config.output.maxTimelineRecords)s.timeline.push(latest);
    else {s.recording=false;s.errors.recording='Timeline limit reached; stop and export the recording';}
  }
  if(now-s.lastPublish>=config.output.publishMs){s.lastPublish=now;broadcast('angle',latest);}
},1000/config.output.fps);

const server=createServer(async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
    const path=new URL(req.url,'http://localhost').pathname;
    if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)fail('Same-origin requests only',403);
    if(path==='/api/events'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});res.write(': connected\n\n');listeners.add(res);req.on('close',()=>listeners.delete(res));return;
    }
    if(path==='/api/health'&&req.method==='GET'){send(200,{service:'fusion',version:1,services:await health(),config});return;}
    if(path==='/api/angle'&&req.method==='GET'){send(200,latest||{sessionId:session?.id??null,measurementAngleDeg:null,displayAngleDeg:null,state:session?'REQUESTING':'STOPPED'});return;}
    if(path==='/api/start'&&req.method==='POST'){
      if(session&&!session.recording&&Date.now()-session.activity>config.network.leaseIdleMs)await stop();
      if(session)fail('A camera session is already active',409);
      const options=await json(req);const services=await health();
      if(session)fail('A camera session is already active',409);
      const camera={...config.camera,...(services.keyboard.camera||services.lighting.camera||{})};
      camera.horizontalFovDegrees??=config.camera.horizontalFovDegrees;
      const profiles=await requestJson(config.services.lighting,'/v1/profiles',{timeoutMs:config.network.healthTimeoutMs}).catch(()=>({selectedProfileId:null}));
      let profileId=options.profileId===undefined?profiles.selectedProfileId:options.profileId;
      let profileError=null;
      if(profileId){
        try{const profile=await requestJson(config.services.lighting,`/v1/profiles/${profileId}`);
          if(['width','height','horizontalFovDegrees'].some(k=>profile.capture?.[k]!==camera[k]))throw new Error('Saved calibration camera differs; collect a new sweep.');
        }catch(error){profileError=error.message;profileId=null;}
      }
      const incompatible=services.lighting.camera&&['width','height','horizontalFovDegrees'].some(k=>services.lighting.camera[k]!==camera[k]);
      if(session)fail('A camera session is already active',409);
      const s=start(camera,{profileId:profileId||null,mode:!profileId&&(incompatible||profileError)?'features-only':'measurement',initialization:'model-output'});
      s.profileId=profileId||null;send(200,{sessionId:s.id,camera,services,profileId:s.profileId,profileError});return;
    }
    if(path==='/api/stop'&&req.method==='POST'){
      const data=await json(req);if(session&&data.sessionId!==session.id)fail('Expired coordinator session',409);
      await stop();send(200,{stopped:true});return;
    }
    if(path==='/api/frames'&&req.method==='POST'){
      const s=session;if(!s||req.headers['x-session-id']!==s.id)fail('Expired coordinator session',409);
      if(req.headers['content-type']!=='application/octet-stream')fail('Use RGBA8 application/octet-stream',415);
      const frame={frameId:Number(req.headers['x-frame-id']),timestampMs:Number(req.headers['x-timestamp-ms']),width:Number(req.headers['x-width']),height:Number(req.headers['x-height']),
        camera:JSON.parse(decodeURIComponent(req.headers['x-camera-settings']||'%7B%7D')),bytes:await body(req)};
      if(session!==s)fail('Obsolete camera upload',409);
      if(!Number.isSafeInteger(frame.frameId)||frame.frameId<=s.lastFrame||!Number.isFinite(frame.timestampMs)||frame.timestampMs<0||frame.timestampMs<=s.lastTimestamp
        ||frame.width!==s.camera.width||frame.height!==s.camera.height||frame.bytes.length!==frame.width*frame.height*4)fail('Invalid or out-of-order camera frame');
      s.lastFrame=frame.frameId;s.lastTimestamp=frame.timestampMs;s.activity=Date.now();
      if(s.clockOffset===null)s.clockOffset=performance.now()-frame.timestampMs;
      for(const client of Object.values(s.clients))client.queue.push(frame);
      send(202,{accepted:true,sessionId:s.id,frameId:frame.frameId});return;
    }
    if(path==='/api/profiles'&&req.method==='GET'){send(200,await requestJson(config.services.lighting,'/v1/profiles'));return;}
    const profileExport=/^\/api\/profiles\/([a-f0-9-]{36})\/export$/.exec(path);
    if(profileExport&&req.method==='GET'){send(200,await requestJson(config.services.lighting,`/v1/profiles/${profileExport[1]}/export`));return;}
    if(path==='/api/profile'&&req.method==='POST'){
      const data=await json(req),s=session;
      if(s&&data.sessionId!==s.id)fail('Expired coordinator session',409);
      if(s&&(s.calibration?.active()||s.calibration?.state==='TRAINING'))fail('Finish or cancel calibration before changing profile',409);
      const result=s?await s.clients.lighting.activate(data.profileId):await requestJson(config.services.lighting,'/v1/profiles/select',{method:'POST',body:{profileId:data.profileId}});
      if(s){s.engine.invalidate('lighting');s.profileId=data.profileId;}send(200,result);return;
    }
    if(path.startsWith('/api/calibration')){
      const s=session;if(!s)fail('Start the camera first',409);
      if(req.method==='GET'){
        send(200,path==='/api/calibration/export'?s.calibration?.export()??null:s.calibration?.status()??{state:'IDLE'});return;
      }
      const data=await json(req);if(data.sessionId!==s.id)fail('Expired coordinator session',409);
      if(path==='/api/calibration'&&req.method==='POST'){
        if(s.clockOffset===null)fail('Wait for the first shared camera frame',409);
        if(s.calibration?.active()||s.calibration?.state==='TRAINING'||s.recording)fail('A recording or calibration is already active',409);
        const metadata={device:'My laptop',location:'Current environment',position:'desk',lighting:'Current lighting',display:'Fixed display',...data.metadata};
        for(const k of ['device','location','position','lighting','display'])if(typeof metadata[k]!=='string'||!metadata[k].trim())fail('Complete calibration setup metadata');
        await s.clients.lighting.activate(null);s.engine.invalidate('lighting');s.pairs.clear();
        const timestampMs=performance.now()-s.clockOffset;
        await s.clients.lighting.call('recording',{metadata,timestampMs,epochMs:Date.now()});
        s.calibration=new SweepCalibration(config.calibration,metadata);s.trainingStarted=false;s.trainingJob=null;s.timeline=[];s.recording=true;
        send(200,s.calibration.status());return;
      }
      if(path==='/api/calibration'&&req.method==='DELETE'){
        if(s.calibration)s.calibration.state='CANCELLED';clearTimeout(s.trainingTimer);
        if(s.trainingJob?.state==='RUNNING')await requestJson(config.services.lighting,`/v1/jobs/${s.trainingJob.jobId}`,{method:'DELETE'});
        s.recording=false;await s.clients.lighting.call('recording',{},'DELETE');
        if(s.profileId)await s.clients.lighting.activate(s.profileId);
        send(200,{state:'CANCELLED'});return;
      }
      if(path==='/api/calibration/action'&&req.method==='POST'){
        if(!s.calibration)fail('Start calibration first');send(200,s.calibration.manual(data.action));return;
      }
      fail('Not found',404);
    }
    if(path.startsWith('/api/recording')||path==='/api/checkpoint'||path==='/api/reference'||path==='/api/adaptation'){
      const s=session;if(!s)fail('Start a camera session first',409);
      const data=req.method==='GET'?null:await json(req);
      if(req.method!=='GET'&&data.sessionId!==s.id)fail('Expired coordinator session',409);
      const client=s.clients.lighting;
      if(path==='/api/recording'&&req.method==='POST'){
        const result=await client.call('recording',data);s.timeline=[];s.recording=true;send(200,result);return;
      }
      if(path==='/api/recording'&&req.method==='DELETE'){s.recording=false;send(200,await client.call('recording',{},'DELETE'));return;}
      if(path==='/api/recording'&&req.method==='GET'){
        const dataset=await client.call('recording',undefined,'GET');
        send(200,{...dataset,fusion:{version:1,config,camera:s.camera,timeline:s.timeline}});return;
      }
      if(path==='/api/adaptation'&&req.method==='GET'){send(200,await client.call('export',undefined,'GET'));return;}
      if(path==='/api/checkpoint'&&req.method==='POST'){send(200,await client.call('checkpoint',data));return;}
      if(path==='/api/reference'&&req.method==='POST'){send(200,await client.call('reference',data));return;}
      fail('Not found',404);
    }
    if(req.method!=='GET')fail('Not found',404);
    const assets={'/':'index.html','/style.css':'style.css','/app.js':'app.js'};
    if(!assets[path])fail('Not found',404);
    const content=await readFile(resolve(root,assets[path]));
    res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[extname(assets[path])],'Cache-Control':'no-store'});res.end(content);
  }catch(error){send(error.status||400,{error:error.message});}
});
server.requestTimeout=config.network.requestTimeoutMs;
server.on('error',error=>{console.error(error.message);clearInterval(interval);process.exitCode=1;});
server.listen(Number(process.env.PORT||config.port),'127.0.0.1',()=>console.log(`Hinge Fusion ready at http://localhost:${server.address().port}`));
let shuttingDown=false;
async function shutdown(){
  if(shuttingDown)return;shuttingDown=true;clearInterval(interval);await stop();
  for(const res of listeners)res.end();server.close();if(process.connected)process.disconnect();
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void shutdown());
process.on('message',message=>{if(message?.type==='shutdown')void shutdown();});
process.once('disconnect',()=>void shutdown());
