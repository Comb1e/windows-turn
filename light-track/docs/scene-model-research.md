# Scene robustness research — 0.14.0, 2026-09-17

## Inputs and preservation

Six ended annotation groups contain 253 PNGs: 31 manual labels and 222 matching-frame keyboard labels, spanning 9–120° at 640×480/60° FOV. There are three recorded lighting descriptions, not three independently established locations. Only six images cover 46–90°. Dataset, image and annotation hashes are recorded. All 259 original files retain their SHA-256 hashes; labels, v1 feature vectors and older models are unchanged.

Full reproducible output is in ignored `artifacts/scene-robustness-2026-09-17/full-evaluation/`. The published job is `9bf96cbc-c9a0-4129-8a4a-04fe71313b16`, with its complete report and model in `data/annotation-models/`. A reviewable aggregate report is committed as [scene-evaluation-summary.json](scene-evaluation-summary.json).

## Features and methods

| Family | Dimensions | What it measures |
| --- | ---: | --- |
| Existing v1 | 499 | Coarse luminance, color and bright-region statistics |
| Lighting | 1,302 | RGB/luminance/chromaticity quantiles, log color ratios, contrast, highlights/shadows and gradients on 1×1, 2×2 and 4×4 grids |
| Texture | 2,751 | Locally normalized gradient orientation, directional edge energy and orientation-sensitive uniform LBP at two radii |
| Camera metadata | 22 | Exposure/color-temperature/settings values and availability; no device identity, timestamps, labels or group IDs |
| DINOv2 | 2,304 | Frozen ViT-S/14 class token plus spatial patch means over whole-image and 2×2 regions |
| Relative depth | 189 | Depth Anything V2 Small spatial relative-depth quantiles, variation and gradients |

Preprocessing preserves aspect ratio and image orientation. Neural images are resized and edge-padded to 14-pixel patch boundaries; they are never stretched. DINOv2 uses a 336-pixel maximum side and depth uses 392. Relative depth is normalized per image and is not an absolute angle. Feature caches include image identity, extractor settings/version, weight checksum, relevant metadata and neural backend. Missing optional encoders are explicitly reported.

Each feature family and configured combination is compared with ridge regression (alpha 1 or 100), regularized Extra Trees and Random Forests. Constant-column removal and weighted normalization fit only training data; ridge uses the full retained descriptors rather than a learned PCA. Every fitting group has equal total weight. The selected final model is frozen DINOv2 plus ridge alpha 100. Neither encoder is fine-tuned. The previous HOG pilot remains documented in [the 0.13 research](annotation-model-research.md); current texture descriptors add local normalization, a spatial pyramid and LBP.

The two baselines are the original Extra Trees and the exact 0.13 selection procedure. Outer diagnostics exclude one whole group, or all groups sharing a case-normalized lighting description. Head/feature selection uses only the remaining groups. Exact duplicate hashes are removed from every training partition. The held-out lighting descriptions are descriptive partitions, not independently verified environments. Records include all individual predictions, selected candidates, source identities, unavailable methods and software versions.

## Uncalibrated results

Mean of held-out group metrics; lower errors are better. Within-5° is agreement with supplied labels, including keyboard supervision.

| Method | Group MAE | Mean group P95 | Within 5° |
| --- | ---: | ---: | ---: |
| Original Extra Trees | 20.95° | 37.55° | 23.78% |
| Current 0.13 procedure | 19.59° | 35.90° | 22.98% |
| Richer lighting alone | 19.04° | 38.39° | 28.94% |
| Texture alone | 13.87° | 27.35° | 47.96% |
| Camera metadata alone | 43.13° | 57.52° | 2.37% |
| Relative depth alone | 11.21° | 23.89° | 49.30% |
| DINOv2 alone, inner-selected head | 5.73° | 13.14° | 52.48% |
| All feature families combined | 9.58° | 19.35° | 46.41% |
| **Full nested selection procedure** | **6.69°** | **14.73°** | **49.71%** |

The DINO-only family diagnostic is an ablation, not a replacement for the predeclared complete selection procedure. Its final head selected using all data is also not an independent test result. For the full selection procedure, above-keyboard MAE improves 24.87° → 11.30° and above-90° MAE 30.00° → 11.63°. Worst-group MAE improves 34.50° → 16.14°.

Holding out complete lighting descriptions gives **31.24° → 11.58° MAE**, **56.59° → 20.12° mean group P95** (see JSON for exact values), and an above-90° error of 24.20°. Both protocols pass the specified promotion checks: at least 10% MAE improvement; no aggregate P95/within-5°/coverage or larger-angle regression; no group more than 2° worse. This does not establish the target of 95% within 5°.

## Calibration experiments

The experiment reserves exactly 3, 5 or 10 distinct reference images, distributed over each recorded group's angle range. Deterministic tie repetitions use the same support and query IDs for every competing method. Reference images and their duplicate hashes never enter the query set. At least five query images must remain; groups lacking enough images are explicitly skipped. This is a retrospective still-image experiment, not a causal motion replay.

Compare the existing robust equal-angle-bin affine correction with RBF residual correction, whose width/regularization are selected on inner training groups. The global model is fitted without the held scene. Rows below compare equally calibrated baselines and candidate procedures.

| Budget | Eligible groups | Group MAE: current affine → new procedure | Lighting holdout MAE: current affine → new procedure |
| --- | ---: | ---: | ---: |
| 3 | 5 | 11.65° → 5.04° | 13.92° → 3.79° |
| 5 | 5 | 10.11° → 5.44° | 11.13° → 3.67° |
| 10 | 3 | 7.41° → 1.87° | 7.22° → 2.77° |

