"""Fit a provisional lighting model from independently grouped still-image labels."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import uuid

import cv2
import numpy as np
import sklearn
from model_training import ROOT, feature_names, metrics, smooth, keyboard_label_validation, validate_keyboard_angle
from annotation_models import AnnotationModelSelector, diagnostic_metrics, exclude_group, summarize_diagnostics


def screenshot_label_source(sample, capture, config):
    source = sample.get('labelSource', 'manual' if sample.get('angleDeg') is not None else None)
    if source not in (None, 'manual', 'keyboard') or (sample.get('angleDeg') is not None and source is None):
        raise ValueError('Invalid screenshot label source')
    reference = sample.get('keyboardReference')
    binding = None
    if reference is not None:
        if not isinstance(reference, dict):
            raise ValueError('Invalid screenshot keyboard provenance')
        binding = keyboard_label_validation({'keyboardModel': reference}, config, range_mode='model')
        validate_keyboard_angle(reference.get('angleDeg'), binding, reference.get('frameId'))
        if (sample.get('source') != 'camera' or reference.get('camera') != capture
                or not isinstance(reference.get('sessionId'), str) or not reference['sessionId'].strip()
                or type(reference.get('frameId')) is not int or not 0 <= reference['frameId'] <= 2**53 - 1
                or type(reference.get('timestampMs')) not in (int, float)
                or not np.isfinite(reference['timestampMs']) or reference['timestampMs'] < 0
                or sample.get('frameId') != reference['frameId'] or sample.get('timestampMs') != reference['timestampMs']):
            raise ValueError('Screenshot keyboard label lacks matching-frame provenance')
    if source == 'keyboard' and (reference is None or sample.get('angleDeg') != reference['angleDeg']):
        raise ValueError('Screenshot keyboard angle differs from its reference')
    return source, binding


def load_groups(directory, config):
    groups, skipped, fingerprints = [], [], []
    for path in sorted(Path(directory).glob('*/group.json')):
        payload = path.read_bytes()
        group = json.loads(payload)
        if group.get('version') != 1 or group.get('kind') != 'lighting-screenshot-group':
            raise ValueError(f'{path}: unsupported screenshot group schema')
        group_id = group.get('groupId')
        if str(uuid.UUID(group_id)) != path.parent.name:
            raise ValueError(f'{path}: group identity does not match its directory')
        if group.get('state') == 'OPEN':
            skipped.append({'groupId': group_id, 'reason': 'Session is still open'})
            continue
        if group.get('state') != 'CLOSED':
            raise ValueError(f'{path}: invalid session state')
        if (group.get('featureVersion') != 1 or group.get('featureConfig') != config['features']
                or group.get('featureNames') != feature_names(config['features'])):
            raise ValueError(f'{path}: incompatible lighting features')
        metadata = group.get('metadata', {})
        if any(not isinstance(metadata.get(k), str) or not metadata[k].strip() for k in ['device', 'lighting']):
            raise ValueError(f'{path}: missing device or lighting metadata')
        capture = group.get('capture')
        samples = group.get('samples')
        if not isinstance(samples, list):
            raise ValueError(f'{path}: invalid samples')
        if not samples:
            skipped.append({'groupId': group_id, 'reason': 'Empty group'})
            continue
        if (not isinstance(capture, dict) or any(type(capture.get(k)) is not int or capture[k] <= 0 for k in ['width', 'height'])
                or not isinstance(capture.get('horizontalFovDegrees'), (float, int))
                or not 10 <= capture['horizontalFovDegrees'] <= 170):
            raise ValueError(f'{path}: missing or invalid capture binding')
        x, y, ids, hashes, sources, seen = [], [], [], [], [], set()
        label_sources = {'manual': 0, 'keyboard': 0}
        keyboard_models = []
        for sample in samples:
            sample_id = sample.get('sampleId')
            if str(uuid.UUID(sample_id)) != sample_id or sample_id in seen:
                raise ValueError(f'{path}: duplicate or invalid screenshot identifier')
            seen.add(sample_id)
            if sample.get('image') != sample_id + '.png':
                raise ValueError(f'{path}: invalid screenshot path')
            angle = sample.get('angleDeg')
            source, binding = screenshot_label_source(sample, capture, config)
            if angle is None:
                continue
            if type(angle) not in (int, float) or not np.isfinite(angle):
                raise ValueError(f'{path}: invalid measured angle')
            features = np.asarray(sample.get('features'), dtype=float)
            if features.shape != (len(feature_names(config['features'])),) or not np.isfinite(features).all():
                raise ValueError(f'{path}: invalid screenshot features')
            image = (path.parent / sample['image']).read_bytes()
            digest = hashlib.sha256(image).hexdigest()
            if digest != sample.get('imageSha256'):
                raise ValueError(f'{path}: screenshot hash changed')
            decoded = cv2.imdecode(np.frombuffer(image, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
            if decoded is None or decoded.shape[:2] != (capture['height'], capture['width']):
                raise ValueError(f'{path}: screenshot dimensions differ from capture binding')
            x.append(features); y.append(angle); ids.append(sample_id); hashes.append(digest)
            sources.append(source)
            label_sources[source] += 1
            if binding is not None and binding not in keyboard_models:
                keyboard_models.append(binding)
        if not y:
            skipped.append({'groupId': group_id, 'reason': 'No measured labels'})
            continue
        fingerprints.append({'groupId': group_id, 'sha256': hashlib.sha256(payload).hexdigest(), 'revision': group['revision']})
        groups.append({'groupId': group_id, 'metadata': metadata, 'capture': capture,
                       'x': np.asarray(x), 'y': np.asarray(y), 'sampleIds': ids, 'hashes': hashes,
                       'sources': sources, 'labelSources': label_sources, 'keyboardModels': keyboard_models})
    if not groups:
        raise ValueError('No labeled screenshots in ended annotation sessions')
    if len({g['metadata']['device'] for g in groups}) != 1:
        raise ValueError('Train one laptop at a time; select a directory containing its groups')
    if any(g['capture'] != groups[0]['capture'] for g in groups):
        raise ValueError('All training groups must use identical camera capture settings')
    return groups, skipped, fingerprints


def fit_model(groups, config):
    selector = AnnotationModelSelector(config)
    selected, selection = selector.select(groups)
    diagnostics, baseline_diagnostics = [], []
    for held in groups if len(groups) > 1 else []:
        # Purge outer test pixels before *any* inner selection or normalization.
        partition = exclude_group(groups, held)
        row = {'groupId': held['groupId'], 'lighting': held['metadata']['lighting'],
               'trainingGroups': [g['groupId'] for g in partition], 'sampleIds': held['sampleIds'],
               'labelSources': held.get('labelSources', {'manual': len(held['y']), 'keyboard': 0})}
        baseline_row = dict(row)
        if partition:
            fold_candidate, inner_selection = selector.select(partition)
            fitted = selector.fit(partition, fold_candidate)
            prediction = fitted.predict(held['x'])
            baseline_prediction = (prediction if fold_candidate == selector.baseline else
                                   selector.fit(partition, selector.baseline).predict(held['x']))
            sources = np.asarray(held.get('sources', ['manual'] * len(held['y'])))
            training_y = np.concatenate([g['y'] for g in partition])
            row.update(metrics=diagnostic_metrics(held['y'], prediction), predictions=prediction.tolist(),
                       measuredAngles=held['y'].tolist(), selection=inner_selection,
                       trainingAngleRange=[float(training_y.min()), float(training_y.max())],
                       outsideTrainingRange=int(np.sum((held['y'] < training_y.min()) | (held['y'] > training_y.max()))),
                       byLabelSource={source: diagnostic_metrics(held['y'][sources == source], prediction[sources == source])
                                      for source in ['manual', 'keyboard'] if np.any(sources == source)})
            baseline_row.update(metrics=diagnostic_metrics(held['y'], baseline_prediction),
                                predictions=baseline_prediction.tolist(), measuredAngles=held['y'].tolist())
        else:
            row.update(metrics=None, reason='No training screenshots remain after excluding duplicate images')
            baseline_row.update(metrics=None, reason=row['reason'])
        diagnostics.append(row)
        baseline_diagnostics.append(baseline_row)
    fitted = selector.fit(groups, selected)
    x = np.concatenate([g['x'] for g in groups]); y = np.concatenate([g['y'] for g in groups])
    raw = fitted.predict(x); angle_range = [float(y.min()), float(y.max())]
    usable = [row for row in diagnostics if row['metrics'] is not None]
    residual = max((row['metrics']['p95Error'] for row in usable), default=angle_range[1] - angle_range[0])
    # A constant/single-image fit has no measured uncertainty estimate.
    residual = max(config['estimation']['targetErrorDegrees'], residual)
    coverage = {'device': groups[0]['metadata']['device'], 'sessions': len(groups), 'screenshots': len(y),
                'labelSources': {source: sum(g.get('labelSources', {'manual': len(g['y']), 'keyboard': 0})[source]
                                           for g in groups) for source in ['manual', 'keyboard']},
                'trainingAngleRange': angle_range, 'synthetic': False,
                'groups': [{'groupId': g['groupId'], 'lighting': g['metadata']['lighting'], 'screenshots': len(g['y']),
                            'angles': sorted(set(g['y'].tolist()))} for g in groups],
                'splits': {'train': [g['groupId'] for g in groups], 'validation': [], 'test': []}}
    keyboard_models = []
    for group in groups:
        for binding in group.get('keyboardModels', []):
            if binding not in keyboard_models:
                keyboard_models.append(binding)
    calibration = {'residual95': residual,
                   'distance95': max(.01, float(np.quantile(np.sqrt(np.mean(fitted.normalize(x) ** 2, axis=1)), .95))),
                   'spread95': max(.25, float(np.quantile(fitted.spread(x), .95))),
                   'scope': 'Nested excluded-group diagnostic; no independent accuracy calibration'}
    artifact = {'version': 1, 'featureVersion': 1, 'createdAt': datetime.now(timezone.utc).isoformat(),
                'trainingMode': 'screenshot-groups', 'provisional': True,
                'featureConfig': config['features'], 'featureNames': feature_names(config['features']),
                'angleRange': angle_range, 'normalization': {'mean': fitted.mean.tolist(), 'scale': fitted.scale.tolist()},
                'trees': fitted.export(angle_range), 'filter': dict(config['filter']), 'calibration': calibration,
                'capture': groups[0]['capture'], 'coverage': coverage,
                'annotationMethod': {'version': 1, 'selectedCandidate': selected,
                                     'selectionObjective': 'meanGroupMAE', 'diagnostic': 'nested-excluded-group'},
                'keyboardModels': keyboard_models,
                'validation': {'passed': False, 'realData': False, 'minimumCollectionReached': False,
                               'filterTunedWithDynamicReference': False, 'test': None},
                'motionCalibration': {'available': False, 'reason': 'Still images do not calibrate scene motion'}}
    artifact['modelId'] = hashlib.sha256(json.dumps(artifact, sort_keys=True).encode()).hexdigest()
    report = {'modelId': artifact['modelId'], 'trainingMode': 'screenshot-groups', 'acceptancePassed': False,
              'independentValidationAvailable': False, 'parameters': fitted.parameters, 'capture': artifact['capture'],
              'coverage': coverage, 'excludedGroupDiagnostics': diagnostics,
              'modelSelection': selection,
              'softwareVersions': {'python': sys.version.split()[0], 'numpy': np.__version__,
                                   'scikitLearn': sklearn.__version__, 'opencv': cv2.__version__},
              'comparison': {'scope': 'Nested group diagnostic of the selection procedure; not physical accuracy',
                             'baseline': summarize_diagnostics(baseline_diagnostics),
                             'selectedProcedure': summarize_diagnostics(diagnostics),
                             'baselineExcludedGroupDiagnostics': baseline_diagnostics},
              'keyboardModels': keyboard_models,
              'trainingFitOnlyNotValidation': metrics(y, raw),
              'limitations': ['Session identity does not establish unseen-lighting or location independence.',
                              'Keyboard-derived labels are supervision; diagnostic agreement is not independent physical accuracy.',
                              'The final model fits all labeled screenshots; diagnostics hold out entire groups.',
                              'Candidate tuning scores are optimistic; nested diagnostics select without the outer test group.',
                              'Method development used these data; new capture groups are needed for independent evaluation.',
                              'Exact duplicate screenshots are excluded from diagnostic fitting.',
                              'Single-group or constant-angle data cannot establish transfer between lighting setups.',
                              'Still images provide no motion, jitter, or delay validation.',
                              'Only captured angle coverage is represented; uploaded image provenance is user supplied.']}
    indices = np.linspace(0, len(y) - 1, min(64, len(y)), dtype=int)
    # Filter parity is a software fixture, not a motion evaluation of still images.
    values = raw[indices]; times = np.arange(len(values)) * 100.
    parity = {'features': x[indices].tolist(), 'predictions': values.tolist(),
              'filter': {'values': values.tolist(), 'timestamps': times.tolist(), 'outputs': smooth(values, times, config['filter']).tolist()}}
    return artifact, report, parity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, help='Directory containing saved annotation group folders')
    parser.add_argument('--output', type=Path, required=True, help='New model output directory')
    parser.add_argument('--config', type=Path, default=ROOT / 'config.json')
    parser.add_argument('--baseline', action='store_true', help='Use the original fixed Extra Trees trainer without selection')
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('Output already exists; choose a new directory')
    config = json.loads(args.config.read_text(encoding='utf-8'))
    if args.baseline:
        config['annotation']['training']['selection'] = {'enabled': False}
    groups, skipped, sources = load_groups(args.directory, config)
    model, report, parity = fit_model(groups, config)
    # Reject edits made during fitting; PNG identity was verified by the loader.
    for source in sources:
        path = args.directory / source['groupId'] / 'group.json'
        if hashlib.sha256(path.read_bytes()).hexdigest() != source['sha256']:
            raise ValueError('Annotations changed during training; retry after saving labels')
    model['sourceGroups'] = report['sourceGroups'] = sources
    report['skippedGroups'] = skipped
    args.output.mkdir(parents=True, exist_ok=False)
    for name, value in [('model.json', model), ('report.json', report), ('parity.json', parity)]:
        (args.output / name).write_text(json.dumps(value, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    print(f'Provisional screenshot model: {args.output / "model.json"}')
    print(f'{len(groups)} groups, {sum(len(g["y"]) for g in groups)} labeled screenshots; {len(skipped)} groups skipped.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, TypeError, KeyError, OSError) as error:
        print(f'Screenshot training failed: {error}', file=sys.stderr)
        sys.exit(1)
