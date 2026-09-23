import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
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
  // Service responses may contain hundreds of lighting features. They are
  // private to Light Track's image pipeline, never used by Fusion's controller or
  // exact-frame pairing. Keep the coordinator's live state small and bounded.
  const {features: _features, ...summary}=result;
  s.errors[kind]=null;if(!s.engine.ingest(kind,summary))return;
  const pair=s.pairs.get(summary.frameId)||{};pair[kind]=summary;s.pairs.set(summary.frameId,pair);
  while(s.pairs.size>config.network.pairCacheSize)s.pairs.delete(s.pairs.keys().next().value);
  if(pair.keyboard?.valid&&pair.lighting&&!pair.anchored&&pair.keyboard.timestampMs===pair.lighting.timestampMs){
    pair.anchored=true;s.anchors.push({frameId:summary.frameId,angleDeg:pair.keyboard.angleDeg,source:'keyboard',
      ...(pair.lighting.modelGeneration===undefined?{}:{modelGeneration:pair.lighting.modelGeneration})});
  }
  broadcast('service',{sessionId:s.id,kind,result:summary});
}
function start(camera,lightingOptions={}){
  const s={id:randomUUID(),camera,engine:new FusionEngine(config),pairs:new Map(),errors:{},clockOffset:null,lastFrame:-1,lastTimestamp:-1,
    clients:{},lastPublish:0,activity:Date.now()};
  for(const kind of ['keyboard','lighting'])s.clients[kind]=new ServiceClient(kind,config.services[kind],camera,config.network,
    result=>accept(s,kind,result),error=>{if(session===s){s.errors[kind]=error.message;s.engine.invalidate(kind);}},kind==='lighting'?lightingOptions:{});
  s.anchors=new LatestQueue(anchor=>s.clients.lighting.call('anchors',anchor),error=>{s.anchorError=error.message;});
  session=s;latest=null;return s;
}
async function stop(){const s=session;session=null;latest=null;if(s){s.anchors.close();await Promise.allSettled(Object.values(s.clients).map(client=>client.close()));}broadcast('stopped',{});}

const interval=setInterval(()=>{
  const s=session;if(!s||s.clockOffset===null)return;
  const now=performance.now()-s.clockOffset;
  latest={sessionId:s.id,...s.engine.tick(now),services:{keyboard:s.errors.keyboard??null,lighting:s.errors.lighting??null},
    profileId:s.profileId??null,droppedFrames:Object.fromEntries(Object.entries(s.clients).map(([kind,client])=>[kind,client.queue.dropped]))};
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
      if(session&&Date.now()-session.activity>config.network.leaseIdleMs)await stop();
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
          if(['width','height','horizontalFovDegrees'].some(k=>profile.capture?.[k]!==camera[k]))throw new Error('Saved model camera differs; annotate photos using the current camera.');
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
      const result=s?await s.clients.lighting.activate(data.profileId):await requestJson(config.services.lighting,'/v1/profiles/select',{method:'POST',body:{profileId:data.profileId}});
      if(s){s.engine.invalidate('lighting');s.profileId=data.profileId;}send(200,result);return;
    }
    if(/^\/api\/(calibration|recording|checkpoint|reference)(?:[/?]|$)/.test(path))fail('This workflow was removed. Train or calibrate with Light Track photo annotations at http://localhost:1818/annotate.',410);
    if(path==='/api/adaptation'&&req.method==='GET'){
      if(!session)fail('Start a camera session first',409);
      send(200,await session.clients.lighting.call('export',undefined,'GET'));return;
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
