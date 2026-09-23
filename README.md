# Windows hinge estimation

Estimate a laptop hinge angle from one front-camera stream and optionally use it to animate the live Windows desktop. A valid Keyboard measurement sets Fusion's exact target; Light Track supplies a photo-trained fallback. Fusion publishes a separate, smoothly moving display angle for Hinge Glass.

| Component | Purpose | Default address |
| --- | --- | --- |
| Keyboard | Moving-boundary angle estimator | [Keyboard service](http://localhost:1819) |
| Light Track | Photo annotation, model training, scene profiles and image inference | [Light Track](http://localhost:1818) |
| Fusion | Shared capture, keyboard priority and continuous display motion | [Hinge Fusion](http://localhost:1820) |
| Hinge Glass | Native desktop capture, bottom-anchored rotation and distance-based frosting | Local Windows application |

This repository contains `keyboard/`, `light-track/`, `fusion/`, `renderer/` and their documentation. One clone includes all component sources; install their runtimes and prepare local models using the [Keyboard README](keyboard/README.md) and [Light Track README](light-track/README.md). Python environments, datasets, trained artifacts and Keyboard's local `config.json` are ignored by Git. Fusion requires Node.js 20+ and uses Keyboard's local Python environment unless overridden.

## Run the camera stack

From the workspace root:

```powershell
Set-Location fusion
npm start
```

The launcher starts missing services, reuses compatible healthy ones, and reports incompatible occupied ports. Ctrl+C stops only processes it started. `npm run start:coordinator` starts Fusion alone. Shared service addresses, camera defaults and controller settings are in [fusion/config.json](fusion/config.json).

Open [Hinge Fusion](http://localhost:1820) and choose **Start camera**. Only one camera workflow should run at a time; stop the other applications' camera workflows. The browser uses the geometry advertised by the active services. The local Keyboard model uses 640×480 and supports 10–46°; consumers read its current limits from the health API.

Without a compatible image model, Keyboard measurements still work. If no source is available, the displayed value is retained and is not a fresh measurement. The initial 120° value is provisional. Display corrections aim to finish within one second, preserve their original deadline across interruptions, and report missed deadlines.

## Train and select an image model

1. Stop Fusion's camera and open [Light Track photo annotation](http://localhost:1818/annotate).
2. Capture or upload photos and save measured angles. **Start automatic collection** saves exact Keyboard-labeled frames every 0.5 seconds within the visible supported range; stop it before manually labeling larger angles.
3. End the photo groups and choose **Train model** or **Evaluate richer image model**. Optional scene calibration fits a separate group of measured reference photos.
4. In Fusion, choose **Refresh profiles**, select a published image model or scene profile, then **Use profile** and **Start camera**.

Standard v1 annotation models are directly selectable in standalone Light Track and can serve as bases for published scene profiles. Fusion lists published image models and profiles. Correcting or deleting a photo does not change an existing artifact; train a new one to incorporate the correction. See [Fusion setup](fusion/README.md) and the [Light Track guide](light-track/README.md) for details.

Keyboard identity rejection supplies no new angle or adaptation anchor. Image estimates remain provisional; the [identity research guide](keyboard/docs/identity-research.md) and [scene-model research](light-track/docs/scene-model-research.md) describe evidence and limits.

## Run Hinge Glass

From the workspace root:

```powershell
./renderer/build.ps1 -Test
./renderer/start.ps1
```

Start with **Preview** and the manual angle slider. The reference angle defaults to 110° and is adjustable. The bottom edge stays fixed, while frosting grows with image-to-glass distance. **Show calibration grid** compares grid and live desktop through the same projection. **Ctrl+Alt+F12** disables the overlay.

To consume Fusion's displayed angle, start its camera and run `./renderer/start.ps1 -Fusion`, or choose **Fusion** in the renderer's angle-source list. Match **Fusion address** to the coordinator if its port differs. Received angles and connection status appear even before rendering is enabled. Stale input holds geometry while desktop capture continues.

Tests default to a 60 Hz cap and do not change Windows refresh settings. The renderer can be configured up to 240 Hz; physical lid behavior, HDR and game-specific performance require hardware validation. Build requirements and controls are in the [renderer README](renderer/README.md).

## Documentation

- [Workspace architecture](docs/architecture.md): ownership, end-to-end workflows, storage and failure paths.
- [Keyboard architecture](keyboard/docs/architecture.md), [Light Track architecture](light-track/docs/architecture.md), [Fusion architecture](fusion/docs/architecture.md) and [renderer architecture](renderer/docs/architecture.md): component workflows, state machines and design constraints.
- [Technical design and research](docs/technical-design.md): model assumptions, controller reasoning and sources actually used.
- [Iteration history](docs/iteration.md): dated changes, verification and remaining limitations.
