# Iteration history

## 0.16.0 — 2026-09-19 — Photo-only workflows

Photo annotation with manual or matching-frame Keyboard angles is now the only supported training/calibration input. Sweep/timed/geometric/simulation entry points are removed; original data and published artifacts remain preserved. See [current iteration](docs/iteration.md) for causes, verification and limits.

## 0.15.0 — 2026-09-19 — Permanent annotation photo deletion

The editor now permanently deletes individual photos and their stored labels/features after confirmation, with revision checks, a recovery journal, and collection/training/fitting leases. Existing exports and published models/profiles are retained. All 72 JavaScript tests pass; real annotation files were not deleted. Full causes, verification, and limitations are in [docs/iteration.md](docs/iteration.md).

## 0.14.0 — 2026-09-17

**Previous issues:** The 499 mostly photometric features and small color forests transferred poorly between scenes. The latest six-group model averaged 19.59° error, with few independently measured larger angles. Extra features could not be evaluated reproducibly without changing the old schema, and there was no guided measured-reference scene profile.

**Method root causes:** Brightness/color responds to exposure and scene composition as well as hinge angle. Training-fit accuracy and random frame splits could hide this ambiguity. Small-angle keyboard samples dominate the available images, while unseen-scene and high-angle evidence is sparse.

**Improvements:** Added cached, versioned lighting/texture/metadata/frozen image/depth feature comparisons, bounded forest/ridge selection, nested group/lighting-description diagnostics, explicit calibration support/query separation, strict promotion checks, exported-head parity and runtime gates. DINOv2 ViT-S/14 plus ridge alpha 100 was selected and published in existing Light Track and Fusion selectors. Added shared local image inference, explicit backend/timing, bounded transport, and guided approximately ten-reference scene calibration using original screenshot storage and the established affine correction. Old model and profile paths remain available.

**Verification:** All 259 existing annotation files are unchanged. Nested group MAE improves 19.59° → 6.69° and lighting-description holdout MAE 31.24° → 11.58°; all specified uncalibrated promotion gates pass. Export parity maximum error is 0.000064°. RTX 4070 warm inference P95 is 10.11 ms. The full service processed 900 valid frames in 60.01 seconds alongside a 60 fps renderer preview, with P95 52.24 ms, one in flight and zero queued. Browser inspection confirms the new guide and selected model. Detailed regression counts, sources and benchmark limitations are recorded in `docs/validation.md` and `docs/scene-model-research.md`.

**Remaining issues:** CPU-only inference misses the 66.7 ms target. Some service deadlines were exceeded; game/full-screen contention is not accepted. Ten-reference calibration lacks separate high-angle queries in the existing data, so residual calibration is not promoted. Live calibration stays affine, and still-image development diagnostics do not validate physical motion, jitter, reference accuracy or unseen scenes. New independently measured images beyond the calibration references remain necessary.

## 0.13.0 — 2026-09-16

The previous annotation trainer used fixed Extra Trees settings over all brightness/color features. It fitted training labels closely but transferred poorly between capture groups, while raw exposure changes competed with angle cues. There was no data-driven choice of regularization or feature family, and training fit could not establish improvement.

Consulted color-invariance and forest research, scikit-learn/scikit-image implementations, and model-selection-bias research. Local comparisons of color forests, HOG-inspired descriptors, nearest-neighbor and kernel regressors favored a small set of regularized forests using existing color-ratio features. Added whole-group candidate selection with a minimum improvement gate and legacy fallback, nested diagnostics that repeat tuning without the test group, original-method comparison, and page-visible diagnostic results. Exact duplicate pixels are purged before both preprocessing and selection. Export compiles subset split indices back to the unchanged v1 model interface; all original groups, images, labels, teacher references, and features remain usable. No new dependency, annotation migration, relabeling, or runtime feature extraction is needed.

