import { robustVelocity } from './controller.js';
const median=values=>{const a=[...values].sort((a,b)=>a-b);return a.length?a[Math.floor(a.length/2)]:null;};
const span=s=>Math.max(...s.map(p=>p.angleDeg))-Math.min(...s.map(p=>p.angleDeg));

/** The coordinator owns timing decisions; Light Track owns features and training. */
export class SweepCalibration {
  constructor(config,metadata={},keyboardModel=null){
    if(keyboardModel!==null&&(!keyboardModel||typeof keyboardModel.modelId!=='string'||!keyboardModel.modelId.trim()
      ||!Array.isArray(keyboardModel.angleRange)||keyboardModel.angleRange.length!==2
      ||!keyboardModel.angleRange.every(Number.isFinite)||keyboardModel.angleRange[0]>=keyboardModel.angleRange[1]))
      throw new Error('Keyboard service must report its model identity and supported angle range before calibration.');
    this.keyboardModel=keyboardModel===null?null:structuredClone({modelId:keyboardModel.modelId,angleRange:keyboardModel.angleRange});
    this.c=config;this.metadata=metadata;this.state='WAIT_SMALL_ANGLE';this.samples=[];this.window=[];
    this.opening=[];this.closing=[];this.events={};this.reason=null;this.referenceSpeed=null;this.last=null;
  }
  fail(reason){this.state='RETRY';this.reason=reason;return this.status();}
  active(){return ['WAIT_SMALL_ANGLE','OPENING','UPPER_HOLD','CLOSING','LOWER_HOLD'].includes(this.state);}
  velocity(samples){return robustVelocity(samples,{velocityMinSamples:this.c.minSamples,velocityMinSpanMs:100,maxVelocityDegS:120});}
  steady(time){
    const w=this.window;
    return w.length>=this.c.minSamples&&time-w[0].timestampMs>=this.c.holdMs
      &&w.every(p=>p.angleDeg<this.c.smallAngleExclusive)&&span(w)<=this.c.stationarySpanDeg;
  }
  pace(speed){return Number.isFinite(speed)&&speed>0&&Math.abs(speed/this.referenceSpeed-1)<=this.c.paceTolerance;}
  upper(time,origin){
    const last=this.opening.at(-1);
    if(!this.referenceSpeed||!last||time<=last.timestampMs)return this.fail('Not enough opening keyboard measurements; retry from a small angle.');
    const speed=(this.c.upperAngle-last.angleDeg)*1000/(time-last.timestampMs);
    if(!this.pace(speed))return this.fail(`Opening pace differs by more than ${Math.round(this.c.paceTolerance*100)}%. Retry and keep the indicated pace.`);
    this.events.upper={timestampMs:time,angleDeg:this.c.upperAngle,origin};this.openingSpeed=speed;
    this.state='UPPER_HOLD';this.stopStart=null;this.manualUpper=null;
  }
  manual(action){
    if(!this.last)throw new Error('Waiting for matched camera frames');
    if(action==='upper'&&this.state==='OPENING')this.manualUpper=this.last.timestampMs;
    else if(action==='closing'&&this.state==='UPPER_HOLD')this.beginClosing(this.last.timestampMs,'manual');
    else throw new Error('This action is not available in the current calibration state');
    return this.status();
  }
  beginClosing(time,origin){this.events.closingStart={timestampMs:time,origin};this.state='CLOSING';this.window=[];}
  push(keyboard,lighting){
    if(!this.active())return this.status();
    if(keyboard.frameId!==lighting.frameId||keyboard.timestampMs!==lighting.timestampMs)throw new Error('Calibration requires identical frame IDs and timestamps');
    if(this.keyboardModel&&keyboard.modelId!==this.keyboardModel.modelId)return this.fail('Keyboard model changed during calibration; retry the sweep.');
    const t=keyboard.timestampMs;
    if(this.last&&t<=this.last.timestampMs)return this.status();
    if(this.last&&t-this.last.timestampMs>this.c.maxGapMs)return this.fail('Camera or service frame gap; retry the sweep.');
    if(lighting.environmentChange)return this.fail('Camera or lighting conditions changed during calibration.');
    if(this.samples.length>=this.c.maxRecords||this.samples.length&&t-this.samples[0].timestampMs>this.c.maxDurationMs)return this.fail('Calibration time or recording limit reached.');
    const s={frameId:keyboard.frameId,timestampMs:t,angleDeg:keyboard.valid?keyboard.angleDeg:null};
    const previous=this.last;this.last=s;this.samples.push(s);
    const valid=Number.isFinite(s.angleDeg);
    if(valid)this.window.push(s);else this.window=[];
    // Keep the sample immediately before the hold boundary to prove a full hold.
    while(this.window.length>1&&this.window[1].timestampMs<=t-this.c.holdMs)this.window.shift();
    const m=lighting.motion,dt=m?.fromTimestampMs===null?0:(t-m?.fromTimestampMs)/1000;
    const rotation=Array.isArray(m?.rotationVector)&&dt>0&&dt<=this.c.maxGapMs/1000
      ?Math.hypot(...m.rotationVector)*180/Math.PI/dt:null;
    if(this.state==='WAIT_SMALL_ANGLE'){
      if(this.steady(t)){this.events.start={timestampMs:t,angleDeg:median(this.window.map(p=>p.angleDeg))};this.state='OPENING';}
    }else if(this.state==='OPENING'){
      if(valid&&s.angleDeg>this.events.start.angleDeg+this.c.departureDeg){
        if(this.opening.length&&s.angleDeg<this.opening.at(-1).angleDeg-this.c.departureDeg)return this.fail('Opening reversed direction; retry the sweep.');
        this.events.openingStart??={timestampMs:previous?.timestampMs??t};this.opening.push(s);
        if(this.opening.length>=this.c.minSamples&&span(this.opening)>=this.c.minSpanDeg)this.referenceSpeed=this.velocity(this.opening);
      }
      if(this.manualUpper!==null&&this.manualUpper!==undefined&&t-this.manualUpper>=this.c.holdMs)this.upper(this.manualUpper,'manual-user-endpoint');
      else if(!valid&&this.referenceSpeed&&rotation!==null&&rotation<=this.c.stationaryRotationDegS){
        this.stopStart??=t;
        if(t-this.stopStart>=this.c.holdMs)this.upper(this.stopStart,'visual-stop-user-endpoint');
      }else this.stopStart=null;
    }else if(this.state==='UPPER_HOLD'){
      if(rotation!==null&&rotation>=this.c.movingRotationDegS)this.beginClosing(m.fromTimestampMs,'visual-motion');
    }else if(this.state==='CLOSING'||this.state==='LOWER_HOLD'){
      if(valid){
        if(this.closing.length&&s.angleDeg>this.closing.at(-1).angleDeg+this.c.departureDeg)return this.fail('Closing reversed direction; retry the sweep.');
        this.closing.push(s);
      }
      this.state=valid&&s.angleDeg<this.c.smallAngleExclusive?'LOWER_HOLD':'CLOSING';
      if(this.steady(t)){
        const end={timestampMs:this.window[0].timestampMs,angleDeg:median(this.window.map(p=>p.angleDeg))};
        const moving=this.closing.filter(p=>p.timestampMs<end.timestampMs-this.c.boundaryMs);
        const first=moving[0],speed=first?(this.c.upperAngle-first.angleDeg)*1000/(first.timestampMs-this.events.closingStart.timestampMs):null;
        const measured=moving.length>=this.c.minSamples&&span(moving)>=this.c.minSpanDeg?-this.velocity(moving):null;
        if(!this.pace(speed)||!this.pace(measured)||Math.abs(speed/measured-1)>this.c.paceTolerance)return this.fail('Closing pace or keyboard coverage failed. Retry at the indicated pace.');
        this.events.end=end;this.closingSpeed=speed;this.closingKeyboardSpeed=measured;this.state='TRAINING';
      }
    }
    return this.status();
  }
  status(){return {state:this.state,reason:this.reason,referenceSpeedDegS:this.referenceSpeed,
    openingSpeedDegS:this.openingSpeed??null,closingSpeedDegS:this.closingSpeed??null,
    initialAngleDeg:this.events.start?.angleDeg??null,finalAngleDeg:this.events.end?.angleDeg??null,
    matchedFrames:this.samples.length,manualUpperPending:this.manualUpper!==null&&this.manualUpper!==undefined};}
  export(){return {schemaVersion:1,kind:'fusion-sweep-calibration',metadata:this.metadata,config:this.c,keyboardModel:this.keyboardModel,
    events:this.events,samples:this.samples,opening:this.opening,closing:this.closing,
    referenceSpeedDegS:this.referenceSpeed,openingSpeedDegS:this.openingSpeed,closingSpeedDegS:this.closingSpeed,
    closingKeyboardSpeedDegS:this.closingKeyboardSpeed,...this.status()};}
}
