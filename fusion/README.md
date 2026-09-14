# Hinge Fusion 0.1.0

The coordinator uses the two independent loopback services through HTTP. It owns no keyboard detector or brightness model. The camera stream is acquired once in the browser and sent as identical unmirrored RGBA frames to both services. It requests the keyboard model's exact resolution without aspect-ratio stretching.

## Start

Start the keyboard service and Light Track as described in the workspace README, then:

```powershell
npm start
```

Open http://localhost:1820 and start the camera. `PORT` overrides the coordinator's port; `node server.js --config path.json` selects another coordinator configuration. Ports, service URLs, capture settings, stale/grace intervals, controller parameters, queue bounds, and recording limits live in `config.json`.

The current raw angle always equals a valid keyboard reading, regardless of brightness disagreement. The display is deliberately independent: it follows inferred velocity and applies a slowly changing bounded correction. At rest it converges at up to 1°/s; in motion its rate is bounded by 1.2 × the filtered inferred speed + 1°/s. There is no fixed switching duration. A 60° discrepancy at rest can take about a minute to remove.

When the keyboard is visible, velocity comes from robust slopes of its recent raw angles. When hidden, Light Track supplies calibrated relative motion. Before motion calibration, or with an untrackable scene, the velocity estimate decays toward zero and the display uses the slow correction allowance. Approximate scene velocity cannot distinguish every whole-laptop pitch from a hinge rotation; keep the base fixed.

## Collect the source-environment baseline

1. Run Light Track without `--model` and start the coordinator camera. A brightness model is unnecessary for collection.
2. Expand **Baseline calibration and recordings**. Fill in laptop, environment, position, lighting, and display information. Keep the environment and capture configuration consistent across the source recordings.
3. Start recording. The default guide has 12 checkpoints: 10°, 20°, …, 120° in one opening pass. At measured positions, choose **Capture 2-second hold**. For a separate closing recording, set `collection.directions` to `["closing"]` in Light Track's `config.json` and restart that service before recording. Low-angle keyboard labels are attached to the matching frames automatically and override checkpoint labels for training; independent checkpoint values remain preserved for evaluation.
4. Record continuous, trackable movement spanning at least 20° between known labels. At least two such intervals in the training recordings are needed to fit the motion axis, sign, and scale. A missing relative-motion result breaks the calibration interval.
5. End and download the recording. Repeat for at least three complete recordings: training, validation, and test. Every partition must cover the full 10–120° range. Additional separate sweeps improve the evidence.
6. For moving accuracy and delay, import an external synchronized CSV after ending a recording. Its header is `tMs,angle,motion`; `tMs` is relative to the recording start, motion is `moving` or `stationary`, and the entered offset is added to the CSV clock. Importing changes the downloadable recording; download again.

Save recordings in `light-track/data/source/`. Read each JSON's `sessionId` and choose complete validation and test recordings before training:

```powershell
Set-Location E:\Projects\windows-turn\light-track
.\.venv\Scripts\python.exe research/train.py data/source --mode source-environment --validation-session VALIDATION_RECORDING_ID --test-session TEST_RECORDING_ID --output artifacts/source
npm start -- --model artifacts/source/model.json
```

The training command retains all remaining recordings for training. It writes the model, validation report, inference parity fixture, capture binding, model fingerprint, and motion calibration. A failed or missing motion calibration is explicit in `report.json`; it never silently supplies a fabricated velocity.

Source-environment validation is separate from the original cross-environment acceptance gates. A successful source test does not mark deployment in other rooms validated. Synthetic fixtures cannot pass real acceptance.

## New environments

Start a new session at approximately 120°. The system assumes that value without prompting and waits 1–3 seconds for a usable settled brightness baseline. It initially changes only the output offset. Accurate keyboard labels progressively improve the temporary adapter; scale fitting requires three 2° bins, at least 10° of label coverage, and at least 5° of baseline-prediction variation.

The frozen source model is never rewritten. At most 256 representative anchors are retained in memory. Reset/stop removes them. **Export adaptation** saves an explicit research snapshot. Model/adapter updates never reset display position or become a motion derivative.

A mid-session environmental change carries the last provisional estimate rather than assuming 120° again. Weak or clipped signals suppress measurement output. A camera resolution change requires a new session and a compatible baseline. Cross-environment affine correction may fail when the original model collapses multiple angles to one prediction; narrow-range keyboard anchors cannot certify wide-angle accuracy.

## API and recording output

The UI uses `/api/start`, `/api/frames`, `/api/stop`, and the `/api/events` SSE stream. Other local consumers can poll `GET /api/angle` for:

```json
{
  "measurementAngleDeg": 25,
  "displayAngleDeg": 38.5,
  "source": "keyboard",
  "authoritative": true,
  "state": "KEYBOARD",
  "motionVelocityDegS": -12,
  "displayVelocityDegS": -14,
  "displaySpeedBoundDegS": 15.4,
  "measurementAgeMs": 40,
  "provisional": false
}
```

Angles may be `null` when unavailable. `lastValid` and `displayAgeMs` identify retained values separately. `motionVelocityDegS` is filtered physical-motion inference, not the displayed derivative. `adaptation` includes the state, version, segment, parameters, and anchor coverage.

Recording export includes lighting features, raw/adapted values, keyboard label provenance, motion increments, frozen settings, initial adapter state, and the real display timeline. It contains no camera pixels. It remains in memory until downloaded; export before stopping/restarting. Preview visibility does not affect processing.

## Validation and replay

```powershell
npm test
node research/smoke.mjs
npm run replay -- data/recording.json data/report.json
```

The smoke command starts all three real services on temporary ports with generated synthetic inputs, then closes only its own child processes. It produces ignored software fixtures and a replay report under `data/smoke/`. The saved synthetic model is deliberately not a deployment model.

Replay calls the adapter's public `restore/observe/add` functions from the neighboring Light Track checkout; pass its module path as the third argument if located elsewhere. It scores the current prediction before admitting its keyboard label. Accuracy uses independent checkpoint/reference labels, excluding keyboard teachers. Reports distinguish raw brightness, adapted brightness, recorded adaptation, replay display, and actual recorded display; missing predictions reduce coverage. Dynamic delay needs synchronized moving labels. Display discontinuity corrections are not subject to a fixed latency deadline.

Software verification does not establish real laptop angle accuracy, reference synchronization, or live camera latency. Those measurements require real recordings with independent references.
