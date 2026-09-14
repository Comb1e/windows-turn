const $=id=>document.getElementById(id);
let session=null,stream=null,animation=null,inFlight=false,pending=null,sequence=0,lastCapture=-Infinity,lastVideo=-1,showPreview=true,recording=false,lightConnected=false,unsaved=false,generation=0;
let calibrationState='IDLE',calibrationBusy=false,profileData=[];
const calibrationActive=()=>['WAIT_SMALL_ANGLE','OPENING','UPPER_HOLD','CLOSING','LOWER_HOLD','TRAINING'].includes(calibrationState)||calibrationBusy;
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
function controls(){const active=Boolean(session);$('start').disabled=active;$('stop').disabled=!active;$('camera').disabled=active;$('record').disabled=!active||!lightConnected||recording||unsaved;$('end-record').disabled=!recording;$('checkpoint').disabled=!recording;$('export-adaptation').disabled=!active||!lightConnected;
  const calibrating=calibrationActive();$('calibrate').disabled=!active||!lightConnected||calibrating||recording||unsaved;
  $('cancel-calibration').disabled=!active||(!calibrating&&calibrationState!=='RETRY');
  $('record').disabled ||= calibrating;$('apply-profile').disabled=calibrating||!$('profiles').value;
  $('export-profile').disabled=!$('profiles').value;$('profiles').disabled=calibrating;
  $('upper-hold').disabled=calibrationState!=='OPENING';$('closing-start').disabled=calibrationState!=='UPPER_HOLD';}
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
    session=await api('/api/start',{profileId:$('profiles').value||undefined});const c=session.camera;controls();$('state').textContent='Requesting camera';message('Waiting for camera access. Stop cancels this attempt.');
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
    animation=requestAnimationFrame(tick);message(session.profileError||'Camera ready. Use a saved calibration or start a sweep below 25°.');await cameras();
  }catch(error){if(current===generation){await stop();message(error.message);}}finally{controls();}
};
async function stop(){generation++;cancelAnimationFrame(animation);pending=null;stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;
  if(session)await api('/api/stop',{}).catch(error=>message(error.message));session=null;recording=false;lightConnected=false;calibrationState='IDLE';$('state').textContent='Stopped';message('Camera stopped.');controls();}
