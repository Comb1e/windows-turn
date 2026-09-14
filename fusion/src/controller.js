const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));

/** Continuous motion feedforward plus filtered, bounded error feedback. */
export class DisplayController {
  constructor(config){this.c=config;this.angle=config.initialAngle;this.velocity=0;this.correction=0;this.time=null;this.displayVelocity=0;}
  update(target,motion,timestamp) {
    if(!Number.isFinite(timestamp))throw new Error('Invalid controller timestamp');
    if(this.time!==null && timestamp<=this.time)return this.snapshot();
    const elapsed=this.time===null?0:timestamp-this.time;this.time=timestamp;
    if(!Number.isFinite(target)||elapsed>this.c.staleMs){this.velocity=0;this.correction=0;this.displayVelocity=0;return this.snapshot();}
    const steps=Math.max(1,Math.ceil(elapsed/this.c.maxStepMs)),dt=elapsed/steps;
    for(let i=0;i<steps;i++){
      this.velocity+=(1-Math.exp(-dt/this.c.motionTauMs))*((Number.isFinite(motion)?motion:0)-this.velocity);
      const allowance=this.c.restCorrectionDegS+this.c.motionAllowance*Math.abs(this.velocity);
      const requested=Math.tanh(this.c.errorGain*(target-this.angle)/allowance);
      this.correction=clamp(this.correction+(1-Math.exp(-dt/this.c.correctionTauMs))*(requested-this.correction),-1,1);
      this.displayVelocity=this.velocity+allowance*this.correction;
      this.angle=clamp(this.angle+this.displayVelocity*dt/1000,this.c.minAngle,this.c.maxAngle);
    }
    return this.snapshot();
  }
  snapshot(){return {displayAngleDeg:this.angle,motionVelocityDegS:this.velocity,displayVelocityDegS:this.displayVelocity,
    displaySpeedBoundDegS:(1+this.c.motionAllowance)*Math.abs(this.velocity)+this.c.restCorrectionDegS};}
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
    if(motion===null&&fresh(l)&&Number.isFinite(l.motion?.velocityDegS)){motion=l.motion.velocityDegS;motionSource='scene';}
    const output=this.controller.update(selected?.angleDeg??null,motion,now);
    if(selected)this.lastValid={angleDeg:selected.angleDeg,timestampMs:selected.timestampMs,source};
    return {...output,timestampMs:now,measurementAngleDeg:selected?.angleDeg??null,source,state,held,
      measurementTimestampMs:selected?.timestampMs??null,measurementAgeMs:selected?now-selected.timestampMs:null,
      displayAgeMs:this.lastValid?now-this.lastValid.timestampMs:null,lastValid:this.lastValid,
      authoritative:source==='keyboard'&&!held,provisional:source==='lighting'||held,motionSource,
      adaptation:l?.adaptation??null,sourceQuality:selected?.quality??null,frameId:selected?.frameId??null};
  }
}
