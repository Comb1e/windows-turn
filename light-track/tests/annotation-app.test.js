import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('annotation page collects, blocks conflicting edits, stops cleanly, labels large angles and trains from its button', async () => {
  const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
  const html = await readFile(new URL('../annotation.html', import.meta.url), 'utf8');
  const elements = new Map(), events = {}, groups = [], uploads = [];
  let animation, timer, signal = 12, releaseFrame, training = null, cameraStopped = false, nextCamera = null;
  let confirmDelete = false, confirmation = '';
  const settle = () => new Promise(setImmediate);
  class Element {
    constructor() { Object.assign(this, { value: '', textContent: '', hidden: false, disabled: false, listeners: {}, files: [] }); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    replaceChildren() {} async decode() {} async play() {} click() { return this.listeners.click?.(); }
    removeAttribute(name) { delete this[name]; }
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
    getContext() { return { fillRect() {}, drawImage() {}, getImageData: (x, y, width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(signal) }) }; }
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element());
  const el = id => elements.get(id), video = el('video'); Object.assign(video, { readyState: 2, videoWidth: 640, videoHeight: 480, currentTime: 0 });
  const track = { getSettings: () => ({ width: 640, height: 480 }), stop() { cameraStopped = true; }, addEventListener() {} };
  const response = value => ({ ok: true, json: async () => structuredClone(value) });
  const replacements = {
    document: { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener: (name, fn) => { events[name] = fn; } },
    window: { addEventListener: (name, fn) => { events[name] = fn; }, confirm: text => { confirmation = text; return confirmDelete; } }, Option: class {},
    navigator: { mediaDevices: { getUserMedia: async () => nextCamera ?? ({ getVideoTracks: () => [track], getTracks: () => [track] }), enumerateDevices: async () => [] } },
    requestAnimationFrame: fn => { animation = fn; return 1; }, cancelAnimationFrame: () => { animation = null; },
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { timer = null; },
    fetch: async (url, options = {}) => {
      if (url === '/config.json') return response(config);
      if (url === '/annotations/api/training') {
        if (options.method === 'POST') { training = { jobId: 'job-1', state: 'RUNNING', phase: 'TRAINING' }; return response(training); }
        return response(training ? [training] : []);
      }
      if (url === '/annotations/api/training/job-1') return response(training);
      if(url==='/annotations/api/scene-calibration')return response({jobId:'scene-job',state:'Fitting'});
      if(url==='/annotations/api/scene-calibration/scene-job')return response({state:'Ready',profileId:'scene-profile',referenceCount:3,coverage:[20,100]});
      const path = url.replace('/annotations/api/groups', ''), group = groups.find(g=>path.startsWith('/'+g.groupId))??groups[0];
      const data = typeof options.body === 'string' ? JSON.parse(options.body) : null;
      if (path === '') {
        if (options.method === 'POST') { const created = { groupId: 'group-'+(groups.length+1), metadata: data.metadata, createdAt: new Date().toISOString(), state: 'OPEN', revision: 0, samples: [] }; groups.push(created); return response(created); }
        return response(groups.map(g => ({ ...g, labeled: g.samples.filter(s => s.angleDeg !== null).length, count: g.samples.length })));
      }
      if (path.endsWith('/collection') && options.method === 'POST') return response({ collectionId: data.collectionId, keyboardModel: { modelId: 'teacher', angleRange: [10, 46] } });
      if (path.includes('/collection/')) {
        if (options.method === 'DELETE') return response({ stopped: true });
        const meta = JSON.parse(decodeURIComponent(options.headers['X-Screenshot'])); uploads.push({ bytes: options.body, meta });
        await new Promise(resolve => { releaseFrame = resolve; });
        const sample = { sampleId: 'auto-' + meta.frameId, angleDeg: 25.123456789, labelSource: 'keyboard', notes: '' };
        group.samples.push(sample); group.revision++;
        return response({ collectionId: path.split('/').at(-1), state: 'COLLECTING', angleDeg: sample.angleDeg,
          savedCount: group.samples.length, revision: group.revision, saved: { sample, revision: group.revision, capture: config.camera } });
      }
      if (path.endsWith('/images') && options.method === 'POST') {
        const sampleId = 'manual-1'; group.samples.push({ sampleId, angleDeg: null, notes: '' }); group.revision++; return response({ group, sampleId });
      }
      if (path.includes('/labels/')) { Object.assign(group.samples.at(-1), data, { labelSource: 'manual' }); group.revision++; return response(group); }
      if (path.includes('/images/') && options.method === 'DELETE') { group.samples = group.samples.filter(s => s.sampleId !== path.split('/').at(-1)); group.revision++; return response(group); }
      if (path.endsWith('/close')) { group.state = 'CLOSED'; group.revision++; return response(group); }
      return response(group);
    },
  };
  const originals = Object.fromEntries(Object.keys(replacements).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  try {
    for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    await import('../src/annotation-app.js?automatic-collection-test');
    el('meta-device').value = 'laptop'; el('meta-lighting').value = 'desk lamp';
    await el('new-group').click(); await el('camera').click(); await el('auto-start').click();
    assert.equal(el('groups').disabled, true); assert.equal(el('files').disabled, true); assert.equal(el('train-model').disabled, true);
    assert.equal(el('delete-photo').disabled, true);
    video.currentTime = .1; animation(100); await settle();
    signal = 99; video.currentTime = .2; animation(200); await settle();
    assert.equal(uploads.length, 1); assert.equal(uploads[0].bytes[0], 12);
    releaseFrame(); await settle(); assert.match(el('auto-reading').textContent, /25\.12°.*10–46°.*Saved 1/);
    await el('auto-stop').click(); assert.equal(el('groups').disabled, false); assert.equal(el('angle').value, 25.123456789);
    await el('snap').click(); el('angle').value = '95.5'; el('angle').listeners.input();
    assert.equal(el('auto-start').disabled, true); await el('save').click(); assert.equal(groups[0].samples.at(-1).angleDeg, 95.5);
    await el('auto-start').click(); video.currentTime = .3; animation(300); await settle();
    const stopping = el('end-group').click(); releaseFrame(); await stopping;
    assert.equal(groups[0].state, 'CLOSED'); assert.equal(el('auto-start').disabled, true);
    await el('train-model').click(); assert.match(el('training-status').textContent, /Training from/); assert.equal(el('train-model').disabled, true);
    training = { ...training, state: 'READY', coverage: { sessions: 1, screenshots: 3, trainingAngleRange: [25.123456789, 95.5] }, modelUrl: '/model-download', reportUrl: '/report-download' };
    await timer(); assert.equal(el('training-result').hidden, false); assert.equal(el('trained-model').href, '/model-download');
    assert.match(el('training-status').textContent, /Model ready/);
    assert.equal(el('training-diagnostic').hidden, true);
    await el('train-model').click();
    training = { ...training, state: 'READY', coverage: { sessions: 4, screenshots: 212, trainingAngleRange: [9, 120] },
      diagnostic: { baseline: { meanGroupMAE: 19.93 }, selectedProcedure: { evaluatedGroups: 4, meanGroupMAE: 17.09 } } };
    await timer(); assert.equal(el('training-diagnostic').hidden, false);
    assert.match(el('training-diagnostic').textContent, /19\.93°.*17\.09°/);
    el('stop-camera').click(); assert.equal(cameraStopped, true);
    await el('reload').click(); assert.match(el('group-status').textContent, /Session ended/);
    let deliverCamera, lateCameraStopped = false;
    nextCamera = new Promise(resolve => { deliverCamera = resolve; });
    const opening = el('camera').click(); await settle(); assert.equal(el('stop-camera').disabled, false);
    el('stop-camera').click(); await opening;
    assert.match(el('message').textContent, /cancelled/); assert.equal(el('reload').disabled, false);
    deliverCamera({ getTracks: () => [{ stop() { lateCameraStopped = true; } }] }); await settle();
    assert.equal(lateCameraStopped, true);
    el('scene-base').value='base-job';await el('scene-start').click();assert.equal(groups.length,2);
    assert.match(el('scene-status').textContent,/Collecting/);assert.match(el('scene-guide').textContent,/0 \/ about 10/);
    groups[1].samples=[{sampleId:'s1',angleDeg:20},{sampleId:'s2',angleDeg:60},{sampleId:'s3',angleDeg:100}];
    await el('reload').click();assert.equal(el('scene-fit').disabled,false);
    await el('scene-fit').click();assert.equal(groups[1].state,'CLOSED');assert.match(el('scene-status').textContent,/Ready.*3 references/);
    assert.equal(el('scene-result').hidden,false);await el('scene-reset').click();assert.match(el('scene-status').textContent,/Invalidated/);
    await el('reload').click(); el('notes').value = 'unsaved'; el('notes').listeners.input();
    await el('delete-photo').click(); assert.equal(groups[1].samples.length, 3);
    assert.match(confirmation, /s1.*[\s\S]*unsaved edits/); assert.equal(el('notes').value, 'unsaved');
    confirmDelete = true;
    await el('delete-photo').click(); assert.deepEqual(groups[1].samples.map(s => s.sampleId), ['s2', 's3']);
    assert.equal(el('angle').value, 60); assert.equal(el('discard').disabled, true);
    await el('next').click(); await el('delete-photo').click(); assert.equal(el('angle').value, 60);
    await el('delete-photo').click(); assert.equal(groups[1].samples.length, 0);
    assert.equal(el('delete-photo').disabled, true); assert.equal(el('photo').hidden, true); assert.equal(el('photo').src, undefined);
  } finally {
    for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
