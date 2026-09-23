import { setTimeout as delay } from 'node:timers/promises';

export function checkKeyboardContract(info, camera) {
  if (info?.service !== 'keyboard' || info.version !== 1 || info.ready !== true ||
      typeof info.modelId !== 'string' || !info.modelId.trim() ||
      !Array.isArray(info.angleRange) || info.angleRange.length !== 2 ||
      !info.angleRange.every(Number.isFinite) || info.angleRange[0] >= info.angleRange[1]) {
    throw new Error('Keyboard must report a ready model and its supported angle range.');
  }
  if (['width', 'height', 'horizontalFovDegrees'].some(k => info.camera?.[k] !== camera[k])) {
    throw new Error('Keyboard camera dimensions or FOV differ. Match Light Track camera settings and start a compatible group.');
  }
}

/** Camera-free client. Never reconnect implicitly or substitute a previous angle. */
export class KeyboardClient {
  constructor(settings) { this.settings = settings; this.id = null; }
  async request(path, { method = 'GET', body, headers = {}, timeoutMs = this.settings.requestTimeoutMs } = {}) {
    try {
      const response = await fetch(new URL(path, this.settings.url), { method,
        headers: { ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs) });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error || `Keyboard returned ${response.status}`), { status: response.status });
      return value;
    } catch (error) {
      if (error.status) throw error;
      throw new Error(`Keyboard unavailable or timed out. Start the services, then retry collection. (${error.message})`);
    }
  }
  async open(camera) {
    checkKeyboardContract(await this.request('/v1/health', { timeoutMs: this.settings.healthTimeoutMs }), camera);
    const info = await this.request('/v1/sessions', { method: 'POST', body: { camera } });
    this.id = info.sessionId;
    if (typeof this.id !== 'string' || !this.id) throw new Error('Keyboard did not return a session ID.');
    checkKeyboardContract(info, camera);
    this.info = info;
    return info;
  }
  frame(meta, bytes) {
    return this.request(`/v1/sessions/${this.id}/frames`, { method: 'POST', body: bytes, headers: {
      'Content-Type': 'application/octet-stream', 'X-Frame-Id': String(meta.frameId),
      'X-Timestamp-Ms': String(meta.timestampMs), 'X-Width': String(meta.width), 'X-Height': String(meta.height) } });
  }
  async close() {
    if (!this.id) return;
    const id = this.id, deadline = Date.now() + this.settings.requestTimeoutMs;
    try {
      for (;;) {
        try { await this.request(`/v1/sessions/${id}`, { method: 'DELETE', timeoutMs: this.settings.healthTimeoutMs }); return; }
        catch (error) {
          if (error.status === 409 && /expired/i.test(error.message)) return;
          if (error.status !== 409 || !/busy/i.test(error.message) || Date.now() >= deadline) throw error;
          await delay(this.settings.releaseRetryMs);
        }
      }
    } finally { this.id = null; }
  }
}
