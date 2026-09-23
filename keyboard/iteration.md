# Iteration history

Current release: [0.7.0 — optional identity evidence and larger annotation batches](docs/iteration.md).

## 2026-09-15 — 0.6.2: recognize thin visible strips and require every annotation to pass automatically

The previous fix allowed supervised fitting while two correctly annotated photos still failed automatic recognition. Its fixed 16-pixel lower-context requirement was incompatible with the thin visible base at 46°, and one global shading curve rejected the reflective 43° strip. Candidate handling could stop at an invalid high-scoring background line or declare ambiguity before checking refined geometry. Thus successful training did not meet the user's requirement that every correct reference be recognized by the actual detector.

This version samples the deepest real lower pixels available in each column while retaining the full upper context and a four-pixel minimum visible strip at 640×480. Texture is checked after detrending each horizontal support region. Local-peak proposals undergo gradient-support, straightness and surface checks before accepted candidates compete. Gradient refinement uses guard samples and requires 90% of supported points within two processing pixels of the fitted line. Invalid strong lines no longer terminate the search or make a valid weaker line appear ambiguous. New limits remain configurable and backward compatible with the existing local configuration.

Training now requires full-frame, hint-free recognition of every reference with a matching boundary position before saving. Missing, ambiguous and wrong-boundary detections fail the operation and preserve the previous model. The fit can use shared local annotation refinement internally, but that can no longer conceal an automatic-recognition failure. Each saved diagnostic records the annotation-position error and recognition status.

All eight original photos are automatically recognized, including 43° -> 43.09° and 46° -> 46.00°. All eight also pass through the real HTTP frame API from fresh sessions after three-frame confirmation, with no annotation hints or carried-over tracking. All 128 Python tests pass; eight diagnostic probes derived from the earlier table/touchpad screenshots reject. Detection overlays were visually inspected. The verified local model is installed with a backup of its predecessor. Model/schema compatibility, original labels, recordings, local configuration, keyboard authority and Fusion's display controller are preserved.

Remaining methodological limits concern new scenes: structural similarity can still produce ambiguity, insufficient visible pixels cannot supply missing image evidence, and fitting-photo error does not certify independent hardware/environmental accuracy. This version fixes automatic recognition of all current references without memorizing image identities or overriding validity based on their labels.

## 2026-09-15 — 0.6.1: separate surface shading from texture and supervised fitting from live validity

The previous surface check used brightness spread across the entire laptop strip. It rejected a correctly marked 24° boundary because broad shading looked like texture, despite sustained contrast and support in all regions. The trainer also required every labeled photo to pass automatic identity checks, so a visible hand-labeled edge near the image bottom could prevent fitting. Passing regression cross-validation did not separately report automatic detection availability.

This update subtracts a configurable linear/quadratic trend across each complete sampled line before measuring residual texture. Local contrast, polarity, regional support and context-depth requirements stay in force. Shared frame preparation and local gradient/Huber refinement now support supervised annotation refinement during training when automatic recognition is unavailable. Refinement must find a real local transition, preserves measured angle labels, and records provenance. Full-frame automatic-detection results and nullable errors are saved separately and printed by the CLI. Runtime manual selection and frame services never use the supervised fallback. Health identifies boundary validation revision 2.

The user's original 24° photo now predicts approximately 23.99°. All eight current annotations fit a 10–46° regression; six photos are automatically available. The 43° and 46° photos remain unavailable for automatic measurement and are reported explicitly. All 117 Python tests pass, covering shaded positives, retained negative rejection, cropped supervised fitting, immutable labels, and live rejection after manual initialization. The earlier six diagnostic negative probes still reject. Existing local configuration and recordings are preserved; the old default model is backed up before installing the retrained artifact.

Methodological limits: this remains a structural detector, not semantic keyboard recognition. A low-order trend cannot represent every reflection, while similar background edges may still pass. Training accepts human-provided identity, which can be mislabeled; monotonicity and local contrast checks cannot prove semantic correctness. Fitting-image regression accuracy and label coverage do not establish independent angle accuracy or automatic visibility. Photographs with insufficient visible context can contribute supervised labels without becoming valid live measurements.

## 2026-09-15 — 0.6.0: reject table trim and touchpad seams before granting keyboard authority

The previous method scored local horizontal brightness transitions. It could identify the bottom of bright table trim or a recessed touchpad seam as the calibrated laptop boundary, even though their surrounding pixels contradicted the expected surface. A majority of supporting columns also allowed central partial-width segments, and rejection erased the accepted temporal reference, letting subsequent frames bypass its speed constraint. Fusion correctly trusted the service's valid flag, which made false acceptance especially consequential for both angle selection and calibration labels.