$('stop').onclick=()=>{if(calibrationActive())message('Finish or cancel calibration before stopping the camera.');else if(recording||unsaved)message('End and download the recording before stopping the camera.');else void stop();};
$('refresh').onclick=()=>cameras().catch(error=>message(error.message));
$('preview-toggle').onclick=()=>{showPreview=!showPreview;preview.hidden=!showPreview;$('preview-toggle').textContent=showPreview?'Hide preview':'Show preview';};
const events=new EventSource('/api/events');
events.addEventListener('angle',event=>{const value=JSON.parse(event.data);if(value.sessionId!==session?.sessionId)return;
  $('angle').textContent=value.displayAngleDeg.toFixed(1);$('measurement').textContent=value.measurementAngleDeg===null?'Unavailable':`${value.measurementAngleDeg.toFixed(2)}°`;
  $('velocity').textContent=`${value.motionVelocityDegS.toFixed(1)}°/s`;$('age').textContent=value.measurementAgeMs===null?'—':`${Math.round(value.measurementAgeMs)} ms`;
  $('state').textContent=value.state.replaceAll('_',' ');$('source').textContent=value.authoritative?'Keyboard · accurate measurement':value.source==='lighting'?'Brightness · temporary adaptation':value.held?'Keyboard · brief visibility gap':'Current measurement unavailable';
  $('quality').textContent=value.measurementAngleDeg===null?'The displayed value is retained; it is not a fresh measurement.':value.authoritative?'The display follows inferred movement and smoothly corrects any remaining difference.':'Provisional estimate. Wide-angle accuracy needs independent validation.';
  if(value.calibration)showCalibration(value.calibration);
  $('correction-status').textContent=value.controllerState==='CHASING'?value.correctionOverdue?'Correction deadline missed during interrupted or changing input; continuing smoothly.':`Smooth correction · ${(value.correctionRemainingMs/1000).toFixed(1)} s remaining${value.displayTargetHeld?' · briefly retaining the last target':''}${value.comfortExceeded?' · increased pace to meet the deadline':''}`:value.controllerState==='STALE'?'Waiting for a fresh measurement.':'Following screen motion.';
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
window.addEventListener('beforeunload',event=>{if(recording||unsaved||calibrationActive()){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{if(session)navigator.sendBeacon('/api/stop',JSON.stringify({sessionId:session.sessionId}));});
controls();void refreshProfiles().catch(error=>message(error.message));void health().catch(error=>message(error.message));void cameras().catch(()=>{});

async function refreshProfiles(){
  const data=await api('/api/profiles',null,'GET');profileData=data.profiles||[];
  const selected=data.selectedProfileId||$('profiles').value;
  $('profiles').replaceChildren(new Option('No saved calibration',''));
  for(const p of profileData)$('profiles').add(new Option(`${p.name} · ${p.coverage.map(v=>v.toFixed(1)).join('–')}°`,p.profileId));
  $('profiles').value=selected||'';profileDetails();controls();
}
function profileDetails(){const p=profileData.find(p=>p.profileId===$('profiles').value);$('profile-details').textContent=p?`${p.createdAt.slice(0,10)} · ${p.capture.width} × ${p.capture.height} · ${p.metadata.location} · provisional`:'';controls();}
$('profiles').onchange=profileDetails;
$('apply-profile').onclick=async()=>{try{await api('/api/profile',{profileId:$('profiles').value});message('Calibration selected. Display movement continues smoothly.');}catch(error){message(error.message);}};
$('export-profile').onclick=()=>download(`/api/profiles/${$('profiles').value}/export`,`hinge-profile-${$('profiles').value}.json`).catch(error=>message(error.message));
const guides={WAIT_SMALL_ANGLE:'Hold at a keyboard-visible angle below 25°.',
  OPENING:'Open evenly to approximately 120° and hold. Keep the indicated pace. Use “Holding at 120°” if the stop cannot be detected.',
  UPPER_HOLD:'Upper hold accepted. Close evenly at the indicated pace. If motion tracking is unavailable, click “Start closing now” as you begin.',
  CLOSING:'Continue closing evenly until the keyboard reads below 25°, then hold.',LOWER_HOLD:'Hold still below 25° to finish.',
  TRAINING:'Training and saving your calibration. Keyboard measurement remains available.',READY:'Calibration saved and activated. You can select it again from the list.',
  RETRY:'Sweep needs another attempt.',CANCELLED:'Calibration cancelled.',IDLE:'Start the camera to calibrate.'};
function showCalibration(value){
  const previous=calibrationState;calibrationState=value.state;
  $('calibration-guide').textContent=value.reason||guides[value.state]||value.state;
  $('calibration-pace').textContent=value.referenceSpeedDegS?`Keep approximately ${value.referenceSpeedDegS.toFixed(1)}°/s in both directions.`:'';
  controls();if(value.manualUpperPending)$('upper-hold').disabled=true;
  if(previous!=='READY'&&value.state==='READY')void refreshProfiles().catch(error=>message(error.message));
}
events.addEventListener('calibration',event=>{const value=JSON.parse(event.data);if(value.sessionId===session?.sessionId)showCalibration(value);});
$('calibrate').onclick=async()=>{
  calibrationBusy=true;controls();
  try{
    const defaults={device:'My laptop',location:'Current environment',position:'desk',lighting:'Current lighting',display:'Fixed display'};
    const metadata=Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,$(key).value.trim()||value]));metadata.name=$('profile-name').value.trim();
    showCalibration(await api('/api/calibration',{metadata}));
  }catch(error){message(error.message);}finally{calibrationBusy=false;controls();}
};
$('cancel-calibration').onclick=async()=>{try{showCalibration(await api('/api/calibration',{},'DELETE'));}catch(error){message(error.message);}};
for(const [id,action] of [['upper-hold','upper'],['closing-start','closing']])$(id).onclick=async()=>{try{showCalibration(await api('/api/calibration/action',{action}));}catch(error){message(error.message);}};
