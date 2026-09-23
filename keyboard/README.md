# Keyboard-based laptop hinge measurement

Keyboard is the `keyboard/` component of the Windows hinge estimation repository. Run the commands below from this directory. Source code, shared defaults and tests are versioned with the other components; `.venv/`, `data/` and your local `config.json` are ignored. See the [workspace guide](../README.md) for integrated startup.

## Independent fusion service (0.6.2)

Run `.\.venv\Scripts\python.exe -m keyboard_hinge serve` from this directory to expose the existing moving-edge estimator on `http://localhost:1819`. `--model` selects another fitted edge model; `--service-config` selects service settings; `--port` overrides the port. This mode does not open the camera or require additional environment calibration. It uses the model's actual image dimensions and regression range. The retrained local model has labels spanning 10–46° at 640×480. All eight current reference photos are automatically recognized, including the thin visible strips at 43° and 46°.

The separate `../fusion/` coordinator owns the camera and supplies binary RGBA8 frames. `GET /v1/health` declares the model ID, dimensions, and range. `POST /v1/sessions` with `{camera:{width,height}}` acquires a lease; `POST /v1/sessions/{id}/frames` accepts an `application/octet-stream` body with headers `X-Frame-Id`, `X-Timestamp-Ms`, `X-Width`, and `X-Height`. Results echo identity and capture time and contain `angleDeg`, `valid`, `state`, `quality`, and optional edge endpoints. Milliseconds are converted to seconds only at `EdgeSession.update()`.

`POST /v1/sessions/{id}/reset` returns a new session ID; `DELETE /v1/sessions/{id}` releases the session. Concurrent processing is rejected as busy; the API client retains only its latest waiting frame. The API does not average or correct valid keyboard readings. Existing standalone workflows below remain available. Service constants are in `service-config.json`; your local `config.json` is preserved.

Boundary validation compares reference pixels about 10 and 16 pixels above each candidate at 640×480 with visible pixels below it. When the base is cropped, the lower samples stop at the real image bottom, requiring at least four pixels of visible context in every sampled column. Shading and texture are checked within four horizontal regions. Local contrast and support still use original intensities. Each proposed line is refined and checked for straightness before surface validation and ambiguity decisions, so a stronger invalid background edge cannot hide a valid weaker base edge. Search hints use the same checks.

Initial acquisition and reacquisition require three consecutive supported frames spanning at least 100 ms (about 133 ms at 15 FPS). While confirming, the API returns `valid: false`, `angleDeg: null`, and no edge. A brief loss retains the previous accepted boundary and speed reference for 500 ms internally; it never publishes that old angle as a new measurement. After longer gaps it searches broadly and confirms again. Fusion already falls back to brightness after its keyboard grace period, and only valid keyboard frames become calibration labels. Confirmed angles still use the original fitted regression without averaging.

Existing angle models remain readable. Detection settings have defaults in `config.py` and examples in `config.example.json`; omitted settings work with existing local configs. New limits control minimum visible context, line residuals, the candidate budget and annotation-matching tolerance. The default line check requires 90% of supported gradient points to lie within two processing pixels of the fitted line. Restart the keyboard service after updating code. `GET /v1/health` exposes `boundaryValidation: surface-context-and-temporal-confirmation-v3` for verification.

Training uses the human-marked boundary as an identity reference. It shares local gradient/Huber refinement with live detection, then runs automatic full-frame detection without annotation hints on every reference. **The model is saved only if every reference is recognized and the detected line matches its annotation** within the configured pixel tolerance (4.8 pixels at 640×480 by default). A missing result, ambiguous result or different detected boundary fails training and preserves the previous model. Saved diagnostics include the detected angle and boundary-position error for every photo. This replaces the previous behavior that allowed training success with unrecognized references. Manual **S** initialization still uses automatic evidence and temporal confirmation.

See [boundary validation](docs/boundary-validation.md) for the measured checks and limitations. Visually similar sustained edges can still fool this detector, and reflections or textured laptop surfaces can cause additional rejections. Full-frame negative recordings and actual laptop testing are still needed to quantify those rates.

**Front-camera photos → measured angle + two moving-boundary endpoints → fast fitting → live angle.**

