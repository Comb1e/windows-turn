# Light Track 0.16.0

Light Track is the `light-track/` component of the Windows hinge estimation repository. Run the commands below from this directory. Source code, shared configuration and tests are versioned with the other components; `.venv/`, `data/` and `artifacts/` are ignored. See the [workspace guide](../README.md) for integrated startup.

Light Track learns lid angles **only from annotated photos**. Label screenshots with a measured angle or let Keyboard label the exact captured frame. The live page runs a saved model. Optional scene calibration also fits annotated photos.

Sweep calibration, timed checkpoint collection, synchronized CSV labeling, two-angle geometric setup, and the reflection simulation have been removed from the applications, APIs, and training commands. Existing photos, annotations, exported recordings, published models, and profiles are preserved. Old published models/profiles can still be loaded or exported for compatibility; their former collection/training workflows cannot run. Removed HTTP actions return `410 Gone` with a link to photo annotation.

## Start

For manual annotation and measurement, run from this directory:

```powershell
npm start
```

Open [photo annotation](http://localhost:1818/annotate) or [live measurement](http://localhost:1818/). For keyboard-assisted photo labels, run `npm start` from `../fusion` to start all three services. **Stop Fusion's camera before starting annotation capture**; one workflow owns Keyboard at a time. Restart already running services after updating, then reload their pages.

Python training uses `.venv/Scripts/python.exe` on Windows (or `LIGHT_TRACK_PYTHON`). Install `requirements.txt` for the standard photo model. The optional image model additionally requires the vision dependencies described below. `npm start -- --no-video` hides the preview without stopping measurement; `--model path/to/model.json` provides an existing startup model. `PORT` defaults to 1818.

## Annotate photos

1. Enter the laptop identifier and lighting description, then **Start annotation session**. Each session is one group; positions, lighting and angles may repeat.
2. Start the camera. **Capture screenshot** saves a still image; uploads are also supported. Enter its actual measured angle and **Save annotation**. No assumed pace or suggested angle becomes a label.
3. For keyboard assistance, choose **Start automatic collection**. The camera feeds Keyboard at up to 15 Hz. The first valid matching frame is saved immediately; subsequent valid screenshots are saved at least 0.5 seconds apart. Repeated angles are retained. Invalid or identity-rejected keyboard readings save nothing.
4. **Stop collection** before reviewing photos or entering manual labels for larger angles. Previous/Next switches photos; **Clear label** retains the image; **Delete photo** permanently removes its PNG, label, notes and feature vector after one confirmation, including any unsaved edits.
5. **End session**. Closed groups remain editable but cannot receive new images. Empty groups are retained. Train again after correcting or deleting source data: published models, scene profiles and earlier exports remain unchanged.

The keyboard service reports its model identity and supported range (currently 10–46°); no fixed small-angle cutoff is imposed by photo annotation. Exact pixels, frame ID, timestamp, angle, model range, quality, and camera provenance are saved together. A service/model change, stale response or concurrent revision prevents saving. Collection stops when the camera stops, the page is hidden, or its ownership lease expires.

Each `data/annotations/<group-id>/` contains a manifest and lossless PNGs. Back up the whole directory. Original v1 vectors and old manual labels remain usable. Revision checks prevent stale tabs overwriting edits. Collection, server training and scene fitting block conflicting photo deletion. Independently started CLI trainers do not acquire the server's in-process lease; finish them before editing their input groups.

## Train and measure

**Train model** uses all ended, labeled groups for the same laptop and capture settings. It compares the original Extra Trees model with regularized color forests, using whole-group diagnostics and training-only selection. Sparse and single-image groups are supported; open, empty and unlabeled groups are skipped explicitly. Download the model/report or choose **Use newest model**.

**Evaluate richer image model** compares lighting, texture, metadata and optional frozen pretrained features on the same photos. It publishes only when the accuracy, runtime and export-parity gates pass. Failure leaves existing models in place. The current saved DINOv2/ridge model uses 253 screenshots: nested development-group MAE was 6.69°, compared with 19.59° for the prior procedure. These development diagnostics do not establish unseen-scene physical accuracy. See [research and feature ablations](docs/scene-model-research.md) and [annotation model research](docs/annotation-model-research.md).

The live page defaults to **Newest annotation model (automatic)**. Stop the camera to select an older annotation model, a scene profile, a server startup artifact or a local model JSON file. **Refresh models** discovers new results. Failed selections keep the last valid model; missing dependencies or weights report an explicit error. Model inference continues when the preview is hidden. Stale frames show no current angle.

New captures use independent defaults of **640×480 and 60° horizontal FOV**. A saved model's capture dimensions/FOV take precedence for inference, including historical models. Camera resolution mismatches are rejected. Uploaded photos preserve aspect ratio; a group cannot mix capture geometry.

Equivalent photo-training CLI, from this directory:

```powershell
.\.venv\Scripts\python.exe research/train_annotations.py data/annotations --output artifacts/photos-v1
node research/check-parity.mjs artifacts/photos-v1/model.json artifacts/photos-v1/parity.json
npm start -- --model artifacts/photos-v1/model.json
```

Use a new output directory for each run. All supported trainers require screenshot groups; feature-only recordings and sweep exports are no longer training inputs. Shared schema/export helpers live in `research/model_training.py` and have no collection CLI.

## Calibrate a scene with photos

On the annotation page, select a base annotation model and **Start scene calibration**. This creates a separate photo group. Capture about ten measured angles spread across your intended range, using exact-frame Keyboard labels when available and manual measurements elsewhere. Save the **actual** angle, not the suggestion. Stop automatic collection before manually capturing larger angles.

**Save scene profile** requires at least three distinct reference angles spanning 20°. Coverage is shown; repeated angles do not replace diversity. Up to 100 references are supported. Profiles are immutable and bind the base model and camera. Select **Scene · …** on the live page or refresh/select the profile in Fusion. Choose the base model to reset after changing the scene. Detected camera changes invalidate scene calibration. Fresh photos at non-reference angles are needed for independent acceptance.

## Optional image worker

The evaluated image model uses a local Python worker, shared by standalone measurement and Fusion's frame API. One frame runs and at most one newer pending frame replaces its predecessor. Backend and processing time are reported. The configured backend is CUDA; CPU is supported but did not meet the 66.7 ms measurement budget in the recorded benchmarks. The original v1 photo models keep their JavaScript inference path.

```powershell
.\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
.\.venv\Scripts\python.exe -m pip install -r requirements-vision.txt
.\.venv\Scripts\python.exe research/scene_features.py --prepare-assets
```

Weights and pinned official sources remain under ignored `artifacts/vision-assets`; live inference never downloads them. Offline/live extraction shares the same versioned implementation. `research/scene-config.json` owns feature settings, cache keys and candidate grids. Research sources actually used include DINOv2, Depth Anything V2, texture-feature references and Cawley–Talbot; their roles and measured limitations remain in the linked research notes. This workflow simplification adds no new learning algorithm.

## Configuration and verification

`config.json` owns camera, annotation, model selection, scene calibration and worker settings. `service-config.json` owns bounded live-service adaptation and profile storage. Fusion retains keyboard target priority and temporary live adaptation; neither publishes training labels or a model. Relative camera motion remains an inference diagnostic; it cannot establish an absolute angle.

```powershell
npm test
npm run check
.\.venv\Scripts\python.exe -m unittest discover -s research -p "test_*.py"
```

On hosts without IPv6 localhost support, use `$env:NODE_OPTIONS='--dns-result-order=ipv4first'` for tests. Renderer integration tests use 60 Hz and never change Windows refresh settings. See [architecture](docs/architecture.md), [validation](docs/validation.md), and [iteration history](docs/iteration.md).
