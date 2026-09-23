import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractFeatures, featureNames } from '../src/features.js';
import { OneEuroFilter } from '../src/filter.js';
import { validateModel, infer, Estimator } from '../src/model.js';
import { LightingEstimator } from '../src/estimators.js';
const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url)));
function frame(pixel,width=80,height=60) {
  const data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set([...pixel(x,y),255],(y*width+x)*4);
  return {width,height,data};
}
const extract=pixel=>extractFeatures(frame(pixel),config.features);
test('diffuse lighting works without highlights; exposure and color remain observable',()=>{
  const dim=extract(()=>[50,50,50]), bright=extract(()=>[100,100,100]), red=extract(()=>[150,40,40]);
  assert.equal(dim.regions.length,0);assert.equal(dim.features.length,featureNames(config.features).length);
  assert.ok(Math.abs(bright.summary.mean-2*dim.summary.mean)<1e-6);
  assert.ok(red.summary.saturation>dim.summary.saturation);
  const names=featureNames(config.features);
  assert.ok(red.features[names.indexOf('red_ratio')]>red.features[names.indexOf('blue_ratio')]);
  assert.ok(dim.features.every(Number.isFinite));
});
test('darkness, clipping, and multiple local bright regions do not invalidate features',()=>{
  const dark=extract(()=>[0,0,0]), clipped=extract(()=>[255,255,255]);
  assert.equal(dark.summary.dark,1);assert.equal(clipped.summary.clipped,1);
  const multiple=extract((x,y)=>((x>=10&&x<14&&y>=10&&y<14)||(x>=50&&x<54&&y>=40&&y<44))?[250,250,250]:[80,80,80]);
  assert.equal(multiple.regions.length,2);assert.ok(multiple.features.every(Number.isFinite));
});
test('spatial distributions distinguish equal average brightness',()=>{
  const a=extract((x)=>x<40?[180,180,180]:[30,30,30]);
  const b=extract((x)=>x>=40?[180,180,180]:[30,30,30]);
  assert.ok(Math.abs(a.summary.mean-b.summary.mean)<1e-12);assert.notDeepEqual(a.features,b.features);
});
test('filter suppresses stationary noise and follows steps with irregular timestamps',()=>{
  const filter=new OneEuroFilter(config.filter), outputs=[];
  let t=0;
  for(let i=0;i<100;i++){t+=i%2?60:75;outputs.push(filter.update(60+(i%2?1:-1),t));}
  const tail=outputs.slice(20), rms=Math.sqrt(tail.reduce((s,v)=>s+(v-60)**2,0)/tail.length);
  assert.ok(rms<1);
  for(let i=0;i<7;i++){t+=65;filter.update(100,t);}
  assert.ok(Math.abs(filter.value-100)<5);
  const held=filter.value;assert.equal(filter.update(20,t-1),held);
  assert.equal(filter.update(20,t+1000),20);
  assert.throws(()=>filter.update(NaN,t+2000));
});
function model() {
  const n=featureNames(config.features).length;
  return {version:1,featureVersion:1,featureNames:featureNames(config.features),featureConfig:config.features,angleRange:[10,120],
    normalization:{mean:Array(n).fill(0),scale:Array(n).fill(1)},trees:[[[0,.5,1,2,60],[-1,0,-1,-1,30],[-1,0,-1,-1,100]]],
    filter:config.filter,calibration:{residual95:3,distance95:1,spread95:1},validation:{passed:false}};
}
test('lighting adapter refuses a different processed frame size from its source model',()=>{
  const m=model();m.capture={width:80,height:60};
  const estimator=new LightingEstimator(m,config.estimation);
  const image=frame(()=>[70,70,70]), lighting=extractFeatures(image,config.features);
  assert.ok(Number.isFinite(estimator.update(image,0,{lighting}).angle));
  assert.throws(()=>estimator.update({...image,height:80},100,{lighting}),/requires 80×60/);
});

test('model schema fails closed and low-reliability estimates keep updating',()=>{
  const m=validateModel(model(),config.features);
  const low=extract(()=>[70,70,70]), high=extract(()=>[200,200,200]);
  assert.equal(infer(m,low.features).raw,30);assert.equal(infer(m,high.features).raw,100);
  const estimator=new Estimator(m,config.estimation);assert.equal(estimator.update(low,0).reliability,'low');
  assert.ok(estimator.update(high,100).angle>30);
  const bad=model();bad.trees[0][0][2]=0;assert.throws(()=>validateModel(bad,config.features));
  const wrong=model();wrong.featureNames=[];assert.throws(()=>validateModel(wrong,config.features));
});
