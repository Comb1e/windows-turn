# Hinge Glass validation — 2026-09-17

## Current version: 0.1.5, Fusion connection

- Release build succeeds. Core geometry/source/configuration, 30 native window checks and 641,501 actual-HLSL checks pass; the new fourth CTest suite contains **five native HTTP integration tests**. Existing Fusion tests remain **28/28 passing**. Fusion and estimator source code are unchanged.
- The small-event regression was run first against the old worker. A complete 72° SSE publication with no following bytes remained unavailable (`valid: false`, status “Connecting to Fusion”). Querying available bytes before reading passes the same deadline, without weakening it.
- The production WinHTTP worker is checked against real loopback sockets for snapshot startup/status, a fragmented event, 10°/120° boundaries, silent/stale input, invalid/reordered data, retired sessions across reconnection, explicit camera stop, service startup after the renderer, stream EOF and service restart on the same port.
- Integration with the **actual Fusion coordinator and display controller** covers camera-start API, RGBA upload, changing displayed angle, stale controller output, camera stop/restart and a second native client connecting after the camera is active. Independent measurement services and RGBA camera frames are simulated; this checks the application connection, not physical camera accuracy. Test ports are ephemeral and existing services are not restarted.
- Live desktop preview using `--fusion --smoke --fps 60 --seconds 8 --no-preferences` followed a local streamed sweep from 110° to **75°**, using one SSE subscription. The report records 355 renders / 351 presents / 345 captures over 8.0095 seconds, 960×600, RTX 4070 Laptop GPU, GPU p95 **0.229376 ms**, frame-interval p99 **16.9008 ms**. The 44.32 fps overall average includes initialization and shader startup; this short smoke run is not sustained 60 Hz acceptance. Report: `renderer/out/fusion-live-60.json` (ignored). Live desktop pixels were not saved.
- All application rendering was capped at **60 fps**; Windows' display reported 60 Hz and its refresh settings were not modified. Physical camera/lid, new-effect 240 Hz, HDR and game-load checks remain pending. The controls' new address/status UI is compiled and launched; direct interaction with that field has not been automated.

## Previous version: 0.1.4, distance frosting and single rotation

- Release build and **3/3 CTest suites pass**: 166,827 core checks, 30 native window checks and 641,501 shader checks. Shader correctness runs offscreen on WARP and is not reported as hardware performance.
- Independent 3D closest-point controls validate image-to-glass distance. Independent forward rotations and ray intersections validate the retained projection across reference angles, viewing distances, screen heights, edge-on/back-face conditions and reversal. Fixed-bottom and aspect-ratio regressions remain covered.
- Actual HLSL tests cover reference/zero-blur identity, valid finite output at closure, variable blur radius and the distance response. An 85° stripe test retains 99.9195% of near-hinge contrast and only 0.0180% in the upper region. These percentages describe that synthetic frequency pattern, not every video or desktop.
- The former physical compensation implementation, selector, config setting and benchmark option are removed. Loading an old `projectionMode: physical` preference produces the sole rotation geometry; saving it removes obsolete settings. A removed CLI selector fails explicitly.
- Native fixtures confirm controls above output without focus steal, slider usability, cursor routing, capture exclusion, dialogs, minimization, recovery layering and cleanup.
- Existing Fusion tests: **28/28 pass**. Estimator and Fusion source code are unchanged.
- Synthetic 85° rotation output was inspected: increasingly blurred upper image and clear green bottom edge. The independent shader suite also checks exact/reference closure and maximum blur zero. Diagnostic images under `renderer/out/` are synthetic only.
- The first distance-frost live sweep used the old physical benchmark override and reproduced the user's stretching report. Its 59.926 fps / GPU p95 1.126368 ms are historical performance evidence only, not validation of the requested geometry. The user requested deletion of that mode; it is no longer executable in this version.
- The final single-rotation live sweep at 2560×1600 completed 60.021 seconds after warmup: 3,592 rendered frames (59.846 fps), 3,590 DXGI-presented increments (59.812 fps), GPU p95 **1.1264 ms**, and frame-interval p99 27.3844 ms on the **NVIDIA GeForce RTX 4070 Laptop GPU**. Capture delivered 2,520 frames and discarded 425 superseded frames; rendering kept its independent cadence and bounded queue. This is a desktop functional benchmark at 60 Hz, not game-load or optical-latency acceptance. Report: `renderer/out/live-rotation-60.json` (ignored).
- Launched through `./renderer/start.ps1`. Native accessibility inspection confirms the manual slider, grid checkbox and frost-distance field, with no view-mode selector. While the app remained active, the observed slider angle changed from 111.1° to 72.8° and the live status reported capture/render/present at 60 fps. Controls remained exposed to native accessibility. The automation bridge did not support direct numeric-field value editing; the interactive grid toggle itself was not automated in this check. Native window fixtures cover pointer, focus and slider behavior independently.

