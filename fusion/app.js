const $=id=>document.getElementById(id);
let session=null,stream=null,animation=null,inFlight=false,pending=null,sequence=0,lastCapture=-Infinity,lastVideo=-1,showPreview=true,lightConnected=false,generation=0;
let profileData=[];
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
    const s=data.services[kind];$(kind+'-status').textContent=s.ready?(kind==='keyboard'?`Ready · ${s.angleRange.join('–')}° · ${s.camera.width} × ${s.camera.height}`:s.modelReady?'Model loaded · cross-environment estimates remain provisional':'Train or select a photo-annotation model'):s.error;
  }
}
async function cameras(){const devices=await navigator.mediaDevices.enumerateDevices();const selected=$('camera').value;$('camera').replaceChildren(new Option('Default front camera',''));
  for(const d of devices.filter(d=>d.kind==='videoinput'))$('camera').add(new Option(d.label||'Camera',d.deviceId));$('camera').value=selected;}
function cameraSettings(){const s=stream?.getVideoTracks()[0]?.getSettings()||{};return Object.fromEntries(['deviceId','width','height','frameRate','resizeMode','exposureMode','exposureTime','whiteBalanceMode','colorTemperature','brightness','contrast'].filter(k=>s[k]!==undefined).map(k=>[k,s[k]]));}
function clearPending(){if(pending)pending.bytes=null;pending=null;}
function controls(){const active=Boolean(session);$('start').disabled=active;$('stop').disabled=!active;$('camera').disabled=active;
  $('export-adaptation').disabled=!active||!lightConnected;$('apply-profile').disabled=!$('profiles').value;$('export-profile').disabled=!$('profiles').value;}
async function upload(frame){
  if(inFlight){pending=frame;return;}inFlight=true;
  try{
    const response=await fetch('/api/frames',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Session-Id':frame.sessionId,'X-Frame-Id':String(frame.id),'X-Timestamp-Ms':String(frame.timestamp),
      'X-Width':String(frame.width),'X-Height':String(frame.height),'X-Camera-Settings':encodeURIComponent(JSON.stringify(frame.camera))},body:frame.bytes});
    if(!response.ok)throw new Error((await response.json()).error);
  }catch(error){message(error.message);}finally{
    // Release the browser-side frame reference as soon as fetch has consumed
    // the body. At most one in-flight and one waiting frame remain live.
    frame.bytes=null;inFlight=false;const next=pending;pending=null;
    if(next&&session?.sessionId===next.sessionId)void upload(next);
    else if(next)next.bytes=null;
  }
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
    session=await api('/api/start',{profileId:$('profiles').value||undefined});const c=session.camera;controls();$('state').textContent='Requesting camera';message('Waiting for camera access. Stop cancels this attempt.');
    const acquired=await navigator.mediaDevices.getUserMedia({video:{width:{exact:c.width},height:{exact:c.height},frameRate:{ideal:c.fps},...($('camera').value?{deviceId:{exact:$('camera').value}}:{facingMode:'user'})},audio:false});
    if(current!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
    stream=acquired;
    video.srcObject=stream;await video.play();
    if(current!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
    if(video.videoWidth!==c.width||video.videoHeight!==c.height)throw new Error('Camera resolution does not match the saved keyboard model');
    canvas.width=preview.width=c.width;canvas.height=preview.height=c.height;sequence=0;lastCapture=-Infinity;lastVideo=-1;
    stream.getVideoTracks()[0].addEventListener('ended',()=>{void stop().then(()=>message('Camera disconnected. Reconnect and start again.'));});
    animation=requestAnimationFrame(tick);message(session.profileError||'Camera ready. Select a photo-trained model or scene profile for Light Track.');await cameras();
  }catch(error){if(current===generation){await stop();message(error.message);}}finally{controls();}
};
async function stop(){generation++;cancelAnimationFrame(animation);clearPending();stream?.getTracks().forEach(t=>t.stop());stream=null;video.pause?.();video.srcObject=null;video.load?.();
  if(session)await api('/api/stop',{}).catch(error=>message(error.message));session=null;lightConnected=false;$('state').textContent='Stopped';message('Camera stopped.');controls();}