The default opening range is **10–45°**. Closed means 0°. The camera must be fixed to the display. When only a strip of the base is visible in the lower half, mark the **moving boundary above that strip** with two points. The fixed bottom border of the photograph carries no angle information. Four-corner geometry and empirical corner tracking remain available for a fixed physical rectangle.

## Quick start for a partially visible keyboard

The example config selects the moving-edge method:

~~~json
"camera": {"index": 0, "width": 640, "height": 480, "horizontal_fov_deg": 60},
"uncalibrated": {"method": "edge", "use_fov": true}
~~~

1. Run **annotate**, choose **Moving boundary (2 points)**, and click the left and right ends of the boundary above the visible base. Mark a wide segment in the lower half and enter its measured angle.
2. Capture at least four photos at three or more angles. Full physical keyboard corners and measured dimensions are unnecessary.
3. Fit and run:

~~~powershell
.\.venv\Scripts\python.exe -m keyboard_hinge train-uncalibrated --method edge
.\.venv\Scripts\python.exe -m keyboard_hinge run-uncalibrated
~~~

Live mode detects the edge automatically. **S** optionally selects two endpoints to guide an ambiguous search. Missing, weak, or competing edges clear the reading; a clearly detected edge can be reacquired automatically. The method measures image boundary height and slight tilt, with optional FOV-based vertical viewing angles. It does **not** interpret this clipped outline as the pose of a physical rectangle.

Live uncalibrated mode requests the resolution saved in the model, even if config contains another resolution. For example, a model trained on 640×480 photos opens at 640×480 despite a 1280×720 config. It checks the actual camera frames and never silently stretches a different aspect ratio. If the camera cannot supply that resolution, collect photos at a supported resolution and retrain.

Existing cropped four-corner annotations can be used with **--method edge**: their **first two points** must be the moving boundary, ordered left to right. New edge annotations store only two endpoints. Do not use the fixed photo-bottom points. Select **Fixed rectangle (4 corners)** and train with **--method corners** to retain the earlier method.

The default search is the lower half, constrained further by the labeled heights. Settings in **limits** include edge_search_min_y_fraction, edge_search_max_y_fraction, edge_min_contrast, edge_min_support, edge_ambiguity_ratio, and edge_search_margin_fraction. The method expects a broad, approximately horizontal edge of consistent contrast direction. Other horizontal objects can look similar, so it cannot guarantee object identity.

## Choose a mode

| Mode | Required inputs | Best use |
| --- | --- | --- |
| Uncalibrated moving edge | Photos, angles, two boundary endpoints; optional FOV | Fast lower-half boundary detection when the full keyboard is cropped |
| Uncalibrated, no FOV | Photos, measured angles, four corners | Fast, low-quality measurement without camera calibration or keyboard dimensions |
| Uncalibrated, optional FOV assistance | Same annotations plus an approximate horizontal FOV | Adds approximate plane-normal features; useful when you know the camera FOV |
| Geometry, approximate intrinsics | Annotations, horizontal FOV, measured rectangle width/depth | Geometric estimation without a printed checkerboard |
| Geometry, calibrated camera | Annotations, checkerboard calibration, measured width/depth | Preferred when accuracy matters; estimates lens distortion |

For this laptop, start with **moving edge + optional 60° FOV assistance**. This needs no checkerboard, camera calibration file, hinge file, or measured keyboard dimensions. FOV assistance is an assumption, not a guarantee of improved accuracy; compare its evaluation errors against the FOV-free model.

~~~mermaid
flowchart TD
    A[Capture photos and annotate angles plus four corners] --> B{Use measured geometry?}
    B -->|No| C{Know horizontal FOV?}
    C -->|Yes, optionally| D[Empirical fit with FOV features]
    C -->|No| E[Empirical fit from corner shape]
    B -->|Yes| F{Checkerboard available?}
    F -->|Yes| G[Calibrate camera]
    F -->|No| H[Approximate intrinsics from FOV]
    G --> I[Fit hinge from selected annotations]
    H --> I
    D --> J[Evaluate independent photos]
    E --> J
    I --> J
    J --> K[Live tracking with manual selection]
~~~

## Install and settings

PowerShell, from the `keyboard/` directory:

