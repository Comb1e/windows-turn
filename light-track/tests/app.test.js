import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { featureNames } from '../src/features.js';

// Replay actual app orchestration against fresh synthetic camera frames, without
// opening a device or depending on browser timing/permissions in the test runner.
test('live orchestration uses models only, preserves preview behavior, and handles stale frames',async()=>{
  const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url),'utf8'));
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  let now=0, animation=null, watchdog=null, signal=70;
  const elements=new Map();
  class Element {
    constructor(){this.value='';this.textContent='';this.hidden=false;this.disabled=false;this.checked=false;this.listeners={};this.style={};this.classList={toggle(){}};this.parentElement={style:{}};this.files=[];}
    addEventListener(name,fn){this.listeners[name]=fn;}
    setAttribute(){}
    replaceChildren(){}
    click(){return this.listeners.click?.();}
    get valueAsNumber(){return this.value===''?NaN:Number(this.value);}
    getContext(){return context;}
    async play(){}
  }
  const context={clearRect(){},drawImage(){},save(){},restore(){},scale(){},beginPath(){},arc(){},stroke(){},strokeRect(){},
    getImageData(x,y,width,height){const data=new Uint8ClampedArray(width*height*4);for(let i=0;i<data.length;i+=4)data.set([signal,signal,signal,255],i);return {width,height,data};}};
  for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],new Element());
  // Browser track settings may disagree with the decoded video dimensions.
  const video=elements.get('video');Object.assign(video,{videoWidth:640,videoHeight:480,readyState:2,currentTime:0});
  let stopped=false;
  const track={label:'synthetic test camera',getSettings:()=>({width:960,height:540,frameRate:15}),stop(){stopped=true;},addEventListener(){}};
  const n=featureNames(config.features).length;
  const model={version:1,featureVersion:1,featureConfig:config.features,featureNames:featureNames(config.features),angleRange:[10,120],
    normalization:{mean:Array(n).fill(0),scale:Array(n).fill(1)},trees:[[[0,.5,1,2,60],[-1,0,-1,-1,30],[-1,0,-1,-1,100]]],
    filter:config.filter,calibration:{residual95:4,distance95:100,spread95:2},validation:{passed:false},coverage:{device:'test'}};
  const replacements={
    document:{hidden:false,getElementById:id=>elements.get(id),createElement:()=>new Element(),addEventListener(){}},
    window:{addEventListener(){}},performance:{now:()=>now,timeOrigin:0},Option:class {},
    navigator:{mediaDevices:{getUserMedia:async()=>({getVideoTracks:()=>[track],getTracks:()=>[track]}),enumerateDevices:async()=>[]}},
    requestAnimationFrame:callback=>{animation=callback;return 1;},cancelAnimationFrame:()=>{animation=null;},
    setInterval:callback=>{watchdog=callback;return 1;},setTimeout:()=>1,
    fetch:async url=>({ok:true,status:200,json:async()=>url==='config.json'?config:url==='runtime-config.json'?{showVideo:false}:url==='/annotations/api/training'?[]:model}),
  };
  const originals=Object.fromEntries(Object.keys(replacements).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const originalCreate=URL.createObjectURL;
  try {
    for(const [key,value] of Object.entries(replacements))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    await import('../src/app.js?orchestration-test');
    await Promise.resolve();await Promise.resolve();
    await elements.get('start').click();
    const frame=()=>{now+=80;video.currentTime+=.08;animation(now);};
    frame();assert.equal(elements.get('angle').textContent,'30.0°');
    assert.equal(elements.get('camera-stage').hidden,true);
    const initial=elements.get('angle').textContent;
    elements.get('toggle-video').click();frame();assert.equal(elements.get('angle').textContent,initial);
    elements.get('toggle-video').click();signal=200;frame();assert.notEqual(elements.get('angle').textContent,initial);
    for(const removed of ['new-collection','capture-checkpoint','start-replay','capture-first-reference','demo','estimation-method'])assert.equal(elements.has(removed),false);
    assert.equal(elements.get('status').textContent,'LOW RELIABILITY');
    const settings=JSON.parse(elements.get('camera-settings').textContent);
    assert.equal(settings.width,960);assert.equal(settings.decodedWidth,640);assert.equal(settings.decodedHeight,480);
    now+=1000;watchdog();assert.equal(elements.get('status').textContent,'STALE INPUT');assert.equal(elements.get('angle').textContent,'—');
    frame();assert.equal(elements.get('status').textContent,'LOW RELIABILITY');assert.notEqual(elements.get('angle').textContent,'—');
    elements.get('stop').click();assert.equal(stopped,true);assert.equal(elements.get('angle').textContent,'—');assert.equal(elements.get('status').textContent,'STOPPED');
  } finally {
    URL.createObjectURL=originalCreate;
    for(const [key,descriptor] of Object.entries(originals)) {if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  }
});
