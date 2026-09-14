export function quantile(values,p){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y),i=(a.length-1)*p;return a[Math.floor(i)]+(a[Math.ceil(i)]-a[Math.floor(i)])*(i%1);}
export function errors(rows,key){
  const labeled=rows.filter(r=>Number.isFinite(r.reference)),valid=labeled.filter(r=>Number.isFinite(r[key]));
  const e=valid.map(r=>Math.abs(r[key]-r.reference));
  return {labeled:labeled.length,valid:valid.length,coverage:labeled.length?valid.length/labeled.length:null,
    meanAbsoluteError:e.length?e.reduce((a,b)=>a+b,0)/e.length:null,medianAbsoluteError:quantile(e,.5),p95AbsoluteError:quantile(e,.95),
    within5AmongValid:e.length?e.filter(v=>v<=5).length/e.length:null,within5IncludingMissing:labeled.length?e.filter(v=>v<=5).length/labeled.length:null};
}
export function temporal(rows,key,maxGapMs=250){
  const groups=[];let current=[];
  for(const r of rows){
    const previous=current.at(-1),valid=Number.isFinite(r.reference)&&Number.isFinite(r[key]);
    if(!valid||previous&&(r.timestampMs-previous.timestampMs>maxGapMs||r.motion!==previous.motion||r.referenceSource!==previous.referenceSource||r.checkpoint!==previous.checkpoint)){
      if(current.length)groups.push(current);current=[];
    }
    if(valid)current.push(r);
  }
  if(current.length)groups.push(current);
  const residuals=[],delays=[];
  for(const group of groups){
    if(group[0].motion==='stationary'&&group.length>=5&&group.at(-1).timestampMs-group[0].timestampMs>=500){
      const residual=group.map(r=>r[key]-r.reference),mean=residual.reduce((a,b)=>a+b,0)/residual.length;
      residuals.push(...residual.map(v=>v-mean));
    } else if(group[0].motion==='moving'&&group[0].referenceSource==='reference'&&group.length>=10&&group.at(-1).timestampMs-group[0].timestampMs>=1500){
      if(Math.max(...group.map(r=>r.reference))-Math.min(...group.map(r=>r.reference))<10)continue;
      let best=null;
      for(let delay=0;delay<=1000;delay+=10){
        let loss=0,count=0,j=0;
        for(const r of group){if(r.timestampMs<group[0].timestampMs+1000)continue;const t=r.timestampMs-delay;
          while(j+1<group.length&&group[j+1].timestampMs<t)j++;
          const a=group[j],b=group[j+1];if(!b)continue;
          const reference=a.reference+(b.reference-a.reference)*(t-a.timestampMs)/(b.timestampMs-a.timestampMs);
          loss+=(r[key]-reference)**2;count++;
        }
        if(count&&(!best||loss/count<best.loss))best={loss:loss/count,delay};
      }
      if(best)delays.push(best.delay/1000);
    }
  }
  return {stationaryJitterRms:residuals.length?Math.sqrt(residuals.reduce((a,b)=>a+b*b,0)/residuals.length):null,
    motionDelayP95Seconds:quantile(delays,.95),synchronizedMovingSegments:delays.length};
}
