const $=id=>document.getElementById(id);
let session=null,stream=null,animation=null,inFlight=false,pending=null,sequence=0,lastCapture=-Infinity,lastVideo=-1,showPreview=true,recording=false,lightConnected=false,unsaved=false,generation=0;
const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
const video=$('video'),preview=$('preview'),previewCtx=preview.getContext('2d');
const message=text=>{$('message').textContent=text;};
async function api(path,data,method='POST'){
  const response=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify({...data,sessionId:session?.sessionId})});
  const value=await response.json();if(!response.ok)throw new Error(value.error);return value;
}
async function health(){
  const data=await api('/api/health',null,'GET');
  for(const kind of ['keyboard','lighting']){
    const s=data.services[kind];$(kind+'-status').textContent=s.ready?(kind==='keyboard'?`Ready · ${s.angleRange.join('–')}° · ${s.camera.width} × ${s.camera.height}`:s.modelReady?'Model loaded · cross-environment estimates remain provisional':'Ready to collect · a real baseline model is needed'):s.error;
  }
}
async function cameras(){const devices=await navigator.mediaDevices.enumerateDevices();const selected=$('camera').value;$('camera').replaceChildren(new Option('Default front camera',''));
  for(const d of devices.filter(d=>d.kind==='videoinput'))$('camera').add(new Option(d.label||'Camera',d.deviceId));$('camera').value=selected;}
