# Iteration history

## 0.1.4 — Distance-based frosting and one rotation path — 2026-09-17

**Previous issues:** Frosting increased uniformly across the whole image, so points near the glass lost as much detail as distant points. The user again saw stretching during a live test after the grid looked correct. The old full-screen benchmark report confirmed `projectionMode: physical` while the stationary grid used rotation.

**Method root causes:** One angle-derived scalar drove a single Gaussian radius and global sharp/blur mix. It had no per-point distance to the glass. Separately, the benchmark script forced the alternative physical compensation transformation despite the interactive default. A successful grid in a different geometry could not validate that live run.

**Improvements:** Frost radius now follows the closest distance from each projected image point to the finite glass rectangle. It is zero at the hinge and grows toward the top; clamping the nearest point to the finite glass prevents distance decreasing beyond 90° of relative rotation. Added an adjustable `frostDistanceMm` scale (150 mm default), exponential response, four dense Gaussian levels and interpolation by variance after projection in linear light. The physical-lid mode has been deleted from the implementation, UI, configuration and benchmark scripts at the user's request. The removed CLI option is explicitly rejected. Legacy mode and obsolete calibration values are ignored and dropped on save. All output uses the corrected bottom-anchored rotation. A grid checkbox switches only the image source for direct comparison with live capture, preserving angle and output size. The existing visible-controls fix remains in place.

**Verification:** Release build and all three CTest suites pass: 166,827 core checks, 30 native-window checks and 641,501 actual-HLSL checks. Independent forward projection and ray-plane controls cover the retained rotation; closest-point controls verify distance, configurable references/heights, near-parallel geometry, closure and reversal. The stripe regression retains 99.9195% of near-hinge contrast while the upper region retains 0.0180%. Zero blur and reference-angle output remain unchanged. A legacy physical preference cannot alter geometry or be saved again. Existing Fusion tests remain 28/28 passing. All application render tests use a 60 fps cap. Final live timing and UI checks are recorded in `renderer/docs/validation.md`.

**Remaining issues:** User visual acceptance of the live desktop remains separate from numeric projection correctness. Removing physical compensation means this version no longer provides the former world-space image anchoring for a moving real panel. Frosting models distance to a flat captured desktop, not per-object depth inside games/videos. HDR, game-specific compatibility, physical lid power behavior and new-effect 240 Hz acceptance remain pending.

## 0.1.3 — Keep debug controls accessible — 2026-09-17

**Previous issues:** The Hinge Glass debug page disappeared behind full-screen rendering, preventing angle adjustment; cursor suppression also hid the native pointer over the panel.

**Method root causes:** The full-screen overlay was owned by the controls. Win32 keeps owned windows above their owner, and minimizing an owner hides its owned windows. Global cursor suppression did not distinguish the control panel from transformed content.

**Improvements:** Made full-screen output independent/unowned; a reusable window-layer helper keeps the controls above visible output without activating them, releases topmost on disable and respects minimization. A shared pointer helper covers controls, child widgets, dialogs, popups and drag capture. Native pointer visibility is restored over controls; transformed cursor rendering is omitted there. Preview ownership and capture exclusion remain intact. Benchmark completion targets the controls directly instead of relying on an owner relationship.

**Verification:** Release build and 30 native window checks pass, including ownership, z-order, no focus steal, slider use, mouse capture, recovery/show-hide, minimization/restoration, dialogs, capture exclusion and cleanup. Existing geometry and source tests remain passing. Microsoft ownership and positioning documentation used for the fix is recorded in the renderer research notes.

**Remaining issues:** Real hardware display/session recovery and crash-recovery cursor fault injection still require dedicated checks. The separate stretch report was not resolved by this window-layer change.

## 0.1.2 — Correct slider projection and strengthen frosting — 2026-09-17

**Previous issues:** Lowering the slider on a stationary screen stretched a narrow strip of the desktop across the output. The previous documentation instructed a stationary slider test while using projection intended for a physically moving lid. Preview windows also assumed a 16:10 aspect ratio for every monitor. Frosting was too weak, and increasing the old kernel's radius exposed visible repeated-edge bands.

**Method root causes:** In physical compensation the source plane is fixed and the destination screen rotates. Near a grazing viewing angle, its pixels necessarily sample an increasingly narrow part of the fixed source. Without actual lid movement that inverse projection looks enlarged. Comparing the homography only with another physical ray intersection could prove the equation while missing the mismatch between test conditions and user intent. A fixed 960×600 preview independently distorted non-16:10 sources. The old blur retained too much sharp imagery and spread a fixed 13 samples too far apart at large radii.

**Improvements:** Added a distinct stationary test with a rigid textured rectangle rotating around the unchanged bottom edge, a centered camera, and back-face/edge-on rejection. Both modes share one ray-to-plane projection helper. Only the explicit **View mode** selector changes projection: Preview, synthetic grid and Enable screen all preserve it. An intermediate implementation selected physical mode automatically on full-screen entry; user testing showed that this reintroduced the reported stretching after a successful grid test, so that implicit switch was removed. Physical mode still anchors the image at the user-adjustable reference angle while frosting increases with closure. The original physical transformation and bottom anchoring are preserved. Preview sizing uses a uniform aspect-preserving scale. Frosting now defaults to 64 pixels, builds earlier using a configurable response curve, and uses a dense separable Gaussian kernel without repeated-edge bands. The angle slider remains immediate and tests use 60 fps.