This version adds a shared structural evidence interface at candidate selection and after line refinement: same-polarity sustained contrast at two depths, support in each horizontal region, and a comparatively consistent laptop-side surface. Unsupported strong lines are removed before ranking so they cannot suppress a supported weaker candidate. Runtime acquisition/reacquisition requires three consecutive frames spanning at least 100 ms, while loss clears public output but retains the previous accepted boundary and speed reference for 500 ms. Pending candidates are not published or averaged. Limits have backward-compatible config defaults; the saved regression, local config, and recordings are preserved. Health exposes the validation revision; existing models need no refitting.

Validation: 112 Python tests pass, and a three-real-service smoke test preserves keyboard priority, temporary adaptation and brightness fallback with synthetic frames. All four saved fitting photos remain accepted. Diagnostic probes from the user's cropped, overlaid screenshots reject six previously accepted target lines after explicit inpainting/padding; these probes are not original-frame or independent accuracy validation. Full-band detection measured approximately 14 ms locally. See `docs/boundary-validation.md` for the procedure and limits.

Remaining shortcomings: this is structural verification, not semantic recognition. A persistent similar background may pass, while reflections or textured laptop surfaces may reduce valid coverage. Temporal confirmation adds approximately 133 ms at 15 FPS on acquisition. Full-frame negative recordings and actual laptop evaluation remain necessary; no claim of eliminating all false keyboard readings is made.

## 2026-09-14 — 0.5.0: independent camera-free frame service

The previous live workflow opened its own camera and exposed results through preview/JSONL only. It could not share identical capture frames with a separate brightness service, and its seconds-based timestamp interface differed from the browser's milliseconds. A merged application would also couple otherwise independent estimators.

Added `keyboard_hinge serve`, a loopback frame API wrapping the existing `EdgeSession` without modifying its angle or confidence behavior. It declares model dimensions/range, validates session and monotonic frame identity, accepts exact RGBA8 frames, and converts timestamps at the estimator boundary. Service settings are separate from the existing local camera configuration. Reset/stop/health and bounded busy handling support an independent coordinator. Existing standalone modes remain compatible.

Validation: 88 tests pass, including real HTTP RGBA inference, resolution/length errors, timestamp conversion, ownership/reset, same-origin rejection, and busy processing. A Windows rejected-upload test exposed connection resets when a response preceded draining a large body; bounded body consumption now precedes normal rejections.

Remaining limitations: the underlying boundary detector cannot prove object identity and needs visible, distinct edges; model accuracy still depends on the existing laptop fit. The integration treats valid keyboard readings as authoritative by contract, not as a newly measured hardware accuracy claim.

## 2026-09-14 — 0.1.0: calibrated visible-base estimator

Previous state: this method had a prose plan and an empty project. There was no executable calibration/capture pipeline, camera-to-screen mounting model, signed-angle convention, or explicit failure behavior. Taking an unsigned angle between plane normals would also confuse supplementary openings.

This version adds a measured planar rectangle, guided intrinsic and two-angle hinge calibration, calibrated planar pose candidates, signed hinge fitting, geometric quality checks, manually initialized feature tracking, a runtime state machine, and optional nullable JSONL output. Configuration centralizes geometry and rejection limits; camera capture, JSON persistence, and geometry are shared interfaces. Architecture and workflow diagrams document the implementation. Git management is local to `keyboard/` on `main`.

Methodological limitations remaining: physical visibility is not solved; initial correspondence identification is manual; short-term optical flow can drift; four selected corners can be mislabeled consistently; intrinsics depend on camera settings; the hinge pivot is not modeled; and confidence is not statistical uncertainty. The tracking deadline requires periodic manual reselection instead of claiming indefinite reliable tracking. Synthetic tests establish mathematical and software behavior but cannot establish real webcam accuracy.

Next evidence needed: real webcam visibility at intended openings, accurately measured planar dimensions, varied checkerboard calibration views, two reliable reference angles, and additional independently measured validation angles. An automatic key detector or long-term relocalizer should only be introduced after obtaining laptop-specific images and measuring repetitive-key matching failures.

Validation: 26 automated tests pass with Python 3.13, NumPy 2.5, and OpenCV 5.0. During synthetic image testing, using hinge residual alone to flag ambiguity incorrectly rejected a correct pose even when its competing branch had much worse reprojection error. Candidate selection now considers both rotation agreement and image reprojection evidence, while rejecting materially different angles with similarly good fits.

## 2026-09-14 — 0.2.0: constrained range and browser annotation

The JSON-only workflow required manual editing. This version adds 10–45° defaults and a local browser annotator.


