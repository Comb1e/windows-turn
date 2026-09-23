export function freezeScreenshot(source, width, height, config) {
  const canvas = document.createElement('canvas'); canvas.width = config.processing.width;
  canvas.height = Math.round(canvas.width * height / width);
  if (!width || !height || canvas.width * canvas.height > config.annotation.maxPixels) throw new Error('Image dimensions exceed the screenshot pixel limit.');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = 'black'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { frame: ctx.getImageData(0, 0, canvas.width, canvas.height), capturedAt: Date.now() };
}
