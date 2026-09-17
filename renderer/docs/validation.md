# Hinge Glass validation — 2026-09-17

## Current version: 0.1.2, slider projection and stronger frosting

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
