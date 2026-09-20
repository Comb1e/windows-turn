# Fusion architecture

```mermaid
flowchart LR
  Launcher[Local service launcher] --> Services[Keyboard and Light Track]
  Camera[Single browser camera] --> RGBA[Frame ID, timestamp and RGBA]
  RGBA --> KQ[Keyboard: one running and newest pending]
  RGBA --> LQ[Light Track: one running and newest pending]
  KQ --> Keyboard[Automatic keyboard angle]
  LQ --> Lighting[Photo-trained image angle]
  Keyboard --> Target[Available keyboard has target priority]
  Lighting --> Target
  Keyboard --> Pair[Match exact frame and timestamp]
  Lighting --> Pair
  Pair --> Adapt[Temporary live adaptation]
  Adapt --> Lighting
  Target --> Controller[Continuous display trajectory]
  Controller --> Output[Snapshot and SSE at configured rate]
  Output --> UI[Fusion status and target]
  Output --> Glass[Hinge Glass angle source]
```

Keyboard and Light Track are independent repositories and HTTP services. Fusion owns camera fan-out, source selection and smooth display output. Light Track owns photo annotation, training, scene fitting and immutable profile storage. The coordinator keeps compact service summaries and a bounded frame-pair cache. Feature vectors are discarded after receipt; no training or recording timeline is retained. Session identity, monotonic frame IDs, capture timestamps and model generations reject obsolete work.

```mermaid
stateDiagram-v2
  [*] --> STOPPED
  STOPPED --> REQUESTING: Start and obtain service camera settings
  REQUESTING --> KEYBOARD: Valid fresh keyboard reading
  REQUESTING --> LIGHTING: Only image model available
  KEYBOARD --> KEYBOARD: Short configured visibility grace
  KEYBOARD --> LIGHTING: Keyboard unavailable past grace
  LIGHTING --> KEYBOARD: Keyboard reacquired
  KEYBOARD --> STALE: No usable source
  LIGHTING --> STALE: No usable source
  STALE --> KEYBOARD: Fresh keyboard frame
  STALE --> LIGHTING: Fresh image-model frame
  REQUESTING --> STOPPED: Cancel or camera failure
  KEYBOARD --> STOPPED: Stop or disconnect
  LIGHTING --> STOPPED: Stop or disconnect
```

The keyboard target is exact, without lighting motion or sample-age extrapolation. Available keyboard velocity drives smooth motion. Light Track motion is used only during lighting fallback. Existing brief target holds do not imply a new measurement. The display controller preserves position, velocity, acceleration and jerk when replanning; a correction's original deadline is retained through temporary gaps. The renderer consumes the displayed angle and velocity, with freshness separate from rendering state.

```mermaid
flowchart LR
  Link[Open photo annotation; stop Fusion camera] --> Photos[Manual or exact-frame keyboard labels]
  Photos --> Train[Train annotation model]
  Photos --> Fit[Fit scene profile from photo references]
  Train --> Store[Light Track immutable artifacts]
  Fit --> Store
  Store --> Refresh[Refresh profiles]
  Refresh --> Select[Select and use profile]
  Select --> Boundary[Activate on next frame]
  Boundary --> Reset[Invalidate old lighting results and anchors]
  Reset --> Inference[Continue live inference]
```

Profile camera geometry is checked before activation. Existing published profiles can still be loaded/exported. Sweep, recording, checkpoint and CSV-reference actions return 410 and have no runtime handler. All new training and calibration uses photo annotations; suggested angles never become labels without a measurement. Keyboard rejection/unavailable status cannot supply targets, photo labels or adaptation anchors. Relative-motion helpers remain inference-only.

`config.json` owns camera rate, network/lease limits, source freshness, controller settings and output cadence. The launcher uses bounded readiness checks and closes only owned services. Keyboard recognition and Light Track research references are maintained in their own repositories. Hardware evaluation uses 60 Hz renderer tests without changing system refresh settings.
