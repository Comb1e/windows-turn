import { physicalStep, physicalDerivatives } from './motion-feedforward.js';
import { trajectory } from './trajectory.js';
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));

/** Continuous position, speed, acceleration and jerk with an immutable chase deadline. */
export class DisplayController {
  constructor(config){
    this.c={trackingHorizonMs:250,trackingMaxMs:1000,preferredSpeedDegS:4,motionAllowance:.2,
      preferredAccelerationDegS2:15,preferredJerkDegS3:60,maxInitialMs:950,deadlineMs:1000,
      toleranceDeg:1,candidateStepMs:250,replanVelocityDegS:.15,replanAngleDeg:.05,displayHoldMs:500,...config};
    this.state=[config.initialAngle,0,0,0];this.physical=[config.initialAngle,0,0,0];this.rawMotion=0;this.velocity=0;this.time=null;this.plan=null;
    this.mode='STALE';this.chase=null;this.lastChase=null;this.target=null;
    this.lastMeasurement=null;this.targetHeld=false;
    this.comfortExceeded=false;this.peaks=[0,0,0];
  }
  get angle(){return this.state[0];}
  get tau(){return this.c.motionTauMs/3000;}
  sample(timestamp){
    const dt=this.time===null?0:Math.max(0,timestamp-this.time)/1000;
    const physical=physicalStep(this.physical,this.rawMotion,dt,this.tau);
    const base=physicalDerivatives(physical,this.tau);
    const correction=this.plan?this.plan.curve.at((timestamp-this.plan.start)/1000):[0,0,0,0];
    return base.map((v,i)=>v+correction[i]);
  }
  advance(timestamp,elapsed){
    const steps=Math.max(1,Math.ceil(elapsed/this.c.maxStepMs));
    for(let i=0;i<steps;i++)this.physical=physicalStep(this.physical,this.rawMotion,elapsed/steps/1000,this.tau);
    const base=physicalDerivatives(this.physical,this.tau);
    const correction=this.plan?this.plan.curve.at((timestamp-this.plan.start)/1000):[0,0,0,0];
    this.state=base.map((v,i)=>v+correction[i]);this.velocity=base[1];
    const bounded=clamp(this.state[0],this.c.minAngle,this.c.maxAngle);
    if(bounded!==this.state[0]){this.state=[bounded,0,0,0];this.physical=[bounded,0,0,0];this.velocity=0;this.plan=null;}
  }
  makePlan(target,timestamp){
    const c=this.c,remaining=this.chase&&!this.chase.overdue?this.chase.deadline-timestamp:c.trackingMaxMs;
    const maximum=Math.max(1,Math.min(remaining,this.chase&&this.chase.start===timestamp?c.maxInitialMs:remaining));
    const minimum=Math.min(c.trackingHorizonMs,maximum),durations=[];
    for(let ms=minimum;ms<maximum;ms+=c.candidateStepMs)durations.push(ms);
    durations.push(maximum);
    const limits=[c.preferredSpeedDegS+c.motionAllowance*Math.abs(this.velocity),c.preferredAccelerationDegS2,c.preferredJerkDegS3];
    let chosen=null;
    for(const ms of durations){
      const base=physicalDerivatives(this.physical,this.tau);
      const future=physicalStep(this.physical,this.rawMotion,ms/1000,this.tau);
      const end=clamp(target+this.rawMotion*ms/1000,c.minAngle,c.maxAngle);
      const futureState=physicalDerivatives(future,this.tau);
      const atBoundary=end===c.minAngle||end===c.maxAngle;
      const terminal=[end-future[0],...futureState.slice(1).map(v=>atBoundary?-v:0)];
      const curve=trajectory(this.state.map((v,i)=>v-base[i]),terminal,ms/1000),peaks=curve.peaks();
      const score=Math.max(...peaks.map((p,i)=>(p/limits[i])**(1/(i+1))));
      const candidate={curve,peaks,score,start:timestamp,end:timestamp+ms,target,velocity:this.rawMotion};
      if(!chosen||score<chosen.score)chosen=candidate;
      if(score<=1){chosen=candidate;break;}
    }
    this.plan=chosen;this.peaks=chosen.peaks;this.comfortExceeded=chosen.score>1+1e-6;
  }
  update(target,motion,timestamp,observation=null){
    if(!Number.isFinite(timestamp))throw new Error('Invalid controller timestamp');
    if(this.time!==null&&timestamp<=this.time)return this.snapshot();
    const elapsed=this.time===null?0:timestamp-this.time;
    const current=Number.isFinite(target);
    if(current)this.lastMeasurement={angle:target,timestampMs:observation?.timestampMs??timestamp,
      extrapolateTarget:observation?.extrapolateTarget!==false};
    const age=this.lastMeasurement?timestamp-this.lastMeasurement.timestampMs:Infinity;
    this.targetHeld=!current&&age>=0&&age<=this.c.displayHoldMs;
    if((!current&&!this.targetHeld)||elapsed>this.c.staleMs){
      // Freeze across a genuine gap, but never grant an existing chase a new deadline.
      if(this.chase&&timestamp>=this.chase.deadline&&!this.chase.overdue){
        this.chase.overdue=true;this.lastChase={...this.chase,completed:false,reason:'stale-input',ended:timestamp};
      }
      this.state=[this.angle,0,0,0];this.physical=[this.angle,0,0,0];this.rawMotion=0;this.time=timestamp;
      this.velocity=0;this.plan=null;this.mode='STALE';this.target=null;this.peaks=[0,0,0];this.comfortExceeded=false;this.targetHeld=false;
      return this.snapshot();
    }
    this.advance(timestamp,elapsed);this.time=timestamp;this.rawMotion=Number.isFinite(motion)?motion:0;
    // An authoritative observation is the feedback target even while the physical
    // motion filter still carries velocity from the previously selected source.
    const offset=this.lastMeasurement.extrapolateTarget?this.velocity*Math.max(0,age)/1000:0;
    const aligned=clamp(this.lastMeasurement.angle+offset,this.c.minAngle,this.c.maxAngle);
    const error=aligned-this.angle;this.target=aligned;
    const base=physicalDerivatives(this.physical,this.tau);
    const settled=Math.abs(error)<=this.c.toleranceDeg&&(timestamp>=this.plan?.end||
      Math.abs(this.state[1]-this.velocity)<.2&&Math.abs(this.state[2]-base[2])<.5&&Math.abs(this.state[3]-base[3])<1);
    if(this.chase&&current&&settled){
      this.lastChase={...this.chase,ended:timestamp,errorDeg:error,completed:true,deadlineMet:timestamp<=this.chase.deadline};this.chase=null;
    }else if(this.chase&&timestamp>=this.chase.deadline&&!this.chase.overdue){
      this.chase.overdue=true;this.lastChase={...this.chase,ended:timestamp,errorDeg:error,completed:false,reason:'deadline-missed'};
    }
    if(!this.chase&&current&&Math.abs(error)>this.c.toleranceDeg)this.chase={start:timestamp,deadline:timestamp+this.c.deadlineMs,overdue:false};
    this.mode=this.chase?'CHASING':'TRACKING';
    const predicted=this.plan?this.plan.target+this.plan.velocity*(timestamp-this.plan.start)/1000:null;
    if(!this.plan||timestamp>=this.plan.end||Math.abs(aligned-predicted)>this.c.replanAngleDeg
      ||Math.abs(this.rawMotion-this.plan.velocity)>this.c.replanVelocityDegS){this.makePlan(aligned,timestamp);}
    return this.snapshot();
  }
  snapshot(){return {displayAngleDeg:this.angle,motionVelocityDegS:this.velocity,displayVelocityDegS:this.state[1],
    displayAccelerationDegS2:this.state[2],displayJerkDegS3:this.state[3],controllerState:this.mode,
    targetAngleDeg:this.target,correctionErrorDeg:this.target===null?null:this.target-this.angle,
    correctionElapsedMs:this.chase?this.time-this.chase.start:0,correctionRemainingMs:this.chase?Math.max(0,this.chase.deadline-this.time):0,
    correctionDeadlineMs:this.chase?.deadline??null,correctionOverdue:this.chase?.overdue??false,
    displayTargetHeld:this.targetHeld,displayTargetAgeMs:this.lastMeasurement?this.time-this.lastMeasurement.timestampMs:null,comfortExceeded:this.comfortExceeded,lastCorrection:this.lastChase,
    plannedCorrectionPeaks:this.peaks,displaySpeedBoundDegS:Math.abs(this.velocity)+this.peaks[0]};}
}

