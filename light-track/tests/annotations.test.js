import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { inflateSync } from 'node:zlib';
import { AnnotationStore } from '../annotation-store.js';
import { AnnotationServer } from '../annotation-server.js';
import { extractFeatures } from '../src/features.js';

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const meta = { width: 16, height: 12, source: 'camera', capturedAt: 1000, camera: { width: 16, height: 12 } };
const bytes = Buffer.from(Array.from({ length: 16 * 12 * 4 }, (_, i) => i % 4 === 3 ? 255 : i % 256));
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'light-annotations-'));
  try { await run(new AnnotationStore(root, config), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test('sessions persist independent lighting groups with arbitrary angles, repeats and counts', () => fixture(async (store, root) => {
  let group = await store.create({ device: 'laptop', lighting: 'two lamps' });
  for (let i = 0; i < 14; i++) {
    const added = await store.append(group.groupId, { ...meta, revision: group.revision }, bytes);
    group = await store.label(group.groupId, added.sampleId, { revision: added.group.revision, angleDeg: i === 0 ? 0 : 132.75 - i, notes: '' });
  }
  const closed = await store.close(group.groupId, group.revision);
  assert.equal(closed.state, 'CLOSED'); assert.equal(closed.samples.length, 14);
  await assert.rejects(store.append(group.groupId, { ...meta, revision: closed.revision }, bytes), /new annotation session/);
  const again = await store.create({ device: 'laptop', lighting: 'two lamps' });
  const other = await store.create({ device: 'laptop', lighting: 'daylight' });
  assert.notEqual(again.groupId, group.groupId); assert.notEqual(other.groupId, again.groupId);
  const restarted = new AnnotationStore(root, config);
  assert.equal((await restarted.list()).length, 3);
  assert.deepEqual((await restarted.get(group.groupId)).samples.map(s => s.angleDeg), closed.samples.map(s => s.angleDeg));
  const corrected = await restarted.label(group.groupId, closed.samples[0].sampleId, { revision: closed.revision, angleDeg: 17.35, notes: 'Corrected measurement' });
  assert.equal(corrected.samples[0].angleDeg, 17.35);
}));
test('stored PNG and features belong to the same exact screenshot', () => fixture(async store => {
  const group = await store.create({ device: 'laptop', lighting: 'window' });
  const added = await store.append(group.groupId, { ...meta, revision: group.revision }, bytes);
  const png = await store.image(group.groupId, added.sampleId);
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const decoded = inflateSync(Buffer.concat(chunks));
  for (let y = 0; y < meta.height; y++) assert.deepEqual(decoded.subarray(y * 65 + 1, y * 65 + 65), bytes.subarray(y * 64, y * 64 + 64));
  const saved = await store.get(group.groupId);
  assert.deepEqual(saved.samples[0].features, extractFeatures({ ...meta, data: bytes }, config.features).features);
  assert.equal(added.group.samples[0].features, undefined);
}));
test('concurrent edits, invalid labels and changed capture geometry cannot corrupt a group', () => fixture(async store => {
  const group = await store.create({ device: 'laptop', lighting: 'window' });
  const added = await store.append(group.groupId, { ...meta, revision: 0 }, bytes);
  const write = angleDeg => store.label(group.groupId, added.sampleId, { revision: 1, angleDeg, notes: '' });
  const results = await Promise.allSettled([write(25.1), write(80)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  for (const angleDeg of [NaN, Infinity, '12', undefined]) await assert.rejects(store.label(group.groupId, added.sampleId, { revision: 2, angleDeg, notes: '' }), /finite/);
  await assert.rejects(store.append(group.groupId, { ...meta, width: 12, height: 16, revision: 2 }, bytes), /configuration changed/);
  const cleared = await store.label(group.groupId, added.sampleId, { revision: 2, angleDeg: null, notes: '' });
  assert.equal(cleared.samples[0].angleDeg, null);
  await assert.rejects(store.get('../outside'), /identifier/);
}));
test('annotation HTTP API validates uploads and exposes saved groups and screenshots', () => fixture(async (_, root) => {
  const api = new AnnotationServer(root, config), server = createServer((req, res) => api.handle(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/annotations/api/groups`;
  const post = (path, data) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    assert.equal((await fetch(base, { headers: { Origin: 'https://example.com' } })).status, 403);
    const group = await (await post('', { metadata: { device: 'laptop', lighting: 'window' } })).json();
    const upload = payload => fetch(`${base}/${group.groupId}/images`, { method: 'POST', headers: {
      'Content-Type': 'application/octet-stream', 'X-Screenshot': encodeURIComponent(JSON.stringify({ ...meta, revision: 0 })) }, body: payload });
    assert.equal((await upload(bytes.subarray(1))).status, 400);
    const response = await upload(bytes); assert.equal(response.status, 201);
    const added = await response.json();
    assert.equal((await fetch(`${base}/${group.groupId}/images/${added.sampleId}`)).headers.get('content-type'), 'image/png');
    assert.equal((await (await fetch(`${base}/${group.groupId}/export`)).json()).samples[0].features.length, 499);
    assert.equal((await post(`/${group.groupId}/close`, { revision: 1 })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));