The ten-reference split exhausts the available above-90° images in eligible groups, so its promotion check **fails for missing larger-angle evidence**, despite the attractive average. On the current image baseline, replacing affine correction with selected residual correction also fails the improvement checks. Live scene calibration therefore retains the established affine algorithm; the experimental residual procedure is not silently substituted. More independently measured non-reference angles, particularly above 90°, are needed to judge ten-reference calibration.

## Runtime and software checks

- DINOv2 checkpoint SHA-256: `b938bf1bc15cd2ec0feacfe3a1bb553fe8ea9ca46a7e1d8d00217f29aef60cd9`.
- Depth Anything Small checkpoint SHA-256: `715fade13be8f229f8a70cc02066f656f2423a59effd0579197bbf57860e1378`.
- Python 3.13; PyTorch 2.11.0+cu128. Other exact versions and pinned project commits are in the config/report.
- Warm DINOv2/predictor P95: **10.11 ms RTX 4070 Laptop GPU**; **13.40 ms alongside a 60 fps renderer preview**; **67.46 ms isolated CPU**, exceeding the 66.7 ms budget. The earlier CPU run overlapped regression tests and measured 158.10 ms; it is not the isolated result.
- Full local frame service, including existing motion processing and worker transport: **900/900 valid frames in 60.01 s, 14.997 fps, P95 52.24 ms, maximum 74.50 ms** with a live Hinge Glass preview capped at 60 fps. One frame in flight, zero queued frames. Twenty-four scheduled deadlines were exceeded; no worst-case latency guarantee is made. The saved still verifies software throughput, not changing-camera accuracy.
- The matching renderer report records 4,470 renders, 4,467 presents, average 59.60 render fps including startup, GPU P95 0.208 ms, 960×600 preview. Its monitor reports 240 Hz but the application cap is **60 fps**; Windows settings were not changed. This is not full-screen/game contention or 240 Hz acceptance.
- Exported ridge prediction parity against an independently refitted final head is within **0.000064°** over all saved images. Unit tests also cover unseen synthetic inputs for every head.
- Regression coverage includes old schemas, feature boundary images, cache identity, missing metadata/assets, duplicate purging, outer-test isolation, calibrated support/query separation, promotion failures, state transitions, cancellation, stale transport, real Python inference, profile publication/export, original-file preservation and browser orchestration.

The browser loaded the published model through **Use newest model** and displayed the new calibration guide and diagnostic. Camera acquisition was not used for acceptance. Profiles bind capture geometry and reject detected camera changes during a session; browser camera identifiers can differ by origin, so this does not authenticate physical camera identity across applications. Models remain provisional; reference uncertainty, whole-laptop movement, unrepresented scenes, sparse larger angles and game/GPU contention still need hardware data.

## Reproduction

From `light-track`, after optional vision setup in the README:

```powershell
.\.venv\Scripts\python.exe research/scene_experiment.py data/annotations --output artifacts/new-scene-evaluation --backend cuda
node research/publish_scene_experiment.mjs artifacts/new-scene-evaluation
.\.venv\Scripts\python.exe research/benchmark_scene.py artifacts/new-scene-evaluation/candidate-model.json data/annotations/GROUP_ID/group.json --backend cuda --output artifacts/image-timing.json
node research/scene_live_smoke.mjs data/annotation-models/JOB_ID/model.json data/annotations/GROUP_ID/group.json artifacts/service-timing.json 60
```

Use new evaluation output directories. Publication validates source hashes, independent export parity and runtime before exposing the model in the existing selectors. Existing training, recordings, sweep profiles and annotation formats remain supported.

## References actually used

| Reference | Role |
| --- | --- |
| Oquab et al., [DINOv2: Learning Robust Visual Features without Supervision](https://arxiv.org/abs/2304.07193); [official project](https://github.com/facebookresearch/dinov2) | Frozen global/spatial feature candidate; local official encoder implementation and standard ViT-S/14 weights. No fine-tuning or task-specific generalization guarantee is inferred from the paper. |
| Yang et al., [Depth Anything V2](https://arxiv.org/abs/2406.09414); [official project](https://github.com/DepthAnything/Depth-Anything-V2) | Relative structural descriptors using the Apache-2.0 Small encoder. It was evaluated and not selected for live use. |
| [scikit-image LBP example](https://scikit-image.org/docs/stable/auto_examples/features_detection/plot_local_binary_pattern.html), referencing Ojala's local binary patterns | Texture histograms as an alternative to raw intensity. The implementation retains orientation because camera rotation contains the desired signal. |
| Dalal–Triggs HOG, via [scikit-image's HOG explanation](https://scikit-image.org/docs/stable/auto_examples/features_detection/plot_hog.html) and the prior project pilot | Local normalization and spatial gradient histograms; revisited as a measured baseline rather than assuming illumination invariance. |
| Cawley and Talbot, [On Over-fitting in Model Selection and Subsequent Selection Bias in Performance Evaluation](https://jmlr.org/papers/v11/cawley10a.html) | Nested candidate selection and separation of tuning, retrospective diagnostics and future independent validation. |
| Existing `SessionAdapter`, `AnnotationModelSelector`, screenshot storage and Python/JavaScript parity paths | Reused fitting/provenance contracts, baselines and lifecycle boundaries. |

Official sources were inspected during planning/implementation on 2026-09-17. Images and annotations stayed local; only public code, documentation and weights were downloaded.
