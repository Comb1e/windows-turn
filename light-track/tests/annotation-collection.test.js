import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { inflateSync } from 'node:zlib';
import { AnnotationServer } from '../annotation-server.js';
import { extractFeatures } from '../src/features.js';

const original = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(run, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), 'keyboard-annotation-'));
  const config = structuredClone(original); Object.assign(config.camera, { width: 16, height: 12 }); config.processing.width = 16;
  Object.assign(config.annotation.keyboard, settings);
  const camera = config.camera, seen = [], deleted = [], health = { version: 1, service: 'keyboard', ready: true,
    modelId: 'model-46', angleRange: [10, 46], camera }, mock = { angle: 45.123456789, transform: r => r, gate: null, createError: null };
  let sessionId;
  const keyboard = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks); let value = health, status = 200;
    if (req.url === '/v1/sessions') {
      if (mock.createError) { status = 409; value = { error: mock.createError }; }
      else { sessionId = randomUUID(); value = { ...health, sessionId }; }
    } else if (req.method === 'DELETE') { deleted.push(req.url); mock.onDelete?.(); value = { stopped: true }; }
    else if (req.url.endsWith('/frames')) {
      seen.push({ bytes, headers: req.headers });
      mock.onFrame?.(); if (mock.gate) await mock.gate;
      value = mock.transform({ sessionId, frameId: Number(req.headers['x-frame-id']), timestampMs: Number(req.headers['x-timestamp-ms']),
        valid: mock.angle !== null, angleDeg: mock.angle, modelId: health.modelId, quality: { confidence: .95, reason: 'Keyboard hidden' } });
    }
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
  }).listen(0, '127.0.0.1'); await once(keyboard, 'listening');
  config.annotation.keyboard.url = `http://127.0.0.1:${keyboard.address().port}`;
  const api = new AnnotationServer(root, config), server = createServer((req, res) => api.handle(req, res)).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/annotations/api/groups`;
  const request = async (path, method = 'GET', body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const value = await res.json(); if (!res.ok) throw Object.assign(new Error(value.error), { status: res.status }); return value;
  };
  const group = await request('', 'POST', { metadata: { device: 'test laptop', lighting: 'lamp' } });
  const id = randomUUID(), path = `/${group.groupId}/collection/${id}`, bytes = Buffer.from(Array.from({ length: 16 * 12 * 4 }, (_, i) => i % 256));
  let frameId = 0, revision = 0;
  const start = (overrides = {}) => request(`/${group.groupId}/collection`, 'POST', { collectionId: id, revision, camera, ...overrides });
  const frame = async (timestampMs, overrides = {}) => {
    const result = await request(path, 'POST', bytes, { 'Content-Type': 'application/octet-stream', 'X-Screenshot': encodeURIComponent(JSON.stringify({
      width: 16, height: 12, revision, capturedAt: 100000 + timestampMs, frameId: ++frameId, timestampMs, camera, ...overrides })) });
    revision = result.revision ?? revision; return result;
  };
  try { await run({ api, config, mock, health, group, id, path, bytes, seen, deleted, request, start, frame, camera }); }
  finally { mock.gate = null; await api.close(); await Promise.all([server, keyboard].map(s => new Promise(r => s.close(r)))); await rm(root, { recursive: true, force: true }); }
}

test('automatic HTTP collection saves exact pixels and full-precision labels every 500 ms, including repeated angles', () => fixture(async f => {
  const info = await f.start(); assert.deepEqual(info.keyboardModel.angleRange, [10, 46]);
  const first = await f.frame(0); assert.equal(first.saved.sample.angleDeg, f.mock.angle); assert.equal(first.saved.group, undefined);
  assert.equal((await f.frame(499)).saved, null); assert.ok((await f.frame(500)).saved);
  f.mock.angle = null; assert.equal((await f.frame(1000)).state, 'WAITING');
  f.mock.angle = 45.123456789; assert.ok((await f.frame(1100)).saved);
  await f.request(f.path, 'DELETE');
  const group = await f.api.store.get(f.group.groupId); assert.equal(group.samples.length, 3); assert.equal(group.state, 'OPEN');
  assert.equal(f.deleted.length, 1); assert.deepEqual(f.seen[0].bytes, f.bytes);
  const sample = group.samples[0]; assert.equal(sample.labelSource, 'keyboard');
  assert.equal(sample.keyboardReference.frameId, 1); assert.equal(sample.keyboardReference.timestampMs, 0);
  assert.equal(sample.keyboardReference.modelId, 'model-46');
  assert.deepEqual(sample.features, extractFeatures({ width: 16, height: 12, data: f.bytes }, f.config.features).features);
  const png = await f.api.store.image(group.groupId, sample.sampleId), compressed = [];
  for (let offset = 8; offset < png.length;) { const size = png.readUInt32BE(offset); if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + size)); offset += size + 12; }
  const pixels = inflateSync(Buffer.concat(compressed));
  for (let y = 0; y < 12; y++) assert.deepEqual(pixels.subarray(y * 65 + 1, y * 65 + 65), f.bytes.subarray(y * 64, (y + 1) * 64));
  let edited = await f.api.store.label(group.groupId, sample.sampleId, { revision: group.revision, angleDeg: sample.angleDeg, notes: 'note only' });
  assert.equal(edited.samples[0].labelSource, 'keyboard');
  edited = await f.api.store.label(group.groupId, sample.sampleId, { revision: edited.revision, angleDeg: 90, notes: 'external correction' });
  assert.equal(edited.samples[0].labelSource, 'manual'); assert.equal(edited.samples[0].keyboardReference.angleDeg, sample.angleDeg);
  edited = await f.api.store.label(group.groupId, sample.sampleId, { revision: edited.revision, angleDeg: null, notes: '' });
  assert.equal(edited.samples[0].labelSource, null); assert.equal(edited.samples[0].angleDeg, null);
}));

test('stopping during a keyboard response rejects its late label and permits a fresh collection', () => fixture(async f => {
  await f.start(); const arrived = deferred(), release = deferred(); f.mock.onFrame = arrived.resolve; f.mock.gate = release.promise;
  const response = f.frame(0); await arrived.promise;
  const stopped = f.api.collection.stop(f.group.groupId, f.id); assert.equal(f.api.collection.current.active, false);
  release.resolve(); await Promise.all([response, stopped]);
  assert.equal((await f.api.store.get(f.group.groupId)).samples.length, 0);
  await f.start(); f.mock.gate = null; assert.ok((await f.frame(100)).saved);
}));

test('a stop waits for an already-started save before releasing the lease', () => fixture(async f => {
  await f.start(); const entered = deferred(), release = deferred(), save = f.api.store.save.bind(f.api.store);
  f.api.store.save = async g => { entered.resolve(); await release.promise; return save(g); };
  const frame = f.frame(0); await entered.promise;
  const stop = f.api.collection.stop(f.group.groupId, f.id); assert.equal(f.deleted.length, 0);
  release.resolve(); await Promise.all([frame, stop]); assert.equal(f.deleted.length, 1);
  assert.equal((await f.api.store.get(f.group.groupId)).samples.length, 1);
}));

test('model identity, frame identity, timestamps and range errors stop without publishing labels', async () => {
  for (const transform of [r => ({ ...r, modelId: 'changed' }), r => ({ ...r, frameId: r.frameId + 1 }),
    r => ({ ...r, timestampMs: r.timestampMs + 1 }), r => ({ ...r, sessionId: 'old' }), r => ({ ...r, angleDeg: 47 })]) {
    await fixture(async f => { await f.start(); f.mock.transform = transform; await assert.rejects(f.frame(0), /Keyboard/);
      assert.equal(f.api.collection.current, null); assert.equal((await f.api.store.get(f.group.groupId)).samples.length, 0); });
  }
});

test('future model ranges work and concurrent group edits force an explicit restart', () => fixture(async f => {
  f.health.angleRange = [5, 60]; f.mock.angle = 55.333; await f.start(); const saved = await f.frame(0);
  assert.equal(saved.saved.sample.angleDeg, 55.333);
  await f.api.store.label(f.group.groupId, saved.saved.sample.sampleId, { revision: saved.revision, angleDeg: 80, notes: '' });
  await assert.rejects(f.frame(500), /another tab/); assert.equal(f.api.collection.current, null);
}));

test('camera mismatch and another keyboard owner are actionable without releasing somebody else’s session', () => fixture(async f => {
  await assert.rejects(f.start({ camera: { ...f.camera, horizontalFovDegrees: 70 } }), /Camera settings/);
  f.health.camera = { ...f.camera, height: 13 }; await assert.rejects(f.start(), /dimensions or FOV/);
  f.health.camera = f.camera; f.mock.createError = 'Another session owns the keyboard service';
  await assert.rejects(f.start(), /Another session/); assert.equal(f.deleted.length, 0); assert.equal(f.api.collection.current, null);
}));

test('idle leases release Keyboard even after a browser disappears', () => fixture(async f => {
  const expired = deferred(); f.mock.onDelete = expired.resolve; await f.start(); await expired.promise;
  await f.api.collection.current?.stopping; assert.equal(f.api.collection.current, null);
}, { leaseIdleMs: 40 }));

test('a timed-out frame stops collection and cannot later append a screenshot', () => fixture(async f => {
  await f.start(); const release = deferred(); f.mock.gate = release.promise;
  try { await assert.rejects(f.frame(0), /timed out/); assert.equal((await f.api.store.get(f.group.groupId)).samples.length, 0); }
  finally { release.resolve(); }
}, { requestTimeoutMs: 80 }));
