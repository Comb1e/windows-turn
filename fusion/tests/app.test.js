import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('camera startup can be cancelled; late camera and old-session events cannot revive it',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const elements=new Map(),events={},windowEvents={},uploads=[];let animation=null,releaseCamera,stopped=0,cameraRequests=0;
  const context={drawImage(){},putImageData(){},getImageData(x,y,width,height){return {width,height,data:new Uint8ClampedArray(width*height*4)};}};
  class Element{constructor(){this.value='';this.disabled=false;this.hidden=false;this.textContent='';this.files=[];}getContext(){return context;}replaceChildren(){}add(){}async play(){}addEventListener(){}get valueAsNumber(){return Number(this.value);}}
  for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],new Element());
  Object.assign(elements.get('video'),{videoWidth:64,videoHeight:64,readyState:2,currentTime:0});
  const track={stop(){stopped++;},getSettings:()=>({width:64,height:64}),addEventListener(){}};
  const stream={getTracks:()=>[track],getVideoTracks:()=>[track]};
  const replacements={
    document:{getElementById:id=>elements.get(id),createElement:()=>new Element()},window:{addEventListener:(name,fn)=>{windowEvents[name]=fn;}},
    navigator:{mediaDevices:{enumerateDevices:async()=>[],getUserMedia:async()=>{cameraRequests++;if(cameraRequests===1)return new Promise(resolve=>{releaseCamera=resolve;});return stream;}},sendBeacon(){}},
    Option:class{},EventSource:class{addEventListener(name,fn){events[name]=fn;}},
    requestAnimationFrame:fn=>{animation=fn;return 1;},cancelAnimationFrame:()=>{animation=null;},
    fetch:async(path,options)=>{
      let data={};if(path==='/api/start')data={sessionId:`s${cameraRequests}`,camera:{width:64,height:64,fps:15}};
      if(path==='/api/health')data={services:{keyboard:{ready:false,error:'offline'},lighting:{ready:false,error:'offline'}}};
      if(path==='/api/frames')uploads.push(options);return {ok:true,status:path==='/api/frames'?202:200,json:async()=>data};
    }
  };
  const original=Object.fromEntries(Object.keys(replacements).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  try{
    for(const [key,value] of Object.entries(replacements))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
    await import('../app.js?ui-lifecycle');await settle();
    const starting=elements.get('start').onclick();await settle();
    assert.equal(elements.get('stop').disabled,false);assert.equal(elements.get('state').textContent,'Requesting camera');
    elements.get('stop').onclick();await settle();releaseCamera(stream);await starting;
    assert.equal(stopped,1);assert.equal(animation,null);assert.equal(elements.get('start').disabled,false);
    await elements.get('start').onclick();assert.ok(animation);
    events.service({data:JSON.stringify({sessionId:'obsolete',kind:'lighting',result:{valid:true,angleDeg:70,quality:{}}})});
    assert.equal(elements.get('record').disabled,true);
    events.service({data:JSON.stringify({sessionId:'s1',kind:'lighting',result:{valid:false,quality:{reason:'Collect baseline'}}})});
    assert.equal(elements.get('record').disabled,false);
    const video=elements.get('video');video.currentTime=1;animation(100);await settle();assert.equal(uploads.length,1);
    elements.get('preview-toggle').onclick();video.currentTime=2;animation(200);await settle();assert.equal(uploads.length,2);assert.equal(elements.get('preview').hidden,true);
    windowEvents.pagehide();elements.get('stop').onclick();await settle();assert.equal(animation,null);
  }finally{for(const [key,descriptor] of Object.entries(original)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});
