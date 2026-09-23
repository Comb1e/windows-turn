> Historical recording audit. New collection and training uses photo annotations only; legacy collection commands were removed in 0.16.0.

# Collection audit — 2026-09-14

The new recording `light-track-2c765508-d1ab-4453-b78a-aab24f7da4c3.json` is usable as experimental training input. The existing loader accepts its schema, finite features, increasing timestamps, metadata, and labels. It contains all 12 checkpoints from 10° through 120°, unlike the earlier recording. Reliable standalone or fusion performance is not established by this audit.

The original file is unchanged, with SHA-256 `7e763c68cfb1ab2d851f0f30b8f3471ac472df186b9ccd358930654e55832236`. Detailed local results are saved in `artifacts/collection-audit-2c765508/report.json`.

## Collection contents

| Item | Result |
| --- | --- |
| Frames | 2,655 over 183.23 seconds |
| Features | 499 per frame; all finite |
| Stationary labels | 359 across 12 holds |
| Angle coverage | 10°, 20°, …, 120° |
| Completed hold duration/count | All at least two seconds and 29–31 frames |
| Processed frame capture | 640×360, configured approximate horizontal FOV 65° |
| Browser report and decoded video | Both 960×540 |
| Moving labels / relative rotations | None |

The recorded `capture` fields now explicitly identify processing dimensions; they are no longer inferred solely from camera reports. All 3,479 nontrivial pixel-count fractions are consistent with a 640×360 processing area. The fusion coordinator requires 640×480. The standalone camera configuration still requests 960×540, which this stream supplied and the app resized proportionally to 640×360. Camera hardware capabilities alone do not force the browser's negotiated video size.

At 30° and 40°, mean luminance varies by about 13.64 and 14.23 percentage points during the labeled holds. Possible causes include exposure/scene variation or movement; feature-only data cannot identify the cause. Most other holds have much less luminance variation.

One frame at the 60° checkpoint is timestamped 0.2 ms before the capture start. This is a small animation/click clock-boundary anomaly, not a missing checkpoint. The strict audit flags it, and 0.8.4 prevents future pre-click frames from receiving hold labels. The diagnostics below retain exported labels rather than silently modifying the dataset.

## Exploratory estimator checks

The estimator and preprocessing reuse the existing training functions and configuration. Parameters were fixed before scoring: 32 Extra Trees, depth 8, minimum leaf size 8, seed 42. Each excluded-hold fold fits preprocessing on the remaining holds only. There is no random adjacent-frame split or parameter selection against these results.

| Check | Median absolute error | 95th percentile error | Within 5° |
| --- | ---: | ---: | ---: |
| Exclude an entire hold | 9.375° | 53.0625° | 24.23% |
| Training-median constant, same folds | 30.0° | 60.0° | 0% |
| Fit and score on all new-recording holds; not validation | 0.0° | 0.625° | 99.44% |
| Fit all new holds, score earlier recording | 20.0391° | 76.4844° | 11.54% |

Excluding a hold usually removes that angle entirely from training, so the first check tests interpolation/extrapolation within one recording. It is not an estimate of accuracy at every trained checkpoint. The earlier recording was already inspected, has different display metadata, and lacks explicit processing metadata; comparison against it is exploratory, not an untouched final test. No parameters were tuned using that comparison.

The available data demonstrate successful collection and fitting, with weak evidence of generalization. They do not satisfy independent source training/validation/test, motion calibration, or dynamic delay evaluation. No production model was exported or installed. This file remains useful for a provisional experiment using its recorded processing configuration; direct deployment into the existing 640×480 fusion camera path is not established.
