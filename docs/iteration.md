# Iteration history

## Integration: Light Track 0.15.0 / Keyboard 0.7.0 — 2026-09-19

**Previous issues:** Unwanted annotation screenshots could not be permanently deleted. Structurally plausible background edges could become keyboard angles, while eight original positive photos provided insufficient identity evidence.

**Method causes:** Photo storage lacked a recoverable deletion transaction and usage leases. Boundary strength and temporal consistency do not establish laptop identity. Automatic keyboard labels cannot serve as independent identity ground truth.

**Improvements:** Light Track adds confirmed, revision-checked, journaled individual-photo deletion with collection/training/fitting conflicts. Keyboard adds optional DINO, PerSAM/MobileSAM and YOLO-World verification before candidate selection, preserving the existing nullable angle contract. Identity labels are stored separately and support the next approximately 20 photos with group/duplicate-safe reference, validation and test exports. No verifier qualifies for default promotion. Fusion continues using valid keyboard angles first and Light Track when keyboard readings are unavailable; the renderer interface is unchanged.

**Verification:** Light Track: 72 JavaScript and 55 Python tests, plus syntax checks. Keyboard: 144 Python tests and browser checks for identity save/reload/dirty edits. Fusion: 34 tests, including HTTP fallback and exclusion of rejected frames from adaptation anchors, with process-local `NODE_OPTIONS=--dns-result-order=ipv4first` because this host rejects the launcher's IPv6 localhost port probe. Renderer: 4 CTest tests. A 15-minute saved-image/session replay processed 13,500 frames at 15 Hz with no growing queue or sustained memory increase. Hinge Glass ran an RTX 4070 synthetic preview capped at 60 Hz; Windows refresh settings were unchanged. All 316 protected source images/manifests/model files retained their original hashes.

**Remaining issues:** Candidate coverage is insufficient: DINO accepts 5/8 existing positives, PerSAM 4/8 with a known false acceptance, and YOLO 0/8. New independent photos are needed before promotion. Saved-frame memory tests do not establish live-camera/browser memory behavior or unseen-scene physical accuracy. Full-resolution/game contention and physical lid acceptance remain pending. Detailed evidence and reproducible commands are in `keyboard/docs/identity-research.md`.

Earlier versions: [historical iteration log](../iteration.md).
