# Automatic keyboard identity — 0.7.0, 2026-09-19

No candidate is promoted. The default moving-edge detector remains enabled without a semantic verifier. All three optional verifiers execute locally, but none meets the required positive coverage and independent-evidence gates. Enabling an experimental verifier can reduce false readings while also losing real keyboard readings.

## Sources actually used

| Source | Use |
| --- | --- |
| [Matcher paper](https://arxiv.org/abs/2305.13310), [official project](https://github.com/aim-uofa/Matcher) | Inspired dense foreground/background reference matching. Our DINO gate is a bounded similarity implementation, not a reproduction of Matcher or a claim of its published accuracy. |
| [DINOv2](https://arxiv.org/abs/2304.07193), [official project](https://github.com/facebookresearch/dinov2) | Frozen ViT-S/14 patch features; reuse the existing local Light Track checkpoint and pinned source. |
| [PerSAM paper](https://arxiv.org/abs/2305.03048), [official project](https://github.com/ZrrSkywalker/Personalize-SAM) | Pinned official `per_segment_anything`, target attention, semantic prompt, and cascaded mask refinement. |
| [MobileSAM](https://github.com/ChaoningZhang/MobileSAM) | Small pretrained SAM encoder for the PerSAM experiment. |
| [YOLO-World paper](https://arxiv.org/abs/2401.17270), [official project](https://github.com/AILab-CVC/YOLO-World), [Ultralytics implementation](https://docs.ultralytics.com/models/yolo-world/) | Small pretrained checkpoint, built-in laptop/keyboard classes, and boundary alignment checks. A box alone cannot establish the precise moving edge. |
| [LightGlue paper](https://arxiv.org/abs/2306.13643), [official project](https://github.com/cvg/LightGlue) | Considered and deferred: local probes found only 0–2 ORB and 0–6 SIFT features on the reference base surfaces, including no usable points at the thinnest views. |

Weights and source revisions are recorded in `identity-config.json`, local asset manifests, and the archived reports. Public source/weights were downloaded; photos stayed local. Encoders are frozen. Angle values and filenames never enter identity features.

## Evaluation protocol and results

The [review manifest](identity-evidence/evaluation.json) contains eight original human boundary annotations, 15 visually reviewed absent-target Light Track images, and 11 uncertain images excluded from identity scoring. Identity review of the additional images was performed by Codex and is recorded as such. Previous automatic angle labels are not identity ground truth. Original positive images are already used to fit the angle regressor, so their results are diagnostic. Reference matching excludes the evaluated photo from its reference bank. No threshold was selected on these scored images.

All methods use the same 640×480 originals, boundary tolerance of 4.8 pixels, and unchanged boundary/refinement/angle model. Exact duplicates cannot cross roles or groups. New sidecar exports isolate complete reference, validation, and test groups; `--partition validation` excludes test images and `--partition test` excludes validation images. Settings must be frozen before the test run. The script reports insufficiency rather than promoting without independently reviewed positives and negatives across at least three held-out groups. There is no automatic deployment step.

| Method | Correct positives / 8 | False accepts / 15 absent | Mean accepted boundary error | Warm CUDA P95 | Warm CPU P95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Existing detector | 8 | 1 | 1.44 px | 7.00 ms* | 8.19 ms |
| DINO dense references | 5 | 0 | 1.56 px | 37.71 ms | 167.17 ms |
| PerSAM + MobileSAM | 4 | 1 | 1.42 px | 101.40 ms | 1038.75 ms |
| YOLO-World small + boundary | 0 | 0 | unavailable | 32.09 ms | 114.55 ms |

*The existing detector always runs on CPU, including in the CUDA comparison. CPU measurements use four Torch threads; all CUDA candidates actually used the NVIDIA GeForce RTX 4070 Laptop GPU. Timings cover detection and verification, exclude asset loading, and use five warmup iterations followed by 30 timed frames. They are local desktop measurements, not a guarantee under game load. The CPU YOLO run also overlapped the 60 Hz preview check. See [CUDA report](identity-evidence/cuda-report.json), [CPU report](identity-evidence/cpu-report.json), and [CPU YOLO report](identity-evidence/yolo-cpu-report.json).

The three thin-strip positive views pass the baseline but all fail DINO identity. The 46° view lacks a complete real-image feature patch below its edge and becomes explicitly unavailable; padding cannot authorize a reading. The known sofa edge (SHA256 `064ddd6d0d20ab0419d1428309c1339f4eba7dd0f3860e7f023882ab2407eb05`) produces a baseline angle near 28.85° and is rejected by DINO. PerSAM still accepts it. YOLO's zero false accepts are accompanied by zero useful positive coverage.

Median fresh-session acquisition on correctly accepted static images, replayed at 15 Hz, was 138 ms for baseline, 162 ms for DINO, and 204 ms for PerSAM. YOLO never acquired. These are replay acquisition measurements, not physical motion/reappearance measurements. Per-image results, scores, reasons, reference/detected edges, and thin-strip metrics are in the adjacent `*-predictions.json` files. Mean boundary errors in the table use different accepted subsets; the promotion check compares matched accepted boundaries individually.

Promotion requires fewer false accepts, no known negative accepted, at least 90% retention of baseline correct positives, no accepted-boundary error regression, sufficient independent groups, and warm P95 below 66.7 ms. DINO fails coverage and independent evidence; PerSAM also fails false acceptance and speed; YOLO fails useful coverage. More photos can change that assessment; the implementation supports up to 64 references with 128 foreground and 128 background DINO prototypes per reference.

## Memory and renderer contention

The [900-second replay](identity-evidence/memory-900s.json) processed 13,500 frames at 15 Hz, with one frame in flight, no pending queue, 14 session resets, P95 38.5 ms, and one missed deadline. GPU allocations stayed at 102,729,728 bytes and reserved memory at 142,606,336 bytes. Private memory ended about 15 MiB below the post-warmup measurement; there was no sustained increase. This run used eight references before adding the per-reference prototype cap.

The final capped implementation's [60-second recheck](identity-evidence/memory-60s.json) processed 900 frames with P95 42.2 ms, zero missed deadlines, 100,236,800 allocated GPU bytes, and 121,634,816 reserved GPU bytes. It is too short to establish post-60-second-warmup memory growth. The 15-minute result is not presented as a fresh 15-minute run of the later capped bank.

Hinge Glass used a synthetic **960×600 preview capped at 60 Hz**, on the RTX 4070. The long [renderer report](identity-evidence/renderer-900s.json) measured 59.99 rendered frames/s and 0.37 ms GPU P95. The physical display reported 240 Hz; Windows refresh settings were not changed. These runs do not validate full-resolution live capture, browser/camera allocations, game contention, or physical lid behavior. A live camera/browser soak and independent reappearance tests remain hardware acceptance work.

## Reproduce

Run from `keyboard/`. The minimal detector still works in its existing `.venv`; optional encoders need a compatible Torch environment. This workstation used the existing Light Track environment (Python 3.13, Torch 2.11.0+cu128) plus optional packages in ignored `data/identity-deps`. Dependencies and weights are loaded only on explicit opt-in. Missing or incompatible assets produce `unavailable`.

```powershell
# In a separate vision environment, install compatible Torch/torchvision first,
# then the optional packages. Existing environment users can reuse installed assets.
python -m pip install -r requirements-identity.txt
python ../light-track/research/scene_features.py --prepare-assets
python research/prepare_identity.py

../light-track/.venv/Scripts/python.exe research/evaluate_identity.py --manifest docs/identity-evidence/evaluation.json --output data/identity/new-cuda --backend cuda --acquisition
../light-track/.venv/Scripts/python.exe research/evaluate_identity.py --manifest docs/identity-evidence/evaluation.json --output data/identity/new-cpu --backend cpu
../light-track/.venv/Scripts/python.exe research/identity_soak.py --manifest docs/identity-evidence/evaluation.json --output data/identity/new-soak.json --backend cuda --seconds 900 --renderer
.venv/Scripts/python.exe -m pytest -q
```

Use a new output name on each run. The archived manifest uses relative paths into the original local ignored datasets, so it requires those photos. The asset preparer resumes verified checkpoint chunks and validates ZIP CRCs; live inference never downloads a checkpoint. Existing manifests, PNGs, angle models, and profiles are preserved. A hash audit verified all 316 protected originals unchanged.

## Your next approximately 20 photos

Use the existing annotation page: `python -m keyboard_hinge annotate`. Stop Fusion's camera before opening the annotation camera. **Keyboard identity examples** saves its own `annotations.identity.json`; an identity example needs no measured angle. For **Base visible**, mark the true moving boundary with two points. **Base not visible** and **Uncertain** need no points. Save measured angles separately only when actually known.

Aim for around 12 visible bases (including several thin strips, reflections and darker views) and eight absent-target views with confusing sofa/table/touchpad edges. Spread them across at least five capture groups. An example allocation is four reference photos from one group, six validation photos from another, and ten held-out photos across three additional groups. Validation and test sets each need both positives and negatives. This is a suggestion, not a required image count. Do not split consecutive photos from one session across roles. Keep doubtful views uncertain instead of guessing an edge.

```powershell
python research/build_identity_dataset.py --sidecar data/annotations.identity.json --legacy-evaluation docs/identity-evidence/evaluation.json --output data/identity/batch-20
../light-track/.venv/Scripts/python.exe research/evaluate_identity.py --manifest data/identity/batch-20/evaluation.json --output data/identity/batch-20-validation --partition validation --backend cuda
# Freeze identity-config.json before opening final test results.
../light-track/.venv/Scripts/python.exe research/evaluate_identity.py --manifest data/identity/batch-20/evaluation.json --output data/identity/batch-20-test --partition test --backend cuda
```

The optional legacy argument brings only existing reference examples into the new reference bank. It does not add their fitting results to independent test evidence. Exports refuse group/duplicate leakage, altered image hashes, conflicting duplicate reviews, and mixed camera dimensions. Angle accuracy beyond the saved regressor's range requires separate measured-angle calibration. Object identity cannot be established from a textureless strip indistinguishable from the background; its unavailable coverage must remain visible.