~~~powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[test]'
# Only copy this on first setup; preserve an existing config.json.
Copy-Item config.example.json config.json
~~~

Your local settings can contain:

~~~json
{
  "camera": {
    "index": 0,
    "width": 1280,
    "height": 720,
    "horizontal_fov_deg": 60
  },
  "uncalibrated": {
    "use_fov": true,
    "method": "edge"
  }
}
~~~

Camera index 0 is a starting point; select the actual front camera on your machine. **camera.horizontal_fov_deg** is editable from 10 to 170° and defaults to 60°. The example config enables optional FOV assistance. Set **uncalibrated.use_fov** to false, or pass --no-fov when training, to use corner shape alone. If the uncalibrated section is absent, FOV assistance is off.

Keep the same camera, resolution, zoom, crop, focus, and mirroring settings during capture and live use. Turn off automatic framing and background effects. Both previews use unmirrored images. Whole-laptop motion is compatible with a camera fixed to the display; moving the camera relative to the display requires a new fit.

For a different config, put the global option before the command:

~~~powershell
.\.venv\Scripts\python.exe -m keyboard_hinge --config my-laptop.json annotate
~~~

## 1. Capture and annotate

~~~powershell
.\.venv\Scripts\python.exe -m keyboard_hinge annotate
~~~

Open the printed localhost URL. Choose **Use front camera**, select the device if necessary, then **Capture frame**. The browser requests the configured resolution; if it is unsupported, edit the camera settings and restart. You can also upload existing images. Browser and OpenCV device lists may differ, so verify that live use opens the same physical camera. Stop the browser camera before starting an OpenCV workflow.

For edge mode, click two endpoints left to right as described above. For the optional four-corner modes:

1. Set a known opening and measure it independently, for example with a protractor.
2. Mark **front left → front right → rear right → rear left** around the same rectangle. Front is nearest the user; rear is nearest the hinge. These are physical labels, not the current image's left/right directions.
3. Drag markers to correct them, enter the angle, and save.

Use the angle slider or numeric field. R resets corners, Backspace undoes a corner, Enter saves, and arrow keys navigate when you are not typing. Unsaved changes are marked and navigation asks before discarding them.

Collect at least **four valid photos at three distinct angles** for empirical fitting. Prefer 6–10 photos spread across the visible 10–45° interval, with additional independently labeled photos for evaluation. Do not expect predictions beyond the range represented by your training labels. Geometry needs at least two references separated by 15°, for example 10° and 45°, plus evaluation photos.

The default image directory is data/annotations; labels go to data/annotations.json. Override both if needed:

~~~powershell
.\.venv\Scripts\python.exe -m keyboard_hinge annotate --input data/photos --output data/labels.json
~~~

## 2A. Optional uncalibrated corner mode

For a fixed physical rectangle, fit with the corner method and optional FOV setting:

~~~powershell
.\.venv\Scripts\python.exe -m keyboard_hinge train-uncalibrated --method corners
~~~

The FOV flags below apply to either method. Append **--method corners** when using four fixed physical corners, or **--method edge** for two endpoints:

~~~powershell
# Use the configured FOV (60 degrees by default).
.\.venv\Scripts\python.exe -m keyboard_hinge train-uncalibrated --use-fov

# Try another FOV without editing config.json.
.\.venv\Scripts\python.exe -m keyboard_hinge train-uncalibrated --horizontal-fov-deg 62 --output data/model-fov62.json

# Fit a model that needs no FOV at all.
.\.venv\Scripts\python.exe -m keyboard_hinge train-uncalibrated --no-fov --output data/model-no-fov.json
~~~

The corner model uses small regularized regression, not neural-network training. Without FOV it uses centered, scale-normalized corner coordinates. With FOV it additionally estimates a plane normal from the rectangle homography using assumed centered intrinsics and zero distortion. No physical rectangle size is used. The edge method instead fits boundary height and optional viewing angle; it does not calculate a plane normal from clipped points.

Training saves data/angle-model.json, including the chosen FOV or null, feature normalization, coefficients, supported shapes, labeled angle range, image resolution, training fingerprint, and validation diagnostics. Live use takes the FOV from this model. **Retrain after changing FOV**; changing config alone does not reinterpret an already fitted model.

