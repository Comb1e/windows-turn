# Workspace architecture

```mermaid
flowchart LR
  Start[Fusion launcher] --> Services[Independent local services]
  Annotation[Photo annotation: manual or matching-frame keyboard angle] --> Photos[Immutable source PNGs and revisioned labels]
  Photos --> Train[Light Track model training and photo scene calibration]
  Train --> Saved[Saved models and profiles]
  Camera[Fusion camera] --> Keyboard[Automatic keyboard detector]
  Camera --> Light[Light Track selected model]
  Saved --> Light
  Keyboard --> Fusion[Keyboard target priority; lighting fallback]
  Light --> Fusion
  Fusion --> Display[Smooth displayed angle and velocity]
  Display --> Glass[Hinge Glass renderer]
```

The root repository owns Fusion and Hinge Glass. `keyboard/` and `light-track/` are independent repositories on `main`. Light Track uses photo annotations as its only training and calibration workflow. Keyboard-assisted collection labels exact saved frames within the service-reported range; manual measurements cover other angles. Scene calibration also uses photo references. Sweep calibration, timed checkpoint collection, CSV labeling, geometric absolute-angle setup and reflection simulation are removed. Existing source data and published artifacts remain preserved.

## Measurement and ownership

```mermaid
flowchart TD
  Owner[One active camera workflow] --> Frame[RGBA, ID, timestamp and camera metadata]
  Frame --> K[Keyboard bounded latest-frame queue]
  Frame --> L[Light Track bounded latest-frame queue]
  K --> Valid[Valid identity and boundary]
  Valid --> Target[Keyboard angle is target]
  L --> Fallback[Photo-trained fallback]
  Target --> Pair[Exact-frame keyboard adaptation anchors]
  Fallback --> Pair
  Target --> Controller[Continuous display controller]
  Fallback --> Controller
  Controller --> API[Snapshot and SSE]
```

Fusion discards image feature vectors from coordinator state and keeps a bounded pair cache. It has no training or recording buffers. Rejected keyboard identity results supply no angle or adaptation anchor. Optional identity verifiers remain experimental because none qualified for default promotion; the human identity-review sidecar is separate from measured-angle annotations. Session/generation checks reject stale responses. Camera ownership prevents simultaneous Fusion and annotation capture.

Photo mutation uses serialized revision checks and usage leases. Permanent deletion journals removal and atomically replaces the manifest before cleaning up the PNG. Published models and profiles remain immutable; correcting training data requires a new artifact. Offline trainers require stable inputs outside server lease management.

## Hinge Glass

```mermaid
flowchart LR
  Sources[Manual slider, debug sweep or Fusion angle source] --> Gate[Identity, time, range and freshness]
  Desktop[GPU desktop capture and cursor] --> Plane[Single bottom-anchored plane projection]
  Gate --> Plane
  Reference[Adjustable reference angle and viewpoint] --> Plane
  Plane --> Distance[Per-pixel separation from glass]
  Plane --> Blur[Linear-light Gaussian blur levels]
  Distance --> Mix[Distance-based frosting]
  Blur --> Mix
  Mix --> Output[Preview or capture-excluded overlay]
  Output --> Controls[Independent controls above overlay]
```

The renderer has one projection path for grid and live capture. Physical-lid mode is absent. The bottom remains anchored; the top becomes more frosted as image separation from the glass increases. Renderer debug sweeps are animation tests and are unrelated to the removed Light Track training sweeps. Fusion snapshot/SSE reads available bytes immediately, validates session identity, and reconnects automatically. Stale input freezes geometry while live capture continues.

```mermaid
stateDiagram-v2
  [*] --> Disabled
  Disabled --> Starting: Enable
  Starting --> Active: Capture and device ready
  Active --> Recovering: Capture or GPU lost
  Recovering --> Active: Recreated resources
  Active --> Suspended: Lock or panel unavailable
  Suspended --> Starting: Unlock or resume
  Starting --> Faulted: Unrecoverable failure
  Recovering --> Faulted: Recovery failed
  Active --> Disabled: Disable or emergency hotkey
  Faulted --> Starting: Retry
```

GPU selection and timing identify the actual adapter. Tests use a 60 Hz render cap and never change Windows refresh settings. RTX/240 Hz, full-resolution game contention and physical lid closure remain hardware acceptance items. See [renderer architecture](../renderer/docs/architecture.md), [Fusion architecture](../fusion/docs/architecture.md), and the independent Light Track and Keyboard architecture documents for current details and actual research references.
