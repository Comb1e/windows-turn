/**
 * The display timeline is intentionally smaller than the live service result.
 * Lighting feature vectors belong to the Light Track recording; Fusion only
 * needs the values required to replay and measure the displayed trajectory.
 */
export function timelineSample(output) {
  return {
    timestampMs: output.timestampMs,
    frameId: output.frameId ?? null,
    measurementAngleDeg: output.measurementAngleDeg ?? null,
    targetAngleDeg: output.targetAngleDeg ?? null,
    displayAngleDeg: output.displayAngleDeg ?? null,
    motionVelocityDegS: output.motionVelocityDegS ?? null,
    displayVelocityDegS: output.displayVelocityDegS ?? null,
    displaySpeedBoundDegS: output.displaySpeedBoundDegS ?? null,
    source: output.source ?? 'none',
    authoritative: Boolean(output.authoritative),
    state: output.state ?? 'UNAVAILABLE',
    controllerState: output.controllerState ?? 'STALE',
    measurementAgeMs: output.measurementAgeMs ?? null,
    displayAgeMs: output.displayAgeMs ?? null
  };
}

export function timelineSize(sample) {
  return Buffer.byteLength(JSON.stringify(sample), 'utf8');
}

export function timelineFits(count, bytes, sampleBytes, limits) {
  return count < (limits.maxTimelineRecords ?? Infinity)
    && bytes + sampleBytes <= (limits.maxTimelineBytes ?? Infinity);
}