All current application tests are capped at **60 fps**. The current monitor reports 60 Hz; no Windows refresh setting was changed by the application or these tests. Physical-lid world-space compensation has been removed, so it is no longer a claimed feature. New-effect 240 Hz, HDR, games and hardware lid behavior remain unverified.

## Previous version: 0.1.2, slider projection and stronger frosting

- Release build passes; **99,392 core assertions pass**. The original physical-mode ray controls remain, alongside independent forward rigid-rotation controls and world-position checks for the physical effect.
- Tests cover whole-source recovery, no top-edge enlargement during the standard closing sweep, both bottom corners and interior edge points, near/exact edge-on geometry, back-face culling, reversal, invalid inputs, and source aspect ratios 16:10, 16:9, portrait, ultrawide and square.
- The stronger frosting is monotonic across four reference angles, is clear at/above reference, and reaches maximum at closure. At the default reference and an 85° slider angle the blur contribution exceeds 57%, versus roughly 13% previously; the default radius maximum increased from 24 to 64 pixels.
- Synthetic GPU frames at 110°, 85°, 40° and 0° validate the stationary rotating-plane view. The whole image is visible at 85°/40°, instead of enlarging a strip. Images with the stronger frosting were inspected; a dense Gaussian kernel removed the repeated-edge bands exposed by the stronger radius. Final 40° GPU p95 was 0.201728 ms at 960×600.
- A real-capture smoke check of physical mode completed at an 85° input and 60 fps cap. It retains the fixed source plane and uses the stronger frosting. This checks capture/render integration; it is not a physical-lid alignment measurement.
- The final eight-second live physical-mode sweep, after warmup, recorded 481 rendered and presented frames in 8.0162 seconds (60.003 fps) with GPU p95 0.132096 ms at 960×600. This is a 60 fps functional sweep, not a 240 Hz acceptance test.
- All new render runs used a **60 fps cap**. The Windows display remained at its already configured 240 Hz; no system refresh setting was changed. Short smoke averages include startup and shader compilation and are not sustained-rate acceptance benchmarks.
- Preview and Enable screen preserve the selected view mode. The intermediate automatic switch on full-screen entry was removed after the user reported that live rendering still stretched despite the corrected grid test. Physical-lid mode is selected explicitly; the user must still calibrate the eye position and move the actual lid for perceptual acceptance of that effect.
- Native accessibility inspection of the final live preview confirms the visible view-mode selector, manual slider, blur control and output buttons. During interactive slider use, its live capture, render and presented counters each reported 60 fps. The application was left open for the user's review.

New ignored artifacts: `rotation-110.png`, `rotation-85.png`, `rotation-40.png`, `rotation-0.png`, `smooth-frost-40.png`, and matching JSON under `renderer/out/`. Live artifacts contain timing metadata only. Existing Fusion code is unchanged; its last complete baseline remains 28 passing tests.

## Previous version: 0.1.1, fixed bottom edge

