# Iteration history

## 2026-09-16 — Keyboard-assisted screenshot collection and page training

Light Track's previous screenshot workflow duplicated manual angle entry where Keyboard already supplied accurate small-angle measurements, and required CLI commands for training. Its annotation page now collects exact matching screenshots with keyboard labels every 500 ms, including repeated angles, and pauses saving when Keyboard cannot measure. Users stop collection to review/correct labels or add larger-angle manual measurements. Service/model identity, camera compatibility, revision checks, explicit states and lease cleanup preserve frame correspondence.

The new Train model button runs the existing screenshot trainer asynchronously, checks model/schema and Python/JavaScript prediction parity, and publishes separate downloadable model/report artifacts. Teacher provenance and label-source counts persist through training. Old groups, manual labels, group diagnostics and provisional accuracy status remain compatible. Documentation diagrams cover capture, state transitions, persistence and training. Changes are owned by the independent Light Track repository; the coordinator continues using the existing service interfaces.

Validation: 56 Light Track Node tests, 37 Python research tests, 28 Fusion tests, syntax checks, and browser-triggered training of the saved 11-image group passed. Physical moving-angle accuracy is not established by these software checks.

## 2026-09-15 — Light Track screenshot groups and independent camera defaults

The earlier Light Track calibration workflow required timed video checkpoints and a fixed range, making sparse screenshot labels and repeated lighting sessions awkward to collect or train. Standalone camera defaults also differed from the keyboard scheme. Light Track now has a persistent screenshot annotation workspace and group-aware provisional trainer: each session is a unique group, angles and image counts are unconstrained, and repeated lighting is allowed. Whole-group diagnostics retain session boundaries. Its own config uses matching 640×480/60° uncalibrated camera defaults without reading Keyboard configuration; saved model capture bindings take precedence for lighting measurement. Stills do not establish motion performance or physical accuracy.

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

## 2026-09-14 — Shorter Light Track checkpoint guide

The previous fusion recording instructions requested both opening and closing holds in one recording. Light Track now defaults to 12 checkpoints per recording, so the instructions use one opening pass and describe how to collect a separate closing recording. Independent training, validation, and test recordings and synchronized motion references remain necessary for evaluation.

## 2026-09-14 — Fusion 0.1.0: separate services, temporary adaptation, motion-based display

The previous workspace contained two separate applications with incompatible capture ownership, dimensions, timestamp units, and output conventions. Keyboard measurements could not supply matched-frame labels to brightness inference. A direct switch between their angles would expose model offsets as display jumps; differentiating that signal would wrongly treat calibration changes as physical motion. Brightness artifacts were synthetic, and its location-disjoint trainer did not support a one-environment baseline workflow.

This version adds a camera-free keyboard frame API, a separate brightness/adaptation/motion API, and a root-managed coordinator with independent bounded service queues. The coordinator sends identical RGBA frames, preserves accurate keyboard authority, and exposes raw measurement separately from the motion-controlled display. A frozen baseline receives a bounded temporary affine correction from matched keyboard observations. A source-environment trainer, baseline recording UI, motion-axis fitting, causal replay, and independent-reference metrics complete the research workflow.

Methodological limitations remain explicit: 120° is assumed initially; small-angle labels cannot establish the whole response curve in a new room; affine adaptation cannot undo collapsed model predictions; scene rotation can confuse whole-laptop pitch; and initial real source calibration and independent hardware accuracy/latency measurements remain necessary. At rest, large display discrepancies resolve slowly under the configured 1°/s correction allowance.

Software validation covers keyboard API contracts, adaptation, source training, relative motion, source priority, timing, bounded queues, controller rate limits, HTTP integration, and all three real services with synthetic RGBA inputs. Synthetic smoke data is excluded from real acceptance. Repositories stay on `main`; original local camera configuration and data are preserved.
