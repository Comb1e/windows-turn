import { FEATURE_VERSION, featureNames } from './features.js';
import { OneEuroFilter } from './filter.js';

const finiteArray = (a,n) => Array.isArray(a) && a.length===n && a.every(Number.isFinite);
export function validateModel(model, featureConfig) {
  if(model?.version===2)return validateImageModel(model,featureConfig);
  const names=featureNames(featureConfig), n=names.length;
  if (model?.version!==1 || model.featureVersion!==FEATURE_VERSION || JSON.stringify(model.featureNames)!==JSON.stringify(names) || Object.keys(featureConfig).some(k=>model.featureConfig?.[k]!==featureConfig[k])) throw new Error('Model feature schema does not match this application.');
  if (!finiteArray(model.normalization?.mean,n) || !finiteArray(model.normalization?.scale,n) || model.normalization.scale.some(v=>v<=0)) throw new Error('Invalid model normalization.');
  if (!finiteArray(model.angleRange,2) || model.angleRange[0]>model.angleRange[1]) throw new Error('Invalid model angle range.');
  if (model.trainingMode!=='screenshot-groups' && (model.angleRange[0]!==10 || model.angleRange[1]!==120)) throw new Error('Legacy models must cover 10°–120°.');
  validateTrees(model.trees,n,model.angleRange);
  for (const key of ['residual95','distance95','spread95']) if (!Number.isFinite(model.calibration?.[key]) || model.calibration[key]<0) throw new Error('Invalid uncertainty calibration.');
  validateFilter(model.filter);
  return model;
}
function validateFilter(filter) {
  for (const key of ['minCutoff','derivativeCutoff','resetGapSeconds']) if (!Number.isFinite(filter?.[key]) || filter[key]<=0) throw new Error('Invalid filter settings.');
  if (!Number.isFinite(filter.beta) || filter.beta<0) throw new Error('Invalid filter beta.');
}
function validateTrees(trees,n,range) {
  if (!Array.isArray(trees) || !trees.length || trees.length>256) throw new Error('Invalid tree ensemble.');
  for (const tree of trees) {
    if (!Array.isArray(tree) || !tree.length || tree.length>8191) throw new Error('Model tree is too large.');
    const parents=new Uint16Array(tree.length);
    tree.forEach((node,i)=>{
      if (!finiteArray(node,5)) throw new Error('Invalid model node.');
      const [feature,,left,right,value]=node;
      if (feature===-1) { if (left!==-1 || right!==-1 || value<range[0] || value>range[1]) throw new Error('Invalid model leaf.'); }
      else {
        if (!Number.isInteger(feature) || feature<0 || feature>=n || !Number.isInteger(left) || !Number.isInteger(right) || left<=i || right<=i || left>=tree.length || right>=tree.length || left===right) throw new Error('Invalid tree children.');
        parents[left]++; parents[right]++;
      }
    });
    if (parents.some((p,i)=>i>0 && p!==1)) throw new Error('Tree contains unreachable/shared nodes.');
  }
}
function validateImageModel(model,featureConfig) {
  if(!finiteArray(model.angleRange,2)||model.angleRange[0]>model.angleRange[1]||typeof model.modelId!=='string')throw new Error('Invalid image model identity/range');
  validateFilter(model.filter);
  if(!Number.isFinite(model.calibration?.residual95)||model.calibration.residual95<0)throw new Error('Invalid image model uncertainty');
  if(model.kind==='scene-calibrated-model') {
    if(!model.baseModel||model.baseModel.kind==='scene-calibrated-model')throw new Error('Nested scene calibration is not supported');
    validateModel(model.baseModel,featureConfig);
    if(model.baseModelId!==model.baseModel.modelId||JSON.stringify(model.capture)!==JSON.stringify(model.baseModel.capture))throw new Error('Scene profile binding differs from base model');
    if(!finiteArray(model.referenceRange,2)||model.referenceRange[0]>model.referenceRange[1]||!Number.isInteger(model.referenceCount)||model.referenceCount<3||model.referenceCount>100)throw new Error('Invalid scene references');
    const fit=model.calibrationFit;
    if(fit?.kind!=='affine'||!Number.isFinite(fit.a)||!Number.isFinite(fit.b)||Math.abs(fit.a)>4||Math.abs(fit.a)<.25)throw new Error('Unsupported scene correction');
    return model;
  }
  if(model.kind!=='image-angle-model'||model.promotionPassed!==true)throw new Error('Experimental image model has not passed promotion checks');
  if(!Array.isArray(model.families)||!model.families.length||new Set(model.families).size!==model.families.length||model.families.some(f=>!['legacy','lighting','texture','metadata','dino','depth'].includes(f)))throw new Error('Invalid image feature families');
  const t=model.transform,n=t?.columns?.length;
  if(!Number.isInteger(n)||n<1||n>20000||!t.columns.every(i=>Number.isInteger(i)&&i>=0&&i<20000)||new Set(t.columns).size!==n||!finiteArray(t.mean,n)||!finiteArray(t.scale,n)||t.scale.some(s=>s<=0))throw new Error('Invalid image feature transform');
  const c=model.featureConfig;
  if(!c||!Array.isArray(c.pyramid)||c.pyramid.length>4||c.pyramid.some(v=>!Number.isInteger(v)||v<1||v>8)||!Array.isArray(c.quantiles)||c.quantiles.length>10||c.quantiles.some(v=>!Number.isFinite(v)||v<0||v>1))throw new Error('Invalid image feature configuration');
  for(const key of ['maxSide','visionSide','depthSide'])if(!Number.isInteger(c[key])||c[key]<16||c[key]>1024)throw new Error('Invalid image feature dimensions');
  if(!Number.isFinite(c.epsilon)||c.epsilon<=0||!Number.isInteger(c.visionThreads)||c.visionThreads<1||c.visionThreads>16||!Number.isInteger(c.gradientBins)||c.gradientBins<1||c.gradientBins>36)throw new Error('Invalid image feature limits');
  if(!Array.isArray(c.metadataFields)||c.metadataFields.length>32||!Array.isArray(c.metadataModes)||c.metadataModes.length>8)throw new Error('Invalid camera feature schema');
  if(model.predictor?.kind==='forest')validateTrees(model.predictor.trees,n,model.angleRange);
  else if(model.predictor?.kind!=='ridge'||!finiteArray(model.predictor.coefficients,n)||!Number.isFinite(model.predictor.intercept))throw new Error('Invalid image predictor');
  return model;
}
export function infer(model, features) {
  if (!finiteArray(features,model.featureNames.length)) throw new Error('Invalid feature vector.');
  const z=features.map((v,i)=>Math.fround((v-model.normalization.mean[i])/model.normalization.scale[i]));
  if(!z.every(Number.isFinite)) throw new Error('Normalization produced invalid features.');
  const outputs=model.trees.map(tree=>{
    let i=0;
    while (tree[i][0]!==-1) { const [feature,threshold,left,right]=tree[i]; i=z[feature]<=threshold?left:right; }
    return tree[i][4];
  });
  const angle=outputs.reduce((s,v)=>s+v,0)/outputs.length;
  const spread=Math.sqrt(outputs.reduce((s,v)=>s+(v-angle)**2,0)/outputs.length);
  const distance=Math.sqrt(z.reduce((s,v)=>s+v*v,0)/z.length);
  return {raw:Math.max(model.angleRange[0],Math.min(model.angleRange[1],angle)),spread,distance};
}
export class Estimator {
  constructor(model, config) { this.model=model; this.config=config; this.filter=new OneEuroFilter(model.filter); }
  reset() { this.filter.reset(); }
  update(result,timestamp) {
    const output=infer(this.model,result.features), calibration=this.model.calibration;
    const angle=this.filter.update(output.raw,timestamp);
    const unfamiliar=output.distance>calibration.distance95 || output.spread>calibration.spread95;
    const weak=result.summary.dark>this.config.maxDarkFraction || result.summary.clipped>this.config.maxClippedFraction || result.summary.contrast<this.config.minContrast;
    const validated=this.model.validation?.passed===true;
    const radius=Math.max(calibration.residual95,output.spread)*Math.max(1,output.distance/Math.max(.01,calibration.distance95));
    const reasons=[!validated?'Model has not passed all real-data acceptance gates':null,unfamiliar?'Lighting differs from validation coverage':null,weak?'Weak or clipped lighting signal':null,radius>this.config.targetErrorDegrees?'Empirical error range exceeds 5°':null].filter(Boolean);
    return {...output,angle,interval:[Math.max(this.model.angleRange[0],angle-radius),Math.min(this.model.angleRange[1],angle+radius)],radius,reliability:reasons.length?'low':'supported',reasons,timestamp};
  }
}
