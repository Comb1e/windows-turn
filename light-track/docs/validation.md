# Current workflow validation

Light Track 0.16.0 / Fusion 0.3.0 uses photo annotations only for training/calibration. Current verification is recorded in [iteration.md](iteration.md). The records below are historical evidence; removed collection/training commands are not supported.

# Software validation

## Scene robustness and image inference — 2026-09-17 (0.14.0)

Passed **65 Light Track Node tests**, **55 Python research tests**, **38 application-module syntax checks**, the original **32 Fusion tests plus the new image-profile integration test**, and **all four renderer CTest suites**. New coverage verifies grouped isolation and duplicate removal, support/query disjointness, exact reference budgets, independent exported forest/ridge controls, image boundary cases, metadata availability, cache identities, explicit missing assets, promotion counterexamples, state transitions, stale/cancelled transport, a real Python profile worker, immutable scene fitting/export and page behavior. Fusion's actual coordinator receives the new profile's angle and immediately restores keyboard target priority on reacquisition.

The local evaluated image model is published as job/profile `9bf96cbc-c9a0-4129-8a4a-04fe71313b16`. Browser inspection confirmed the model loads through **Use newest model**, the guide requests actual measured references, and the page shows the 19.59° → 6.69° nested diagnostic. Browser orchestration also exercises asynchronous image results, backend/timing display, preview toggles, profile reset and obsolete responses. No physical camera accuracy was inferred from these checks.

All **259 original annotation files** match the pre-work SHA-256 inventory. New model/report/cache/encoder artifacts are separate and ignored by Git. Group and lighting-description promotion checks pass for the global image model. Ten-reference calibration lacks held-out above-90° queries and is explicitly not promoted as an improved residual method; the live guide retains affine correction. [Research notes](scene-model-research.md) and [aggregate results](scene-evaluation-summary.json) contain all ablations and limitations.

The actual RTX 4070 Laptop GPU reports 10.11 ms warm model P95, 13.40 ms alongside renderer preview, and full frame-service P95 52.24 ms for 900 valid frames in 60.01 seconds (14.997 fps). One request remained in flight, with no queued frames. Maximum service latency was 74.50 ms and 24 scheduled deadlines were exceeded. The corresponding renderer remained Active at a 60 fps cap, averaging 59.60 fps including startup. The operating display reported 240 Hz; no OS refresh setting was changed. Isolated CPU model P95 was 67.46 ms, above the 66.7 ms budget. Still-image throughput, development-group accuracy and preview contention do not establish live motion accuracy, game/full-screen contention, or hardware lid acceptance.

## Compatible annotation model improvement — 2026-09-16 (0.13.0)

Passed all 59 Node tests, 45 Python research tests, and syntax checks for 32 JavaScript modules. New tests cover selection on illumination-shifted synthetic groups, legacy fallback with insufficient/duplicate-only evidence, equal group weighting, training-fold limits, outer-test isolation from inner tuning, aligned identities through duplicate removal, and both forest families' remapped split indices against browser predictions on unseen perturbed features. The page/API tests cover the optional diagnostic summary and old results without it. Existing annotation provenance, sweep, source, replay, and model-selection tests pass.

Browser testing found that Node's JSON serialization changed a configured `1.0` feature fraction to integer `1`; scikit-learn interprets those differently. The trainer now explicitly casts feature fractions to float, and a regression test verifies equal predictions for both JSON spellings. Final page and CLI forests/normalization arrays match exactly.

Using the Fusion launcher, restarted the idle services, then trained all four existing groups from **Train model**. Published job `3605446e-00f0-4d8d-b9fc-875ecb9d0a89` passed validation/parity and contains 212 images, 23 manual labels, 189 keyboard labels, and the original 9–120° coverage. The page shows the nested 19.93° → 17.09° mean group error comparison; reload restores it. **Use newest model** loads this job automatically on the live page. The original 11-image manual group reopened with its PNG and editable 120° label intact. All 216 original annotation files match their pre-work SHA-256 hashes. Prior models remain in their original directories.

The selected forest has 2,596 nodes and a 140,417-byte model, versus 22,308 nodes and 973,493 bytes previously. Detailed group metrics, consulted research, reproducible commands, software versions, and limitations are in [annotation model research](annotation-model-research.md). One group's mean error worsens slightly and large-angle transfer remains weak. These are development-data diagnostics, not independent physical accuracy, motion, jitter, delay, or live camera validation. The camera remained stopped during verification.

## Page model selection — 2026-09-16 (0.12.0)

All 59 Node tests pass; syntax checks cover 32 JavaScript modules. Model selection tests exercise newest successful completion (rather than creation time or listing order), pending/failed exclusion, schema/camera/file-size validation, startup fallback, annotation and local-file inference, switching capture dimensions, clearing the prior filter/readout, refresh preserving explicit choices, reload choosing latest, and disabling changes during capture. The existing real trainer/parity HTTP integration and geometry UI tests also pass.

Browser verification confirmed the newest saved 83-image annotation model loads automatically as the lighting estimator, switching to the older 11-image model succeeds, Refresh models keeps that manual choice, and reloading selects the newest model again. No new camera acquisition or physical-accuracy claim is part of this change.

## Keyboard-assisted screenshots and page training — 2026-09-16 (0.11.0)

Passed 56 Light Track Node tests, 37 Python research tests, 28 Fusion Node tests, and syntax checks for 31 JavaScript modules. New coverage exercises exact RGBA/PNG/features and full-precision labels, 500 ms saves and repeated angles, invalid-reading recovery, updated model ranges, late results and stop/save races, timeouts/idle expiry, ownership/camera/revision failures, correction/clearing provenance, cancellable pending camera acquisition, and mixed-source training with Python/JavaScript parity.

