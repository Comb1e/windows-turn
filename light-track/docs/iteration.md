# Iteration history

## 0.16.0 — 2026-09-19 — Photo annotations as the only training workflow

**Previous issue:** Screenshot annotation coexisted with sweep training, timed checkpoints/CSV references, two-angle geometric setup and reflection simulation. Users could enter obsolete workflows from standalone or Fusion controls and old API/CLI entry points.

**Method root cause:** Successive experiments retained separate collection, labeling and absolute-angle setup paths. Sweep labels inferred hidden angles from timing; those paths did not require a saved photo with its measured angle.

**Improvements:** Removed the alternate UIs, handlers, collectors and trainers. All new training/calibration uses screenshot groups with manual or exact-frame keyboard labels. Retained photo capture/upload, automatic Keyboard labeling, editing/deletion, v1/v2 training, optional photo-reference scene calibration, model selectors and existing artifact loading/export. Extracted common Python model helpers and the bounded worker transport so removal does not duplicate code or change feature schemas. Standalone measurement has one model path; stale input clears the current angle. Fusion links to annotation and no longer retains training/recording timelines. Retired HTTP actions return 410 before starting work.

**Verification:** 54 JavaScript and 29 Python tests pass; 31 application modules pass syntax checks. Coverage includes matching-frame keyboard labels and arbitrary reported ranges, rejected/late results, revision/deletion conflicts, scene fitting/cancellation, v1/v2 loading, camera mismatch, selection/reload, preview behavior, retired endpoints, and existing artifact export. Tests dedicated to deleted workflows were retired; retained model/math tests moved to shared helpers. Integration passes 28 Fusion tests, 144 Keyboard tests and all 4 renderer CTests. Browser inspection confirms a single model workflow, working preview toggle, preserved annotation/Keyboard controls, and the new Fusion annotation link/profile controls. No physical camera or display-setting changes were made. All 2,042 pre-existing files under `data/` and `artifacts/` match their initial SHA-256 hashes; all 15 published model artifacts load successfully.

**Remaining issues:** This removes competing workflows and does not retrain or improve physical accuracy. Previously published models can contain legacy training; they remain readable without recreating those workflows. Runtime Fusion adaptation remains temporary and never publishes labels/models. Fresh camera captures are still needed for physical acceptance. Independently launched CLI training requires stable input files outside server usage leases. Historical reports remain marked as historical; removed tools remain recoverable from Git history. Research sources/method evidence remain in the annotation and scene-model research notes; no new learning method was introduced.

## 0.15.0 — 2026-09-19 — Permanent annotation photo deletion

**Previous issue:** The editor could clear a label but could not remove a mistaken or unwanted screenshot.

**Method cause:** PNGs and manifest entries had no shared deletion transaction, and collection/training used the same files without a deletion lock.

**Improvement:** Added a single-photo Delete button with one explicit confirmation, revision-checked HTTP deletion, journal recovery, and shared usage leases for collection, training, and scene fitting. The next available photo is selected and counts/scene coverage update. Published artifacts are immutable.

**Verification:** 72 JavaScript tests pass, including first/last/only deletions, cancellation, dirty edits, open/closed/empty groups, concurrent revisions, active usage leases, filesystem failure, restart recovery, PNG removal, and preservation of other samples/published artifacts. Syntax checks pass. All deletion tests use disposable fixtures; real annotations are untouched.

**Remaining issues:** Deleting a source sample cannot remove its influence from an already trained model or exported copy; a new model/profile must be made. Offline training processes launched independently from the server do not acquire its in-process lease, so finish CLI training before editing its inputs.

Earlier versions: [historical iteration log](../iteration.md).
