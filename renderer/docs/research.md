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

Robert Kooima's generalized-perspective article was located during planning, but its original server could not be read securely in this environment; it is not claimed as a directly read implementation source.
