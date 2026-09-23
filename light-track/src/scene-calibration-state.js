export const sceneStates=['Idle','Collecting','Fitting','Ready','Invalidated','Failed'];
export function sceneTransition(state,event) {
  const next={Idle:{START:'Collecting'},Collecting:{FIT:'Fitting',RESET:'Invalidated'},Fitting:{SUCCESS:'Ready',FAIL:'Failed',RESET:'Invalidated'},
    Ready:{START:'Collecting',RESET:'Invalidated'},Invalidated:{START:'Collecting'},Failed:{START:'Collecting',FIT:'Fitting',RESET:'Invalidated'}}[state]?.[event];
  if(!next)throw new Error(`Invalid scene calibration transition ${state}: ${event}`);
  return next;
}
export function sceneReferenceSummary(samples,settings) {
  const values=samples.filter(s=>Number.isFinite(s.angleDeg)),angles=[...new Set(values.map(s=>s.angleDeg))].sort((a,b)=>a-b);
  const span=angles.length?angles.at(-1)-angles[0]:0;
  return {count:values.length,distinct:angles.length,range:angles.length?[angles[0],angles.at(-1)]:null,
    canFit:angles.length>=settings.minDistinctAngles&&span+settings.angleToleranceDeg>=settings.minSpanDeg&&values.length<=settings.maxReferences,
    suggestion:settings.suggestedAngles.find(a=>!angles.some(v=>Math.abs(v-a)<3))??null};
}
