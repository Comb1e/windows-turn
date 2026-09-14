# Iteration history

## 2026-09-14 — Shorter Light Track checkpoint guide

The previous fusion recording instructions requested both opening and closing holds in one recording. Light Track now defaults to 12 checkpoints per recording, so the instructions use one opening pass and describe how to collect a separate closing recording. Independent training, validation, and test recordings and synchronized motion references remain necessary for evaluation.

## 2026-09-14 — Fusion 0.1.0: separate services, temporary adaptation, motion-based display

The previous workspace contained two separate applications with incompatible capture ownership, dimensions, timestamp units, and output conventions. Keyboard measurements could not supply matched-frame labels to brightness inference. A direct switch between their angles would expose model offsets as display jumps; differentiating that signal would wrongly treat calibration changes as physical motion. Brightness artifacts were synthetic, and its location-disjoint trainer did not support a one-environment baseline workflow.

This version adds a camera-free keyboard frame API, a separate brightness/adaptation/motion API, and a root-managed coordinator with independent bounded service queues. The coordinator sends identical RGBA frames, preserves accurate keyboard authority, and exposes raw measurement separately from the motion-controlled display. A frozen baseline receives a bounded temporary affine correction from matched keyboard observations. A source-environment trainer, baseline recording UI, motion-axis fitting, causal replay, and independent-reference metrics complete the research workflow.

Methodological limitations remain explicit: 120° is assumed initially; small-angle labels cannot establish the whole response curve in a new room; affine adaptation cannot undo collapsed model predictions; scene rotation can confuse whole-laptop pitch; and initial real source calibration and independent hardware accuracy/latency measurements remain necessary. At rest, large display discrepancies resolve slowly under the configured 1°/s correction allowance.

Software validation covers keyboard API contracts, adaptation, source training, relative motion, source priority, timing, bounded queues, controller rate limits, HTTP integration, and all three real services with synthetic RGBA inputs. Synthetic smoke data is excluded from real acceptance. Repositories stay on `main`; original local camera configuration and data are preserved.