The reported leave-one-angle-out error holds out all images with the same angle together. It helps reveal inconsistent labels and poor fits, but it is not an independent hardware accuracy measurement. A mean error above **5°** prints a low-quality warning; this configurable threshold does not guarantee acceptable errors below it.

To reserve specific photos for evaluation, use their exact image IDs with --items:

~~~powershell
# Replace these example filenames with your actual images.
.\.venv\Scripts\python.exe -m keyboard_hinge train-uncalibrated --items opening-10.png opening-20.png opening-30.png opening-45.png
~~~

Evaluate, then run:

~~~powershell
.\.venv\Scripts\python.exe -m keyboard_hinge evaluate-annotations --model data/angle-model.json --report data/evaluation.json
.\.venv\Scripts\python.exe -m keyboard_hinge run-uncalibrated --model data/angle-model.json --jsonl data/measurements.jsonl
~~~

In the live preview, press **S**, select the same four corners, and press **Enter**. The preview shows **approximate / uncalibrated**, angle, and a heuristic confidence score. Lost texture, invalid quadrilaterals, unsupported shapes, out-of-range predictions, excessive speed, or the 30-second drift deadline clear the angle. Press **S** to recover. **Q/Esc** quits.

## 2B. Fit and use geometry

Only this path requires the real width and depth of the chosen planar rectangle. Its left-to-right edge must be parallel to the hinge. Do not mix points on key tops, the palm rest, and a recessed touchpad.

Edit config.json, replacing 120 and 75 with your measured millimeters:

~~~json
"base": {
  "name": "My measured keyboard rectangle",
  "points_mm": [[0, 0, 0], [120, 0, 0], [120, 75, 0], [0, 75, 0]],
  "point_labels": ["front left", "front right", "rear right", "rear left"],
  "measurements_confirmed": true
}
~~~

Choose one camera setup:

~~~powershell
# No printed target: uses camera.horizontal_fov_deg, default 60.
.\.venv\Scripts\python.exe -m keyboard_hinge camera-approximate

# Optional one-run override.
.\.venv\Scripts\python.exe -m keyboard_hinge camera-approximate --horizontal-fov-deg 62

# Higher-accuracy path: measured 18 mm checkerboard squares.
.\.venv\Scripts\python.exe -m keyboard_hinge calibrate-camera --square-mm 18
~~~

Checkerboard defaults are 9 × 6 inner corners (10 × 7 squares). Capture at least 12 sharp, varied views of a flat printed board. Space captures; C fits and saves. Similar duplicate views and excessive reprojection error are rejected. Camera setup itself does not require confirmed keyboard dimensions.

Fit the hinge from selected annotations, then evaluate the others:

~~~powershell
# Replace these filenames with two or more actual reference image IDs.
.\.venv\Scripts\python.exe -m keyboard_hinge calibrate-hinge-annotations --references opening-10.png opening-45.png
.\.venv\Scripts\python.exe -m keyboard_hinge evaluate-annotations --report data/evaluation-geometry.json
.\.venv\Scripts\python.exe -m keyboard_hinge run --jsonl data/measurements.jsonl
~~~

Without --references, all annotated photos participate in fitting. Extra references are checked for consistent corner order, measured angle, and hinge-only rotation. Legacy live reference collection remains available:

~~~powershell
.\.venv\Scripts\python.exe -m keyboard_hinge calibrate-hinge --angles 10 45
~~~

The hinge file is bound to the exact camera intrinsics and rectangle geometry. Regenerating camera intrinsics with a different FOV invalidates that hinge file: fit the hinge again before running.

## Evaluation and stored data

**evaluate-annotations** prints each image's measured angle, estimate, absolute error, and failure reason. It reports successful/failed counts, mean and median absolute error, maximum error, and the five worst successful estimates. Failures are counted, not converted into zero errors.

Fitting images are marked and excluded from aggregate metrics by default. Use --include-training only to inspect fitting errors. If every image was used for fitting, capture more labeled photos before claiming validation accuracy. Old hinge files lack image IDs, so their evaluations cannot automatically identify reference photos.

All dataset commands accept --annotations and --input. By default, the image directory is the annotation path without .json: data/labels.json implies data/labels. Pass --input data/photos if the images are elsewhere. Images must decode, match the model/camera resolution, and contain the annotated corners.