**Verification:** Release build and expanded core tests pass. Independent forward-rotation controls check source texture recovery, whole-image visibility, top-edge contraction, the fixed bottom edge, exact edge-on/back-face conditions and reversal. Separate world-coordinate tests confirm that physical mode holds the same image points at the reference plane through different physical angles. Frosting is tested for monotonic increase. The GPU produced inspected synthetic frames at 110°, 85° and 40° with every source row visible in the rotating test; a 0° diagnostic checks the back-face boundary. Source/aspect and previous physical, calibration, stale/session/SSE and settings tests are retained. See `renderer/docs/validation.md` for final counts and render results.

**Remaining issues:** The stationary rotating-plane view is a test aid, not evidence of world-space alignment while the real lid moves. That still needs the user's calibrated physical viewing test. A nearly edge-on physical screen has limited visible area; real-lid compensation should not be artificially normalized to fit a stationary preview. Existing HDR, capture compatibility and physical power-management validation limits remain.

## 0.1.1 — Hinge Glass fixed bottom edge — 2026-09-17

**Previous issues:** The first renderer's active bottom edge moved during rotation, especially with the default nonzero hinge offset. The user requested a stationary bottom edge and 60 Hz testing. A separately reported possible rotation problem was withdrawn pending this correction.

**Method root cause:** The first projection rotated the mechanical-hinge-to-active-panel offset with the panel. It only tested the hinge center with zero offset; that control could pass while the displayed bottom edge moved.

**Improvements:** The complete active bottom edge is now the visual pivot. The hinge offset locates a constant origin at the reference angle, then the eye and physical pixels are expressed relative to that origin. The reference remains adjustable. The default render/test cap is 60 Hz; the 240 Hz capability is retained. A clearly labeled 0–180° manual slider is placed near the top of the controls for camera-free testing. Colored grid borders make bottom movement and orientation visible during synthetic diagnostics.

**Verification:** Independent world-space ray/plane controls and homography tests pass. Regression cases now assert every tested point across the bottom edge, including both corners, with hinge offsets 0/10/50/200 mm and lateral viewer offsets −150/0/150 mm. Original identity, full closure, source ordering, stale data, invalid geometry, SSE parsing, settings and lifecycle cases remain included. The 85° GPU diagnostic shows the green bottom border anchored across the full output width. The existing 28 Fusion tests also pass. Detailed rendering results and limitations are in `renderer/docs/validation.md`.

**Remaining issues:** User visual acceptance of the rotation after this pivot correction, physical lid shutdown/resume, HDR display behavior, game-specific capture/occlusion and independent motion-to-photon measurement remain hardware/application checks. No additional rotation-direction change was made based on the withdrawn symptom.

## 0.1.0 — Initial Hinge Glass renderer — 2026-09-17

**Previous issues:** The workspace estimated and displayed hinge angles but could not transform live desktop/game/video content.

**Method root cause:** Browser angle display and camera inference cannot replace native composed-monitor capture and refresh-paced GPU presentation.

**Improvements:** Added an independent C++20 Win32/C++/WinRT/D3D11 renderer, live GPU capture, viewer-calibrated homography, linear-light frosting, configurable reference angle, native debug controls, manual/scripted/Fusion sources, capture-excluded overlay, transformed cursor with native input, process-exit cursor recovery, device/session recovery, HDR-aware formats, and benchmark telemetry. Papers, projects and official APIs actually used are recorded in `renderer/docs/research.md`.

**Verification:** Release compilation, 43,206 initial core checks, real monitor capture, synthetic PNG inspection and full-screen capture passed. Intel/60 Hz was initially available; RTX 4070/240 Hz became available during development. Before the user's request to use 60 Hz for further tests, a completed 60-second synthetic benchmark measured 237.62 rendered fps, 237.68 DXGI-presented fps and 0.2304 ms GPU p95 at 2560×1600. That was a synthetic software-counter result, not live-game, optical-latency or final-pivot acceptance. Bounded two-frame presentation fixed the hybrid-GPU half-refresh issue seen with a one-frame queue.

**Remaining issues:** The initial mechanical pivot moved the bottom active edge; corrected in 0.1.1. Protected/exclusive-fullscreen content is outside the supported baseline. Actual game compatibility, HDR, physical lid behavior and Fusion measurement outside 10–120° require further validation.

## 2026-09-16 — Improve Light Track annotation training without data migration

The fixed all-feature annotation forest fit its own labels closely but transferred poorly between sessions. Light Track 0.13.0 now selects regularized color forests using existing stored features and whole-group tuning, compares the selection procedure with the original method using nested group diagnostics, and exposes results through the training page. Research sources and method limitations are documented in the Light Track repository. Original groups, PNGs, labels, keyboard provenance, old model files, and Fusion/Keyboard APIs retain their formats and usability.

The four local development groups (212 images) show nested mean group error of 17.094° versus 19.926° originally. Large-angle transfer remains weak, one keyboard group's mean error worsens slightly, and these development results are not independent physical validation. The final model retains all labeled data and the existing runtime format; prior models remain selectable.

Validation: 59 Light Track Node tests, 45 Python tests, syntax checks, page-triggered publication, reload/default model selection, and original-group reopening pass. All 216 source annotation files match their initial hashes. The idle services were refreshed through the Fusion launcher; its camera remains stopped.

## 2026-09-16 — Select Light Track models in the browser

Page-based training previously ended at model downloads, leaving users to supply a CLI path and restart the server before measurement. Light Track now lists completed annotation models on its live page, selects the newest successful completion by default, supports older/startup models and local JSON files, and links training results directly to measurement. Model changes are validated before installation, reset old readings/filter state, and apply saved camera settings to the next session. Manual choices survive list refresh; page reload returns to the newest annotation default.

Validation: 59 Light Track Node tests and 32-module syntax checks pass. Browser inspection verified the newest 83-image model as the automatic lighting default and availability of the older 11-image model. These checks establish software selection behavior, not physical angle accuracy.

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