function cameraSettings(){const s=stream?.getVideoTracks()[0]?.getSettings()||{};return Object.fromEntries(['deviceId','width','height','frameRate','resizeMode','exposureMode','exposureTime','whiteBalanceMode','colorTemperature','brightness','contrast'].filter(k=>s[k]!==undefined).map(k=>[k,s[k]]));}
function controls(){const active=Boolean(session);$('start').disabled=active;$('stop').disabled=!active;$('camera').disabled=active;$('record').disabled=!active||!lightConnected||recording||unsaved;$('end-record').disabled=!recording;$('checkpoint').disabled=!recording;$('export-adaptation').disabled=!active||!lightConnected;}
async function upload(frame){
  if(inFlight){pending=frame;return;}inFlight=true;
  try{
    const response=await fetch('/api/frames',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Session-Id':frame.sessionId,'X-Frame-Id':String(frame.id),'X-Timestamp-Ms':String(frame.timestamp),
      'X-Width':String(frame.width),'X-Height':String(frame.height),'X-Camera-Settings':encodeURIComponent(JSON.stringify(frame.camera))},body:frame.bytes});
    if(!response.ok)throw new Error((await response.json()).error);
  }catch(error){message(error.message);}finally{inFlight=false;const next=pending;pending=null;if(next&&session?.sessionId===next.sessionId)void upload(next);}
}
function tick(timestamp){
  if(!session)return;
  if(timestamp-lastCapture>=1000/session.camera.fps&&video.readyState>=2&&video.currentTime!==lastVideo){
    lastCapture=timestamp;lastVideo=video.currentTime;ctx.drawImage(video,0,0,canvas.width,canvas.height);
    const image=ctx.getImageData(0,0,canvas.width,canvas.height);
    if(showPreview)previewCtx.putImageData(image,0,0);
    void upload({sessionId:session.sessionId,id:++sequence,timestamp,width:canvas.width,height:canvas.height,bytes:image.data.buffer,camera:cameraSettings()});
  }
  animation=requestAnimationFrame(tick);
}
$('start').onclick=async()=>{
  const current=++generation;
  $('start').disabled=true;
  try{
    session=await api('/api/start',{});const c=session.camera;controls();$('state').textContent='Requesting camera';message('Waiting for camera access. Stop cancels this attempt.');
    const acquired=await navigator.mediaDevices.getUserMedia({video:{width:{exact:c.width},height:{exact:c.height},frameRate:{ideal:c.fps},...($('camera').value?{deviceId:{exact:$('camera').value}}:{facingMode:'user'})},audio:false});
    if(current!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
    stream=acquired;
    video.srcObject=stream;await video.play();
    if(current!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
    if(video.videoWidth!==c.width||video.videoHeight!==c.height)throw new Error('Camera resolution does not match the saved keyboard model');
    canvas.width=preview.width=c.width;canvas.height=preview.height=c.height;sequence=0;lastCapture=-Infinity;lastVideo=-1;
    stream.getVideoTracks()[0].addEventListener('ended',async()=>{cancelAnimationFrame(animation);pending=null;
      if(recording){await api('/api/recording',{},'DELETE').catch(()=>{});recording=false;$('download').disabled=false;}
      controls();message('Camera disconnected. Export any recording before stopping the session.');});
    animation=requestAnimationFrame(tick);message('Started at an assumed 120°. Keyboard readings will supply accurate anchors.');await cameras();
  }catch(error){if(current===generation){await stop();message(error.message);}}finally{controls();}
};
async function stop(){generation++;cancelAnimationFrame(animation);pending=null;stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;
  if(session)await api('/api/stop',{}).catch(error=>message(error.message));session=null;recording=false;lightConnected=false;$('state').textContent='Stopped';message('Camera stopped.');controls();}
$('stop').onclick=()=>{if(recording||unsaved)message('End and download the recording before stopping the camera.');else void stop();};
$('refresh').onclick=()=>cameras().catch(error=>message(error.message));
$('preview-toggle').onclick=()=>{showPreview=!showPreview;preview.hidden=!showPreview;$('preview-toggle').textContent=showPreview?'Hide preview':'Show preview';};
const events=new EventSource('/api/events');
events.addEventListener('angle',event=>{const value=JSON.parse(event.data);if(value.sessionId!==session?.sessionId)return;
  $('angle').textContent=value.displayAngleDeg.toFixed(1);$('measurement').textContent=value.measurementAngleDeg===null?'Unavailable':`${value.measurementAngleDeg.toFixed(2)}°`;
  $('velocity').textContent=`${value.motionVelocityDegS.toFixed(1)}°/s`;$('age').textContent=value.measurementAgeMs===null?'—':`${Math.round(value.measurementAgeMs)} ms`;
  $('state').textContent=value.state.replaceAll('_',' ');$('source').textContent=value.authoritative?'Keyboard · accurate measurement':value.source==='lighting'?'Brightness · temporary adaptation':value.held?'Keyboard · brief visibility gap':'Current measurement unavailable';
  $('quality').textContent=value.measurementAngleDeg===null?'The displayed value is retained; it is not a fresh measurement.':value.authoritative?'The display follows inferred movement and smoothly corrects any remaining difference.':'Provisional estimate. Wide-angle accuracy needs independent validation.';
  if(value.adaptation)$('adaptation-status').textContent=`${value.adaptation.state.replaceAll('_',' ')} · ${value.adaptation.anchorCount} anchors · version ${value.adaptation.version}`;
  for(const [kind,error] of Object.entries(value.services))if(error)$(kind+'-status').textContent=error;
});
events.addEventListener('service',event=>{const {sessionId,kind,result}=JSON.parse(event.data);if(sessionId!==session?.sessionId)return;
  if(kind==='keyboard')$('keyboard-status').textContent=result.valid?`${result.angleDeg.toFixed(2)}° · authoritative`:result.quality.reason||'Keyboard not visible';
  else{
    lightConnected=true;controls();$('lighting-status').textContent=result.valid?`${result.angleDeg.toFixed(2)}° · provisional`:result.quality.reason||'Settling or awaiting an anchor';
    if(result.recording){const r=result.recording;$('record-status').textContent=`${r.count} frames · ${r.checkpoint!==null?'holding '+r.checkpoint+'°':r.error||'ready for the next hold'}`;
      $('checkpoint').disabled=!recording||r.checkpoint!==null;if(!r.active&&recording){recording=false;controls();$('download').disabled=false;$('import-reference').disabled=false;}}
  }
});
$('record').onclick=async()=>{try{await api('/api/recording',{metadata:Object.fromEntries(['device','location','position','lighting','display'].map(k=>[k,$(k).value])),timestampMs:performance.now(),epochMs:Date.now()});recording=true;unsaved=true;$('download').disabled=true;$('import-reference').disabled=true;controls();}catch(error){message(error.message);}};
$('end-record').onclick=async()=>{try{await api('/api/recording',{},'DELETE');recording=false;$('download').disabled=false;$('import-reference').disabled=false;controls();}catch(error){message(error.message);}};
$('checkpoint').onclick=async()=>{try{await api('/api/checkpoint',{angleDeg:$('reference-angle').valueAsNumber,timestampMs:performance.now()});$('checkpoint').disabled=true;}catch(error){message(error.message);}};
async function download(path,name){const data=await api(path,null,'GET');const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('download').onclick=async()=>{try{await download('/api/recording',`hinge-session-${Date.now()}.json`);unsaved=false;controls();}catch(error){message(error.message);}};
$('export-adaptation').onclick=()=>download('/api/adaptation',`hinge-adaptation-${Date.now()}.json`).catch(error=>message(error.message));
$('import-reference').onclick=async()=>{try{const file=$('reference-file').files[0];if(!file)throw new Error('Choose a synchronized reference CSV');const result=await api('/api/reference',{csv:await file.text(),offsetMs:$('reference-offset').valueAsNumber});unsaved=true;controls();message(`Matched ${result.matched} reference samples. Download the updated recording.`);}catch(error){message(error.message);}};
window.addEventListener('beforeunload',event=>{if(recording||unsaved){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{if(session)navigator.sendBeacon('/api/stop',JSON.stringify({sessionId:session.sessionId}));});
controls();void health().catch(error=>message(error.message));void cameras().catch(()=>{});
