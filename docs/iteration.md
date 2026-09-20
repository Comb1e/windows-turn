# Iteration history

## Integration: Light Track 0.16.0 / Fusion 0.3.0 — 2026-09-19

**Previous issue and cause:** Multiple historical collection/calibration workflows remained executable, including sweep-inferred training and timed recording. Keeping obsolete paths exposed made it possible to bypass photo annotation.

**Improvement:** Light Track now trains and calibrates only from annotated photos, including matching-frame Keyboard labels. Fusion removes sweep/recording logic, links to photo annotation and refreshes published profiles. Shared inference/motion helpers and old saved artifacts remain usable. Current architecture diagrams and running instructions describe only the supported workflow; original datasets are preserved.

**Verification:** 259 automated checks pass: Light Track 54 JavaScript + 29 Python; Fusion 28; Keyboard 144; renderer 4. Light Track syntax checks pass for 31 modules. Browser checked model selection, preview visibility, annotation and keyboard controls, and Fusion's replacement entry. Retired endpoints fail explicitly; original positive paths and stale/invalid/boundary cases remain covered. All 2,042 existing Light Track data/artifact files retain their SHA-256 hashes; all 15 published model artifacts load. Physical capture was not started, and no Windows refresh setting changed.

**Remaining issues:** This is workflow simplification, not new model training or hardware acceptance. Historical artifacts can still be read/exported; their deleted training tools are only in Git history. Photo collection owns Keyboard, so stop Fusion's camera before using annotation. Light Track implementation is committed on `main` as `6c98922`; detailed changes are in Light Track's and Fusion's current iteration documents.

## Integration: Light Track 0.15.0 / Keyboard 0.7.0 — 2026-09-19

**Previous issues:** Unwanted annotation screenshots could not be permanently deleted. Structurally plausible background edges could become keyboard angles, while eight original positive photos provided insufficient identity evidence.

**Method causes:** Photo storage lacked a recoverable deletion transaction and usage leases. Boundary strength and temporal consistency do not establish laptop identity. Automatic keyboard labels cannot serve as independent identity ground truth.

**Improvements:** Light Track adds confirmed, revision-checked, journaled individual-photo deletion with collection/training/fitting conflicts. Keyboard adds optional DINO, PerSAM/MobileSAM and YOLO-World verification before candidate selection, preserving the existing nullable angle contract. Identity labels are stored separately and support the next approximately 20 photos with group/duplicate-safe reference, validation and test exports. No verifier qualifies for default promotion. Fusion continues using valid keyboard angles first and Light Track when keyboard readings are unavailable; the renderer interface is unchanged.

**Verification:** Light Track: 72 JavaScript and 55 Python tests, plus syntax checks. Keyboard: 144 Python tests and browser checks for identity save/reload/dirty edits. Fusion: 34 tests, including HTTP fallback and exclusion of rejected frames from adaptation anchors, with process-local `NODE_OPTIONS=--dns-result-order=ipv4first` because this host rejects the launcher's IPv6 localhost port probe. Renderer: 4 CTest tests. A 15-minute saved-image/session replay processed 13,500 frames at 15 Hz with no growing queue or sustained memory increase. Hinge Glass ran an RTX 4070 synthetic preview capped at 60 Hz; Windows refresh settings were unchanged. All 316 protected source images/manifests/model files retained their original hashes.

**Remaining issues:** Candidate coverage is insufficient: DINO accepts 5/8 existing positives, PerSAM 4/8 with a known false acceptance, and YOLO 0/8. New independent photos are needed before promotion. Saved-frame memory tests do not establish live-camera/browser memory behavior or unseen-scene physical accuracy. Full-resolution/game contention and physical lid acceptance remain pending. Detailed evidence and reproducible commands are in `keyboard/docs/identity-research.md`.

Earlier versions: [historical iteration log](../iteration.md).
