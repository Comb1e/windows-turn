# Windows hinge estimation

Three independently runnable components share one front-camera stream:

| Project | Function | Default address |
| --- | --- | --- |
| `keyboard/` | Existing accurate moving-boundary estimator, exposed as a frame API | http://localhost:1819 |
| `light-track/` | Brightness inference, temporary adaptation, relative motion, and calibration recording | http://localhost:1818 |
| `fusion/` | Camera UI, independent API clients, keyboard priority, motion-based display | http://localhost:1820 |

`keyboard/` and `light-track/` retain their own Git repositories and standalone applications. This root repository contains the coordinator and integration documentation, and ignores those two repositories. All three use branch `main`. No estimator source is copied into the coordinator.

## Run

Open three PowerShell terminals. Existing virtual environments are already available in this workspace.

```powershell
Set-Location E:\Projects\windows-turn\keyboard
.\.venv\Scripts\python.exe -m keyboard_hinge serve
```

```powershell
Set-Location E:\Projects\windows-turn\light-track
npm start
```

```powershell
Set-Location E:\Projects\windows-turn\fusion
npm start
```

Open [Hinge Fusion](http://localhost:1820), then select **Start camera**. Only the coordinator browser opens the webcam; leave the other applications' camera workflows stopped.

Without a real brightness model, keyboard readings and baseline recording work. The wide-angle measurement remains unavailable; the displayed initial 120° is explicitly a retained/provisional value. After source calibration, restart only Light Track with `npm start -- --model artifacts/source/model.json`, then start a new coordinator session.

The existing keyboard model requests 640×480 and supports 10–44°. It remains authoritative whenever it returns a valid result. The displayed angle is separate and may take time to converge to an accurate measurement, especially after a large mismatch while stationary.

See [fusion setup and calibration](fusion/README.md), [architecture](docs/architecture.md), [technical design and research](docs/technical-design.md), and [iteration history](iteration.md).
