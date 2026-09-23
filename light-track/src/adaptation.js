// Session-only output calibration. The source forest is never modified.
export const median = values => {
  const a=[...values].sort((x,y)=>x-y), m=Math.floor(a.length/2);
  return a.length ? (a.length%2 ? a[m] : (a[m-1]+a[m])/2) : null;
};
const span = a => Math.max(...a)-Math.min(...a);
const huberWeight = (error,delta) => Math.min(1,delta/Math.max(Math.abs(error),1e-12));

export class SessionAdapter {
  constructor(config) {this.c=config;this.version=0;this.segment=0;this.reset(config.initialAngle,'assumed-start');}
  reset(prior,origin='carried-estimate') {
    this.segment++;this.version++;this.a=1;this.b=0;this.prior=prior;this.origin=origin;
    this.state='BOOTSTRAP';this.samples=[];this.anchors=[];this.start=null;this.lastSettings=null;
    this.settingsChangedAt=null;this.bootstrap=null;this.lastFit=-Infinity;this.reason=null;this.lastAngle=null;
  }
  suspend(reason) {this.state='SUSPENDED';this.reason=reason;}
  initializeModel() {
    this.a=1;this.b=0;this.origin='model-output';this.bootstrap={z:0,angle:0,origin:'model-output',settled:true};
    this.version++;return this;
  }
  observe(z,timestamp,settingsKey) {
    if(!Number.isFinite(z)) return null;
    if(this.start===null) this.start=timestamp;
    if(this.lastSettings!==settingsKey) this.settingsChangedAt=timestamp;
    this.lastSettings=settingsKey;
    if(this.state==='SUSPENDED') return null;
    if(this.bootstrap===null) {
      this.samples.push(z);
      if(this.samples.length>this.c.maxBootstrapSamples)this.samples.shift();
      const settled=timestamp-this.settingsChangedAt>=this.c.settleMs;
      if(timestamp-this.start>=this.c.settleMs && (settled || timestamp-this.start>=this.c.maxSettleMs)) {
        const raw=median(this.samples);
        this.bootstrap={z:raw,angle:this.prior,origin:this.origin,settled};
        this.b=this.prior-raw;this.version++;
      } else return null;
    }
    this.fit(timestamp);
    const angle=this.a*z+this.b;
    this.lastAngle=angle;
    // Do not silently turn out-of-range extrapolations into confident endpoints.
    return angle>=this.c.minAngle && angle<=this.c.maxAngle ? angle : null;
  }
  add(sample,angle) {
    if(!Number.isFinite(angle) || angle<this.c.minAngle || angle>this.c.maxAngle || !Number.isFinite(sample.raw))throw new Error('Invalid keyboard anchor');
    if(this.anchors.some(a=>a.frameId===sample.frameId))return false;
    const bin=Math.floor(angle/this.c.binDegrees);
    const previous=this.anchors.findLast(a=>a.bin===bin);
    if(previous && sample.timestampMs-previous.timestampMs<this.c.anchorIntervalMs)return false;
    this.anchors.push({...sample,angle,bin,source:'keyboard'});
    if(this.anchors.length>this.c.maxAnchors) {
      const counts=new Map();for(const a of this.anchors)counts.set(a.bin,(counts.get(a.bin)||0)+1);
      const fullest=[...counts].sort((a,b)=>b[1]-a[1])[0][0];
      this.anchors.splice(this.anchors.findIndex(a=>a.bin===fullest),1);
    }
    if(this.bootstrap===null) {this.bootstrap={z:sample.raw,angle,origin:'keyboard',settled:true};this.b=angle-sample.raw;}
    this.state=this.state==='SUSPENDED'?'OFFSET_ADAPTED':this.state;
    this.fit(sample.timestampMs);
    return true;
  }
  fit(timestamp) {
    if(!this.anchors.length || timestamp-this.lastFit<this.c.refitMs)return;
    this.lastFit=timestamp;
    // Equal total weight per angular bin prevents repeated angles dominating live adaptation.
    const bins=new Map();for(const p of this.anchors){if(!bins.has(p.bin))bins.set(p.bin,[]);bins.get(p.bin).push(p);}
    const points=[...bins.values()].map(v=>({z:median(v.map(p=>p.raw)),y:median(v.map(p=>p.angle)),weight:1}));
    const affine=points.length>=this.c.minBins && span(points.map(p=>p.y))>=this.c.minAngleSpan && span(points.map(p=>p.z))>=this.c.minPredictionSpan;
    let a=1,b=median(points.map(p=>p.y-p.z));
    const center=median(points.map(p=>p.z));
    const training=[...points];
    if(this.bootstrap?.origin!=='keyboard'&&this.bootstrap?.origin!=='model-output')training.push({z:this.bootstrap.z,y:this.bootstrap.angle,weight:this.c.startupWeight});
    for(let iteration=0;iteration<this.c.fitIterations;iteration++) {
      let sw=0,sx=0,sy=0,sxx=this.c.ridge,sxy=this.c.ridge;
      for(const p of training){const w=p.weight*huberWeight(a*p.z+b-p.y,this.c.huberDegrees),x=p.z-center;
        sw+=w;sx+=w*x;sy+=w*p.y;sxx+=w*x*x;sxy+=w*x*p.y;}
      if(affine) {
        const determinant=sxx*sw-sx*sx;
        if(determinant<=1e-9){this.reason='Ill-conditioned affine fit';return;}
        a=(sxy*sw-sx*sy)/determinant;b=(sy-a*sx)/sw-a*center;
      } else b=training.reduce((sum,p)=>sum+p.weight*huberWeight(p.z+b-p.y,this.c.huberDegrees)*(p.y-p.z),0)/sw;
    }
    if(!Number.isFinite(a+b) || Math.abs(a)>this.c.maxAbsScale || Math.abs(a)<this.c.minAbsScale){this.reason='Unsupported affine scale';return;}
    this.a=a;this.b=b;this.state=affine?'AFFINE_ADAPTED':'OFFSET_ADAPTED';this.reason=affine?null:'Scale awaits sufficient prediction and angle diversity';this.version++;
  }
  status() {
    return {state:this.state,version:this.version,segment:this.segment,a:this.a,b:this.b,anchorCount:this.anchors.length,
      anchorRange:this.anchors.length?[Math.min(...this.anchors.map(a=>a.angle)),Math.max(...this.anchors.map(a=>a.angle))]:null,
      provisional:true,origin:this.origin,prior:this.prior,reason:this.reason,bootstrap:this.bootstrap};
  }
  export() {return {kind:'temporary-lighting-adaptation',schemaVersion:1,...this.status(),anchors:structuredClone(this.anchors),
    runtime:{start:this.start,lastFit:Number.isFinite(this.lastFit)?this.lastFit:null,lastSettings:this.lastSettings,settingsChangedAt:this.settingsChangedAt,samples:[...this.samples],lastAngle:this.lastAngle}};}
  static restore(config,snapshot) {
    const a=new SessionAdapter(config);
    if(!snapshot)return a;
    if(snapshot.kind!=='temporary-lighting-adaptation'||snapshot.schemaVersion!==1||!Array.isArray(snapshot.anchors)||snapshot.anchors.length>config.maxAnchors
      ||![snapshot.a,snapshot.b,snapshot.prior].every(Number.isFinite))throw new Error('Invalid adapter snapshot');
    for(const key of ['a','b','prior','origin','state','version','segment','bootstrap','reason'])a[key]=structuredClone(snapshot[key]);
    a.anchors=structuredClone(snapshot.anchors);
    Object.assign(a,structuredClone(snapshot.runtime));a.lastFit=snapshot.runtime.lastFit??-Infinity;
    return a;
  }
}
