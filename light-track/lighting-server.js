import { randomUUID, createHash } from 'node:crypto';
import { extractFeatures } from './src/features.js';
import { infer, validateModel } from './src/model.js';
import { SessionAdapter } from './src/adaptation.js';
import { PythonWorker } from './python-worker.js';
import { ProfileStore } from './profile-store.js';
import { captureCamera } from './src/camera.js';
import { ImageWorker } from './image-worker.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const fingerprint = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
export async function readBody(req,maximum) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>maximum)fail('Request too large',413);chunks.push(chunk);}
  return Buffer.concat(chunks);
}
export function frameMetadata(headers) {
  const frameId=Number(headers['x-frame-id']),timestampMs=Number(headers['x-timestamp-ms']);
  const width=Number(headers['x-width']),height=Number(headers['x-height']);
  if(!Number.isSafeInteger(frameId)||frameId<0||!Number.isFinite(timestampMs)||timestampMs<0||!Number.isInteger(width)||!Number.isInteger(height))fail('Invalid frame metadata');
  const camera=JSON.parse(decodeURIComponent(headers['x-camera-settings']||'%7B%7D'));
  if(!camera || typeof camera!=='object' || Array.isArray(camera))fail('Invalid camera settings');
  return {frameId,timestampMs,width,height,camera};
}

