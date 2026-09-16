# Windows hinge estimation

Three independently runnable components share one front-camera stream:

| Project | Function | Default address |
| --- | --- | --- |
| `keyboard/` | Existing accurate moving-boundary estimator, exposed as a frame API | http://localhost:1819 |
| `light-track/` | Brightness inference, temporary adaptation, relative motion, and calibration recording | http://localhost:1818 |
| `fusion/` | Camera UI, independent API clients, keyboard priority, motion-based display | http://localhost:1820 |

`keyboard/` and `light-track/` retain their own Git repositories and standalone applications. This root repository contains the coordinator and integration documentation, and ignores those two repositories. All three use branch `main`. No estimator source is copied into the coordinator.

Light Track also provides [screenshot annotation](http://localhost:1818/annotate): each session is one lighting group with arbitrary angles and image count. **Start automatic collection** saves exact keyboard-labeled screenshots every 0.5 seconds at visible small angles, including repeated angles; stop it to add manual larger-angle labels. **Train model** trains all ended labeled groups from the page and provides model/report downloads. Its standalone camera defaults remain independently configured as 640×480/60°. See the Light Track README for setup, provenance and optional CLI commands.

## Run

From `fusion`, one command starts or reuses all three services:

```powershell
Set-Location E:\Projects\windows-turn\fusion
npm start
```

The launcher uses each project's own runtime and configuration. It checks service health, reports occupied incompatible ports, and stops only the processes it started when you press Ctrl+C. Existing independently started services keep running. `npm run start:coordinator` starts only Fusion if you prefer managing the services yourself.

Open [Hinge Fusion](http://localhost:1820), then select **Start camera**. Only the coordinator browser opens the webcam; leave the other applications' camera workflows stopped.

Without a real brightness model, keyboard readings and baseline recording work. The wide-angle measurement remains unavailable; the displayed initial 120° is explicitly a retained/provisional value. For provisional measurement, use **Start sweep calibration** in Fusion. It trains, saves, and activates a selectable Light Track profile without a service restart. The stricter source-environment training path remains available for independent validation.

The existing keyboard model requests 640×480 and supports 10–46°; consumers obtain the active supported range from its API. It remains authoritative whenever it returns a valid result. The displayed angle is separate and may take time to converge to an accurate measurement, with a hard 1-second correction deadline and continuous trajectory replanning.

See [fusion setup and calibration](fusion/README.md), [architecture](docs/architecture.md), [technical design and research](docs/technical-design.md), and [iteration history](iteration.md).