Labels remain JSON, managed through the UI. Schema version 2 also supports two-point records:

~~~json
{
  "item_id": "frame-123.png",
  "timestamp": 1789380000.0,
  "angle_deg": 26.0,
  "source": "camera",
  "corner_mode": "visible-edge",
  "edge": [[10, 350], [630, 346]],
  "corners": null,
  "notes": ""
}
~~~

For four-corner mode, records use corner_mode: physical (the default when omitted), edge: null, and corners:

~~~json
{
  "schema_version": 2,
  "annotations": [{
    "item_id": "frame-123.png",
    "timestamp": 1789380000.0,
    "angle_deg": 26.0,
    "source": "camera",
    "notes": "",
    "corners": [[200, 550], [1000, 550], [900, 250], [300, 250]]
  }]
}
~~~

Both point types use original-image pixel coordinates. Timestamps are Unix seconds. Version 1 annotations can be opened; angle-only records need either two edge points or four fixed corners added before fitting. Saving writes version 2 atomically. Duplicate uploads receive new IDs so existing labels keep their original images. Live JSONL timestamps use a monotonic clock and invalid estimates have angle_deg: null and zero confidence. Edge evaluation detects the boundary from each actual photo, so detector failures count even when manual endpoints are present.

## Accuracy and verification

- The keyboard must be visible and textured. Hidden corners, blur, reflections, repetitive keys, lens distortion, and extreme foreshortening can make estimates unavailable or inaccurate.
- Empirical models are specific to the same camera, laptop, rectangle, and capture setup. FOV-free shape features remove translation and uniform scale. FOV-assisted features depend on image position and approximate intrinsics as well.
- Confidence describes tracking/shape or pose consistency; it is not a probability or degree-error bound. Check both error statistics and the number of failed estimates.
- Geometry rejects inconsistent pose branches instead of using an inferior in-range branch to replace a better out-of-range fit.
- The limits section in config centralizes the angle range and quality settings. Loosening rejection thresholds does not improve the measurement itself.
- Automated tests use synthetic projections and rendered tracking images. **Real laptop accuracy has not yet been measured.** Compare known openings on your laptop before relying on the output.

~~~powershell
.\.venv\Scripts\python.exe -m pytest -q
~~~

Implementation diagrams are in [docs/architecture.md](docs/architecture.md); dated method changes are in [docs/iteration.md](docs/iteration.md). Use Git branch main. Local photos, models, and recordings belong under ignored data/.

## Identity examples and experimental verification

The annotation page now has **Keyboard identity examples**. Run `.venv/Scripts/python.exe -m keyboard_hinge annotate`, upload or capture photos, choose **Base visible**, **Base not visible**, or **Uncertain**, enter a scene/capture group and role, then **Save identity example**. Visible bases need two boundary endpoints; identity labels need no angle. These labels are stored separately, preserving existing angle annotations. The workflow supports your next approximately 20 photos and larger batches. See [capture guidance, export and evaluation commands](docs/identity-research.md#your-next-approximately-20-photos).

DINO dense references, PerSAM/MobileSAM, and YOLO-World are optional experiments. **None passed promotion; the default detector is unchanged.** [Measured results and setup](docs/identity-research.md) explain their coverage and speed limits. An explicitly selected verifier with missing dependencies or assets returns unavailable, allowing Fusion's normal Light Track fallback.

For standalone opt-in after preparing assets, use a Python environment with the optional dependencies:

```powershell
../light-track/.venv/Scripts/python.exe -m keyboard_hinge run-uncalibrated --identity dino --identity-config identity-config.json
```

`identity-config.json` selects `cpu` or `cuda`, thresholds and the reference manifest. For the frame service, copy `service-config.json` to a separate local file and add `"identity": {"method": "dino", "config": "identity-config.json", "backend": "cuda"}`. Run `python -m keyboard_hinge serve --service-config data/service-identity.json` in the vision environment, then start Fusion; its launcher can reuse this service. Stop the old service first if it already owns port 1819. Health and per-frame quality report actual verification availability and backend. These options do not change the saved angle model or add angle smoothing.
