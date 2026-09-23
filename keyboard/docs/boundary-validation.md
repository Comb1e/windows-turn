# Boundary validation — 2026-09-15

## 0.6.2: automatic recognition of every current reference

All eight original 640×480 reference photos now pass full-frame automatic detection without annotation hints. The 43° photo returns 43.09° and the 46° photo returns 46.00°. Their detected lines differ from the annotations by at most 1.29 and 1.49 pixels respectively across the sampled width. The earlier acceptance of annotations only for fitting has been replaced with a training requirement: every photo must produce a valid automatic angle and match the annotated boundary before the model can be saved.

The detector uses the visible lower strip with full upper-context probes, checks shading within horizontal regions, and refines and validates candidate lines before testing ambiguity. It requires a minimum visible strip instead of an unconditional 16-pixel lower band. Straightness and local-gradient checks reject curved/background candidates that previously prevented selection of the weaker true boundary. Gradient searches include guard samples to avoid treating a peak outside the search window as an observed endpoint inside it.

Validation completed:

- All 128 Python tests pass, including a cropped 47° synthetic reference, near-bottom distractors, curved backgrounds, preserved false-match rejection, and training refusal when automatic detection is unavailable or selects a different boundary.
- All eight original photos also pass through real HTTP RGBA requests, each in a new session after the normal three-frame confirmation. No annotation hint, saved angle lookup, or carried-over tracking location is supplied to the service.
- Eight diagnostic probes derived from the earlier two false-match screenshots are rejected, including placements near the image bottom. These remain inpainted, repositioned crops rather than original camera frames.
- Detection overlays were inspected to confirm that the reported lines coincide with the actual annotated laptop edge, including the thin strips at 43° and 46°.

Local artifacts: `data/visible-strip-http-validation.json`, `data/negative-probes-visible-strip.json`, and `data/visible-strip-detections.jpg`. Fitting-photo accuracy and successful recognition do not establish independent environmental accuracy. Very similar background structures or insufficient visible contrast can still be ambiguous in new frames; no image-keyed memorization or unconditional validity override is used.

## 0.6.1 previous results: correctly annotated shaded surfaces

The original full-resolution `frame-1789403944835.jpg` exposed a false rejection: all four regions supported the boundary, but broad shading produced roughly 40 intensity levels of surface spread against a transition of about 60–70. The raw spread exceeded the 0.5 ratio even though the laptop surface was locally smooth. Subtracting a quadratic trend reduces residual spread to about 8 while preserving contrast and regional checks. The existing 24° annotation now predicts approximately 23.99°.

Training now distinguishes human-supervised local boundary refinement from automatic recognition. The complete eight-image dataset fits without changing labels or dropping photos, including a 46° boundary too close to the image bottom for the 16-pixel automatic context check. The saved model records which boundaries needed supervised refinement and evaluates automatic detection separately. Six of eight fitting photos are automatically available; the 43° photo rejects on tilt after full-frame candidate selection, and the 46° photo rejects on context. Their measurements remain unavailable at runtime. Regression label coverage of 10–46° must not be interpreted as guaranteed automatic visibility across that range.

All 117 Python tests pass. Regression tests cover broad quadratic shading at multiple angles, preservation of texture/table/seam rejection, fitting and serialization of a cropped labeled edge, CLI availability warnings, and rejection of that cropped edge through live manual initialization. Local negative probes from the earlier two screenshots still reject all six targeted lines; these retain the original inpainting/cropping limitations below. The eight photos are fitting data, so the small regression errors do not establish independent accuracy.

Local reports: `data/evaluation-shading-fix.json` and `data/negative-probes-shading-fix.json`.

## 0.6.0 initial checks

The previous detector accepted sufficiently strong horizontal edges without checking whether their contrast persisted beyond the immediate line. A bright table trim and a dark touchpad seam could therefore become authoritative angles. Rejection also erased the temporal reference, so the next frame could bypass the previous speed constraint and reacquire a different line.

Version 0.6.0 adds sustained contrast, regional support and lower-surface consistency before candidate ranking and after refinement, plus temporal confirmation with retained identity after loss. Tests check invalid output as well as preservation of valid raw angles. No angle coefficients, local settings, user recordings, or annotations are changed.

## Automated and local checks

- 112 Python tests pass, including real HTTP frames, table trim and seam simulations at multiple image heights, central partial-width edges, textured distractors, exposure changes, stronger distractors beside a valid edge, reacquisition, timestamp gaps, and raw-angle preservation.
- All four existing 640×480 calibration photos remain accepted. The recorded labels 10°, 22°, 30°, and 44° produce approximately 10.000°, 21.868°, 29.943°, and 44.000°. These photos are fitting data and do not establish independent accuracy.
- Both user screenshots were checked as local structural probes. Their green overlays were inpainted and the crops were padded into 640×480 frames without stretching, placing the reported line at three constructed heights. The old detector accepted all six targeted lines; the new checks reject all six. Cropping lost the original frame coordinates and painting altered pixels, so these are diagnostic probes, not original-frame replay or evidence of angle accuracy. User images are kept out of Git.
- A local 25-call timing run, excluding the first five calls, measured about 14.1 ms median and 14.7 ms 95th percentile for full-band detection on one saved image. This is a local CPU observation, not an end-to-end camera latency guarantee.
- A smoke run with all three real service processes and synthetic RGBA frames passed: initial brightness 80°, confirmed keyboard 25°, adapted fallback 25°, 15 temporary anchors, and zero planned display speed-bound violations. This verifies compatibility with Fusion and Light Track, not hardware accuracy.

The local diagnostic report is stored under ignored `data/boundary-validation-2026-09-15.json`.

## Remaining methodological limits

The method still cannot identify a keyboard semantically. A wide background transition with matching polarity and a uniform lower surface can pass. The added surface assumptions can reject genuine boundaries affected by texture, reflections, cropping, or occlusion. Three-frame confirmation reduces transient errors but cannot disprove a persistent lookalike. Keyboard visibility and full-frame negative sequences across lighting conditions are needed to measure false acceptance and lost coverage.

Fusion continues to trust valid keyboard results exclusively; these checks act inside the keyboard service before that authority is granted. No rejected or confirming frame supplies an angle for temporary brightness adaptation or sweep labels. The first accepted frame retains its exact model prediction. Acquisition takes at least 100 ms and three frames, about 133 ms at 15 FPS, while normal tracking adds no angle smoothing. Actual laptop visibility and display smoothness still require a live session.