On four development groups containing 212 screenshots (23 manual, 189 keyboard), nested mean group absolute error improved 19.926° → 17.094° (14.21%), and mean within-5° agreement improved 26.10% → 36.74%. One keyboard group slightly worsened; large-angle transfer remains weak. The selected final forest has 2,596 nodes versus 22,308 previously. The more optimistic all-data tuning score is recorded separately. These sessions informed development and cannot establish independent physical accuracy. Sources and full per-group results are in `docs/annotation-model-research.md`.

Validation: 59 Node tests, 45 Python tests, syntax checks, and model parity pass. Browser training published a new 212-image model, restored its comparison on reload, and selected it as the live-page default. A browser/CLI configuration-number mismatch found during verification was fixed with explicit feature-fraction typing and a regression test. Original manual annotations reopened successfully; all 216 annotation files retain their original hashes. The services run through the existing Fusion launcher with its camera stopped.

## 0.12.0 — 2026-09-16

The previous release could train annotations from the page but still required a command-line model path and server restart to use the result. The live page fetched only `/model.json`, and geometric tracking remained the initial estimator even when an annotation model was ready.

Added a live-page model selector using published annotation jobs, newest successful completion as the default, optional startup-model selection, and browser-local model files. Automatic selection refreshes to a newer completion; manual choices remain until changed or the page reloads. Invalid candidates retain the previous valid estimator. Switching clears old readings/filter state and binds the next camera session to the chosen model's capture settings. The annotation result now links directly to measurement. Model size limits live in configuration and are shared with CLI loading.

Validation: all 59 Node tests and syntax checks pass, including completion ordering, unfinished/failed exclusion, local-file validation and size limits, older-model selection, camera binding, filter/readout reset, refresh semantics, reload defaults, and camera-time selection locks. Physical angle accuracy is not established by model selection tests.

## 0.11.0 — 2026-09-16

The previous screenshot workflow required users to enter every measured angle, even where Keyboard already supplied accurate measurements. Repeated clicks and manual labels limited collection efficiency. Training also required a terminal, leaving the browser workflow incomplete.

Added automatic exact-frame keyboard labels: save the first valid screenshot immediately, then valid frames at least 500 ms apart, including repeated angles. Tracking input remains continuous because Keyboard needs consecutive frames to confirm its boundary. Explicit states, one in-flight request, model/camera binding, revision checks, late-result rejection, and lease cleanup protect image/label correspondence. Loss of visibility pauses saves; service or model errors require restart. Manual corrections retain the original teacher reference and change active label provenance.

The annotation page now starts asynchronous screenshot training, shows progress, and offers model/report downloads. Each run uses a unique directory and publishes only after model validation and Python/JavaScript parity checks. Existing groups remain readable; reports distinguish manual and keyboard supervision and preserve model references. Shared range validation has an explicit screenshot mode while retaining sweep behavior.

Verification: 56 Light Track Node tests, 37 Python research tests, 28 Fusion tests, and syntax checks pass. Tests cover cadence, repeated angles, exact pixels/features/angles, invalid recovery, model/range changes, concurrent edits, stop/save races, camera mismatch, timeouts, lease expiry, correction/clearing, page orchestration, mixed-label training, downloads and restoration. Browser verification trained the existing 11-image group through the new button and published a parity-checked 9–120° provisional model. Physical moving-angle accuracy remains a hardware validation task; teacher agreement is not independent validation.

## 0.10.0 — 2026-09-15

The previous lighting collection method required video-derived, timed checkpoint holds on a fixed angle schedule. It could not retain and review individual screenshots, accept arbitrarily sized sessions, or fit sparse groups of different-angle images under repeated or changing lighting. The uncalibrated standalone camera also requested 960×540/65° while the keyboard scheme used 640×480/60°.

Added a persistent screenshot annotation workspace with explicit per-session groups, capture/upload, individual measured labels, corrections, and same-lighting repetitions across distinct groups. There is no required angle list, range, direction, hold duration, or screenshot count. PNG screenshots and shared extracted features are saved together, with revision checks and atomic group manifests. The trainer balances group weights, records actual angle coverage, and diagnoses transfer with whole groups excluded from fitting. Exact duplicate images are excluded across diagnostic folds. Single-image and sparse groups can produce provisional artifacts without pretending to provide independent or temporal validation.

