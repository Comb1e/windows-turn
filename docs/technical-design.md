# Technical design and research

## Authority and environmental adaptation

The keyboard service's valid angle is authoritative by product contract. The coordinator uses it without brightness weighting or sample-age extrapolation; this policy does not establish physical accuracy. A displayed value is a separate continuous state, so it can temporarily differ from the measurement while following the motion constraint. Missing keyboard velocity means zero input motion, never a substitution of scene motion while the target remains keyboard-derived.

Light Track evaluates the selected saved model to obtain a baseline angle. Version 1 uses lighting features and tree inference; version 2 supports evaluated image models, including the published DINOv2/ridge model, and scene profiles wrapping a base model with an affine correction. Image models use a local inference worker. Fusion does not depend on a particular feature count or predictor family and discards service feature vectors after receipt.

A separate session-specific affine correction produces `theta = a*z + b` from baseline output `z`. Fusion requests model-output initialization (`a = 1, b = 0`), then supplies exact keyboard anchors. No model means no image angle; the controller's initial 120° is only a retained display value. Live correction never rewrites the saved model. Neither initialization nor affine calibration establishes a physical illumination model.

Keyboard labels supply exact matched-frame supervision. Representatives are balanced across 2° angle bins, stored only in memory, and bounded to 256 samples. At most two fits per second use Huber-weighted regression; scale is regularized toward one. Scale fitting needs at least three bins, 10° label span, and 5° baseline prediction span. Degenerate or extreme scales are rejected. The service exposes a provisional state and reason rather than claiming that more samples resolve non-identifying lighting. The current live anchor endpoint accepts only 10–45°; this is separate from Keyboard's advertised range and does not prevent a valid 46° measurement from driving Fusion.

Weak light suspends the measurement. Recovery and detected environmental changes clear the temporary dataset and carry the last estimate as a provisional prior; selected Fusion profiles do not assume a 120-degree starting angle. Camera mode changes, stationary relative-motion lighting jumps, and lighting changes at a keyboard-confirmed stationary angle trigger segmentation. These detectors cannot identify every environmental change.

Affine output calibration is deliberately small. A source model can fail outside its training environment, including collapsing different openings to the same prediction. A fitted correction cannot recover information absent from that output. Additional labels within the visible-keyboard range do not certify wide-angle behavior. Photo scene references are fitting inputs; separate photos are needed for independent acceptance.

## Motion and smooth correction

The controller separates physical motion feedforward from position-error correction. Three exact first-order stages filter physical velocity with a combined 120 ms mean delay while preserving velocity, acceleration, and jerk continuity. Keyboard targets use robust keyboard slopes; calibrated scene motion is reserved for lighting targets. Source/model changes never become physical-velocity derivatives.

Seventh-degree correction trajectories match position, velocity, acceleration, and jerk at both ends. Candidate durations begin at 250 ms, initially end within 0.95 seconds, and are tested against preferred correction speed `4 + 0.2 * abs(physical velocity)` degrees/second, acceleration 15 degrees/second², and jerk 60 degrees/second³. Polynomial derivative roots locate extrema analytically. The first comfortable duration wins; otherwise the planner minimizes normalized exceedance before the immutable one-second deadline. Normal updates and source/profile changes do not reset that deadline.

Comfort limits may be exceeded after late discrepancies; the deadline takes priority. Brief missing measurements retain the display target only while the previous observation is at most 500 ms old; longer gaps freeze movement while retaining the original deadline. Expired corrections are reported without restarting the countdown. Physical-range clamping and stale freezing remain continuity exceptions. Unpredictable target changes exactly at an expired deadline cannot be corrected retroactively and are reported as a miss. See [keyboard-target validation](../fusion/docs/keyboard-target-validation.md) and the controller evidence in the [historical validation report](../fusion/docs/sweep-validation.md) for deterministic controls and their hardware limits.

## Desktop projection and frosting

Hinge Glass keeps the output plane fixed and rotates a rigid source rectangle around their shared active bottom edge. A centered eye casts rays through output pixels onto the source plane. For eye position E, output point P and source-plane normal n, the intersection is `Q = E - dot(n,E) / dot(n,P-E) * (P-E)`. A homography implements that mapping; independent tests use direct ray intersection and forward 3D projection. Near-parallel and behind-eye rays are rejected, and preview scaling preserves aspect ratio.