$('stop').onclick=()=>void stop();
$('refresh').onclick=()=>cameras().catch(error=>message(error.message));
$('preview-toggle').onclick=()=>{showPreview=!showPreview;preview.hidden=!showPreview;$('preview-toggle').textContent=showPreview?'Hide preview':'Show preview';};
const events=new EventSource('/api/events');
events.addEventListener('angle',event=>{const value=JSON.parse(event.data);if(value.sessionId!==session?.sessionId)return;
  $('angle').textContent=value.displayAngleDeg.toFixed(1);$('measurement').textContent=value.measurementAngleDeg===null?'Unavailable':`${value.measurementAngleDeg.toFixed(2)}°`;
  $('target').textContent=Number.isFinite(value.targetAngleDeg)?`${value.targetAngleDeg.toFixed(2)}°${value.displayTargetHeld||value.held?' (held)':''}`:'Unavailable';
  $('velocity').textContent=`${value.motionVelocityDegS.toFixed(1)}°/s`;$('age').textContent=value.measurementAgeMs===null?'—':`${Math.round(value.measurementAgeMs)} ms`;
  $('state').textContent=value.state.replaceAll('_',' ');$('source').textContent=value.authoritative?'Keyboard · accurate measurement':value.source==='lighting'?'Brightness · temporary adaptation':value.held?'Keyboard · brief visibility gap':'Current measurement unavailable';
  $('quality').textContent=value.measurementAngleDeg===null?'The displayed value is retained; it is not a fresh measurement.':value.authoritative?'The keyboard angle is the target. The display follows keyboard motion and smoothly corrects any remaining difference.':'Provisional estimate. Wide-angle accuracy needs independent validation.';
  $('correction-status').textContent=value.controllerState==='CHASING'?value.correctionOverdue?'Correction deadline missed during interrupted or changing input; continuing smoothly.':`Smooth correction · ${(value.correctionRemainingMs/1000).toFixed(1)} s remaining${value.displayTargetHeld?' · briefly retaining the last target':''}${value.comfortExceeded?' · increased pace to meet the deadline':''}`:value.controllerState==='STALE'?'Waiting for a fresh measurement.':'Following screen motion.';
  if(value.adaptation)$('adaptation-status').textContent=`${value.adaptation.state.replaceAll('_',' ')} · ${value.adaptation.anchorCount} anchors · version ${value.adaptation.version}`;
  for(const [kind,error] of Object.entries(value.services))if(error){const status=$(kind+'-status');if(status)status.textContent=error;}
});
events.addEventListener('service',event=>{const {sessionId,kind,result}=JSON.parse(event.data);if(sessionId!==session?.sessionId)return;
  if(kind==='keyboard')$('keyboard-status').textContent=result.valid?`${result.angleDeg.toFixed(2)}° · authoritative`:result.quality.reason||'Keyboard not visible';
  else{
    lightConnected=true;controls();$('lighting-status').textContent=result.valid?`${result.angleDeg.toFixed(2)}° · provisional`:result.quality.reason||'Settling or awaiting an anchor';

  }
});
async function download(path,name){
  const response=await fetch(path,{headers:{'Accept':'application/json'}});
  if(!response.ok){let value;try{value=await response.json();}catch{value=null;}throw new Error(value?.error||`Download failed (${response.status})`);}
  // Keep exported profiles out of the JS object heap. The browser streams the
  // response into a Blob instead of parsing and stringifying it twice.
  const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('export-adaptation').onclick=()=>download('/api/adaptation',`hinge-adaptation-${Date.now()}.json`).catch(error=>message(error.message));
window.addEventListener('pagehide',()=>{if(session)navigator.sendBeacon('/api/stop',JSON.stringify({sessionId:session.sessionId}));});
controls();void refreshProfiles().catch(error=>message(error.message));void health().catch(error=>message(error.message));void cameras().catch(()=>{});

async function refreshProfiles(){
  const data=await api('/api/profiles',null,'GET');profileData=data.profiles||[];
  const selected=data.selectedProfileId||$('profiles').value;
  $('profiles').replaceChildren(new Option('No saved profile',''));
  for(const p of profileData)$('profiles').add(new Option(`${p.name} · ${p.coverage.map(v=>v.toFixed(1)).join('–')}°`,p.profileId));
  $('profiles').value=selected||'';profileDetails();controls();
}
function profileDetails(){const p=profileData.find(p=>p.profileId===$('profiles').value);$('profile-details').textContent=p?`${p.createdAt.slice(0,10)} · ${p.capture.width} × ${p.capture.height} · ${p.metadata.location} · provisional`:'';controls();}
$('profiles').onchange=profileDetails;
$('apply-profile').onclick=async()=>{try{await api('/api/profile',{profileId:$('profiles').value});message('Profile selected. Display movement continues smoothly.');}catch(error){message(error.message);}};
$('export-profile').onclick=()=>download(`/api/profiles/${$('profiles').value}/export`,`hinge-profile-${$('profiles').value}.json`).catch(error=>message(error.message));
$('refresh-profiles').onclick=()=>refreshProfiles().catch(error=>message(error.message));
