# Hinge Fusion 0.2.0

The coordinator uses the two independent loopback services through HTTP. It owns no keyboard detector or brightness model. The camera stream is acquired once in the browser and sent as identical unmirrored RGBA frames to both services. It requests the keyboard model's exact resolution without aspect-ratio stretching.

## Start

Run this from the Fusion directory to start all three services:

```powershell
npm start
```

The launcher reuses healthy existing services and starts missing ones in their own project directories. It does not merge the projects. Ctrl+C stops only services it launched. `npm run start:coordinator` starts Fusion alone. `KEYBOARD_PYTHON` selects a Python executable; otherwise the keyboard project virtual environment is used. `npm start -- --config path.json` selects startup and service settings. `npm start -- --model ../light-track/artifacts/source/model.json` supplies a CLI model when launching a new Light Track process; an already running service retains its existing model. Saved profiles still work without `--model`.

Open http://localhost:1820 and start the camera. `PORT` overrides the coordinator's port; `node server.js --config path.json` selects another coordinator configuration. Ports, service URLs, capture settings, stale/grace intervals, controller parameters, queue bounds, and recording limits live in `config.json`.

With Light Track 0.14, **Saved calibration** also lists promoted image models and measured-reference scene profiles. Choose **Image model · 253 screenshots** and click **Use calibration** to try the current DINOv2/ridge model. Scene profiles belong to their captured lighting/camera setup; select the base image model after changing scenes. Create scene profiles through Light Track's annotation page with Fusion's camera stopped. Older sweep profiles remain supported, and keyboard target priority is unchanged.

When a fresh valid keyboard reading is available, both the measured angle and **Target angle** equal that reading. Brightness disagreement never overrides it. Only motion measured from contiguous keyboard samples may drive a keyboard target; sparse samples or brief visibility gaps do not substitute scene motion. The keyboard target is not extrapolated between samples. After the configured keyboard grace period, usable brightness becomes the fallback.

Displayed movement is separate: filtered physical motion supplies feedforward, and a seventh-degree correction trajectory preserves position, velocity, acceleration, and jerk during replanning. The large displayed angle therefore converges smoothly to the target. Each chase has an original 1-second deadline that source/profile changes do not restart. Late large discrepancies can exceed the preferred correction speed, acceleration, and jerk; the page reports this explicitly. Existing filtered motion decays continuously on keyboard reacquisition instead of snapping the displayed derivatives.

## Calibrate with one opening and closing sweep

1. Start all three services and open Fusion at http://localhost:1820. Light Track needs no `--model` for this workflow. Leave the standalone camera pages stopped.
2. Start the camera. Optionally edit setup details and the profile name, then click **Start sweep calibration**.
3. Hold a keyboard-visible angle below 25° for 0.8 seconds. Open evenly to approximately 120°, maintaining the speed measured during the initial keyboard-visible movement.
4. Hold near 120° for automatic stop detection. If tracking cannot establish the stop, click **Holding at 120°** and remain still. This records your approximate endpoint; the camera does not independently prove it.
5. When prompted, close at the indicated pace. If motion tracking is unavailable, click **Start closing now** as you begin. Stop below 25° and hold; the final keyboard angle can differ from the initial angle.
6. Accepted sweeps train automatically, save a profile, and activate it. Select saved profiles in **Saved calibration → Use calibration**. **Export profile** downloads model, recording, calibration parameters, and diagnostics together.

Opening and closing pace checks tolerate 20% difference by default. Insufficient keyboard coverage, reversed movement, long frame gaps, or changed camera/lighting conditions require another sweep. Failed recordings remain downloadable through the advanced recording export; **Cancel calibration** restores the previous selected profile. Models have actual coverage such as 18–120°, not fabricated 10° examples.

Both services receive identical 640×480 RGBA frames. The old standalone 640×360 model is incompatible, but it does not prevent collection in feature-only mode. Profiles store their capture binding, model ID, label provenance, pace measurements, and timestamps under Light Track's `data/profiles`. Selection persists across restarts. Online adaptation remains temporary and never edits a saved model.

Hidden-angle labels assume constant speed between keyboard and upper-hold anchors. Boundary regions are excluded, and inferred labels have lower training weight. Opening/closing agreement is only a diagnostic; this single sweep does not independently validate wide-angle accuracy or environmental transfer. Keep the base stationary and display/lighting stable. Calibration can work without scene-motion calibration; hidden-angle physical velocity then degrades to a decay toward zero.

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

