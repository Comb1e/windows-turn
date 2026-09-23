> Historical recording audit. New collection and training uses photo annotations only; legacy collection commands were removed in 0.16.0.

# Real collection audit and dimension correction — 2026-09-14

The camera recording `6bb134a9-77e9-4d62-8d88-12a69de62dbb` passes the existing training loader's schema checks. Its SHA-256 is `8c66ca563811b81dbcf66572fb6cc2aa05203655a8f17fa0b3630848ebf69141`. The original JSON was not changed.

There are 4,417 frames over 304.24 seconds, each with 499 valid features. All 13 completed holds have 30 labeled frames and satisfy the two-second capture rule. There are 390 checkpoint-labeled frames and 4,027 unlabeled frames. Labels cover 20° through 120°; 10° is absent. The user confirmed the first hold was physically 120° and the camera size was 640×480.

## Dimensions: corrected interpretation

The original audit incorrectly treated `record.camera.width/height` (960×540) as the actual source/processed dimensions. Those values come from the browser track's `getSettings()`; the legacy standalone exporter did not record `video.videoWidth/videoHeight` or `ImageData.width/height`. The hardware size, browser track report, decoded video, and processing canvas must be distinguished.

A separate diagnostic checks the `dark`, `clipped`, and `bright_area` features. The current extractor computes these as integer pixel counts divided by processed frame area. Across 5,352 nonzero, nonunit observations:

| Candidate processing size | Fractions yielding integer pixel counts within 1e-6 |
| --- | ---: |
| 640×480 | 34.12% |
| 640×360 | 100% |
| 960×540 | 25.02% |

This is consistent with a 640×360 processing buffer given the configured 640-pixel processing width and aspect-preserving resizing. It is indirect evidence, not a measurement of camera hardware. Raw frames are absent, so the original cropping/resampling cannot be recovered. Updating metadata alone would not convert these stored spatial features to direct 640×480 features. Future exports record the actual processing dimensions explicitly.

## Exploratory angle check

An Extra Trees diagnostic uses 32 trees, depth 8, minimum leaf size 8, and seed 42, fixed before scoring. Each fold excludes one whole stationary hold and fits normalization only on the other holds. No adjacent frames from the excluded hold enter fitting. This within-recording test includes omitted-angle interpolation/extrapolation and does not establish independent-session accuracy.

| Diagnostic | Median absolute error | 95th percentile absolute error | Within 5° |
| --- | ---: | ---: | ---: |
| Entire hold excluded | 21.11° | 44.73° | 24.87% |
| Training-median constant, same folds | 35.00° | 65.00° | 7.69% |
| Fit and score on all training holds, not validation | 0.00° | 0.31° | 100% |

The fit can reproduce recorded examples but gives weak evidence of predicting unseen holds. These results are independent of the dimension metadata interpretation. Mean brightness across the three 120° holds is 74.92%, 36.55%, and 67.49%; the recording alone cannot determine the cause of that difference.

There is only one recording and no synchronized moving-angle labels or relative-motion data. A recording-disjoint source baseline, motion calibration, and live delay evaluation are not established. No deployment model was exported. Detailed local results and the reproducible diagnostic script are in `artifacts/collection-audit-20260914/`.
