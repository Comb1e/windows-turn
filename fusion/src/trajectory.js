// Polynomial coefficients use normalized time, avoiding tiny powers of seconds.
export const derivative = p => p.slice(1).map((v,i)=>v*(i+1));
export const evaluate = (p,x) => p.reduceRight((sum,v)=>sum*x+v,0);

/** Isolate all real roots in [0,1] between roots of the derivative. */
export function roots(p) {
  p=[...p];while(p.length>1&&Math.abs(p.at(-1))<1e-12)p.pop();
  if(p.length<2)return [];
  if(p.length===2){const x=-p[0]/p[1];return x>=0&&x<=1?[x]:[];}
  const cuts=[0,...roots(derivative(p)),1].sort((a,b)=>a-b),out=[];
  const tolerance=1e-10*Math.max(1,...p.map(Math.abs));
  for(const x of cuts)if(Math.abs(evaluate(p,x))<=tolerance)out.push(x);
  for(let i=1;i<cuts.length;i++){
    let lo=cuts[i-1],hi=cuts[i],f=evaluate(p,lo);
    if(f*evaluate(p,hi)>=0)continue;
    for(let n=0;n<48;n++){const mid=(lo+hi)/2,g=evaluate(p,mid);if(f*g<=0)hi=mid;else{lo=mid;f=g;}}
    out.push((lo+hi)/2);
  }
  return [...new Set(out.map(x=>Math.round(x*1e12)/1e12))];
}

/** Unique minimum-snap septic matching position, velocity, acceleration and jerk. */
export function trajectory(start,end,seconds) {
  if(!(seconds>0))throw new Error('Trajectory duration must be positive');
  const p=[start[0],start[1]*seconds,start[2]*seconds**2/2,start[3]*seconds**3/6];
  const rows=[[1,1,1,1],[4,5,6,7],[12,20,30,42],[24,60,120,210]];
  let low=p;
  for(let i=0;i<4;i++){rows[i].push(end[i]*seconds**i-evaluate(low,1));low=derivative(low);}
  for(let col=0;col<4;col++){
    const divisor=rows[col][col];for(let j=col;j<5;j++)rows[col][j]/=divisor;
    for(let row=0;row<4;row++)if(row!==col){const f=rows[row][col];for(let j=col;j<5;j++)rows[row][j]-=f*rows[col][j];}
  }
  p.push(...rows.map(row=>row[4]));
  const polys=[p];for(let i=1;i<5;i++)polys.push(derivative(polys.at(-1)));
  return {
    seconds,
    at(time){const x=Math.max(0,Math.min(1,time/seconds));return polys.slice(0,4).map((q,i)=>evaluate(q,x)/seconds**i);},
    peaks(physicalVelocity=0){return [1,2,3].map(order=>{
      const q=polys[order].map(v=>v/seconds**order);if(order===1)q[0]-=physicalVelocity;
      return Math.max(...[0,1,...roots(polys[order+1])].map(x=>Math.abs(evaluate(q,x))));
    });}
  };
}
