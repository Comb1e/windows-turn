# Hinge Fusion 0.3.0

Fusion sends the same camera frame to Keyboard and Light Track. A fresh valid keyboard angle is the target whenever available. Light Track's photo-trained model supplies the fallback. The displayed angle follows the existing smooth controller and is published to Hinge Glass.

## Start

From this directory:

```powershell
npm start
```

The launcher starts Keyboard, Light Track and Fusion, reusing healthy local services. Open http://localhost:1820. `npm run start:coordinator` runs only Fusion. Stop and restart already running services after updating, then reload their pages.

## Train Light Track with photos

Open **photo annotation** from Fusion or visit http://localhost:1818/annotate. Stop Fusion's camera before annotation capture. Capture/upload photos with manually measured angles, or use **Start automatic collection** to save exact matching-frame Keyboard labels. End the groups, then **Train model** or **Evaluate richer image model**. Optional scene calibration fits a separate group of annotated photos.

Return to Fusion and **Refresh profiles**, select the published image model or scene profile, then **Use profile** and **Start camera**. Standard v1 annotation models can be used directly in standalone Light Track or as a base for a published scene profile. Existing published artifacts remain selectable and exportable.

Sweep calibration, inferred intermediate labels, feature-only recording, timed holds and CSV import are removed. They cannot be started through old URLs either (`410 Gone`). Existing recordings and models are preserved. Without a suitable model, keyboard measurements still work; a retained displayed value is explicitly not a fresh measurement. Light Track's photo annotations are the only supported training/calibration workflow.

## Runtime

One browser camera owns capture; Keyboard and Light Track each process one running frame and one replaceable pending frame. A service disconnect invalidates that source and reconnects without accepting obsolete results. Keyboard identity rejection provides no target or adaptation anchor. Anchors require matching frame timestamps and IDs. Temporary adaptation is session-only and never saves training labels or overwrites a model.

The renderer consumes `/api/angle` and `/api/events`, including `displayAngleDeg` and displayed velocity. Keyboard target priority, stale handling, displayed-angle publication and emergency renderer controls are unchanged. Test renderer operation at **60 Hz** without changing Windows refresh settings.

## Interfaces and tests

Current routes: `/api/health`, `/api/start`, `/api/stop`, `/api/frames`, `/api/angle`, `/api/events`, `/api/profiles`, `/api/profile`, `/api/profiles/:id/export`, and `/api/adaptation`. Shared settings are in `config.json`; Light Track owns model/profile files. There are no coordinator training or recording buffers.

```powershell
npm test
```

If localhost IPv6 is unavailable on the host, set `$env:NODE_OPTIONS='--dns-result-order=ipv4first'` for tests. `research/smoke.mjs` exercises real services with synthetic frames; this cannot establish physical accuracy. Historical saved-recording analysis remains read-only through `npm run replay -- recording.json report.json`; it neither collects data nor trains a model.

See [architecture](docs/architecture.md), [iteration history](docs/iteration.md), and the [Light Track README](../light-track/README.md) for photo capture, training, vision dependencies and limitations.
