export function captureCamera(config, calibration) {
  const defaults = config.camera;
  return { width: calibration?.width ?? defaults.width, height: calibration?.height ?? defaults.height,
    horizontalFovDegrees: calibration?.horizontalFovDegrees ?? defaults.horizontalFovDegrees };
}
export function cameraConstraints(camera, deviceId) {
  return { video: { width: { exact: camera.width }, height: { exact: camera.height },
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }) }, audio: false };
}
export function checkCameraFrame(width, height, camera) {
  if (width !== camera.width || height !== camera.height) {
    throw new Error(`Camera requires ${camera.width}×${camera.height}; received ${width}×${height}. Select the configured camera and resolution.`);
  }
}
