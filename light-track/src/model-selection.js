import { validateModel } from './model.js';

export function annotationModels(jobs) {
  if (!Array.isArray(jobs)) throw new Error('Saved annotation models could not be listed.');
  return jobs.filter(job => job.state === 'READY' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(job.jobId))
    .map(job => ({ id: job.jobId, kind: 'annotation', date: job.completedAt || job.createdAt,
      url: `/annotations/api/training/${job.jobId}/model`, device: job.coverage?.device || 'experimental',
      screenshots: job.coverage?.screenshots }))
    .filter(model => Number.isFinite(Date.parse(model.date)))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.id.localeCompare(a.id));
}

export function validateLightingArtifact(model, config) {
  validateModel(model, config.features);
  const capture = model.capture;
  if (capture && (!Number.isInteger(capture.width) || capture.width <= 0 ||
      !Number.isInteger(capture.height) || capture.height <= 0 ||
      (capture.horizontalFovDegrees !== undefined && (!Number.isFinite(capture.horizontalFovDegrees) ||
        capture.horizontalFovDegrees < 10 || capture.horizontalFovDegrees > 170)))) {
    throw new Error('Model camera settings are invalid.');
  }
  return model;
}

export async function readLightingFile(file, config) {
  // The fallback supports an already-running 0.11 server until its next restart.
  const limit = config.modelSelection?.maxBytes ?? 20_000_000;
  if (file.size > limit) throw new Error(`Model exceeds ${limit / 1_000_000} MB. Choose a smaller model file.`);
  return validateLightingArtifact(JSON.parse(await file.text()), config);
}