Light Track's own config now carries matching 640×480/60° uncalibrated defaults. The application does not read Keyboard configuration. Shared exact-resolution capture rules cover annotation and measurement; saved lighting-model capture bindings override defaults for calibrated measurement. Existing collections and models remain separate from the screenshot dataset.

Verification passed 45 Node tests, 26 Python training tests, syntax checks, browser annotation/reload checks, and a browser-saved screenshot-to-model parity run. Physical lighting transfer and motion performance remain unvalidated; details are in `docs/validation.md`.

## 2026-09-15 — Automatic keyboard model limits and recovered calibration profiles

The previous sweep trainer hard-coded a 44-degree ceiling and its shared loader separately imposed 45 degrees. Retraining the independent keyboard model to support 46 degrees therefore caused valid matched labels to fail calibration. Fusion now captures the active keyboard service model ID and supported range automatically and includes them in each sweep. Both Python training paths share a metadata-based validator. A changed keyboard model aborts an active sweep; labels are never clamped or dropped to fit an obsolete limit.

Recovery exposed a second failure: weighted Extra Trees leaf averages reached 120.00000000000006 and failed strict model validation. The generic exporter now repairs endpoint roundoff only, while rejecting material range errors. Profile artifacts retain validation-range provenance. Legacy sweeps without model metadata remain explicitly marked as having no recorded model-range evidence.

Both original failed recordings were retained byte-for-byte and trained successfully through the normal profile store. The 01:26 profile covers 10.879–120 degrees with 298 exact keyboard labels; the 01:32 profile covers 11.232–120 degrees with 232 exact labels and is selected for the next session. All five labels above 44 degrees survived unchanged. Python/JavaScript prediction differences were below 5e-14 degrees. Profiles and the recovery audit remain local under Light Track data.

Validation: 30 Python tests, 38 Light Track Node tests and syntax checks, and 28 Fusion tests pass, including an HTTP sweep through training, profile publication, selection and restoration with a 10–46-degree keyboard model. Tests also cover future model ranges, invalid ranges and labels, legacy recovery, model identity changes, and numeric endpoint export errors.

Methodological limits: successful training does not establish live angle accuracy. Opening/closing diagnostic 95th-percentile differences remain about 29–35 degrees for the first recording and 32–48 degrees for the latest, against partly inferred labels. Motion calibration is available only in the latest profile. Both profiles remain provisional; missing historical keyboard model IDs are not reconstructed from today's model.

## 2026-09-14 — One-command startup and one-second correction without countdown resets

The initial sweep implementation cleared the correction on every unavailable reading. A stationary regression with repeated 100 ms gaps restarted the old ten-second countdown 76 times in 30 seconds and barely moved. The corrected controller retains a display target for up to 500 ms independently of raw measurement availability, keeps its original deadline across longer gaps, and reports overdue recovery without silently starting a fresh timer. Source and model changes continue to preserve trajectory derivatives. The user shortened the hard deadline from ten seconds to one second; the initial maximum trajectory is now 950 ms, and comfort preferences remain subordinate to the deadline.

Fusion's `npm start` now starts or reuses the independent Keyboard, Light Track, and Fusion services, checks readiness, and shuts down only its own processes. Separate-project runtimes and local configurations remain intact. The coordinator-only command remains available. Regression tests cover stationary gaps, expired-deadline recovery, one-second convergence, occupied ports, process reuse, and actual three-service startup/shutdown. Large differences must move visibly faster under the revised deadline; physical camera accuracy and real laptop visual assessment remain unverified.

## 2026-09-14 — Sweep profiles and smooth correction within ten seconds

The previous collection path required manually labeled checkpoints and could not create/select a usable profile in Fusion. Startup offset assumed 120 degrees even when starting with a visible keyboard. The old display controller corrected at only 1 degree per second at rest, allowing minute-long discrepancies. A trajectory-only display without a separate physical feedforward path also added avoidable motion delay during initial implementation checks.

