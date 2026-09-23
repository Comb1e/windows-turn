import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { extractFeatures, FEATURE_VERSION, featureNames } from './src/features.js';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function identifier(id) { if (!idPattern.test(id)) fail('Invalid annotation identifier'); return id; }
const removeIfPresent = path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });

// Lossless screenshots preserve the exact pixels used by the shared extractor.
export function encodePng({ width, height, data }) {
  const chunk = (type, bytes) => {
    const body = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export class AnnotationStore {
  constructor(root, config) {
    this.config = config; this.directory = resolve(root, config.annotation.directory); this.pending = Promise.resolve();
    this.readers = new Map(); this.ready = this.recover();
    this.ready.catch(() => {}); // Report startup recovery failures through the API.
  }
  path(id) { return join(this.directory, identifier(id)); }
  // Serialize entire read/modify/write transactions, including concurrent tabs.
  mutate(action) {
    const result = this.pending.then(() => this.ready).then(action); this.pending = result.catch(() => {}); return result;
  }
  acquireUsage(groupId, reason) {
    if (groupId !== '*') identifier(groupId);
    return this.mutate(() => {
      const token = Symbol(reason); this.readers.set(token, { groupId, reason });
      return () => this.readers.delete(token);
    });
  }
  async recover() {
    await mkdir(this.directory, { recursive: true });
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (entry.isDirectory() && idPattern.test(entry.name)) await this.recoverGroup(entry.name);
    }
  }
  async recoverGroup(id) {
    const directory = this.path(id);
    for (const name of await readdir(directory)) {
      if (/^\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.test(name)) {
        await removeIfPresent(join(directory, name)); continue;
      }
      const match = /^\.delete-([a-f0-9-]+)\.(json|tmp)$/.exec(name);
      if (!match || !idPattern.test(match[1])) continue;
      const path = join(directory, name);
      if (match[2] === 'tmp') { await removeIfPresent(path); continue; }
      const record = await json(path);
      if (record.version !== 1 || record.groupId !== id || record.sampleId !== match[1]) fail('Invalid photo deletion journal', 500);
      const group = await json(join(directory, 'group.json'));
      // The atomic manifest replacement is the commit point. Before it, retain
      // the original image; after it, complete physical deletion on restart.
      if (!group.samples.some(s => s.sampleId === record.sampleId)) await removeIfPresent(join(directory, `${record.sampleId}.png`));
      await removeIfPresent(path);
    }
  }
  async save(group) {
    const temporary = join(this.path(group.groupId), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(group) + '\n', { flag: 'wx' });
      await rename(temporary, join(this.path(group.groupId), 'group.json')); return group;
    } finally { await removeIfPresent(temporary); }
  }
  async get(id) { await this.ready; return json(join(this.path(id), 'group.json')); }
  summary(group) { return { ...group, samples: group.samples.map(({ features, ...sample }) => sample) }; }
  async list() {
    await this.ready;
    await mkdir(this.directory, { recursive: true });
    const groups = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
      try {
        const group = await this.get(entry.name);
        groups.push({ groupId: group.groupId, state: group.state, metadata: group.metadata, createdAt: group.createdAt,
          count: group.samples.length, labeled: group.samples.filter(s => s.angleDeg !== null).length });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return groups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  create(metadata) {
    return this.mutate(async () => {
      const clean = {};
      for (const key of ['device', 'lighting', 'location', 'position', 'display']) {
        const value = metadata?.[key] ?? '';
        if (typeof value !== 'string' || value.length > this.config.annotation.maxTextLength) fail(`Invalid ${key}`);
        clean[key] = value.trim();
      }
      if (!clean.device || !clean.lighting) fail('Enter the laptop identifier and lighting condition');
      const group = { version: 1, kind: 'lighting-screenshot-group', groupId: randomUUID(), revision: 0,
        createdAt: new Date().toISOString(), state: 'OPEN', metadata: clean, capture: null,
        featureVersion: FEATURE_VERSION, featureConfig: this.config.features, featureNames: featureNames(this.config.features), samples: [] };
      await mkdir(this.path(group.groupId), { recursive: true }); return this.save(group);
    });
  }
  checkRevision(group, revision) {
    if (revision !== group.revision) fail('This group changed in another tab. Reload the group before saving.', 409);
  }
  close(id, revision) {
    return this.mutate(async () => {
      const group = await this.get(id); this.checkRevision(group, revision);
      if (group.state !== 'OPEN') fail('This annotation session has ended', 409);
      group.state = 'CLOSED'; group.closedAt = new Date().toISOString(); group.revision++; return this.save(group);
    });
  }
  append(id, meta, bytes, { keyboardReference = null, incremental = false, isActive = () => true } = {}) {
    return this.mutate(async () => {
      const group = await this.get(id); this.checkRevision(group, meta.revision);
      if (!isActive()) return null;
      if (group.state !== 'OPEN') fail('Start a new annotation session to add screenshots', 409);
      const { width, height, source, capturedAt, camera = {} } = meta;
      if (!Number.isInteger(width) || !Number.isInteger(height) || Math.min(width, height) < 1 ||
          width * height > this.config.annotation.maxPixels || bytes.length !== width * height * 4) fail('Invalid screenshot dimensions or RGBA bytes');
      if (!['camera', 'upload'].includes(source) || !Number.isFinite(capturedAt) || !Number.isFinite(new Date(capturedAt).getTime()) ||
          !camera || typeof camera !== 'object' || Array.isArray(camera)) fail('Invalid screenshot source or capture metadata');
      const capture = { width, height, horizontalFovDegrees: this.config.camera.horizontalFovDegrees };
      if (JSON.stringify(group.featureConfig) !== JSON.stringify(this.config.features) ||
          (group.capture && JSON.stringify(group.capture) !== JSON.stringify(capture))) fail('Capture configuration changed. Start a new annotation session.');
      const image = { width, height, data: bytes }, result = extractFeatures(image, this.config.features);
      const png = encodePng(image), sampleId = randomUUID();
      const sample = { sampleId, image: `${sampleId}.png`, imageSha256: createHash('sha256').update(png).digest('hex'),
        source, capturedAt, camera, angleDeg: keyboardReference?.angleDeg ?? null,
        labelSource: keyboardReference ? 'keyboard' : null, notes: '', features: result.features,
        ...(keyboardReference ? { keyboardReference, frameId: meta.frameId, timestampMs: meta.timestampMs,
          labeledAt: new Date().toISOString() } : {}) };
      await writeFile(join(this.path(id), sample.image), png, { flag: 'wx' });
      group.capture ??= capture; group.samples.push(sample); group.revision++; await this.save(group);
      if (incremental) {
        const { features, ...summary } = sample;
        return { sample: summary, revision: group.revision, capture: group.capture };
      }
      return { group: this.summary(group), sampleId };
    });
  }
  label(id, sampleId, body) {
    return this.mutate(async () => {
      const group = await this.get(id); this.checkRevision(group, body.revision);
      const sample = group.samples.find(s => s.sampleId === identifier(sampleId));
      if (!sample) fail('Unknown screenshot', 404);
      if (body.angleDeg !== null && !Number.isFinite(body.angleDeg)) fail('Enter a finite measured angle');
      if (typeof body.notes !== 'string' || body.notes.length > this.config.annotation.maxTextLength) fail('Invalid annotation notes');
      sample.labelSource = body.angleDeg === null ? null : body.angleDeg === sample.angleDeg ? sample.labelSource || 'manual' : 'manual';
      sample.angleDeg = body.angleDeg; sample.notes = body.notes; sample.labeledAt = new Date().toISOString(); group.revision++;
      await this.save(group); return this.summary(group);
    });
  }
  deletePhoto(id, sampleId, revision) {
    identifier(sampleId);
    return this.mutate(async () => {
      const use = [...this.readers.values()].find(r => r.groupId === '*' || r.groupId === id);
      if (use) fail(`Cannot delete photos during ${use.reason}. Stop or finish it first.`, 409);
      await this.recoverGroup(id);
      const group = await this.get(id); this.checkRevision(group, revision);
      const index = group.samples.findIndex(s => s.sampleId === sampleId);
      if (index < 0) fail('Unknown screenshot', 404);
      if (group.samples[index].image !== `${sampleId}.png`) fail('Unexpected screenshot filename', 400);
      const journal = join(this.path(id), `.delete-${sampleId}.json`), temporary = join(this.path(id), `.delete-${sampleId}.tmp`);
      let committed = false;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, groupId: id, sampleId }), { flag: 'wx' });
        await rename(temporary, journal);
        group.samples.splice(index, 1); group.revision++;
        await this.save(group); committed = true;
        await removeIfPresent(join(this.path(id), `${sampleId}.png`));
        await removeIfPresent(journal);
        return this.summary(group);
      } catch (error) {
        if (!committed) await removeIfPresent(journal);
        else error.message = `Photo removed from the group; file cleanup is pending. Reload the group. ${error.message}`;
        throw error;
      } finally { await removeIfPresent(temporary); }
    });
  }
  async image(id, sampleId) {
    const group = await this.get(id), sample = group.samples.find(s => s.sampleId === identifier(sampleId));
    if (!sample) fail('Unknown screenshot', 404);
    return readFile(join(this.path(id), sample.image));
  }
}
