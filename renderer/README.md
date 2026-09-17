# Hinge Glass 0.1.1

A native Windows animation that captures a monitor continuously, places its live image on a virtual plane fixed relative to the keyboard, and views it through the moving, frosted lid. The reference angle defaults to **110° and is adjustable**. It works without a camera or angle service.

## Build and run

Requires Windows 10 2004 or newer, a Direct3D 11 GPU, Visual Studio 2022 C++ build tools, Windows SDK 10.0.26100.0 and CMake 3.24+. No downloaded libraries or game injection are required.

```powershell
./renderer/build.ps1 -Test
./renderer/start.ps1
```

The executable is `renderer/build/Release/HingeGlass.exe`. Ship it with the adjacent `config.json` and `glass.hlsl`. The Microsoft Visual C++ runtime must be installed.

1. Start with **Preview**. Move the physical-angle slider through 0–180° while the laptop stays stationary.
2. Adjust **Reference angle** (1–179°), blur, and viewing geometry. Numeric edits apply when focus leaves the field. **Apply / save** persists them under `%LOCALAPPDATA%/HingeGlass/preferences.json`.
3. Select the monitor and GPU, then **Enable screen**. The effect appears only below the reference angle. **Ctrl+Alt+F12** immediately disables it. This hotkey is registered before enabling any overlay.
4. **Close sweep**, **Open sweep**, and **Reverse sweep** exercise repeatable motion. A manual edit returns to manual control.

The **entire active bottom edge stays fixed**, including both corners. Eye distance is forward from the mechanical hinge over the keyboard; height is above the keyboard; lateral offset is positive right. Screen dimensions describe the active panel; hinge offset locates its bottom edge at the reference angle. That origin remains fixed while the visual plane rotates; the offset is never rotated with the image. Defaults are approximate and should be calibrated to the viewer. The illusion is correct for that fixed viewpoint, not for unrestricted head movement or both eyes independently.

The cursor is drawn into the virtual content before projection and frosting. Actual input coordinates, clicks, focus, and game mouse movement remain unchanged. The overlay is an animation, not a replacement desktop hit-testing system. A small companion process restores system-cursor visibility if the renderer crashes. It exits when the renderer exits.

## Angle service

Choose **Fusion** to subscribe to `http://127.0.0.1:1820/api/events`; `/api/angle` initializes each connection. Start Fusion's camera through its existing UI. This application does not own or start the camera.

`IAngleSource::sample(now)` returns angle, angular velocity, source and reception timestamps, session identity, validity, and freshness. Manual and scripted sources implement the same interface. Fusion uses the already-smoothed `displayAngleDeg` / `displayVelocityDegS`, predicts for at most the configured 17 ms publication interval, and freezes geometry on stale input while video remains live. Old session data cannot revive a retired session. All network access is loopback HTTP, with bounded messages and connection timeouts.

Fusion currently supports **10–120°**. Its 10° endpoint is not a closed-lid measurement. Full 0° closure is available in debug mode; physical integration below Fusion's current range requires an improved angle source.

## GPU, refresh rate, color and compatibility

Auto selects an available RTX 4070 preferentially, then another high-performance hardware adapter. An explicit unavailable adapter fails visibly. The controls report the GPU actually used. The default cap is **60 Hz for testing**, as requested; users can set up to 240 Hz. Presentation is also capped by the selected display's active refresh. Integer refresh divisors use vertical-sync intervals. Three swap buffers with a maximum two queued frames avoid the hybrid-GPU half-refresh behavior observed with a one-frame limit. Capture itself keeps at most the newest frame.

Capture and animation are independent. A 60 fps video remains a 60 fps video while geometry can update at 240 Hz. Static desktops may supply few capture frames: large source-frame age is not by itself a failure. Frame age, capture delivery time, GPU duration, render rate, present statistics and dropped captures are reported separately. Capture delivery includes OS capture and cross-adapter scheduling; it does not claim to isolate PCIe transfer time.

SDR capture is decoded to linear light for projection and blur, then encoded for presentation. HDR monitors use floating-point scRGB throughout. Windows' capture border is retained; the application does not silently request permission to remove it. HDR/scRGB code still needs real HDR-monitor validation.

Supported targets are regular videos and windowed/borderless games visible in Windows' desktop composition. Protected video, secure desktops, exclusive fullscreen and applications that block capture are not guaranteed. No protected-content bypass or game injection is attempted. Black pixels are valid content and never treated as proof of failure. A compositor overlay can cause an application to throttle when occluded; test the intended game or player.

## Closed lid and recovery

Use **Lid setup** for instructions: Control Panel → Power Options → Choose what closing the lid does → **Do nothing**, for the intended AC/battery modes. Hinge Glass never edits the power plan. It prevents idle sleep while enabled, then releases the request on disable or failure.

Some firmware still turns the panel off when closed. Software cannot display light from a powered-off panel; capture is recreated when the display returns. Lock, sleep, display loss and GPU failures release cursor suppression and use bounded recovery attempts. Three consecutive failures leave the app faulted with the native desktop visible; enabling again retries. Hardware lid behavior must be tested physically.

## Benchmarks and diagnostics

```powershell
./renderer/benchmark.ps1 -Fps 60
./renderer/benchmark.ps1 -Fps 60 -Live
```

Each benchmark warms up for two seconds after the first frame, then measures a 60-second closing sweep. JSON reports are written under `renderer/out/`. Synthetic benchmarks also export the final rendered PNG; live desktop frames are never saved. Synthetic screenshot readback is outside the measured rendering loop.

The acceptance target is at least 237 presented fps at 2560×1600/240 Hz with RTX 4070 GPU processing p95 below 4.17 ms. JSON distinguishes source, render and compositor-present counts. These are software measurements, not an independent optical motion-to-photon measurement. Game-load contention and hardware lid response require separate acceptance runs.

For a brief live preview check:

```powershell
./renderer/build/Release/HingeGlass.exe --smoke --seconds 8 --angle 85 --no-preferences --report ./renderer/out/smoke.json
```

Configuration is validated before changes take effect. `--config path` selects defaults; `--no-preferences` ignores and does not save user settings. `--fps`, `--angle`, `--synthetic`, `--overlay`, `--benchmark`, `--seconds`, and `--report` support reproducible diagnostics.

See [architecture](docs/architecture.md), [research](docs/research.md), and [validation](docs/validation.md).
