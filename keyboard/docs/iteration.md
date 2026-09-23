# Iteration history

## 0.7.0 — 2026-09-19 — Optional identity evidence and larger annotation batches

**Previous issues:** Similar sofa/table edges could pass structural keyboard checks. Eight fitting photos could not establish unseen-scene object identity, and the annotation UI required an angle even for absent targets.

**Method causes:** Boundary contrast and temporal continuity identify a line, not the laptop. Sparse feature probes found too few base-surface keypoints for reliable local matching. Training-photo success does not measure independent recognition.

**Improvements:** Added a reusable accepted/rejected/unavailable verifier interface before candidate ranking, three frozen optional encoders, shared CLI/service integration, explicit CPU/CUDA status, bounded reference banks, and separate revision-checked identity sidecars. New batches can contain visible, absent and uncertain photos without changing angle annotations. Whole-group/duplicate-safe exports separate references, validation and held-out tests. Existing angle regression, confirmation, nullable service interface and default detector remain unchanged because no candidate qualifies.

**Verification:** 144 Python tests pass. Tests include baseline positives/failures, weaker verified candidates, stale frames, loss/reconfirmation, missing assets, service reconnects, sidecar write failure and revisions, duplicate/group leakage, exclusion of regressor fitting photos from independent evidence, and unchanged source files. Browser checks verified absent labels save without an angle, survive reload, and preserve unsaved angle edits. All 316 protected originals matched their initial hashes. All three encoders executed on CPU and RTX 4070. A 15-minute saved-frame replay stayed at 15 Hz without a growing queue or sustained memory increase; a subsequent 60-second capped-bank check passed with Hinge Glass at 60 Hz.

**Remaining issues:** No default verifier promotion: DINO retains 5/8 positives; PerSAM retains 4/8 and still accepts one known negative; YOLO retains 0/8. Thin textureless strips remain difficult. Independent positives/negatives from the next roughly 20 photos, fresh-camera accuracy, browser memory, physical disappearance/reappearance, and game/full-resolution renderer contention remain acceptance work. See [measured comparison and commands](identity-research.md).

Earlier versions: [historical iteration log](../iteration.md).
