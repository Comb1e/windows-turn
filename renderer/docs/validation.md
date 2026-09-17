# Hinge Glass validation — 2026-09-17

## Current version: 0.1.1, fixed bottom edge

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