This update adds a guided small-angle/open/120-degree-hold/close/small-angle state machine, keyboard-referenced pace checks, explicit inferred-label provenance, weighted provisional Extra Trees training, immutable profile artifacts, asynchronous training, selection persistence, and frame-bound activation. A compatible saved model initializes from its own output. The physical path uses a three-stage velocity filter; septic correction trajectories preserve position, speed, acceleration, and jerk across replanning and retain the original ten-second deadline. Comfort exceedance is exposed instead of hidden. Shared interfaces reuse existing feature extraction, tree inference/export, source-data validation, motion primitives, and temporary adaptation.

Methodological limits: constant average speed cannot prove uniform hidden motion; 120 degrees is approximate user input; one sweep is not independent validation; scene rotation assumes a fixed laptop base. A late large target change can require visibly fast correction. Stale-input freezing and physical-range clamping break derivative continuity, and an unforeseen target arriving at an expired deadline can only be reported as a miss, not corrected retroactively. Deterministic controller and HTTP training/profile tests pass; actual camera sweep and visual smoothness assessment remain pending camera access and user movement. Existing recordings and local keyboard configuration are preserved.

## 0.8.5 — 2026-09-14

The previous application could collect real features and measure angles with a supplied model, but the only training command required independent recording/location groups. A user with one complete collection had no supported route to an initial live trial. The standalone adapter also checked feature schema without checking the processed frame size against a capture-bound model.

Added an explicit provisional trainer for one complete checkpoint recording, using fixed configured estimator settings and a whole-hold diagnostic instead of inventing independent splits. It exports a browser-compatible model, source hash, diagnostic report, and parity fixtures to a new directory while retaining false validation flags. Labels outside hold timestamps are excluded from fitting without changing the source JSON. Standalone inference now enforces the trained processing size. The existing validated workflows are preserved.

The latest real collection produced `artifacts/provisional-2c765508/model.json` from 358 usable labeled frames at 640×360. Verification passed 14 Python training tests, 35 Node tests, syntax checks, and parity for 64 predictions/128 filtered samples. A separate preview on port 1821 loaded the model successfully. Real camera accuracy remains unvalidated, and this capture binding does not match the existing 640×480 fusion stream.
## 0.8.4 — 2026-09-14

The second real collection contains all 12 requested checkpoints. Its explicit capture binding confirms 640×360 processing with 960×540 decoded video, so the earlier uncertainty is resolved for this recording; it does not establish 640×480 fusion compatibility. The frozen-settings exploratory diagnostic has a 9.375° median held-out-hold error and 53.0625° 95th percentile. Fitting all holds reproduces their labels closely, while comparison with the earlier recording remains weak. Neither test establishes independent live accuracy, and more checkpoints alone are not a demonstrated remedy.

The audit also found one frame at 60° timestamped 0.2 ms before its capture click. The previous collector counted frames by callback execution order, allowing this boundary frame to receive a stationary label. Frames predating the click now remain unlabeled and do not count toward hold completion. Existing recordings are unchanged. The audit details and limitations are in `docs/collection-audit-2c765508.md`.
## 0.8.3 — 2026-09-14

The previous standalone exporter saved browser track settings without recording decoded video or processed frame dimensions. An audit consequently treated a 960×540 track report as proof of the camera/processing size, although the user confirmed a 640×480 camera. The recorded pixel fractions separately fit a 640×360 processing area given the configured processing width; this indirect evidence does not identify hardware resolution or reconstruct the original pixels.

Exports now bind the session to actual feature-frame dimensions, retain reported track settings, and include standalone decoded video dimensions. Both services and standalone collection use the same frame-binding check. A configuration change ends collection before mixing frame geometries. Regression coverage uses a 640×480 decoded stream with 960×540 reported settings and verifies the export records both correctly; the 33 Node tests and syntax checks pass. Original recordings and camera configuration remain unchanged. Missing metadata in legacy feature-only exports cannot be repaired merely by assuming hardware size.
## 0.8.2 — 2026-09-14

