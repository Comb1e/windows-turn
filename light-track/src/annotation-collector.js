import { collectionTransition } from './annotation-state.js';

/** One live frame request; camera frames arriving during transport are skipped. */
export class ScreenshotCollector {
  constructor({ request, capture, update, saved, stopped, config }) {
    Object.assign(this, { request, capture, update, saved, stopped, config });
    this.state = 'IDLE'; this.count = 0; this.angle = null; this.range = null; this.reason = '';
  }
  active() { return !['IDLE', 'ERROR'].includes(this.state); }
  transition(event) { this.state = collectionTransition(this.state, event); this.update(); }
  async start(group, camera) {
    if (this.active()) return;
    this.id = crypto.randomUUID(); this.groupId = group.groupId; this.revision = group.revision;
    this.count = 0; this.angle = null; this.range = null; this.reason = ''; this.sequence = 0; this.lastCapture = -Infinity;
    this.transition('START');
    this.opening = this.request(`/${this.groupId}/collection`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionId: this.id, revision: this.revision, camera }) });
    try {
      const info = await this.opening;
      if (this.state !== 'CONNECTING') return;
      this.range = info.keyboardModel.angleRange; this.transition('READY'); this.schedule();
    } catch (error) {
      if (this.state === 'CONNECTING') await this.stop(error.message);
    } finally { this.opening = null; }
  }
  schedule() {
    if (!['WAITING', 'COLLECTING'].includes(this.state)) return;
    this.animation = requestAnimationFrame(time => {
      this.schedule();
      if (this.pending || time - this.lastCapture < 1000 / this.config.processing.fps) return;
      let shot;
      try { shot = this.capture(); } catch (error) { void this.stop(error.message); return; }
      if (!shot) return;
      this.lastCapture = time;
      const meta = { ...shot.meta, revision: this.revision, frameId: ++this.sequence, timestampMs: time };
      this.pending = this.request(`/${this.groupId}/collection/${this.id}`, { method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Screenshot': encodeURIComponent(JSON.stringify(meta)) }, body: shot.data })
        .then(result => {
          if (!['WAITING', 'COLLECTING'].includes(this.state)) return;
          if (result.collectionId !== this.id) throw new Error('Obsolete collection response. Restart collection.');
          this.angle = result.angleDeg; this.reason = result.reason; this.count = result.savedCount; this.revision = result.revision;
          if (result.saved) this.saved(result.saved);
          this.transition(result.angleDeg === null ? 'INVALID' : 'VALID');
        }).catch(error => { if (this.state !== 'STOPPING') void this.stop(error.message); })
        .finally(() => { this.pending = null; });
    });
  }
  stop(reason = '', { leaving = false } = {}) {
    if (this.stopping) return this.stopping;
    if (!this.active()) return Promise.resolve();
    this.reason = reason; this.angle = null; this.transition('STOP'); cancelAnimationFrame(this.animation);
    const path = `/${this.groupId}/collection/${this.id}`;
    // A tiny keepalive request releases an established or connecting lease on page exit.
    if (leaving) void this.request(path, { method: 'DELETE', keepalive: true }).catch(() => {});
    this.stopping = (async () => {
      await this.opening?.catch(() => {});
      try { await this.request(path, { method: 'DELETE' }); }
      catch (error) { this.reason ||= error.message; }
      await this.pending;
      if (!leaving) {
        try { await this.stopped(this.groupId); }
        catch (error) { this.reason ||= error.message; }
      }
      if (this.reason) this.transition('FAIL'); else this.transition('STOPPED');
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }
}
