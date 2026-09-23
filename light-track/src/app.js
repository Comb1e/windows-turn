import { extractFeatures } from './features.js';
import { annotationModels, validateLightingArtifact, readLightingFile } from './model-selection.js';
import { LightingEstimator } from './estimators.js';
import { initialState, transition } from './state.js';
import { cameraConstraints, captureCamera, checkCameraFrame } from './camera.js';
import { ImageEstimator } from './image-estimator.js';

const $ = id => document.getElementById(id);
const config = await fetch('config.json').then(r => { if (!r.ok) throw new Error('Configuration could not be loaded.'); return r.json(); });
const runtime = await fetch('runtime-config.json').then(r => { if (!r.ok) throw new Error('Startup options could not be loaded.'); return r.json(); });
let showVideo=runtime.showVideo;
const view=$('view'),ctx=view.getContext('2d'),video=$('video');
const buffer=document.createElement('canvas'),bufferCtx=buffer.getContext('2d',{willReadFrequently:true});
let state=initialState(),mode=null,stream=null,session=0,animation=null,lastTick=0;
let lighting=null,estimate=null,estimator=null,modelStatus='Loading model…';
let lastVideoTime=-1,lastFresh=null,cameraSettings={},activeCamera=captureCamera(config);
let savedModels=[],sceneProfiles=[],startupModel=null,localModel=null,selectedModel='',loadedModelName='',modelBusy=false,modelError='';
let modelLoaded=Promise.resolve(),imageLifecycle=Promise.resolve();
const cameraKeys=['width','height','frameRate','exposureMode','exposureTime','whiteBalanceMode','colorTemperature','brightness','contrast','saturation'];
function readCameraSettings(){
  const track=stream?.getVideoTracks()[0],settings=track?.getSettings()||{};
  return {...Object.fromEntries(cameraKeys.filter(k=>settings[k]!==undefined).map(k=>[k,settings[k]])),
    decodedWidth:video.videoWidth,decodedHeight:video.videoHeight,cameraLabel:track?.label||''};
}
const message=text=>{$('message').textContent=text;};
const dispatch=event=>{state=transition(state,event);render();};
function setPreviewVisible(visible){
  showVideo=visible;$('camera-stage').hidden=!visible;$('workspace').classList.toggle('information-only',!visible);
  $('toggle-video').textContent=visible?'Hide video':'Show video';$('toggle-video').setAttribute('aria-expanded',String(visible));$('preview-note').hidden=visible;
}
$('toggle-video').addEventListener('click',()=>setPreviewVisible(!showVideo));setPreviewVisible(showVideo);
function resize(width,height){
  buffer.width=activeCamera.width;buffer.height=Math.round(activeCamera.width*height/width);
  view.width=width;view.height=height;view.parentElement.style.aspectRatio=`${width} / ${height}`;$('frame-size').textContent=`${width} × ${height}`;
}
function render(){
  const locked=Boolean(mode)||state.phase==='requesting'||modelBusy;
  $('model-choice').disabled=locked||!savedModels.length&&!startupModel&&!localModel;
  $('refresh-models').disabled=$('model-file').disabled=locked;
  $('camera-source').disabled=Boolean(mode)||state.phase==='requesting';$('stable-camera').disabled=mode!=='camera';
  if(!mode&&state.phase!=='requesting')$('start').disabled=modelBusy;
  $('model-status').textContent=modelBusy?'Loading model…':modelError||(loadedModelName?`${loadedModelName} · ${modelStatus}`:modelStatus);
  $('angle-range').textContent=estimator?.angleRange?`${estimator.angleRange.join('°–')}°`:'Range depends on the loaded model';
  $('status').textContent=state.phase.toUpperCase().replaceAll('-',' ');
  $('angle').textContent=estimate?`${estimate.angle.toFixed(1)}°`:'—';
  $('reliability').textContent=state.phase==='stale-input'?'Stale input · no current reading':estimate?`${estimate.reliability.toUpperCase()} RELIABILITY · empirical range ${estimate.interval.map(v=>v.toFixed(1)+'°').join('–')}`:modelStatus;
  $('estimate-note').textContent=estimate?estimate.reasons.join('. ')||'Within observed model coverage; uncertainty is empirical, not a guarantee.':estimator?'Ready for live frames. Use the camera and capture settings from the annotated photos.':'Train a model using screenshot annotations, with manual or matching-frame keyboard angles.';
  $('raw-angle').textContent=estimate?estimate.inference?`Raw ${estimate.raw.toFixed(2)}° · ${estimate.inference.backend} · ${Number.isFinite(estimate.inference.processingMs)?estimate.inference.processingMs.toFixed(1)+' ms':'timing unavailable'}`:`Raw ${estimate.raw.toFixed(2)}° · ensemble spread ${estimate.spread.toFixed(2)}° · feature distance ${estimate.distance.toFixed(2)}`:'No inference.';
  $('lighting-summary').textContent=lighting?`Brightness ${(lighting.summary.mean*100).toFixed(1)}% · contrast ${(lighting.summary.contrast*100).toFixed(1)}% · saturation ${(lighting.summary.saturation*100).toFixed(1)}%`:'Waiting for camera frames.';
  $('camera-settings').textContent=JSON.stringify(cameraSettings,null,2);
  $('instruction').textContent=state.phase==='requesting'?'Waiting for camera permission…':mode?'Experimental photo-trained angle estimate · 0° closed, 90° upright.':'Start the camera to measure, or open screenshot annotation to add training photos.';
}
$('stable-camera').addEventListener('click',async()=>{
  const track=stream?.getVideoTracks()[0]; if(!track) return;
  try {
    const caps=track.getCapabilities?.() || {}, settings=track.getSettings(), advanced=[];
    if(caps.exposureMode?.includes('manual') && Number.isFinite(settings.exposureTime)) advanced.push({exposureMode:'manual',exposureTime:settings.exposureTime});
    if(caps.whiteBalanceMode?.includes('manual') && Number.isFinite(settings.colorTemperature)) advanced.push({whiteBalanceMode:'manual',colorTemperature:settings.colorTemperature});
    if(!advanced.length) {message('This browser/camera does not expose settings that can be locked. Automatic settings are recorded where available.');return;}
    await track.applyConstraints({advanced}); cameraSettings=readCameraSettings(); estimator?.reset();
    if(estimator instanceof ImageEstimator) {
      if(estimator.model.kind==='scene-calibrated-model')message('Camera settings changed; scene calibration invalidated. Stop and select a matching scene profile or the base model.');
      else {await estimator.start();message('Camera settings updated; image inference restarted.');}
    } else message('Requested stable exposure/white balance. Inspect reported camera settings in diagnostics. Restart camera to return to its defaults.'); render();
  } catch(error) {cameraSettings=readCameraSettings();message(`Camera settings request failed: ${error.message}. See reported settings in diagnostics.`);render();}
});
async function refreshCameras() {
  try {
    const selected=$('camera-source').value;
    const devices=(await navigator.mediaDevices?.enumerateDevices()) || [];
    const options=[new Option('Default camera',''),...devices.filter(d=>d.kind==='videoinput').map((d,i)=>new Option(d.label || `Camera ${i+1}`,d.deviceId))];
    $('camera-source').replaceChildren(...options); $('camera-source').value=selected;
  } catch { /* Camera selection is optional; normal permission flow still works. */ }
}
const modelName = model => `Annotation · ${new Date(model.date).toLocaleString()} · ${model.device} · ${model.screenshots ?? '?'} images · ${model.id.slice(0,8)}`;
function renderModelChoices() {
  const choices=[];
  if(savedModels.length) {
    choices.push(new Option('Newest annotation model (automatic)', 'latest'));
    choices.push(...savedModels.map(model=>new Option(modelName(model),model.id)));
  }
  if(startupModel) choices.push(new Option('Server startup model', 'startup'));
  choices.push(...sceneProfiles.map(p=>new Option(`Scene · ${p.name}`,`profile:${p.profileId}`)));
  if(localModel) choices.push(new Option(`Local file · ${localModel.name}`, 'file'));
  if(!choices.length) choices.push(new Option('No saved models · train or open a JSON file', ''));
  $('model-choice').replaceChildren(...choices); $('model-choice').value=selectedModel;
}
async function modelJson(url, optional=false) {
  const response=await fetch(url);
  if(optional && response.status===404)return null;
  if(!response.ok)throw new Error('Model could not be loaded. Refresh models or choose another model.');
  return response.json();
}
function installModel(model, name) {
  const validated=validateLightingArtifact(model,config);
  const next=validated.version===2?new ImageEstimator(validated,config,{onSample:sample=>{
    if(estimator!==next||mode!=='camera')return;
    if(performance.now()-sample.timestamp>config.estimation.staleMs||document.hidden){estimate=null;return;}
    estimate=sample;render();
  },onError:error=>{if(estimator===next){estimate=null;message(error.message);}}}):new LightingEstimator(validated,config.estimation);
  estimator?.reset();
  if(estimator instanceof ImageEstimator)imageLifecycle=estimator.lifecycle;
  if(next instanceof ImageEstimator)next.lifecycle=imageLifecycle;
  estimator=next; estimate=null; lighting=null; loadedModelName=name;
  modelStatus=`${model.coverage?.device || 'experimental'} · ${model.angleRange.join('–')}° · ${model.validation?.passed?'acceptance gates passed':'not validated'}`;
}
async function selectModel(id) {
  const entry=id==='latest'?savedModels[0]:savedModels.find(model=>model.id===id);
  if(entry) installModel(await modelJson(entry.url),modelName(entry));
  else if(id.startsWith('profile:')) {const p=sceneProfiles.find(p=>p.profileId===id.slice(8));if(!p)throw new Error('Scene profile unavailable');installModel(await modelJson(`/v1/profiles/${p.profileId}/model`),p.name);}
  else if(id==='startup' && startupModel) installModel(startupModel,'Server startup model');
  else if(id==='file' && localModel) installModel(localModel.model,`Local file · ${localModel.name}`);
  else throw new Error('No saved model is available. Train an annotation model or open a model JSON file.');
  selectedModel=id; renderModelChoices();
}
function modelOperation(action) {
  if(mode || state.phase==='requesting' || modelBusy)return modelLoaded;
  modelBusy=true; modelError=''; render();
  modelLoaded=(async()=>{
    try {await action();}
    catch(error) {modelError=error.message; if(!estimator)modelStatus=error.message; $('model-choice').value=selectedModel;}
    finally {modelBusy=false;render();}
  })();
  return modelLoaded;
}
async function refreshModels(initial=false) {
  const results=await Promise.allSettled([modelJson('/annotations/api/training'),modelJson('model.json',true),modelJson('/v1/profiles',true)]);
  const [annotations,startup]=results;
  if(annotations.status==='fulfilled') savedModels=annotationModels(annotations.value);
  if(startup.status==='fulfilled') startupModel=startup.value;
  if(results[2].status==='fulfilled')sceneProfiles=(results[2].value?.profiles||[]).filter(p=>p.kind==='scene-calibration');
  const id=initial || !selectedModel ? savedModels.length?'latest':startupModel?'startup':'' : selectedModel;
  renderModelChoices();
  if(id) await selectModel(id,{initial});
  else {modelStatus='No saved models. Train with annotations or open a model JSON file.';}
  const failed=results.find(result=>result.status==='rejected');
  if(failed)throw failed.reason;
}
$('model-choice').addEventListener('change',()=>modelOperation(()=>selectModel($('model-choice').value)));
$('refresh-models').addEventListener('click',()=>modelOperation(()=>refreshModels()));
$('model-file').addEventListener('change',()=>{
  const file=$('model-file').files[0]; $('model-file').value=''; if(!file)return;
  return modelOperation(async()=>{
    const model=await readLightingFile(file,config);
    installModel(model,`Local file · ${file.name}`); localModel={name:file.name,model}; selectedModel='file'; renderModelChoices();
  });
});

