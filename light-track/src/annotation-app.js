import { annotationTransition } from './annotation-state.js';
import { cameraConstraints, captureCamera, checkCameraFrame } from './camera.js';
import { freezeScreenshot } from './annotation-capture.js';
import { ScreenshotCollector } from './annotation-collector.js';
import { sceneTransition,sceneReferenceSummary } from './scene-calibration-state.js';

const $ = id => document.getElementById(id), base = '/annotations/api/groups';
const metadataKeys = ['device', 'lighting', 'location', 'position', 'display'];
const config = await fetch('/config.json').then(r => r.json());
let phase = 'READY', group = null, index = 0, loadedSample = null, stream = null, cameraGeneration = 0;
let cancelCameraRequest = null;
let trainingBusy = false, trainingTimer = null, pageLeaving = false;
let sceneState='Idle',sceneGroupId=null,sceneBaseId=null,sceneJobId=null,sceneTimer=null,sceneGeneration=0,sceneCamera=null;
const selected = () => group?.samples[index];
const message = text => { $('message').textContent = text; };
const dispatch = event => { phase = annotationTransition(phase, event); render(); };
async function api(path = '', options) {
  return request(base + path, options);
}
async function request(path, options) {
  const response = await fetch(path, options), value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Annotation request failed');
  return value;
}
const json = (method, value) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
let lastVideoTime = -1;
const collector = new ScreenshotCollector({ config,
  request: (path, options) => api(path, { ...options, signal: AbortSignal.timeout(config.annotation.keyboard.requestTimeoutMs + config.annotation.keyboard.healthTimeoutMs) }),
  capture: () => {
    const video = $('video');
    if (!stream) throw new Error('Camera stopped. Restart the preview to collect.');
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return null;
    checkCameraFrame(video.videoWidth, video.videoHeight, captureCamera(config));
    lastVideoTime = video.currentTime;
    const { frame, capturedAt } = freezeScreenshot(video, video.videoWidth, video.videoHeight, config);
    return { data: frame.data, meta: { width: frame.width, height: frame.height, capturedAt,
      camera: { ...stream.getVideoTracks()[0].getSettings(), decodedWidth: video.videoWidth, decodedHeight: video.videoHeight } } };
  },
  update: render,
  saved: result => {
    group.samples.push(result.sample); group.revision = result.revision; group.capture = result.capture;
  },
  stopped: async id => {
    group = await api('/' + id); index = Math.max(0, group.samples.length - 1);
    await showPhoto(); await listGroups();
  },
});
function render() {
  const collecting = collector.active(), busy = phase === 'BUSY' || collecting, open = group?.state === 'OPEN', sample = selected();
  const editable = !busy && sample && loadedSample === sample.sampleId;
  $('new-group').disabled = busy || open; $('end-group').disabled = phase === 'BUSY' || collector.state === 'STOPPING' || !open;
  $('groups').disabled = $('reload').disabled = busy; $('export-group').disabled = busy || !group;
  $('files').disabled = busy || !open; $('snap').disabled = busy || !open || !stream || $('video').readyState < 2;
  $('camera').disabled = busy || Boolean(stream); $('devices').disabled = busy || Boolean(stream);
  $('stop-camera').disabled = !stream && !cancelCameraRequest;
  $('previous').disabled = busy || index <= 0; $('next').disabled = busy || !sample || index >= group.samples.length - 1;
  for (const id of ['angle', 'notes', 'save', 'clear']) $(id).disabled = !editable;
  $('delete-photo').disabled = busy || !sample || trainingBusy || sceneState === 'Fitting';
  $('discard').disabled = busy || phase !== 'DIRTY';
  $('auto-start').disabled = busy || phase === 'DIRTY' || !open || !stream || $('video').readyState < 2;
  $('auto-stop').disabled = !collecting || collector.state === 'STOPPING';
  $('train-model').disabled = busy || trainingBusy;
  $('train-image-model').disabled = busy || trainingBusy;
  const sceneActive=sceneGroupId===group?.groupId&&sceneState==='Collecting';
  const sceneSummary=sceneReferenceSummary(group?.samples||[],config.sceneCalibration);
  $('scene-start').disabled=busy||open||sceneState==='Fitting'||!$('scene-base').value;
  $('scene-base').disabled=sceneState==='Collecting'||sceneState==='Fitting';
  $('scene-fit').disabled=busy||phase==='DIRTY'||!sceneActive||!sceneSummary.canFit;
  $('scene-reset').disabled=sceneState==='Idle'||sceneState==='Invalidated';
  $('scene-guide').textContent=sceneActive?`${sceneSummary.count} / about ${config.sceneCalibration.targetReferences} references · Coverage ${sceneSummary.range?.join('–')??'—'}°${sceneSummary.suggestion!==null?` · Suggested next angle: ${sceneSummary.suggestion}°`:''}. Save at least ${config.sceneCalibration.minDistinctAngles} distinct angles spanning ${config.sceneCalibration.minSpanDeg}°.`:'';
  $('auto-status').textContent = ({ IDLE: 'Ready to collect with Keyboard.', CONNECTING: 'Connecting to Keyboard…',
    WAITING: collector.reason || 'Waiting for a valid keyboard angle…', COLLECTING: 'Collecting labeled screenshots automatically.',
    STOPPING: 'Stopping collection and saving pending work…', ERROR: collector.reason })[collector.state];
  $('auto-reading').textContent = `Keyboard angle ${collector.angle === null ? '—' : collector.angle.toFixed(2) + '°'} · Supported range ${collector.range ? collector.range.join('–') + '°' : '—'} · Saved ${collector.count}`;
  for (const key of metadataKeys) $('meta-' + key).disabled = busy || open;
  $('group-status').textContent = group ? `${open ? 'Session open' : 'Session ended'} · ${group.samples.length} screenshots · ${group.samples.filter(s => s.angleDeg !== null).length} labeled · ${group.groupId}` : 'No group selected.';
  $('item-status').textContent = sample ? `${index + 1} / ${group.samples.length} · ${sample.angleDeg === null ? 'Unlabeled' : sample.angleDeg + '°'}` : 'No screenshots';
  $('label-status').textContent = phase === 'DIRTY' ? 'Unsaved annotation changes' : sample ? sample.angleDeg === null ? 'Enter the measured angle and save.' : sample.labelSource === 'keyboard' ? 'Saved keyboard measurement · exact matching screenshot' : 'Saved manual annotation' : '';
}
async function operation(action, allowDirty = false) {
  if (phase === 'BUSY' || collector.active()) return;
  if (phase === 'DIRTY' && !allowDirty) { message('Save or clear this annotation before leaving the screenshot.'); render(); return; }
  const wasDirty = phase === 'DIRTY'; dispatch('BEGIN');
  try { await action(); dispatch('DONE'); }
  catch (error) { message(error.message); dispatch(wasDirty ? 'RESTORE' : 'DONE'); }
}
async function listGroups() {
  const groups = await api();
  $('groups').replaceChildren(new Option('New session', ''), ...groups.map(g => new Option(
    `${g.metadata.lighting} · ${new Date(g.createdAt).toLocaleString()} · ${g.labeled}/${g.count} labeled · ${g.state.toLowerCase()} · ${g.groupId.slice(0, 8)}`, g.groupId)));
  $('groups').value = group?.groupId || '';
}
async function showPhoto() {
  const sample = selected(); loadedSample = null;
  $('photo').hidden = true; $('empty-photo').hidden = false;
  $('photo').removeAttribute('src');
  $('angle').value = sample?.angleDeg ?? ''; $('notes').value = sample?.notes || '';
  if (!sample) return;
  $('photo').src = `${base}/${group.groupId}/images/${sample.sampleId}`;
  await $('photo').decode();
  loadedSample = sample.sampleId; $('photo').hidden = false; $('empty-photo').hidden = true;
}
async function loadGroup(id) {
  if(sceneState==='Collecting'&&id!==sceneGroupId)setScene('RESET','Invalidated · Selected another annotation group. Saved references are retained.');
  group = id ? await api('/' + id) : null; index = 0;
  if (group) for (const key of metadataKeys) $('meta-' + key).value = group.metadata[key];
  await showPhoto();
  message(group ? 'Saved group loaded. Select a screenshot to review its label.' : 'Enter the setup for a new annotation session.');
}
$('groups').addEventListener('change', () => {
  const id = $('groups').value;
  if (phase === 'DIRTY') $('groups').value = group?.groupId || '';
  operation(() => loadGroup(id));
});
$('reload').addEventListener('click', () => operation(async () => { await loadGroup(group?.groupId); await listGroups(); message('Saved groups reloaded.'); }));
$('new-group').addEventListener('click', () => operation(async () => {
  group = await api('', json('POST', { metadata: Object.fromEntries(metadataKeys.map(k => [k, $('meta-' + k).value])) }));
  index = 0; await showPhoto(); await listGroups(); message('Session started. Capture any measured angles under this lighting setup.');
}));
$('end-group').addEventListener('click', async () => {
  await collector.stop();
  await operation(async () => {
  group = await api(`/${group.groupId}/close`, json('POST', { revision: group.revision }));
  await listGroups(); message('Session ended and saved. Start another session with the same or different lighting.');
  });
});
$('auto-start').addEventListener('click', () => operation(async () => {
  lastVideoTime = -1; await collector.start(group, captureCamera(config));
}));
$('auto-stop').addEventListener('click', () => collector.stop());
for (const [id, direction] of [['previous', -1], ['next', 1]]) $(id).addEventListener('click', () => operation(async () => { index += direction; await showPhoto(); }));
for (const id of ['angle', 'notes']) $(id).addEventListener('input', () => dispatch('EDIT'));
async function saveLabel(clear = false) {
  const angleDeg = clear ? null : $('angle').valueAsNumber;
  if (!clear && !Number.isFinite(angleDeg)) throw new Error('Enter a finite measured angle.');
  group = await api(`/${group.groupId}/labels/${selected().sampleId}`, json('PUT', { revision: group.revision, angleDeg, notes: $('notes').value }));
  $('angle').value = angleDeg ?? ''; await listGroups(); message(clear ? 'Label cleared. The screenshot is kept and excluded from training.' : 'Annotation saved.');
}
$('save').addEventListener('click', () => operation(() => saveLabel(), true));
$('clear').addEventListener('click', () => operation(() => saveLabel(true), true));
$('discard').addEventListener('click', () => operation(() => loadGroup(group.groupId), true));
$('delete-photo').addEventListener('click', async () => {
  const sample = selected();
  if (!sample || phase === 'BUSY' || collector.active() || trainingBusy || sceneState === 'Fitting') return;
  const dirty = phase === 'DIRTY' ? '\nYour unsaved edits for this photo will also be discarded.' : '';
  if (!window.confirm(`Permanently delete photo ${sample.image || sample.sampleId}?\nIts image, label, notes, and stored features will be removed. This cannot be undone.${dirty}`)) return;
  await operation(async () => {
    group = await api(`/${group.groupId}/images/${sample.sampleId}`, json('DELETE', { revision: group.revision }));
    index = Math.max(0, Math.min(index, group.samples.length - 1));
    // Deletion committed. A subsequent image-load/network failure must not
    // resurrect dirty fields belonging to the deleted screenshot.
    dispatch('DONE'); dispatch('BEGIN');
    try { await showPhoto(); await listGroups(); message('Photo permanently deleted. Existing models and profiles are unchanged.'); }
    catch (error) { message(`Photo deleted. Reload to refresh the view. ${error.message}`); }
  }, true);
});
$('export-group').addEventListener('click', () => operation(async () => {
  const data = await api(`/${group.groupId}/export`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `light-track-group-${group.groupId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message('Group metadata, labels and features exported. PNG screenshots remain in the local group directory.');
}));
async function cameras() {
  const devices = await navigator.mediaDevices?.enumerateDevices() || [], current = $('devices').value;
  $('devices').replaceChildren(new Option('Default camera', ''), ...devices.filter(d => d.kind === 'videoinput').map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  $('devices').value = current;
}
function stopCamera() {
  void collector.stop();
  cameraGeneration++; cancelCameraRequest?.(); stream?.getTracks().forEach(t => t.stop()); stream = null;
  $('video').srcObject = null; $('video').hidden = true; render();
}
$('camera').addEventListener('click', () => operation(async () => {
  const generation = ++cameraGeneration;
  const cancelled = new Promise(resolve => { cancelCameraRequest = () => resolve(null); });
  message('Requesting camera access… Use Stop camera to cancel.'); render();
  let acquired;
  try {
    acquired = await Promise.race([cancelled,
      navigator.mediaDevices.getUserMedia(cameraConstraints(captureCamera(config), $('devices').value)).then(value => {
        if (generation !== cameraGeneration) { value.getTracks().forEach(t => t.stop()); return null; }
        return value;
      })]);
  } finally { cancelCameraRequest = null; }
  if (!acquired) { message('Camera request cancelled.'); return; }
  stream = acquired; $('video').srcObject = stream; $('video').hidden = false;
  if(sceneState==='Collecting') {
    const settings=stream.getVideoTracks()[0].getSettings(),binding=JSON.stringify(['deviceId','width','height','resizeMode'].map(k=>settings[k]??null));
    if(sceneCamera!==null&&sceneCamera!==binding)setScene('RESET','Invalidated · Camera configuration changed. Start a new scene calibration.');
    else sceneCamera=binding;
  }
  try { await $('video').play(); checkCameraFrame($('video').videoWidth, $('video').videoHeight, captureCamera(config)); await cameras(); }
  catch (error) { stopCamera(); throw error; }
  stream?.getVideoTracks()[0].addEventListener('ended', stopCamera);
  message('Hold a measured opening and capture a screenshot. Only captured still images are saved.');
}));
$('stop-camera').addEventListener('click', stopCamera);
$('video').addEventListener('loadeddata', render);
async function captureImage(source, width, height, kind, camera = {}) {
  const { frame, capturedAt } = freezeScreenshot(source, width, height, config);
  const result = await api(`/${group.groupId}/images`, { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Screenshot': encodeURIComponent(JSON.stringify({
      width: frame.width, height: frame.height, revision: group.revision, source: kind, capturedAt,
      camera: { ...camera, decodedWidth: width, decodedHeight: height } })) }, body: frame.data });
  group = result.group; index = group.samples.findIndex(s => s.sampleId === result.sampleId);
}
$('snap').addEventListener('click', () => operation(async () => {
  const settings = stream.getVideoTracks()[0].getSettings();
  checkCameraFrame($('video').videoWidth, $('video').videoHeight, captureCamera(config));
  await captureImage($('video'), $('video').videoWidth, $('video').videoHeight, 'camera', settings);
  await showPhoto(); await listGroups(); message('Screenshot saved. Enter the angle measured for this image.');
}));
$('files').addEventListener('change', () => {
  const files = [...$('files').files]; $('files').value = '';
  operation(async () => {
    let imported = 0;
    try {
      for (const file of files) {
        const photo = await createImageBitmap(file);
        try { await captureImage(photo, photo.width, photo.height, 'upload', { filename: file.name }); imported++; }
        finally { photo.close(); }
      }
    } finally { await showPhoto(); await listGroups(); message(`${imported} screenshots saved. Label each image using Previous / Next.`); }
  });
});
window.addEventListener('beforeunload', event => {
  if (phase === 'DIRTY' || phase === 'BUSY') { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { pageLeaving = true; clearTimeout(trainingTimer);clearTimeout(sceneTimer); void collector.stop('', { leaving: true }); stopCamera(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) void collector.stop(); });
$('capture-help').textContent = `Screenshots use ${config.processing.width}-pixel width with their original aspect ratio. Use the same camera and crop for training and measurement.`;
for (const key of metadataKeys) $('meta-' + key).maxLength = config.annotation.maxTextLength;
$('notes').maxLength = config.annotation.maxTextLength;
function showTraining(job) {
  clearTimeout(trainingTimer); trainingBusy = job?.state === 'RUNNING';
  $('training-result').hidden = job?.state !== 'READY';
  const baseline = job?.diagnostic?.baseline, selected = job?.diagnostic?.selectedProcedure;
  const hasComparison = job?.state === 'READY' && selected?.evaluatedGroups > 0
    && Number.isFinite(baseline?.meanGroupMAE) && Number.isFinite(selected?.meanGroupMAE);
  $('training-diagnostic').hidden = !hasComparison;
  $('training-diagnostic').textContent = hasComparison
    ? `Held-out session diagnostic · ${selected.evaluatedGroups} groups · Average angle error: original ${baseline.meanGroupMAE.toFixed(2)}° → selected training method ${selected.meanGroupMAE.toFixed(2)}°. Check new capture sessions before relying on this model's accuracy.` : '';
  if (!job) $('training-status').textContent = 'Ready to train from saved annotations.';
  else if (trainingBusy) {
    $('training-status').textContent = job.phase === 'VALIDATING' ? 'Checking the trained model…' : 'Training from ended annotation groups…';
    if (!pageLeaving) trainingTimer = setTimeout(async () => {
      try { showTraining(await request('/annotations/api/training/' + job.jobId)); }
      catch (error) { trainingBusy = false; $('training-status').textContent = error.message + ' Reload to check training status.'; render(); }
    }, config.annotation.training.pollMs);
  } else if (job.state === 'READY') {
    $('training-status').textContent = `Model ready · ${job.coverage.sessions} groups · ${job.coverage.screenshots} screenshots · ${job.coverage.trainingAngleRange.join('–')}°${job.profileError?' · '+job.profileError:''}`;
    $('trained-model').href = job.modelUrl; $('training-report').href = job.reportUrl;
  } else $('training-status').textContent = 'Training failed: ' + job.error;
  render();
}
$('train-model').addEventListener('click', async () => {
  if (trainingBusy || collector.active() || phase === 'BUSY') return;
  trainingBusy = true; render(); $('training-status').textContent = 'Starting training…';
  try { showTraining(await request('/annotations/api/training', { method: 'POST' })); }
  catch (error) { trainingBusy = false; $('training-status').textContent = error.message; render(); }
});
$('train-image-model').addEventListener('click',async()=>{
  if(trainingBusy||collector.active()||phase==='BUSY')return;
  trainingBusy=true;render();
  try{showTraining(await request('/annotations/api/training',json('POST',{method:'image'})));}
  catch(error){trainingBusy=false;$('training-status').textContent=error.message;render();}
});
function setScene(event,text){sceneState=sceneTransition(sceneState,event);$('scene-status').textContent=text||sceneState;render();}
async function pollScene(generation){
  const job=await request('/annotations/api/scene-calibration/'+sceneJobId);
  if(generation!==sceneGeneration||pageLeaving)return;
  if(job.state==='Fitting'){sceneTimer=setTimeout(()=>pollScene(generation).catch(error=>setScene('FAIL',error.message)),config.sceneCalibration.pollMs);return;}
  if(job.state==='Ready'){setScene('SUCCESS',`Ready · ${job.referenceCount} references · ${job.coverage.join('–')}° · Select this Scene profile in Light Track or Fusion.`);$('scene-result').hidden=false;}
  else setScene(job.state==='Invalidated'?'RESET':'FAIL',job.error||job.state);
}
$('scene-start').addEventListener('click',()=>operation(async()=>{
  if(!['Idle','Ready','Invalidated','Failed'].includes(sceneState))return;
  sceneGeneration++;sceneBaseId=$('scene-base').value;sceneJobId=null;sceneCamera=stream?JSON.stringify(['deviceId','width','height','resizeMode'].map(k=>stream.getVideoTracks()[0].getSettings()[k]??null)):null;
  group=await api('',json('POST',{metadata:Object.fromEntries(metadataKeys.map(k=>[k,$('meta-'+k).value]))}));
  sceneGroupId=group.groupId;index=0;await showPhoto();await listGroups();$('scene-result').hidden=true;
  setScene('START','Collecting · Capture screenshots and save their actual measured angles.');
}));
$('scene-fit').addEventListener('click',()=>operation(async()=>{
  if(group.groupId!==sceneGroupId||sceneState!=='Collecting')return;
  if(group.state==='OPEN')group=await api(`/${group.groupId}/close`,json('POST',{revision:group.revision}));
  await listGroups();setScene('FIT','Fitting scene profile…');const generation=sceneGeneration;
  try{const job=await request('/annotations/api/scene-calibration',json('POST',{groupId:group.groupId,revision:group.revision,baseJobId:sceneBaseId}));sceneJobId=job.jobId;await pollScene(generation);}
  catch(error){setScene('FAIL',error.message);}
}));
$('scene-reset').addEventListener('click',async()=>{
  sceneGeneration++;clearTimeout(sceneTimer);
  if(sceneJobId&&sceneState==='Fitting')await request('/annotations/api/scene-calibration/'+sceneJobId,{method:'DELETE'}).catch(()=>{});
  if(sceneState!=='Idle'&&sceneState!=='Invalidated')setScene('RESET','Invalidated · Saved references and profiles are retained. Start a new session for the changed scene.');
  $('scene-result').hidden=true;
});
render();
await operation(async () => { await listGroups(); await cameras(); message('Ready. Start a session or select a saved group.'); });
try { const jobs=await request('/annotations/api/training');showTraining(jobs[0]);$('scene-base').replaceChildren(...jobs.filter(j=>j.state==='READY').map(j=>new Option(`${new Date(j.completedAt).toLocaleString()} · ${j.coverage?.device||'model'} · ${j.jobId.slice(0,8)}`,j.jobId)));render(); }
catch (error) { $('training-status').textContent = error.message; }