| Check | Result | What it establishes |
| --- | --- | --- |
| VS 2022 / SDK 26100 x64 Release build | Pass | Native application and test executable compile |
| Core tests | 43,622 assertions pass | Independent ray/plane vs homography, identity, closure, visibility, configuration, SSE, session ordering and state transitions |
| Bottom-edge regression | Pass | Seven points across the edge, including both corners, stay fixed for offsets 0/10/50/200 mm, eye offsets −150/0/150 mm and angles 0/10/40/80/109.99° |
| 85° synthetic GPU image at 60 fps cap | Pass, image visually inspected | Full-width green bottom edge remains anchored, left/right colored edges retain orientation |
| Live full-screen capture closing sweep at 60 fps cap | Completed; 3,600 rendered / 3,599 DXGI-presented frames over 62.050 s | Capture, projection, cursor path, frosting and presentation run together at 2560×1600 on the RTX 4070 |
| Live sweep GPU processing | p95 0.275456 ms | GPU work is comfortably below the 16.67 ms test budget |
| Live sweep frame intervals | p99 18.2612 ms; overall 58.017 rendered fps | Typical pacing is near the requested cap; an end-of-run stall makes the measured duration longer than 60 s; this is not hidden from the average |
| Existing Fusion suite | All 28 tests pass | Existing coordinator and estimator integration behavior remains intact |

The display was physically configured at 240 Hz during the final tests; the application requested **60 fps**, using every fourth refresh. The application did not change the Windows refresh setting. All tests started after the user's 60 Hz instruction used the 60 fps cap. The user withdrew the reported flip symptom and requested reassessment after the bottom fix; no independent rotation-direction change was made.

Local diagnostic outputs are in `renderer/out/` (ignored by Git): `bottom-fixed-85.png`, `bottom-fixed-85.json`, and `bottom-fixed-live60.json`. Only synthetic imagery is saved. Live diagnostics save timing metadata, not captured desktop images.

## Earlier development evidence, not final-pivot acceptance

Before the 60 Hz test instruction, a completed 60-second 2560×1600 synthetic closing benchmark on the RTX 4070 at 240 Hz recorded 14,257 rendered frames (237.616 fps), 14,261 DXGI-presented count increments (237.683 fps), GPU p95 0.2304 ms and frame-interval p99 5.1117 ms. Frame-count differences across measurement boundaries are expected with queued presentation. This was the old pivot and an internally generated moving source, not live video or a running game. It does not certify arbitrary-game 240 Hz performance.

Initial Intel/60 Hz live preview also ran successfully. A one-frame swapchain latency limit caused approximately half-refresh pacing on the later hybrid Intel/NVIDIA display path. Three buffers and a maximum two queued frames resolved that specific pacing limit while retaining a bounded queue. A 1×1 ambient-light reduction removed nine redundant source samples per full-resolution pixel.

## Remaining physical and application checks

- User review of the corrected projection while moving the actual lid, with calibrated eye position and reference angle.
- Ordinary video players and specific borderless games, including occlusion throttling, relative mouse input, focus and cursor shapes. These compatibility cases are not certified merely by successful desktop capture.
- HDR display luminance/color correctness; current hardware tests used SDR.
- Actual lid-close firmware behavior, monitor reconfiguration, device removal and lock/sleep/resume stress tests. The recovery paths are implemented; the physical cases were not induced automatically.
- Cursor restoration after forced process termination. Normal renderer shutdown returned cleanly; destructive process fault injection is not counted as tested here.
- Independent optical motion-to-photon latency and isolated cross-adapter transfer timing. `captureDeliveryMs` includes OS capture scheduling and transfer; GPU shader timestamps measure a different interval.
- Native UI inspection: after opening the application visibly, accessibility inspection confirmed the labeled manual-angle slider, angle/reference numeric controls, Preview/Enable/Disable buttons and 60 Hz setting. The bridge became unavailable during the subsequent Preview click check, so live slider interaction is left for user review. Command-line preview and synthetic image inspection succeeded.

Protected content and exclusive fullscreen are outside the supported baseline, not unresolved test failures. Fusion's current 10–120° output cannot validate physical closure at 0°.
