/** Three identical low-pass stages: velocity, acceleration and jerk stay continuous.
 * Their combined mean delay is motionTauMs. Integration is exact for constant input.
 */
export function physicalStep(state,motion,seconds,tauSeconds){
  const [position,v1,v2,v3]=state,h=seconds/tauSeconds,decay=Math.exp(-h);
  const a=v1-motion,b=v2-motion,c=v3-motion;
  return [position+motion*seconds+tauSeconds*(a+b+c-decay*(c+b*(h+1)+a*(h*h/2+h+1))),
    motion+decay*a,motion+decay*(b+a*h),motion+decay*(c+b*h+a*h*h/2)];
}
export function physicalDerivatives(state,tauSeconds){
  const [position,v1,v2,v3]=state;
  return [position,v3,(v2-v3)/tauSeconds,(v1-2*v2+v3)/tauSeconds**2];
}