function stop(){
  session++;if(animation!==null)cancelAnimationFrame(animation);animation=null;
  stream?.getTracks().forEach(t=>t.stop());stream=null;video.pause?.();video.srcObject=null;video.load?.();mode=null;
  lighting=null;estimate=null;lastFresh=null;lastVideoTime=-1;cameraSettings={};estimator?.reset();dispatch({type:'STOP'});
  ctx.clearRect(0,0,view.width,view.height);$('empty-state').hidden=false;$('start').disabled=modelBusy;$('stop').disabled=true;
  $('live-tag').textContent='CAMERA OFF';$('fps').textContent='— fps';$('frame-size').textContent='LOCAL SESSION';
}
$('start').addEventListener('click',async()=>{
  stop();message('');const token=session;$('start').disabled=true;$('stop').disabled=false;dispatch({type:'REQUEST'});
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Camera access requires localhost or HTTPS and a browser with media support.');
    await modelLoaded;if(token!==session)return;
    activeCamera=captureCamera(config,estimator?.capture);
    const acquired=await navigator.mediaDevices.getUserMedia(cameraConstraints(activeCamera,$('camera-source').value));
    if(token!==session){acquired.getTracks().forEach(t=>t.stop());return;}
    stream=acquired;video.srcObject=stream;await video.play();if(token!==session)return;
    checkCameraFrame(video.videoWidth,video.videoHeight,activeCamera);resize(video.videoWidth,video.videoHeight);cameraSettings=readCameraSettings();void refreshCameras();
    stream.getVideoTracks()[0].addEventListener('ended',()=>{if(token===session){stop();message('Camera disconnected. Reconnect and start a new observation.');}});
    mode='camera';lastTick=0;lastFresh=null;lastVideoTime=-1;estimator?.reset();
    $('empty-state').hidden=true;$('stop').disabled=false;$('start').disabled=true;$('live-tag').textContent='LIVE / LOCAL PROCESSING';dispatch({type:'START'});
    if(estimator instanceof ImageEstimator)estimator.start().catch(error=>{if(token===session)message(error.message);});
    animation=requestAnimationFrame(tick);
  }catch(error){if(token===session){stop();message(`Could not start the camera: ${error.message}`);}}
});
$('stop').addEventListener('click',()=>{stop();message('');});
function tick(timestamp){
  if(!mode)return;
  try{
    if(timestamp-lastTick>=1000/config.processing.fps){
      lastTick=timestamp;
      if(video.readyState>=2&&video.currentTime!==lastVideoTime&&!document.hidden){
        $('fps').textContent=lastFresh===null?'— fps':`${Math.round(1000/(timestamp-lastFresh))} fps`;
        lastFresh=timestamp;lastVideoTime=video.currentTime;
        checkCameraFrame(video.videoWidth,video.videoHeight,activeCamera);
        if(video.videoWidth!==view.width||video.videoHeight!==view.height)resize(video.videoWidth,video.videoHeight);
        bufferCtx.drawImage(video,0,0,buffer.width,buffer.height);
        const frame=bufferCtx.getImageData(0,0,buffer.width,buffer.height);lighting=extractFeatures(frame,config.features);cameraSettings=readCameraSettings();
        if(estimator instanceof ImageEstimator){estimator.update(frame,timestamp,{lighting,camera:cameraSettings});if(estimate&&timestamp-estimate.timestamp>config.estimation.staleMs)estimate=null;}
        else estimate=estimator?estimator.update(frame,timestamp,{lighting}).legacy:null;
        dispatch({type:'FRAME',hasModel:Boolean(estimator),low:estimate?.reliability==='low'});
        if(showVideo)ctx.drawImage(buffer,0,0,view.width,view.height);
      }
    }
    animation=requestAnimationFrame(tick);
  }catch(error){stop();message(`Observation stopped: ${error.message}`);}
}
setInterval(()=>{if(mode&&(lastFresh===null||performance.now()-lastFresh>config.estimation.staleMs)){estimate=null;dispatch({type:'STALE'});}},config.processing.statusIntervalMs);
document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&mode){estimate=null;estimator?.reset();dispatch({type:'STALE'});}
  else if(mode&&estimator instanceof ImageEstimator)estimator.start().catch(error=>message(error.message));
});
window.addEventListener('pagehide',stop);render();modelOperation(()=>refreshModels(true));void refreshCameras();