The previous default required 72 stationary holds by repeating both directions three times, adding excessive effort to initial brightness calibration. The guide also hard-coded that schedule independently of the configuration.

Reduced the default to 12 holds: one opening pass from 10° to 120° in 10° steps. Directions and repetitions are configurable, and UI instructions derive from the shared collection schedule used by the service. This shorter per-recording guide retains full angle coverage; repeated and closing recordings remain useful for validation, and stationary holds alone still cannot measure motion delay.

## 0.8.1 — 2026-09-14

The geometry client previously stored native browser fetch as an estimator property and invoked it with the estimator as its receiver. Browsers reject this with “Failed to execute 'fetch' on 'Window': Illegal invocation,” preventing worker startup. Injected arrow-function mocks concealed the browser receiver requirement in the existing tests.

The default transport now calls fetch through globalThis, preserving the browser receiver while retaining transport injection. A regression test enforces the receiver requirement across worker start, reference frame submission, and stop; it failed before the fix. The Node suite and syntax checks pass. This transport correction does not establish hardware angle accuracy.

## 0.8.0 — 2026-09-14

The previous brightness estimator ran only inside its browser and could not receive synchronized keyboard supervision from another project. Its standalone One Euro output obscured where filtering should happen during a source switch. The offline trainer required distinct locations, preventing the proposed one-environment baseline workflow, while the geometry tracker required absolute setup references even when only instantaneous motion was needed.

Added an independent RGBA frame API, exact-frame keyboard anchor cache, frozen-model session adapter, bounded recording/export routes, and source-environment training with recording-disjoint splits and capture binding. The adapter uses a provisional 120° startup offset and regularized Huber affine correction only after sufficient prediction/angle diversity. Weak or changed lighting suspends or starts a new segment with a carried prior; the permanent model is never rewritten. Shared geometry functions support a relative-only motion worker and training-only signed axis/scale fitting. Fusion owns display smoothing; the standalone UI retains its filter.

Validation covers adapter startup, affine recovery, collapsed predictions, bounds, environment resets, API frames/labels/recordings, motion deadlines, source splits, motion fitting, and existing geometry behavior. Source-only exports always retain false cross-environment acceptance. The three-service synthetic smoke run verifies 120° startup, accurate 25° keyboard selection, 25.25° adapted fallback, and zero controller speed-bound violations; it is not hardware accuracy evidence.

Remaining limitations: a source forest can be non-identifying under new illumination; narrow-range labels cannot validate large openings; camera settings and exposure are incompletely observable on some drivers; relative scene motion confuses whole-laptop pitch; and real source calibration, synchronized external references, and live latency measurements are still required.

## 0.7.0 — 2026-09-14

The previous approach reduced camera images to brightness/color summaries and regressed angles from unvalidated data. It discarded geometric correspondences, could confuse illumination/exposure changes with angle changes, and had only synthetic local artifacts. More trees or stronger smoothing could not resolve this lack of identifying information. Always emitting an angle also obscured unavailable evidence.

Added a default local Python/OpenCV geometric tracker with distributed LK features, forward/backward consistency, rotation/essential/homography hypotheses, translation-aware pose checks, measured two-angle anchoring, and bounded ORB keyframe recovery. Stationary holds preserve the absolute reference. Explicit setup/uncertain/lost/stale states suppress current readings and retain a separately aged last valid value. Browser generation checks and server leases prevent obsolete replies from reviving old estimates; startup, backpressure, and worker failure are explicit.

Retained lighting as an independent baseline. Added optional bounded grayscale replay recording, synchronized reference import, development FOV sensitivity, frozen configuration/code/model profiles, location-disjoint test replay, setup exclusion, coverage/error/jitter/delay/drift reporting, and a calibrated phase-correlation baseline. Every sampled recording frame is retained, including worker-busy frames, with separate recorded-live and replayed-geometry coverage. Added geometry, worker, lifecycle, browser-orchestration, and evaluation tests plus updated architecture diagrams.