For a visible source point at height h above the hinge, the distance to the finite glass rectangle is `d = h * sin(min(max(referenceAngle - angle, 0), 90°))`. Clamping the closest point to the rectangle prevents separation from shrinking after 90° of relative rotation. Frost amount is `1 - exp(-frostResponse * d / frostDistanceMm)` and scales the maximum blur radius. The response is zero at the hinge and at/above the reference angle; zero maximum blur also disables tint.

Four Gaussian levels are interpolated by squared radius in linear light. Separate closest-point controls and actual-HLSL tests verify closure, reversal, finite output, fixed-bottom geometry and near-hinge contrast. These checks establish the implemented flat-plane effect, not depth reconstruction or world-space image anchoring. See [renderer architecture](../renderer/docs/architecture.md) for the full rendering and recovery workflow.

## Sources

| Paper/project | Relevant finding | Application and limit |
| --- | --- | --- |
| [Direct Sparse Odometry, Engel/Koltun/Cremers](https://arxiv.org/abs/1607.02565) and [project](https://github.com/JakobEngel/dso) | Direct motion estimation accounts for exposure, response, vignetting, and affine brightness changes. | Separates photometric variation from motion. It does not demonstrate a universal brightness-to-hinge mapping. |
| [A Photometrically Calibrated Benchmark for Monocular Visual Odometry](https://arxiv.org/abs/1607.02555) | Exposes camera response, exposure, and attenuation as meaningful measurement variables. | Preserve available camera settings and bind capture dimensions. |
| [CORAL](https://arxiv.org/abs/1612.01939), [Deep CORAL](https://arxiv.org/abs/1607.01719), [project](https://github.com/VisionLearningGroup/CORAL) | Align source/target second-order feature statistics. | Comparison only, not implemented: a single starting point cannot estimate covariance, and low-angle samples differ from full-range training in angle distribution as well as environment. |
| [Continual Test-Time Domain Adaptation](https://arxiv.org/abs/2203.13591) | Unreliable pseudo-labels can accumulate errors and cause forgetting. | Keep source weights frozen and use accurate keyboard supervision with disposable session state. Its neural algorithm is not copied into Extra Trees. |
| [One Euro Filter](https://gery.casiez.net/1euro/) | Motion-dependent filtering trades jitter against lag. | Retained in the standalone brightness UI; fusion uses one explicit motion-plus-correction controller to avoid double filtering. |
| [WinDuo](https://github.com/BaselAshraf81/winduo) | Webcam motion can drive lid effects; rest-reset intentionally avoids absolute-angle tracking. | Useful comparator. Fusion retains its angle origin at rest and does not copy project code. |
| [Ruckig](https://github.com/pantor/ruckig) and [Jerk-limited Real-time Trajectory Generation with Arbitrary Target States](https://arxiv.org/abs/2105.04830) | Separate the target state from the current trajectory state. | Informs keyboard target/motion separation; Fusion retains its own seventh-degree controller and makes no time-optimality claim. |

These papers and projects informed individual design choices; they do not certify this laptop's accuracy or environmental transfer. The image-model sources actually used, including DINOv2, are recorded with evaluation limits in [Light Track scene-model research](../light-track/docs/scene-model-research.md). Native capture and frosting sources are recorded in [renderer research](../renderer/docs/research.md). This documentation review adds no new learning or control method.

## Evidence requirements

Current training uses measured photo groups; validation keeps complete capture/lighting groups separate to avoid leakage. A model fitted to one scene does not establish cross-environment accuracy. Read-only replay of historical recordings predicts before admitting each keyboard label; teacher labels never score their own accuracy. Independent references score raw/adapted image estimates and actual/replayed display separately, including missing-read coverage.

Provisional goals remain 95% within 5°, stationary jitter at most 1° RMS, and ordinary motion delay at most 0.5 seconds. Large discrepancy corrections keep an original one-second deadline, independently of the ordinary-motion delay goal. Real camera/reference synchronization, live processing delay, changed room lighting, display changes, occlusion, and base movement still require hardware evaluation.
