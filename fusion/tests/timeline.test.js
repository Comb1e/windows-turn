import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineFits, timelineSample, timelineSize } from '../src/timeline.js';

test('display timeline drops service feature payloads and retains replay fields', () => {
  const sample = timelineSample({
    timestampMs: 1234, frameId: 7, measurementAngleDeg: 25, targetAngleDeg: 25,
    displayAngleDeg: 30, motionVelocityDegS: 1, displayVelocityDegS: 2,
    displaySpeedBoundDegS: 3, source: 'keyboard', authoritative: true,
    state: 'KEYBOARD', controllerState: 'CHASING', measurementAgeMs: 40,
    displayAgeMs: 50, features: Array(499).fill(1), summary: { mean: .5 }
  });
  assert.equal(sample.features, undefined);
  assert.equal(sample.summary, undefined);
  assert.equal(sample.displayAngleDeg, 30);
  const size=timelineSize(sample);
  assert.ok(size < 512);
  const limits={maxTimelineRecords:2,maxTimelineBytes:size*2};
  assert.equal(timelineFits(0,0,size,limits),true);
  assert.equal(timelineFits(1,size,size,limits),true);
  assert.equal(timelineFits(2,size*2,size,limits),false);
  assert.equal(timelineFits(0,size*2,1,limits),false);
});