Research references: ORB-SLAM3 (Campos et al., 2021) motivates geometric tracking/keyframe recovery; LightGlue (Lindenberger et al., 2023) remains a possible later matcher. WinDuo demonstrates webcam lid-motion effects but resets its reference at rest, unsuitable for absolute angle. No third-party project code was copied into this implementation.

Remaining limitations: camera intrinsics/distortion are approximate, the laptop base must stay fixed, some scenes are geometrically ambiguous, and near-closed camera occlusion/power behavior may defeat coverage. Full SLAM/learned matching and physical camera calibration are not implemented. No real measured-laptop recordings or validated accuracy claims are supplied; real end-to-end delay and the 30-setup/five-location acceptance work remain outstanding.

## 0.6.0 — 2026-09-14

Implemented the lighting-only angle research plan. The prior version could only observe lighting and had no real feature dataset, trained estimator, measured checkpoint workflow, or dynamic-reference evaluation. It could not answer whether screen angle was recoverable under changing environments.

Added global and spatial lighting features, adaptive multi-region summaries, built-in webcam selection, camera-setting diagnostics, measured checkpoint collection, synchronized moving-reference import, Extra Trees training with location-held-out validation, browser-compatible model artifacts, empirical reliability, timestamp-aware One Euro smoothing, stale-frame states, and parity checks. Synthetic fixtures verify the software path but remain explicitly unvalidated.

## 0.5.0 — 2026-09-14

The previous method required a unique near-white region and only modeled a known lamp on a synthetic plane. It discarded multiple lights, missed diffuse/color variation, lacked measured datasets, and could not estimate real angles or distinguish model confidence from demonstrated accuracy.

Added shared global/spatial lighting features, adaptive multiple-region summaries, guided measured-angle collection, synchronized reference import, explicit freshness/collection/estimation states, validated model loading, and timestamp-aware smoothing. Camera frames remain local, preview visibility stays independent, and missing models produce no fabricated angle. The offline pipeline selects bounded tree models and smoothing on validation locations, then evaluates untouched locations against baseline, error, jitter, and lag gates. Synthetic software fixtures are explicitly ineligible for real acceptance. Real-data collection and demonstrated accuracy remain outstanding.

## 0.4.0 — 2026-09-14

The previous interface always displayed the video canvas, occupying space when only readings were needed. There was no command-line display choice. Added a reversible page preview toggle and --no-video / --video startup options, with runtime configuration delivered by the server. The information layout keeps session controls, status, motion, position, and simulation inputs visible while processing continues. Hiding the preview skips display drawing without changing tracking state.

## Startup port update — 2026-09-14

The previous default port (4173) conflicted with an existing local preview server and prevented startup. Changed the default to the requested port 1818 and updated the README. The PORT environment variable still overrides the default.

## 0.3.0 — 2026-09-14

The previous version coupled highlight observation to object-specific pose acquisition, required unnecessary setup, and mixed angle readings with an auxiliary lighting experiment. Those dependencies also introduced remote model loading and unused UI paths.

This version removes object detection, landmark models, template corner tracking, pose fitting, orientation readouts, and reference calibration. Live observation now uses the full image. The remaining geometry utilities serve only a generic flat-surface simulation. The state machine describes observation and camera lifecycle states, and the interface reports candidate position and motion. Removed unused styling and external font loading, updated tests and diagrams, and added a README with usage and limitations.

## 0.2.0 — 2026-09-14

The initial prototype averaged unrelated bright pixels and used a simulated highlight fixed to a material point. It lacked architecture documentation and behavioral checks.

Connected-component detection, unique temporal association, and a finite-plane point-lamp model replaced these approaches. Disappearance and ambiguity clear motion history. Simulation supports hiding the highlight. Model assumptions and residual interpretation became explicit.

Remaining limitations: brightness does not prove a reflection, simulation is not an independent accuracy benchmark, and live-camera accuracy remains unvalidated.
