# Rendering design references

Reviewed 2026-09-17. Project code was written independently; no Magpie implementation was copied.

| Reference actually used | Application | Limit |
| --- | --- | --- |
| [Win32CaptureSample](https://github.com/robmikh/Win32CaptureSample), README and SimpleCapture.cpp | HMONITOR capture interop, free-threaded frame pool, D3D texture access, scRGB format selection and capture cleanup | Sample behavior does not prove 240 Hz or all-game compatibility |
| [Magpie](https://github.com/Blinue/Magpie), capture-method comparison, CursorManager, ScalingWindow and presentation code | GPU capture/overlay separation; exclude output; draw cursor separately; retain native game input; compare capture and presentation choices | No source copied; its input-remapping approach is deliberately not implemented |
| [S. J. D. MacIntosh, Generalized Projection Matrices (2022)](https://arxiv.org/abs/2208.09549), introduction and shear discussion | Viewer-relative perspective and separation of screen-plane geometry from camera assumptions | The implementation derives a planar ray intersection; it does not use the paper's perspective/orthographic interpolation |
| [Microsoft screen capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture) | GPU frame ownership, size changes, FP16 HDR capture | Capture cannot recover protected pixels |
| [SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity) | WDA_EXCLUDEFROMCAPTURE on controls and overlay to prevent feedback | Requires DWM and Windows 10 2004+ |
| [DXGI flip model](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/dxgi-flip-model) | Flip presentation, frame statistics, bounded latency | Software present counts do not measure the photons reaching the viewer |
| [MagShowSystemCursor](https://learn.microsoft.com/en-us/windows/win32/api/magnification/nf-magnification-magshowsystemcursor) | Documented global cursor visibility control and explicit restoration | Requires crash recovery; cursor hiding never changes input coordinates |
| [SetThreadExecutionState](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate) | Keep display/system awake only while enabled | Cannot override deliberate lid sleep or firmware panel shutdown |
| [Microsoft Projection Transform](https://learn.microsoft.com/en-us/windows/win32/direct3d9/projection-transform), reread for 0.1.2 | Distinguish rigid geometry from perspective and viewport scaling; preserve aspect ratio in slider previews | A rotating-plane test is not a substitute for the physical-lid compensation required to anchor the image in the room |

Robert Kooima's generalized-perspective article was located during planning, but its original server could not be read securely in this environment; it is not claimed as a directly read implementation source.

## References used for 0.1.5 — Fusion transport — 2026-09-17

| Reference actually read | Role in this change | Limit |
| --- | --- | --- |
| [Microsoft WinHttpQueryDataAvailable](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpquerydataavailable), remarks and example | Explicit guidance to query available data before reading when processing partial responses promptly; motivated the SSE transport fix | Availability does not define an SSE message boundary; the existing incremental parser remains necessary |
| [Microsoft WinHttpReadData](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpreaddata), synchronous read semantics | Bounded reads, buffer-filling behavior and zero-byte EOF handling | Documentation alone does not establish actual latency; the native HTTP regression first failed on the old code and passed with the fix |
| This repository's [Fusion server](../../fusion/server.js), [controller](../../fusion/src/controller.js) and [HTTP contract test](../../fusion/tests/server.test.js) | Verify snapshot/SSE payloads, stopped/requesting states, displayed angle/velocity and session changes; run the real coordinator as an integration control | Measurement services and camera uploads in this test are simulated; no estimator implementation was copied or changed |

## Additional references used for 0.1.3–0.1.4 — 2026-09-17

| Reference actually read | Role in this change | Limit |
| --- | --- | --- |
| [NVIDIA GPU Gems 3, Chapter 28: Practical Post-Process Depth of Field](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-28-practical-post-process-depth-field) | Per-pixel blur radius, reduced-resolution Gaussian images, and blending multiple blur levels; motivates spatially varying footprints instead of a uniform blur/opacity mix | Uses camera depth of field; our independently derived distance is between the virtual desktop and finite glass, not the thin-lens CoC formula or scene depth |
| [Microsoft Window Features: Owned Windows](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features) | Explains why the full-screen owned overlay always covered the controls and disappeared when the owner minimized | Window ordering does not alone establish end-to-end capture correctness |
| [Microsoft SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos) | Keep controls above output without activating them; release topmost after disable | Verified separately with native fixture windows |

Distance is derived by closest-point projection onto a finite rectangle sharing the hinge axis. Gaussian levels are interpolated by variance. No project source or shader implementation was copied.
