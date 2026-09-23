import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { captureCamera, cameraConstraints, checkCameraFrame } from '../src/camera.js';

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
test('Light Track owns its uncalibrated defaults; saved calibration overrides them', () => {
  assert.deepEqual(captureCamera(config), { width: 640, height: 480, horizontalFovDegrees: 60 });
  const settings = structuredClone(config);
  Object.assign(settings.camera, { width: 800, height: 600, horizontalFovDegrees: 72 });
  assert.deepEqual(captureCamera(settings), { width: 800, height: 600, horizontalFovDegrees: 72 });
  const calibrated = captureCamera(settings, { width: 640, height: 360, horizontalFovDegrees: 65 });
  assert.deepEqual(cameraConstraints(calibrated, 'chosen').video, { width: { exact: 640 }, height: { exact: 360 }, deviceId: { exact: 'chosen' } });
  assert.throws(() => checkCameraFrame(640, 480, calibrated), /requires 640×360/);
});