export function robustVelocity(samples,config) {
  if(samples.length<config.velocityMinSamples||samples.at(-1).timestampMs-samples[0].timestampMs<config.velocityMinSpanMs)return null;
  // Theil-Sen slopes withstand occasional timing/quantization irregularities.
  const slopes=[];
  for(let i=0;i<samples.length;i++)for(let j=i+1;j<samples.length;j++){
    const dt=samples[j].timestampMs-samples[i].timestampMs;
    if(dt>0)slopes.push((samples[j].angleDeg-samples[i].angleDeg)*1000/dt);
  }
  slopes.sort((a,b)=>a-b);const m=Math.floor(slopes.length/2);
  const value=slopes.length%2?slopes[m]:(slopes[m-1]+slopes[m])/2;
  return Number.isFinite(value)&&Math.abs(value)<=config.maxVelocityDegS?value:null;
}

export class FusionEngine {
  constructor(config){this.c=config;this.controller=new DisplayController(config.display);this.results={};this.history=[];this.lastKeyboard=null;this.lastValid=null;}
  ingest(kind,result) {
    const old=this.results[kind];
    if(old&&result.timestampMs<=old.timestampMs)return false;
    this.results[kind]=result;
    if(kind==='keyboard') {
      if(result.valid&&Number.isFinite(result.angleDeg)){
        if(this.history.length && result.timestampMs-this.history.at(-1).timestampMs>this.c.selection.velocityWindowMs)this.history=[];
        this.history.push(result);this.history=this.history.filter(p=>result.timestampMs-p.timestampMs<=this.c.selection.velocityWindowMs);
        this.lastKeyboard=result;
      } else this.history=[];
    }
    return true;
  }
  invalidate(kind){delete this.results[kind];if(kind==='keyboard')this.history=[];}
  tick(now) {
    const fresh=result=>result && now>=result.timestampMs && now-result.timestampMs<=this.c.selection.staleMs;
    const k=this.results.keyboard,l=this.results.lighting;
    let selected=null,source='none',state='UNAVAILABLE',held=false;
    if(fresh(k)&&k.valid&&Number.isFinite(k.angleDeg)) {selected=k;source='keyboard';state='KEYBOARD';}
    else if(this.lastKeyboard&&now-this.lastKeyboard.timestampMs>=0&&now-this.lastKeyboard.timestampMs<=this.c.selection.keyboardGraceMs){selected=this.lastKeyboard;source='keyboard';state='KEYBOARD_GRACE';held=true;}
    else if(fresh(l)&&l.valid&&Number.isFinite(l.angleDeg)){selected=l;source='lighting';state='LIGHTING';}
    let motion=null,motionSource='unavailable';
    if(source==='keyboard'&&!held){motion=robustVelocity(this.history,this.c.selection);if(motion!==null)motionSource='keyboard';}
    // Sparse or briefly missing keyboard samples are not permission to steer a
    // keyboard target with unrelated scene motion. Retained display targets keep
    // their source policy until a fallback is actually selected.
    const keyboardTarget=(selected?source:this.lastValid?.source)==='keyboard';
    if(!keyboardTarget&&motion===null&&fresh(l)&&Number.isFinite(l.motion?.velocityDegS)){motion=l.motion.velocityDegS;motionSource='scene';}
    const output=this.controller.update(selected?.angleDeg??null,motion,now,selected?{timestampMs:selected.timestampMs,
      extrapolateTarget:source!=='keyboard',key:`${source}:${selected.frameId}:${selected.modelGeneration??0}`}:null);
    if(selected)this.lastValid={angleDeg:selected.angleDeg,timestampMs:selected.timestampMs,source};
    return {...output,timestampMs:now,measurementAngleDeg:selected?.angleDeg??null,source,state,held,
      measurementTimestampMs:selected?.timestampMs??null,measurementAgeMs:selected?now-selected.timestampMs:null,
      displayAgeMs:this.lastValid?now-this.lastValid.timestampMs:null,lastValid:this.lastValid,
      authoritative:source==='keyboard'&&!held,provisional:source==='lighting'||held,motionSource,
      adaptation:l?.adaptation??null,sourceQuality:selected?.quality??null,frameId:selected?.frameId??null};
  }
}
