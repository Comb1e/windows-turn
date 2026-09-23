import { OneEuroFilter } from './filter.js';

/** Local service adapter: one running frame and one replaceable newest frame. */
export class ImageEstimator {
  constructor(model,config,{fetcher=(...args)=>fetch(...args),onSample=()=>{},onError=()=>{}}={}) {
    Object.assign(this,{model,config,fetcher,onSample,onError});this.capture=model.capture;this.angleRange=model.angleRange;
    this.filter=new OneEuroFilter(model.filter);this.generation=0;this.token=null;this.running=null;this.pending=null;this.lifecycle=Promise.resolve();this.active=false;this.sequence=0;
  }
  async json(path,options={}) {const response=await this.fetcher(path,options);const result=await response.json();if(!response.ok)throw new Error(result.error||'Image service unavailable');return result;}
  reset() {
    const token=this.token;this.generation++;this.active=false;this.token=null;this.pending=null;this.filter.reset();
    this.lifecycle=Promise.allSettled([this.lifecycle,this.opening,this.running]).then(async()=>{if(token)await this.json('/v1/sessions/'+token,{method:'DELETE'}).catch(()=>{});});
  }
  async start() {
    const generation=this.generation;await this.lifecycle;
    if(generation!==this.generation)return;
    this.active=true;
    const opening=this.json('/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:this.model,camera:this.capture,initialization:'model-output'})});this.opening=opening;
    try {
      const result=await opening;
      if(generation!==this.generation||!this.active){await this.json('/v1/sessions/'+result.sessionId,{method:'DELETE'});return;}
      this.token=result.sessionId;this.sequence=0;
    }catch(error){if(generation===this.generation){this.active=false;throw error;}}
    finally{if(this.opening===opening)this.opening=null;}
  }
  update(frame,timestamp,{camera={}}={}) {
    if(!this.active||!this.token)return;
    if(frame.width!==this.capture.width||frame.height!==this.capture.height)throw new Error('Camera changed; recalibrate this scene');
    this.pending={bytes:new Uint8Array(frame.data),width:frame.width,height:frame.height,timestamp,camera};this.drain();
  }
  drain() {
    if(this.running||!this.pending||!this.token||!this.active)return;
    const shot=this.pending;this.pending=null;const generation=this.generation,token=this.token,frameId=++this.sequence;
    this.running=this.json(`/v1/sessions/${token}/frames`,{method:'POST',headers:{'Content-Type':'application/octet-stream',
      'X-Frame-Id':String(frameId),'X-Timestamp-Ms':String(shot.timestamp),'X-Width':String(shot.width),'X-Height':String(shot.height),
      'X-Camera-Settings':encodeURIComponent(JSON.stringify(shot.camera))},body:shot.bytes}).then(result=>{
      if(generation!==this.generation||token!==this.token||!this.active)return;
      if(result.sessionId!==token||result.frameId!==frameId||result.timestampMs!==shot.timestamp)throw new Error('Obsolete lighting response');
      if(!result.valid||!Number.isFinite(result.angleDeg)){this.onError(new Error(result.quality?.reason||'No usable image angle'));return;}
      const angle=this.filter.update(result.angleDeg,shot.timestamp),radius=this.model.calibration.residual95;
      this.onSample({angle,raw:result.rawAngleDeg,timestamp:shot.timestamp,reliability:'low',radius,
        interval:[Math.max(this.angleRange[0],angle-radius),Math.min(this.angleRange[1],angle+radius)],
        reasons:['Provisional image model; independent physical validation pending'],inference:result.inference??{backend:'unreported',processingMs:null}});
    }).catch(error=>{if(generation===this.generation)this.onError(error);}).finally(()=>{this.running=null;this.drain();});
  }
}
