"""Fit the existing affine adaptation from explicitly measured scene screenshots."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import numpy as np
from scene_features import ROOT, signature, read_rgb, digest_file
from image_runtime import ImagePredictor
from scene_models import portable_predict, fit_calibration, calibrated
from train_annotations import screenshot_label_source


def fit_profile(group, base, config, directory):
    if group['state'] != 'CLOSED':
        raise ValueError('End the scene calibration group before fitting')
    if group['capture'] != base['capture']:
        raise ValueError('Calibration camera differs from the base model')
    samples = [s for s in group['samples'] if s['angleDeg'] is not None]
    settings = config['sceneCalibration']; angles = np.asarray([s['angleDeg'] for s in samples], dtype=float)
    if (len(samples) > settings['maxReferences'] or len(np.unique(angles)) < settings['minDistinctAngles']
            or not np.isfinite(angles).all() or np.ptp(angles) + settings['angleToleranceDeg'] < settings['minSpanDeg']):
        raise ValueError('Scene calibration requires at least three distinct measured angles spanning 20 degrees')
    if len({s['imageSha256'] for s in samples}) < settings['minDistinctAngles']:
        raise ValueError('Calibration needs distinct reference images')
    runtime = ImagePredictor(base, config['imageInference']['backend']); blocks = {}
    for sample in samples:
        screenshot_label_source(sample, group['capture'], config)
        path = directory / group['groupId'] / sample['image']
        if path.name != sample['sampleId'] + '.png' or digest_file(path) != sample['imageSha256']:
            raise ValueError('Reference image identity changed')
        values = runtime.blocks(read_rgb(path), sample['features'], sample.get('camera', {}))
        for family, value in values.items():
            blocks.setdefault(family, []).append(value[0])
    blocks = {key: np.asarray(value) for key, value in blocks.items()}
    raw, descriptor = portable_predict(base, blocks)
    # Keep the established affine method unless a separately evaluated policy is promoted.
    adaptation = json.loads((ROOT / 'service-config.json').read_text())['adaptation']
    fit = fit_calibration(raw, descriptor, angles, {'kind': 'affine'}, adaptation)
    bounds = [min(base['angleRange'][0], float(angles.min())), max(base['angleRange'][1], float(angles.max()))]
    model = {'version': 2, 'kind': 'scene-calibrated-model', 'baseModel': base, 'calibrationFit': fit,
             'baseModelId': base['modelId'], 'capture': group['capture'], 'angleRange': bounds,
             'referenceRange': [float(angles.min()), float(angles.max())], 'referenceGroupId': group['groupId'],
             'referenceRevision': group['revision'], 'referenceCount': len(samples),
             'referenceIds': [s['sampleId'] for s in samples], 'referenceHashes': [s['imageSha256'] for s in samples],
             'filter': base['filter'], 'calibration': base['calibration'], 'provisional': True,
             'validation': {'passed': False}, 'createdAt': datetime.now(timezone.utc).isoformat(),
             'coverage': {**base.get('coverage', {}), 'device': group['metadata']['device']}}
    model['modelId'] = signature(model)
    predictions = calibrated(raw, descriptor, fit, bounds)
    report = {'kind': 'scene-calibration', 'modelId': model['modelId'], 'referenceCount': len(samples),
              'referenceRange': model['referenceRange'], 'method': fit['kind'], 'baseModelId': base['modelId'],
              'independentValidationAvailable': False, 'referenceFitOnly': {'angles': angles.tolist(), 'predictions': predictions.tolist()},
              'limitations': ['Reference images are fitting data, not validation.',
                             'Only the existing affine correction is deployed; experimental feature/residual candidates require promotion.',
                             'Reset or select another profile after changing the scene or camera.']}
    return model, report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path); parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(); data = json.loads(args.input.read_text())
    group_path = Path(data['directory']) / data['group']['groupId'] / 'group.json'
    before = digest_file(group_path)
    if json.loads(group_path.read_text()) != data['group']:
        raise ValueError('Annotations changed before fitting')
    model, report = fit_profile(data['group'], data['model'], data['config'], Path(data['directory']))
    if digest_file(group_path) != before:
        raise ValueError('Annotations changed during fitting')
    args.output.mkdir(exist_ok=False)
    for name, value in [('model', model), ('report', report)]:
        (args.output / (name + '.json')).write_text(json.dumps(value, allow_nan=False))
