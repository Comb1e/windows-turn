# Fusion iteration history

## 0.3.0 — 2026-09-19 — Train through Light Track photo annotation

**Previous issue:** Fusion offered sweep calibration and recording/checkpoint/reference controls alongside photo-trained models.

**Method root cause:** The coordinator still owned a sweep state machine and recording timeline, allowing inferred labels to enter a competing Light Track trainer.

**Improvements:** Removed sweep state/control code, training polling, recording timelines and related buttons/APIs/configuration. Added a photo-annotation link and profile refresh. Kept saved artifact selection/export, camera ownership, bounded frame queues, exact-frame anchors, automatic keyboard target priority, fallback and displayed-angle protocol. Camera disconnect releases the session. Old collection/calibration URLs return 410 with a clear replacement workflow.

**Verification:** All 28 retained Fusion tests pass, including HTTP/SSE keyboard priority and identity rejection, real Light Track scene-profile inference/export, stale generations, bounded queues, controller continuity and cancellation. Removed workflow tests were retired and HTTP retirement cases added. Light Track passes 54 JS/29 Python tests; Keyboard 144 tests; renderer 4 CTests. Browser inspected the new model/profile controls and annotation entry point. Renderer publication tests remain at 60 Hz; no refresh settings changed.

**Remaining issues:** Standard v1 annotation models are directly available in standalone Light Track and may be used as bases for scene profiles. The Fusion profile list continues to expose published image models/scene profiles and existing artifacts; no model promotion or retraining occurred. Physical accuracy and live-camera long-duration acceptance remain separate hardware work. Read-only replay of historical recordings remains for diagnostics; it cannot collect or train.

Earlier iterations: [historical log](../iteration.md).
