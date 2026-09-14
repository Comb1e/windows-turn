# Iteration history

## 2026-09-14 — 0.1.0

Previously there was no integration component. Running both camera applications independently risked webcam contention, mismatched frames, and hard output jumps. A fixed switch duration would ignore real lid motion, and differentiating selected angles would turn model/source disagreement into false motion.

Added an independent API coordinator, one shared browser capture, bounded per-service queues, exact-frame label pairing, authoritative keyboard selection, explicit loss/stale states, and a persistent motion-feedforward controller with filtered bounded correction. Baseline collection and reference import remain functions of Light Track; the coordinator provides their UI and combines recordings with its actual display timeline. The replay tool uses the adapter's public functions and excludes teacher labels from independent metrics.

Remaining limits: real brightness calibration must be collected; the starting 120° is provisional; affine output correction cannot identify arbitrary environment changes; the physical velocity is inferred; whole-laptop pitch can invalidate scene motion; and hardware accuracy and latency are unverified. Large stationary discrepancies deliberately take longer to correct.