Choose a profile collected under similar conditions or collect a new sweep. A selected profile starts from its own model output; keyboard labels supply temporary offset/affine correction without assuming the current angle is 120°. Exposure/lighting changes invalidate temporary adaptation and carry only a provisional prior. Small-angle anchors do not validate large-angle transfer.

## API and recording output

The UI uses `/api/start`, `/api/frames`, `/api/stop`, and the `/api/events` SSE stream. Other local consumers can poll `GET /api/angle` for:

```json
{
  "measurementAngleDeg": 25,
  "targetAngleDeg": 25,
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

Angles may be `null` when unavailable. `targetAngleDeg` is the controller's current correction target: the exact keyboard measurement when selected, the retained keyboard angle during a brief gap, or the age-aligned brightness estimate on fallback. It is null when the controller is stale. The UI marks retained targets as held. `lastValid` and `displayAgeMs` identify retained values separately. `motionVelocityDegS` is filtered physical-motion inference, not the displayed derivative. `adaptation` includes the state, version, segment, parameters, and anchor coverage.

Recording export includes lighting features, raw/adapted values, keyboard label provenance, motion increments, frozen settings, initial adapter state, and a compact real display timeline. It contains no camera pixels. Fusion drops per-service feature vectors from its live pair cache and enforces the configured display-timeline record/byte budget; when a limit is reached it stops both recording buffers with an explicit status. Downloads use a browser Blob to avoid a second parsed JSON copy. It remains in memory until downloaded; export before stopping/restarting. Preview visibility does not affect processing.

## Validation and replay

```powershell
npm test
node research/controller-validation.mjs
node research/smoke.mjs
npm run replay -- data/recording.json data/report.json
```

The smoke command starts all three real services on temporary ports with generated synthetic inputs, then closes only its own child processes. It produces ignored software fixtures and a replay report under `data/smoke/`. The saved synthetic model is deliberately not a deployment model.

Replay calls the adapter's public `restore/observe/add` functions from the neighboring Light Track checkout; pass its module path as the third argument if located elsewhere. It scores the current prediction before admitting its keyboard label. Accuracy uses independent checkpoint/reference labels, excluding keyboard teachers. Reports distinguish raw brightness, adapted brightness, recorded adaptation, replay display, and actual recorded display; missing predictions reduce coverage. Dynamic delay needs synchronized moving labels. Recorded correction trajectories carry deadlines and completion status; ordinary motion delay is reported separately.

Software verification does not establish real laptop angle accuracy, reference synchronization, or live camera latency. Those measurements require real recordings with independent references.

See [keyboard target validation and references](docs/keyboard-target-validation.md) for the conflicting-motion regression, source boundaries and research used for version 0.2.2.

## Calibration and profile APIs

All mutation requests include the coordinator `sessionId` while a session is active. `POST /api/calibration` starts a sweep with optional `metadata`; `GET /api/calibration` reports state, pace, and endpoints; `DELETE /api/calibration` cancels; `POST /api/calibration/action` accepts `action: upper` or `closing`. `GET /api/calibration/export` exports calibration timing, and `/api/recording` exports the matching lighting data. `/api/events` adds a `calibration` event and includes calibration status in angle events.

`GET /api/profiles` lists saved profiles. `POST /api/profile` selects a `profileId`, and `GET /api/profiles/:id/export` downloads the complete bundle. Selection is only accepted outside an active sweep. Profile/model generation identifiers prevent delayed old-model frames and anchors from replacing current state.

The controller output additionally exposes `displayAccelerationDegS2`, `displayJerkDegS3`, `controllerState`, `correctionErrorDeg`, `correctionElapsedMs`, `correctionRemainingMs`, `correctionDeadlineMs`, `comfortExceeded`, `plannedCorrectionPeaks`, and `lastCorrection`. `displaySpeedBoundDegS` describes the current planned correction peak plus physical speed; it is no longer the old 1°/s-at-rest ceiling. Brief missing readings retain the last display target for up to 500 ms; longer stale gaps freeze position and keep the deadline. Expired chases remain visibly overdue and recover without a new countdown. Physical-range clamping and stale-input freezing remain explicit boundary exceptions to derivative continuity.

The one-second countdown belongs to the active correction, not to individual readings. Brightness/keyboard switches and missing-result events do not reset it. `displayTargetHeld` identifies short retained-target intervals; `correctionOverdue` and `lastCorrection.deadlineMet` distinguish deadline misses from timely convergence. Current `measurementAngleDeg` is still null when neither service supplies usable fresh input.
