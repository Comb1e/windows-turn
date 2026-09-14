# Technical design and research

## Authority and environmental adaptation

The keyboard service's valid angle is the accurate measurement by product contract. The coordinator uses it without brightness weighting. A displayed value is a separate continuous state, so it can temporarily differ from the accurate measurement while following the requested motion constraint.

The brightness service uses its existing 499 lighting features and frozen Extra Trees model: `z = f0(features)`. A session-specific affine output correction produces `theta = a*z + b`. At startup a 1–3 second settling window anchors an assumed 120° with `a = 1, b = 120 - median(z)`. A single assumed point cannot identify scale or establish a physical illumination model.

Keyboard labels supply exact matched-frame supervision. Representatives are balanced across 2° angle bins, stored only in memory, and bounded to 256 samples. At most two fits per second use Huber-weighted regression; scale is regularized toward one. The assumed startup anchor is low-weight; keyboard-derived initial anchors are not duplicated as assumed labels. Scale fitting needs at least three bins, 10° label span, and 5° baseline prediction span. Degenerate or extreme scales are rejected. The service exposes a provisional state and reason rather than claiming that more samples resolve non-identifying lighting.

Weak light suspends the measurement. Recovery and detected environmental changes clear the temporary dataset and carry the last estimate as a provisional prior; only an explicit new session assumes 120° again. Camera mode changes, stationary relative-motion lighting jumps, and lighting changes at a keyboard-confirmed stationary angle trigger segmentation. These detectors cannot identify every environmental change.

Affine output calibration is deliberately small. The original source model can fail outside its source environment, including collapsing different openings to the same prediction. A fitted correction cannot recover information absent from that output. Additional keyboard labels at 10–44° do not certify the response curve at 45–120°.

## Motion and display dynamics

Infer physical velocity from Theil–Sen slopes over a contiguous 250 ms keyboard history whenever available. Otherwise use calibrated frame-to-frame rotations from Light Track's shared distributed-corner, LK forward/backward, and robust rotation/homography/essential-matrix primitives. The relative-motion worker requires no absolute geometric reference at runtime. Its signed axis/scale comes from continuous training-recording intervals spanning at least 20° between known angle labels. Missing motion breaks the interval; the source fit never uses test recordings.

For display angle `d`, selected measurement `m`, filtered physical velocity `w`, and bounded correction state `u`:

```text
e = m - d
C = 1 degree/second + 0.20 * abs(w)
du/dt = (tanh(2 * e / C) - u) / 0.080 seconds
dd/dt = w + C * u
```

Physical velocity uses a 120 ms low-pass time constant. Since `abs(u) <= 1`, `abs(dd/dt) <= 1.2 * abs(w) + 1 degree/second`. Neither source changes nor adapter updates reset the controller. No derivative is taken across those target discontinuities. At rest the small correction budget permits convergence without fabricating a measured physical velocity.

The bound refers to inferred velocity, not unknowable ground-truth motion. Whole-laptop rotation can look like hinge movement in a screen-mounted camera. Keep the base fixed while relying on scene motion; use independent hardware measurements to evaluate velocity bias and display response.

## Sources

| Paper/project | Relevant finding | Application and limit |
| --- | --- | --- |
| [Direct Sparse Odometry, Engel/Koltun/Cremers](https://arxiv.org/abs/1607.02565) and [project](https://github.com/JakobEngel/dso) | Direct motion estimation accounts for exposure, response, vignetting, and affine brightness changes. | Separates photometric variation from motion. It does not demonstrate a universal brightness-to-hinge mapping. |
| [A Photometrically Calibrated Benchmark for Monocular Visual Odometry](https://arxiv.org/abs/1607.02555) | Exposes camera response, exposure, and attenuation as meaningful measurement variables. | Preserve available camera settings and bind capture dimensions. |
| [CORAL](https://arxiv.org/abs/1612.01939), [Deep CORAL](https://arxiv.org/abs/1607.01719), [project](https://github.com/VisionLearningGroup/CORAL) | Align source/target second-order feature statistics. | Deferred: a single starting point cannot estimate covariance, and low-angle samples differ from full-range training in angle distribution as well as environment. |
| [Continual Test-Time Domain Adaptation](https://arxiv.org/abs/2203.13591) | Unreliable pseudo-labels can accumulate errors and cause forgetting. | Keep source weights frozen and use accurate keyboard supervision with disposable session state. Its neural algorithm is not copied into Extra Trees. |
| [One Euro Filter](https://gery.casiez.net/1euro/) | Motion-dependent filtering trades jitter against lag. | Retained in the standalone brightness UI; fusion uses one explicit motion-plus-correction controller to avoid double filtering. |
| [WinDuo](https://github.com/BaselAshraf81/winduo) | Webcam motion can drive lid effects; rest-reset intentionally avoids absolute-angle tracking. | Useful comparator. Fusion retains its angle origin at rest and does not copy project code. |

These papers and projects motivate individual methods. None certifies this laptop's angle accuracy or the proposed environmental transfer.

## Evidence requirements

Source training uses complete recording partitions with identical capture settings and full angle coverage. Cross-environment acceptance stays false for a source-only model. Online replay predicts before admitting each keyboard label; teacher labels never score their own accuracy. Independent references score raw/adapted brightness and actual/replayed display separately, including missing-read coverage.

Provisional goals remain 95% within 5°, stationary jitter at most 1° RMS, and ordinary motion delay at most 0.5 seconds. Large discrepancy corrections follow the velocity budget and have no fixed deadline. Real camera/reference synchronization, live processing delay, changed room lighting, display changes, occlusion, and base movement still require hardware evaluation.