export class LightingServer {
  constructor(root,config,settings,model=null,{motionWorker}={}) {
    this.config=config;this.settings=settings;this.profiles=new ProfileStore(root,config,settings.profiles);
    this.model=null;this.modelError=null;
    try{this.model=model?validateModel(model,config.features):null;}catch(error){this.modelError=error.message;}
    this.modelId=model?createHash('sha256').update(JSON.stringify(model)).digest('hex'):null;
    this.motion=motionWorker||new PythonWorker(root,config,undefined,'motion_tracker.py');
    this.images=new ImageWorker(root,config);
    this.session=null;this.busy=false;this.creating=false;
  }
  health() {
    return {version:1,service:'lighting',ready:true,modelReady:Boolean(this.model),modelId:this.modelId,modelError:this.modelError,
      camera:this.model?.capture||null,motionCalibrated:Boolean(this.model?.motionCalibration?.degreesPerRadian),
      features:this.config.features,trainingWorkflow:'photo-annotations'};
  }
  adapter(model) {
    const settings={...this.settings.adaptation};
    if(model?.trainingMode==='screenshot-groups'||model?.version===2) {
      settings.minAngle=Math.min(settings.minAngle,model.angleRange[0]);
      settings.maxAngle=Math.max(settings.maxAngle,model.angleRange[1]);
    }
    const adapter=new SessionAdapter(settings);
    return model?.trainingMode==='screenshot-groups'||model?.version===2?adapter.initializeModel():adapter;
  }
  async create(body) {
    if(this.creating || this.busy || (this.session && Date.now()-this.session.activity<this.settings.leaseIdleMs))fail('Another session owns lighting',409);
    const profile=body.profileId?await this.profiles.get(body.profileId):null;
    const supplied=body.model?validateModel(body.model,this.config.features):null;
    const model=body.mode==='features-only'?null:profile?.model??supplied??this.model;
    const camera={...captureCamera(this.config,model?.capture),...body.camera};
    if(!Number.isInteger(camera.width)||!Number.isInteger(camera.height)||Math.min(camera.width,camera.height)<64||camera.width*camera.height>this.settings.maxPixels)fail('Invalid camera dimensions');
    if(!Number.isFinite(camera.horizontalFovDegrees)||camera.horizontalFovDegrees<10||camera.horizontalFovDegrees>170)fail('Invalid camera field of view');
    if(model?.capture && ['width','height','horizontalFovDegrees'].some(k=>model.capture[k]!==undefined&&model.capture[k]!==camera[k]))fail('Camera settings differ from source calibration');
    if(this.creating||this.busy||(this.session&&Date.now()-this.session.activity<this.settings.leaseIdleMs))fail('Another session owns lighting',409);
    this.creating=true;
    try {
      const session={id:randomUUID(),camera,activity:Date.now(),sequence:-1,timestamp:-1,cache:new Map(),
        model,modelId:model?.modelId??(model?this.modelId:null),profileId:profile?.profile.profileId??null,modelGeneration:0,
        adapter:this.adapter(model),lastSample:null,lastKeyboard:null,motionReady:false};
      if(body.initialization==='model-output'||profile)session.adapter.initializeModel();
      this.session=session;
      try {await this.motion.request('reset',{...camera,motionCalibration:model?.motionCalibration});session.motionReady=true;}
      catch(error){session.motionError=error.message;}
      return {...this.health(),sessionId:session.id,camera,modelReady:Boolean(model),modelId:session.modelId,profileId:session.profileId,modelGeneration:0};
    } finally {this.creating=false;}
  }
  require(id) {
    if(!this.session || this.session.id!==id)fail('Expired lighting session',409);
    this.session.activity=Date.now();return this.session;
  }
  newSegment(s,reason,angle=null) {
    if(s.model?.kind==='scene-calibrated-model')s.sceneInvalidated=reason;
    const prior=Number.isFinite(angle)?angle:Number.isFinite(s.adapter.lastAngle)?s.adapter.lastAngle:s.adapter.prior;
    s.adapter.suspend(reason);
    s.adapter.reset(Math.max(s.adapter.c.minAngle,Math.min(s.adapter.c.maxAngle,prior)),Number.isFinite(angle)?'keyboard':'carried-estimate');
    s.adapter.reason=reason;s.lastKeyboard=null;
  }
  async observeMotion(s,frame,meta) {
    if(!s.motionReady || s.motionNeedsReset || this.motion.pending)return {velocityDegS:null,quality:'unavailable',reason:s.motionError||'Motion worker busy'};
    const gray=Buffer.alloc(frame.width*frame.height);
    for(let i=0;i<gray.length;i++)gray[i]=Math.round(.299*frame.data[i*4]+.587*frame.data[i*4+1]+.114*frame.data[i*4+2]);
    let timer;
    try {
      return await Promise.race([
        this.motion.request('frame',{width:frame.width,height:frame.height,gray:gray.toString('base64'),timestamp:meta.timestampMs}),
        new Promise(resolve=>{timer=setTimeout(()=>resolve({velocityDegS:null,quality:'unavailable',reason:'Motion deadline exceeded'}),this.settings.motionDeadlineMs);})
      ]);
    } catch(error){return {velocityDegS:null,quality:'unavailable',reason:error.message};}
    finally{clearTimeout(timer);}
  }
  async frame(id,meta,bytes) {
    const s=this.require(id);
    if(this.busy || this.creating)fail('Lighting busy; keep only the latest waiting frame',409);
    if(meta.width!==s.camera.width||meta.height!==s.camera.height||bytes.length!==meta.width*meta.height*4)fail('RGBA byte count or camera dimensions mismatch');
    if(meta.frameId<=s.sequence||meta.timestampMs<=s.timestamp)fail('Frame IDs and capture timestamps must increase');
    this.busy=true;s.sequence=meta.frameId;s.timestamp=meta.timestampMs;
    try {
      if(s.pendingProfile){const next=s.pendingProfile;delete s.pendingProfile;
        s.model=next.model;s.modelId=next.model?.modelId??null;s.profileId=next.profileId;s.modelGeneration++;s.sceneInvalidated=null;
        s.adapter=this.adapter(s.model).initializeModel();s.cache.clear();s.lastSample=null;s.lastKeyboard=null;s.motionNeedsReset=true;
      }
      if(s.motionNeedsReset&&!this.motion.pending){
        try{await this.motion.request('reset',{...s.camera,motionCalibration:s.model?.motionCalibration});s.motionReady=true;s.motionNeedsReset=false;}
        catch(error){s.motionReady=false;s.motionError=error.message;}
      }
      const image={width:meta.width,height:meta.height,data:bytes};
      const lighting=extractFeatures(image,this.config.features);
      const output=s.model?(s.model.version===2?await this.images.frame(s,meta,bytes,lighting.features):infer(s.model,lighting.features)):null;
      const motion=await this.observeMotion(s,image,meta);
      if(this.session!==s)fail('Obsolete lighting result',409);
      const weak=lighting.summary.dark>this.config.estimation.maxDarkFraction||lighting.summary.clipped>this.config.estimation.maxClippedFraction||lighting.summary.contrast<this.config.estimation.minContrast;
      const settingsKey=fingerprint(meta.camera);
      const fixedKey=fingerprint(Object.fromEntries(['width','height','deviceId','resizeMode','exposureMode','whiteBalanceMode'].filter(k=>meta.camera[k]!==undefined).map(k=>[k,meta.camera[k]])));
      const previous=s.lastSample;
      const rotation=motion.rotationVector?Math.hypot(...motion.rotationVector)*180/Math.PI:null;
      let environmentChange=null;
      if(previous && previous.fixedKey!==fixedKey)environmentChange='Camera configuration changed';
      else if(previous && rotation!==null && rotation<this.settings.adaptation.stationaryRotationDegrees && Math.abs(lighting.summary.mean-previous.summary.mean)>this.settings.adaptation.environmentMeanChange)environmentChange='Lighting changed during stationary camera motion';
      if(environmentChange)this.newSegment(s,environmentChange);
      if(weak)s.adapter.suspend('Weak, dark, or clipped lighting signal');
      else if(s.adapter.state==='SUSPENDED')this.newSegment(s,'Lighting signal recovered');
      const angle=!weak&&output&&!s.sceneInvalidated?s.adapter.observe(output.raw,meta.timestampMs,settingsKey):null;
      const sample={modelGeneration:s.modelGeneration,frameId:meta.frameId,timestampMs:meta.timestampMs,raw:output?.raw??null,features:lighting.features,
        summary:lighting.summary,camera:meta.camera,fixedKey,segment:s.adapter.segment,motion,usable:!weak};
      s.lastSample=sample;s.cache.set(meta.frameId,sample);
      while(s.cache.size>this.settings.frameCacheSize)s.cache.delete(s.cache.keys().next().value);
      return {sessionId:id,frameId:meta.frameId,timestampMs:meta.timestampMs,angleDeg:angle,valid:Number.isFinite(angle),rawAngleDeg:output?.raw??null,
        modelGeneration:s.modelGeneration,profileId:s.profileId,inference:{backend:output?.backend??'javascript-cpu',processingMs:output?.processingMs??null},state:s.sceneInvalidated?'Invalidated':weak?'SUSPENDED':s.adapter.state,quality:{provisional:true,reason:s.sceneInvalidated?`Scene calibration invalidated: ${s.sceneInvalidated}. Select a matching profile or base model.`:!s.model?'A real baseline model is required':weak?'Unusable lighting':s.adapter.reason,
          sourceValidated:s.model?.validation?.passed===true,unfamiliar:output?output.distance>s.model.calibration.distance95||output.spread>s.model.calibration.spread95:null},
        adaptation:s.adapter.status(),motion,features:lighting.features,summary:lighting.summary,environmentChange,modelId:s.modelId,
        recording:null};
    } finally {this.busy=false;}
  }
  anchor(id,body) {
    const s=this.require(id),sample=s.cache.get(body.frameId);
    if(body.source!=='keyboard'||!sample)fail('Anchor requires a cached matching frame and keyboard provenance');
    if(body.modelGeneration!==undefined&&body.modelGeneration!==sample.modelGeneration)fail('Anchor belongs to an obsolete model generation',409);
    if(!Number.isFinite(body.angleDeg)||body.angleDeg<10||body.angleDeg>45)fail('Keyboard anchor outside supported keyboard range');
    if(sample.segment!==s.adapter.segment)fail('Anchor belongs to an obsolete environment segment',409);
    if(s.timestamp-sample.timestampMs>this.settings.adaptation.maxAnchorGapMs)return {sessionId:id,frameId:body.frameId,added:false,reason:'Anchor is too old for current adaptation',adaptation:s.adapter.status()};
    // Matching-frame keyboard anchors adapt live inference without publishing training data.
    const previous=s.lastKeyboard;
    if(previous && sample.timestampMs>previous.timestampMs && sample.timestampMs-previous.timestampMs<=this.settings.adaptation.maxAnchorGapMs
      &&Math.abs(body.angleDeg-previous.angle)<this.settings.adaptation.stationaryDegrees
      &&Math.abs(sample.summary.mean-previous.mean)>this.settings.adaptation.environmentMeanChange) {
      this.newSegment(s,'Lighting changed while keyboard confirmed a stationary angle',body.angleDeg);
      sample.segment=s.adapter.segment;
    }
    if(!previous || sample.timestampMs>previous.timestampMs)s.lastKeyboard={timestampMs:sample.timestampMs,angle:body.angleDeg,mean:sample.summary.mean};
    const added=sample.usable&&Number.isFinite(sample.raw)?s.adapter.add(sample,body.angleDeg):false;
    return {sessionId:id,frameId:body.frameId,added,adaptation:s.adapter.status()};
  }
  async handle(req,res) {
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try {
      if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`)fail('Same-origin requests only',403);
      if(req.method==='GET'&&req.url==='/v1/health'){send(200,this.health());return;}
      if(req.method==='GET'&&req.url==='/v1/profiles'){send(200,await this.profiles.list());return;}
      if(/^\/v1\/jobs(?:\/|$)/.test(req.url)||/^\/v1\/sessions\/[^/]+\/(recording|checkpoint|reference|training)(?:[/?]|$)/.test(req.url))fail('This collection workflow was removed. Use photo annotations at /annotate.',410);
      const publicRoute=/^\/v1\/profiles\/([a-f0-9-]{36})(?:\/(export|model))?$/.exec(req.url);
      if(publicRoute&&req.method==='GET'){
        const [,id,action]=publicRoute;
        send(200,action==='model'?(await this.profiles.get(id)).model:action==='export'?await this.profiles.export(id):(await this.profiles.get(id)).profile);return;
      }
      const raw=await readBody(req,req.method==='POST'&&req.url==='/v1/sessions'?this.config.modelSelection.maxBytes:this.settings.maxBodyBytes);
      if(req.method==='POST'&&req.url==='/v1/profiles/select'){const body=JSON.parse(raw);await this.profiles.select(body.profileId);send(200,{profileId:body.profileId});return;}
      if(req.method==='POST'&&req.url==='/v1/sessions'){send(200,await this.create(JSON.parse(raw||'{}')));return;}
      const match=/^\/v1\/sessions\/([^/]+)(?:\/(frames|anchors|reset|export|profile))?$/.exec(req.url);
      if(!match)fail('Not found',404);
      const [,id,operation]=match,s=this.require(id);
      let result;
      if(operation==='profile'&&req.method==='POST'){
        const body=JSON.parse(raw),profile=body.profileId?await this.profiles.get(body.profileId):null;
        if(profile&&['width','height','horizontalFovDegrees'].some(k=>profile.model.capture[k]!==s.camera[k]))fail('Profile camera configuration differs from current capture');
        if(s.pendingProfile)fail('Profile activation already pending',409);
        if(profile)await this.profiles.select(body.profileId);
        s.pendingProfile={model:profile?.model??null,profileId:body.profileId??null};
        result={profileId:body.profileId??null,modelGeneration:s.modelGeneration+1,pending:true};
      } else if(operation==='frames'&&req.method==='POST'){
        if(req.headers['content-type']!=='application/octet-stream')fail('Use RGBA8 application/octet-stream',415);
        result=await this.frame(id,frameMetadata(req.headers),raw);
      } else if(operation==='anchors'&&req.method==='POST')result=this.anchor(id,JSON.parse(raw));
      else if(operation==='export'&&req.method==='GET')result={...s.adapter.export(),modelId:s.modelId,camera:s.camera};
      else if(operation==='reset'&&req.method==='POST'){
        if(this.busy)fail('Wait for the active frame before resetting',409);
        this.session=null;result=await this.create({camera:s.camera,profileId:s.profileId,mode:s.model?'measurement':'features-only',initialization:s.adapter.origin==='model-output'?'model-output':undefined});
      } else if(!operation&&req.method==='DELETE'){this.session=null;result={stopped:true};}
      else fail('Not found',404);
      send(200,result);
    } catch(error){send(error.status||400,{error:error.message});}
  }
  close(){this.session=null;this.motion.close();this.images.close();}
}