The annotation schema now records four keyboard corners with each measured angle, enabling geometric evaluation without a learned model.

## 2026-09-14 — approximate camera mode

When a printed checkerboard is unavailable, approximate intrinsics can be generated from resolution and horizontal FOV. This trades accuracy for setup speed; checkerboard calibration remains preferred.


## 2026-09-14 — 0.3.0: annotated-photo fitting and optional FOV assistance

Previous limitations: the browser accepted angle labels but did not provide usable four-corner editing. Evaluation was not exposed through the CLI, hinge fitting required recapturing live references, and approximate-camera setup still led into a workflow requiring measured physical dimensions. There was no complete path from existing labeled photos to low-quality live estimates without camera calibration. Annotation validation duplicated angle constants, allowed incomplete image relationships, and did not keep in-memory state consistent after failed persistence. Documentation described steps that were not executable and retained examples outside the new 10–45° defaults.

This version completes the canvas editor, shares image/record validation, preserves version 1 labels for completion, and writes version 2 atomically. New commands fit a geometric hinge from selected references, evaluate independent annotated images, train a small empirical corner regression, and run that empirical model with the shared tracker and explicit rejection states. All selected geometric references are checked, and fitting IDs are excluded from validation metrics by default. Existing camera and hinge interfaces remain compatible.

For the known approximately 60° laptop camera, horizontal FOV is now a configurable setting and CLI override. Optional empirical FOV assistance adds homography-derived plane-normal features without requiring rectangle dimensions, a checkerboard, or a camera calibration file. Users can disable it with --no-fov; the saved model records whether FOV was used and its value. Shared approximate intrinsics also use the configured 60° default. Changing FOV requires refitting so live use cannot silently change feature interpretation.

Method changes: empirical fitting stores training support and angle limits and reports leave-one-angle-out diagnostics. Unsupported shapes, extrapolated angles, camera size changes, lost tracking, and excessive motion clear the output. A newly exposed geometric failure allowed an inferior in-range pose to substitute for a better out-of-range pose; that case now rejects. Legacy broad-angle tests explicitly request a broad range, preserving their mathematical coverage alongside new default-range tests.

Remaining limitations: four-corner identity is manual; models are specific to the laptop/camera/rectangle; FOV assistance assumes centered intrinsics and zero distortion; small-data validation cannot establish real accuracy; endpoint regression bias may cause rejection; and optical flow still drifts or fails on weak/repetitive texture. Confidence remains heuristic. No neural model or automatic keyboard detector was introduced.

Validation: automated annotation/API, synthetic geometry, empirical fitting, FOV-option, CLI, and rendered live-tracking tests pass. Browser checks confirmed corner selection/dragging, angle-slider synchronization, saving, navigation, and persistence after reload. Real camera capture and measured laptop accuracy remain hardware experiments.


## 2026-09-14 — 0.4.0: two-point moving boundary and model resolution

Previous limitations: empirical live capture compared configured resolution against the model as if it were camera calibration. Photos at 640×480 produced a valid model but failed startup with a 1280×720 config and a misleading calibration error. The workflow also assumed all four labels were the same physical rectangle. In the user's cropped photos, only the moving boundary above the visible lower base was real; the other corners followed photo borders. Fitting plane normals or tracking that clipped rectangle was not a sound match for these observations.

This version requests the saved model resolution for uncalibrated live use and validates the actual camera output. A new moving-edge method supports two left-to-right endpoints per photo. It learns an angle mapping from the lower-half boundary position, optionally adding vertical viewing angles from the user's approximately 60° FOV. Live use searches a small band for a coherent intensity transition, refines its line, and rejects weak, ambiguous, unsupported or excessively fast measurements. Reacquisition uses new image evidence; S provides a two-point hint. Four-corner methods and calibrated geometry remain available.

Existing cropped labels can use their first two points as the boundary. The user's four records and local model were converted with backups, and local capture settings match 640×480. Evaluation now runs the edge detector on actual images. Tests cover two-point records, malformed endpoints, fitting/persistence, independent image evaluation, ambiguity, automatic loss/recovery, optional FOV, and resolution precedence for both model types. A hardware check opened the actual camera at 640×480 successfully. Synthetic tests pass; the four existing photos are fitting data, not independent accuracy evidence.

Remaining limitations: the boundary must be visible, approximately horizontal, and sufficiently distinct from other edges. The detector cannot prove the boundary belongs to the keyboard. Lighting, motion, tilt, background changes, and the narrow captured angle range can cause rejection or error. Optional FOV remains an approximation; photo-border coordinates alone contain no hinge-angle information.
