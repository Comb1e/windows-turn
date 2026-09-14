# Validation record — 2026-09-14

## Software checks

| Check | Result |
| --- | --- |
| Keyboard pytest suite | 88 passing |
| Light Track Node suite | 31 passing |
| Light Track Python research suite | 20 passing |
| Fusion Node suite | 12 passing |
| JavaScript syntax and Git whitespace checks | Passing |
| Three-service real HTTP pipeline with synthetic RGBA | Passing |

The integration smoke launched each actual service on an isolated port, supplied identical RGBA frames, and exercised the real fitted keyboard model interface, lighting adapter, relative-motion worker, recording, display timeline, and causal replay. It used only generated synthetic inputs and generated models, leaving user data untouched.

Observed smoke results: provisional startup 120°, authoritative keyboard 25°, subsequent brightness fallback 25.25°, 15 accepted representative anchors, 47 recorded feature frames, and zero displayed speed-bound violations. The exact display sample count varies with scheduling. Generated outputs are ignored under `fusion/data/smoke/` and marked synthetic.

The API tests also verify resolution/byte-length rejection, exact frame pairing, session expiry/reset, origin rejection, monotonic timestamps, bounded queue replacement, motion worker deadlines, and preservation of original standalone routes. The controller tests cover mismatches, source/model jumps, acceleration, reversal, rest, stale gaps, and the analytic speed bound. UI orchestration tests cover preview independence, cancellable camera startup, late camera completion, and obsolete-session events.

## Browser and hardware boundary

The running browser UI was inspected at http://localhost:1820. Service status correctly reports the saved 10–44° / 640×480 keyboard model and the lack of a real brightness baseline. Calibration controls, preview layout, and the camera-requesting state were checked. Camera access remained pending in the in-app browser; its coordinator session was cancelled through the API and the page returned to its stopped state. Automated UI orchestration verifies Stop cancellation and late-camera cleanup. No real webcam angle measurements were captured, and no independent angle ground truth was available.

Real brightness calibration, changed-environment validation, actual physical angular velocity, and end-to-end camera latency remain unmeasured. The tool exposes this limitation instead of promoting synthetic fixtures into a deployment model. Use the documented full-range calibration and synchronized-reference workflows to collect that evidence.
