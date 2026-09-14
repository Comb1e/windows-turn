# Iteration history

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

## 2026-09-14 — 0.1.0

Previously there was no integration component. Running both camera applications independently risked webcam contention, mismatched frames, and hard output jumps. A fixed switch duration would ignore real lid motion, and differentiating selected angles would turn model/source disagreement into false motion.

Added an independent API coordinator, one shared browser capture, bounded per-service queues, exact-frame label pairing, authoritative keyboard selection, explicit loss/stale states, and a persistent motion-feedforward controller with filtered bounded correction. Baseline collection and reference import remain functions of Light Track; the coordinator provides their UI and combines recordings with its actual display timeline. The replay tool uses the adapter's public functions and excludes teacher labels from independent metrics.

Remaining limits: real brightness calibration must be collected; the starting 120° is provisional; affine output correction cannot identify arbitrary environment changes; the physical velocity is inferred; whole-laptop pitch can invalidate scene motion; and hardware accuracy and latency are unverified. Large stationary discrepancies deliberately take longer to correct.
