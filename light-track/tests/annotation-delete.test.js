import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AnnotationStore } from '../annotation-store.js';
import { AnnotationServer } from '../annotation-server.js';

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'photo-delete-'));
  try {
    const store = new AnnotationStore(root, config);
    let group = await store.create({ device: 'test', lighting: 'lamp' });
    for (let i = 0; i < 3; i++) {
      const result = await store.append(group.groupId, { revision: group.revision, width: 16, height: 12, source: 'camera', capturedAt: i }, Buffer.alloc(16 * 12 * 4, 30 + i));
      group = await store.label(group.groupId, result.sampleId, { revision: result.group.revision, angleDeg: 20 + i * 30, notes: 'keep provenance' });
    }
    await run({ root, store, group, directory: store.path(group.groupId) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('permanent deletion works in open/closed groups, preserves other samples and retains empty groups', () => fixture(async ({ store, group, directory }) => {
  const original = await store.get(group.groupId), ids = group.samples.map(s => s.sampleId);
  const keptBytes = await store.image(group.groupId, ids[2]);
  group = await store.deletePhoto(group.groupId, ids[0], group.revision);
  assert.equal(group.samples.length, 2); assert.equal(group.samples[0].features, undefined);
  await assert.rejects(readFile(join(directory, ids[0] + '.png')), { code: 'ENOENT' });
  assert.deepEqual((await store.get(group.groupId)).samples, original.samples.slice(1));
  assert.deepEqual(await store.image(group.groupId, ids[2]), keptBytes);
  group = await store.close(group.groupId, group.revision);
  group = await store.deletePhoto(group.groupId, ids[2], group.revision);
  group = await store.deletePhoto(group.groupId, ids[1], group.revision);
  assert.equal(group.state, 'CLOSED'); assert.deepEqual(group.samples, []);
  assert.equal((await store.list())[0].count, 0);
  assert.deepEqual(await readdir(directory), ['group.json']);
}));

test('revision conflicts, concurrent deletion, traversal and unexpected image paths fail without deleting other data', () => fixture(async ({ store, group }) => {
  const id = group.samples[0].sampleId;
  await assert.rejects(store.deletePhoto(group.groupId, id, group.revision - 1), { status: 409 });
  assert.throws(() => store.deletePhoto(group.groupId, '../outside', group.revision), /identifier/);
  const results = await Promise.allSettled([store.deletePhoto(group.groupId, id, group.revision), store.deletePhoto(group.groupId, id, group.revision)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  group = await store.get(group.groupId);
  await assert.rejects(store.deletePhoto(group.groupId, id, group.revision), { status: 404 });
  group.samples[0].image = '../outside.png'; await store.save(group);
  await assert.rejects(store.deletePhoto(group.groupId, group.samples[0].sampleId, group.revision), /filename/);
}));

test('collection, training and fitting leases serialize against deletion, including a queued start', () => fixture(async ({ store, group }) => {
  for (const [scope, reason] of [[group.groupId, 'automatic collection'], ['*', 'annotation training'], [group.groupId, 'scene-profile fitting']]) {
    const starting = store.acquireUsage(scope, reason);
    const deletion = store.deletePhoto(group.groupId, group.samples[0].sampleId, group.revision);
    const release = await starting;
    await assert.rejects(deletion, error => error.status === 409 && error.message.includes(reason));
    release(); release();
  }
  await store.deletePhoto(group.groupId, group.samples[0].sampleId, group.revision);
}));

test('manifest write failure leaves the photo and label intact and removes the journal', () => fixture(async ({ store, group, directory }) => {
  const original = await readFile(join(directory, 'group.json')), save = store.save;
  store.save = async () => { throw new Error('Disk full'); };
  await assert.rejects(store.deletePhoto(group.groupId, group.samples[0].sampleId, group.revision), /Disk full/);
  store.save = save;
  assert.deepEqual(await readFile(join(directory, 'group.json')), original);
  assert.equal((await readdir(directory)).filter(n => n.startsWith('.')).length, 0);
  assert.ok((await store.image(group.groupId, group.samples[0].sampleId)).length);
}));

test('restart rolls back precommit journals and finishes committed deletes without touching published artifacts', () => fixture(async ({ root, store, group, directory }) => {
  const [first, second] = group.samples;
  const artifact = join(root, 'published-model.json'); await writeFile(artifact, 'immutable published model');
  for (const sample of [first, second]) await writeFile(join(directory, `.delete-${sample.sampleId}.json`), JSON.stringify({ version: 1, groupId: group.groupId, sampleId: sample.sampleId }));
  const complete = await store.get(group.groupId); complete.samples.splice(1, 1); complete.revision++; await store.save(complete);
  await writeFile(join(directory, `.delete-${first.sampleId}.tmp`), '{partial');
  const restarted = new AnnotationStore(root, config); await restarted.ready;
  assert.ok((await restarted.image(group.groupId, first.sampleId)).length);
  await assert.rejects(readFile(join(directory, second.image)), { code: 'ENOENT' });
  assert.equal((await readdir(directory)).filter(n => n.startsWith('.')).length, 0);
  assert.equal(await readFile(artifact, 'utf8'), 'immutable published model');
}));

test('failed physical cleanup reports a committed delete and can be completed after restart', () => fixture(async ({ root, store, group, directory }) => {
  const sample = group.samples[0], path = join(directory, sample.image);
  await rm(path); await mkdir(path); // Simulate a filesystem obstruction to unlink.
  await assert.rejects(store.deletePhoto(group.groupId, sample.sampleId, group.revision), /cleanup is pending/);
  assert.equal((await store.get(group.groupId)).samples.length, 2);
  await rm(path, { recursive: true });
  await new AnnotationStore(root, config).ready;
  assert.equal((await readdir(directory)).filter(n => n.startsWith('.')).length, 0);
}));

test('HTTP delete requires same origin, valid revision, and returns an updated summary', () => fixture(async ({ root, group }) => {
  const api = new AnnotationServer(root, config), server = createServer((req, res) => api.handle(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/annotations/api/groups/${group.groupId}/images/${group.samples[0].sampleId}`;
  const options = { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: group.revision }) };
  try {
    assert.equal((await fetch(url, { ...options, headers: { ...options.headers, Origin: 'https://outside.test' } })).status, 403);
    const release = await api.store.acquireUsage('*', 'annotation training');
    assert.equal((await fetch(url, options)).status, 409); release();
    const response = await fetch(url, options); assert.equal(response.status, 200);
    const updated = await response.json(); assert.equal(updated.samples.length, 2); assert.equal(updated.revision, group.revision + 1);
    assert.equal((await fetch(url)).status, 404);
  } finally { await api.close(); await new Promise(resolve => server.close(resolve)); }
}));
