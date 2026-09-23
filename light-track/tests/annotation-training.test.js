import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AnnotationServer } from '../annotation-server.js';
import { AnnotationTraining } from '../annotation-training.js';

test('page training API trains mixed labels, validates parity, publishes downloads and restores saved jobs', { timeout: 60000 }, async () => {
  const root = fileURLToPath(new URL('..', import.meta.url)), temp = await mkdtemp(join(tmpdir(), 'annotation-training-'));
  const config = JSON.parse(await readFile(join(root, 'config.json')));
  config.annotation.directory = join(temp, 'groups'); config.annotation.training.directory = join(temp, 'models'); config.annotation.training.treeCount = 4;
  const api = new AnnotationServer(root, config), server = createServer((req, res) => api.handle(req, res)).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/annotations/api/training`;
  try {
    const group = await api.store.create({ device: 'test laptop', lighting: 'lamp' });
    const camera = { width: 16, height: 12, horizontalFovDegrees: 60 }, meta = { width: 16, height: 12, source: 'camera', capturedAt: 1000, camera, frameId: 1, timestampMs: 0 };
    let saved = await api.store.append(group.groupId, { ...meta, revision: 0 }, Buffer.alloc(16 * 12 * 4, 100), {
      keyboardReference: { modelId: 'keyboard-test', angleRange: [10, 46], angleDeg: 35.123, sessionId: 'test', frameId: 1, timestampMs: 0, camera, quality: {} } });
    saved = await api.store.append(group.groupId, { ...meta, revision: saved.group.revision }, Buffer.alloc(16 * 12 * 4, 180));
    const labeled = await api.store.label(group.groupId, saved.sampleId, { revision: saved.group.revision, angleDeg: 95.25, notes: '' });
    await api.store.close(group.groupId, labeled.revision);
    assert.equal((await fetch(base, { method: 'POST', headers: { Origin: 'https://example.com' } })).status, 403);
    const response = await fetch(base, { method: 'POST' }); assert.equal(response.status, 202); const job = await response.json();
    assert.equal((await fetch(base, { method: 'POST' })).status, 409);
    await api.training.jobs.get(job.jobId).done;
    const ready = await (await fetch(base + '/' + job.jobId)).json(); assert.equal(ready.state, 'READY', ready.error);
    const modelResponse = await fetch(base + '/' + job.jobId + '/model'); assert.match(modelResponse.headers.get('content-disposition'), /attachment/);
    const model = await modelResponse.json(), report = await (await fetch(base + '/' + job.jobId + '/report')).json();
    assert.deepEqual(model.coverage.labelSources, { manual: 1, keyboard: 1 }); assert.equal(model.keyboardModels[0].modelId, 'keyboard-test');
    assert.equal(report.independentValidationAvailable, false); assert.deepEqual(model.angleRange, [35.123, 95.25]);
    assert.equal(model.annotationMethod.selectedCandidate.id, 'legacy-extra-trees');
    assert.match(report.modelSelection.reason, /Too few groups/);
    assert.equal(ready.diagnostic.selectedProcedure.evaluatedGroups, 0);
    const restored = new AnnotationTraining(root, config, api.store); assert.equal((await restored.list())[0].jobId, job.jobId);
    assert.equal((await fetch(base + '/' + job.jobId + '/config')).status, 400);
    const again = await api.training.start(); assert.notEqual(again.jobId, job.jobId); await api.training.jobs.get(again.jobId).done;
    assert.equal((await restored.list()).length, 2);
  } finally { await api.close(); await new Promise(r => server.close(r)); await rm(temp, { recursive: true, force: true }); }
});

test('empty annotation training fails clearly and publishes no model', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url)), temp = await mkdtemp(join(tmpdir(), 'empty-annotation-training-'));
  const config = JSON.parse(await readFile(join(root, 'config.json')));
  config.annotation.directory = join(temp, 'groups'); config.annotation.training.directory = join(temp, 'models');
  const api = new AnnotationServer(root, config);
  try {
    const job = await api.training.start(); await api.training.jobs.get(job.jobId).done;
    const status = await api.training.status(job.jobId); assert.equal(status.state, 'FAILED'); assert.match(status.error, /End at least one session/);
    await assert.rejects(api.training.artifact(job.jobId, 'model'), /not ready/);
  } finally { await api.close(); await rm(temp, { recursive: true, force: true }); }
});