Browser UI verification: Train model completed against the existing 11-image group and exposed model/report downloads; the original group loaded with its labels intact. Published job `10540ba5-f151-4f77-874f-72fb285482a7` covers 9–120° and remains provisional. A fresh page restored that result. The empty temporary browser-check group was moved into ignored verification artifacts; original annotation manifest hashes remain unchanged.

Camera acquisition remained pending in the embedded browser, so physical capture and moving-angle accuracy could not be verified there. Deterministic browser-orchestration tests cover collection, stop, late camera delivery, manual larger-angle labels and training. These checks do not establish independent physical accuracy or unseen-lighting transfer.

## Screenshot groups and camera defaults — 2026-09-15 (0.10.0)

Validation passed 45 Node tests, 26 Python training tests, and syntax checks for 25 JavaScript modules. The final changes to geometric UI compatibility and application asset routes also passed their three focused integration tests. Tests cover persistence across store restarts, unrestricted angle schedules and group sizes, repeated lighting in separate groups, exact PNG/feature correspondence, label correction and clearing, concurrent revision conflicts, incompatible capture rejection, sparse/single-image training, whole-group diagnostic partitions, duplicate-image exclusion, and Python/browser prediction parity. Uncalibrated service and browser capture use Light Track's independent camera settings; saved calibration takes precedence for lighting measurement. Geometry continues if a lighting baseline requires a different resolution.

An isolated browser session verified the annotation layout, saving a 137.25° label, unsaved-edit protection, ending a session after one screenshot, creating a second group with identical lighting, persistence after reload, and discarding edits to restore the saved label. The CLI then trained the browser-saved synthetic screenshot into a provisional artifact and passed its Python/browser parity check, with the still-open group explicitly skipped. Test screenshots and models were confined to a temporary directory.

These checks verify software behavior. They do not establish physical camera accuracy, transfer across real lighting conditions, or motion performance. Screenshot training keeps acceptance flags false and does not produce motion calibration.

## Geometric tracker 0.7.0

Implemented and checked local OpenCV tracking, reference setup, keyframe recovery, server/worker transport, generation/lease invalidation, optional image replay collection, and offline evaluation. OpenCV is installed in the local research environment; the web server can run without a trained lighting model.

Validation run: 23 Node tests, 15 Python tests, and syntax checks for 17 application/research JavaScript modules. An end-to-end smoke sequence sent 202 explicitly synthetic frames through the real Node/Python transport. Development replay exercised all four comparison methods and 55°/65°/75° FOV sensitivity; a frozen-profile test run used a separate synthetic location identity. The synthetic sequences are intentionally repeated software fixtures, not independent real accuracy evidence. Both reports correctly remained unvalidated.

Checks cover synthetic hinge-offset translation with independently moving foreground, planar ambiguity, pure rotation, repeated stationary holds, reversal, dark frames, exposure changes, wrong optics, camera resolution changes, and gap recovery. Node tests cover real Python worker startup/request validation, origin/lease/sequence checks, single-frame backpressure, late startup/results after Stop, recalibration invalidation, the actual geometry UI orchestration with synthetic camera frames, replay capture, and existing lighting behavior.

Replay tests verify setup exclusion, synchronized reference requirements, schema/byte validation, missing predictions in coverage, and no synthetic acceptance. Browser inspection verified the default no-model geometry interface and reference controls. This does not constitute observation of the user's physical camera or laptop motion.

Real-laptop frames and synchronized measured sweeps are not available in the repository. The tracker remains explicitly unvalidated. Approximate optics are labeled in every result. Coverage must be measured alongside accuracy across 10°–120°, especially near closure. Recorded live geometry and replayed geometry are reported separately because worker backpressure, capture gaps, and asynchronous latency affect the actual UI. Replay timing does not establish physical end-to-end latency; `realDataAcceptancePassed` remains false until independent acquisition validation is performed.

## Previous lighting baseline checks

Version 0.6.0 implemented the lighting research workflow; it did not include a validated real-laptop model.

## Completed checks

- 16 JavaScript tests: lighting statistics under diffuse/dark/clipped/color/spatial changes, multiple highlights, filter noise/step/gap handling, measured checkpoint and CSV rules, model topology/schema validation, state transitions, server CLI/assets, and actual app orchestration with synthetic camera frames.
- Six Python tests: source/schema rejection, synchronized-reference requirements, location-disjoint partitions, stationary versus moving evidence, smoothing, delay metrics, and error metrics.
- Syntax checks passed for application and research JavaScript modules.
- End-to-end Extra Trees training used ten explicitly synthetic sessions across five artificial locations. The artifact correctly remained unvalidated.
- JavaScript matched Python on 64 exported model predictions and 128 filter samples within 1e-8 degrees.
- Browser inspection verified absent-model messaging, unvalidated model loading, simulation isolation, and equal lighting readouts across preview visibility changes. Camera acquisition/collection/estimation was exercised with synthetic frames in the orchestration test, not by recording the user's physical environment.

## Outstanding real validation

Collect measured sessions from the actual built-in webcam across at least 30 setups/five locations. Include all angle bins, automatic camera settings, varied display content, multiple lighting situations, relocation, and near-closed views. Reserve independent validation/test locations before fitting. Synchronized moving-angle references are required for dynamic error and delay claims.

Neither ≤5° error, ≤1° stationary jitter, nor ≤0.5-second real response delay is established. Synthetic fixtures are deliberately learnable software tests and provide no evidence of those real-world targets. Offline delay estimates use recorded frame timestamps; physical camera latency, reference-clock accuracy, and live processing overhead also need measurement on the target hardware.
