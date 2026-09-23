import { KeyboardClient } from './keyboard-client.js';
import { collectionTransition } from './src/annotation-state.js';

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const sameCamera = (a, b) => ['width', 'height', 'horizontalFovDegrees'].every(k => a?.[k] === b?.[k]);

export class AnnotationCollection {
  constructor(store, config) { this.store = store; this.config = config; this.current = null; this.closed = false; }
  transition(s, event) { s.state = collectionTransition(s.state, event); }
  touch(s) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { void this.stop(s.groupId, s.id).catch(() => {}); }, this.config.annotation.keyboard.leaseIdleMs);
    s.timer.unref?.();
  }
  async start(groupId, { collectionId, revision, camera }) {
    if (this.closed) fail('Annotation server is shutting down.');
    if (this.current) fail('Automatic collection already owns Keyboard. Stop it before starting another.');
    this.store.path(collectionId); // Validate the client token, also usable to stop a pending start.
    const s = { id: collectionId, groupId, revision, state: 'IDLE', active: true, savedCount: 0,
      lastFrame: -1, lastTime: -1, savedAt: null, client: new KeyboardClient(this.config.annotation.keyboard) };
    this.current = s; this.transition(s, 'START'); this.touch(s);
    s.operation = (async () => {
      s.releaseUsage = await this.store.acquireUsage(groupId, 'automatic collection');
      const group = await this.store.get(groupId); this.store.checkRevision(group, revision);
      if (group.state !== 'OPEN') fail('Start an open annotation group before collecting.');
      if (!sameCamera(camera, this.config.camera) || camera.width !== this.config.processing.width ||
          camera.width * camera.height > this.config.annotation.maxPixels || (group.capture && !sameCamera(camera, group.capture))) {
        fail('Camera settings differ from this group or Light Track configuration. Start a compatible group.', 400);
      }
      if (JSON.stringify(group.featureConfig) !== JSON.stringify(this.config.features)) fail('Feature configuration changed. Start a new group.');
      s.camera = { ...this.config.camera };
      if (!s.active) fail('Collection stopped during connection.');
      s.info = await s.client.open(s.camera);
      if (!s.active) fail('Collection stopped during connection.');
      this.transition(s, 'READY');
      return { collectionId: s.id, state: s.state, camera: s.camera,
        keyboardModel: { modelId: s.info.modelId, angleRange: s.info.angleRange }, revision };
    })();
    try { return await s.operation; }
    catch (error) { await this.stop(groupId, s.id).catch(() => {}); throw error; }
    finally { s.operation = null; }
  }
  frame(groupId, id, meta, bytes) {
    const s = this.current;
    if (!s || !s.active || s.groupId !== groupId || s.id !== id) fail('Expired automatic collection. Restart collection.');
    if (s.operation) fail('Collection busy; send only one frame at a time.');
    this.touch(s);
    s.operation = this.process(s, meta, bytes);
    return s.operation.catch(async error => {
      // Release outside the active operation to avoid waiting on ourselves.
      s.operation = null;
      if (s.active) this.transition(s, 'FAIL');
      await this.stop(groupId, id).catch(() => {});
      throw error;
    }).finally(() => { s.operation = null; });
  }
  async process(s, meta, bytes) {
    if (!meta || !Number.isSafeInteger(meta.frameId) || meta.frameId <= s.lastFrame ||
        !Number.isFinite(meta.timestampMs) || meta.timestampMs < 0 || meta.timestampMs <= s.lastTime ||
        meta.width !== s.camera.width || meta.height !== s.camera.height || bytes.length !== meta.width * meta.height * 4 ||
        meta.revision !== s.revision || !Number.isFinite(meta.capturedAt) || !Number.isFinite(new Date(meta.capturedAt).getTime())) {
      fail('Invalid, stale, or out-of-order collection frame.', 400);
    }
    // Store.append checks membership and revision inside its serialized transaction.
    // Avoid reparsing the growing feature manifest on every tracking-only frame.
    s.lastFrame = meta.frameId; s.lastTime = meta.timestampMs;
    const result = await s.client.frame(meta, bytes);
    if (!s.active) return { state: 'STOPPING', saved: null };
    if (result.sessionId !== s.client.id || result.frameId !== meta.frameId || result.timestampMs !== meta.timestampMs || result.modelId !== s.info.modelId) {
      fail('Keyboard returned an obsolete frame or changed model. Restart collection.');
    }
    if (typeof result.valid !== 'boolean' || (result.valid && (!Number.isFinite(result.angleDeg) ||
        result.angleDeg < s.info.angleRange[0] || result.angleDeg > s.info.angleRange[1]))) fail('Keyboard returned an invalid angle or model range.');
    this.transition(s, result.valid ? 'VALID' : 'INVALID');
    let saved = null;
    if (result.valid && (s.savedAt === null || meta.timestampMs - s.savedAt >= this.config.annotation.keyboard.saveIntervalMs)) {
      const reference = { sessionId: result.sessionId, frameId: result.frameId, timestampMs: result.timestampMs,
        modelId: result.modelId, angleRange: [...s.info.angleRange], camera: s.camera, angleDeg: result.angleDeg,
        quality: result.quality ?? {} };
      saved = await this.store.append(s.groupId, { ...meta, source: 'camera' }, bytes,
        { keyboardReference: reference, incremental: true, isActive: () => s.active });
      if (saved) { s.revision = saved.revision; s.savedAt = meta.timestampMs; s.savedCount++; }
    }
    return { collectionId: s.id, state: s.state, angleDeg: result.valid ? result.angleDeg : null,
      reason: result.valid ? '' : result.quality?.reason || 'Waiting for a visible keyboard.', savedCount: s.savedCount,
      revision: s.revision, saved };
  }
  stop(groupId, id) {
    const s = this.current;
    if (!s || s.groupId !== groupId || s.id !== id) return Promise.resolve({ stopped: true });
    if (s.stopping) return s.stopping;
    s.active = false; clearTimeout(s.timer); this.transition(s, 'STOP');
    s.stopping = (async () => {
      try { await s.operation?.catch(() => {}); await s.client.close(); }
      finally { s.releaseUsage?.(); this.transition(s, 'STOPPED'); if (this.current === s) this.current = null; }
      return { stopped: true, revision: s.revision };
    })();
    return s.stopping;
  }
  async close() { this.closed = true; const s = this.current; if (s) await this.stop(s.groupId, s.id); }
}
