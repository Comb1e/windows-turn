"""Portable predictors, grouped evaluation primitives and scene calibration."""
import json
from pathlib import Path
import numpy as np
from sklearn.ensemble import ExtraTreesRegressor, RandomForestRegressor
from sklearn.linear_model import Ridge

from annotation_models import AnnotationModelSelector, exclude_group
from model_training import export_trees


def scores(y, prediction, keyboard_ceiling=46, high_angle=90):
    y = np.asarray(y); prediction = np.asarray(prediction)
    valid = np.isfinite(prediction); error = np.abs(prediction[valid] - y[valid])
    if not len(error):
        return {'count': len(y), 'validCoverage': 0, 'mae': None, 'p95': None, 'within5': 0, 'aboveKeyboardMAE': None, 'above90MAE': None}
    return {'count': len(y), 'validCoverage': float(valid.mean()), 'mae': float(error.mean()),
            'p95': float(np.quantile(error, .95)), 'within5': float(np.sum(error <= 5) / len(y)),
            'aboveKeyboardMAE': float(np.abs(prediction[valid & (y > keyboard_ceiling)] - y[valid & (y > keyboard_ceiling)]).mean()) if np.any(valid & (y > keyboard_ceiling)) else None,
            'above90MAE': float(np.abs(prediction[valid & (y > high_angle)] - y[valid & (y > high_angle)]).mean()) if np.any(valid & (y > high_angle)) else None,
            'belowKeyboardMAE': float(np.abs(prediction[valid & (y <= keyboard_ceiling)] - y[valid & (y <= keyboard_ceiling)]).mean()) if np.any(valid & (y <= keyboard_ceiling)) else None}


def aggregate(rows):
    available = [r['metrics'] for r in rows if r.get('metrics', {}).get('mae') is not None]
    result = {'groups': len(available), 'skipped': len(rows) - len(available)}
    for key in ('mae', 'p95', 'within5', 'validCoverage', 'aboveKeyboardMAE', 'above90MAE', 'belowKeyboardMAE'):
        values = [m[key] for m in available if m.get(key) is not None]
        result[key] = float(np.mean(values)) if values else None
    result['worstGroupMAE'] = max((m['mae'] for m in available), default=None)
    return result


def promotion(candidate_rows, baseline_rows, settings):
    candidate = {r['groupId']: r for r in candidate_rows if r.get('metrics', {}).get('mae') is not None}
    baseline = {r['groupId']: r for r in baseline_rows if r.get('metrics', {}).get('mae') is not None}
    reasons = []
    if set(candidate) != set(baseline) or len(candidate) < settings['minGroups']:
        reasons.append('Insufficient identical eligible groups')
    for key in candidate.keys() & baseline.keys():
        if candidate[key].get('sampleIds') != baseline[key].get('sampleIds'):
            reasons.append('Evaluation samples differ: ' + key)
        if candidate[key]['metrics']['mae'] > baseline[key]['metrics']['mae'] + settings['maxGroupRegression'] + 1e-9:
            reasons.append('Group regression exceeds limit: ' + key)
    a, b = aggregate(candidate_rows), aggregate(baseline_rows)
    if b['aboveKeyboardMAE'] is None or b['above90MAE'] is None:
        reasons.append('Insufficient larger-angle evaluation coverage')
    if a['mae'] is None or b['mae'] is None or a['mae'] > b['mae'] * (1 - settings['relativeMAE']):
        reasons.append('Mean group MAE improvement below threshold')
    for key in ('p95', 'aboveKeyboardMAE', 'above90MAE'):
        if b[key] is not None and (a[key] is None or a[key] > b[key] + 1e-9):
            reasons.append('Worse or unavailable ' + key)
    for key in ('within5', 'validCoverage'):
        if b[key] is not None and (a[key] is None or a[key] < b[key] - 1e-9):
            reasons.append('Worse or unavailable ' + key)
    return {'passed': not reasons, 'reasons': sorted(set(reasons)), 'candidate': a, 'baseline': b}


def matrix(group, families):
    return np.concatenate([group['blocks'][family] for family in families], axis=1)


class ImageRegressor:
    def __init__(self, groups, candidate, config):
        self.candidate = candidate; self.config = config
        x = np.concatenate([matrix(g, candidate['families']) for g in groups]); y = np.concatenate([g['y'] for g in groups])
        weights = np.concatenate([np.full(len(g['y']), len(y) / len(groups) / len(g['y'])) for g in groups])
        mean = np.average(x, axis=0, weights=weights)
        scale = np.sqrt(np.average((x - mean) ** 2, axis=0, weights=weights))
        self.columns = np.flatnonzero(scale > config['scaleFloor'])
        # Keep one constant feature for a completely uniform training partition.
        if not len(self.columns):
            self.columns = np.array([0])
        self.mean = mean[self.columns]; self.scale = np.maximum(scale[self.columns], config['scaleFloor'])
        z = self.normalize(x); head = candidate['head']; kind = head['kind']
        if kind == 'ridge':
            self.model = Ridge(alpha=head['alpha'], solver='cholesky')
        else:
            constructor = ExtraTreesRegressor if kind == 'extra-trees' else RandomForestRegressor
            self.model = constructor(n_estimators=head['trees'], max_depth=head['depth'], min_samples_leaf=head['leaf'],
                                     max_features=float(head['fraction']), random_state=config['seed'], n_jobs=1)
        self.model.fit(z, y, sample_weight=weights); self.angle_range = [float(y.min()), float(y.max())]

    def normalize(self, x):
        return ((x[:, self.columns] - self.mean) / self.scale).astype(np.float32)

    def predict(self, group):
        return np.clip(self.model.predict(self.normalize(matrix(group, self.candidate['families']))), *self.angle_range)

    def descriptor(self, group):
        return self.normalize(matrix(group, self.candidate['families'])).astype(np.float64)

    def export(self):
        if self.candidate['head']['kind'] == 'ridge':
            predictor = {'kind': 'ridge', 'coefficients': self.model.coef_.tolist(), 'intercept': float(self.model.intercept_)}
        else:
            predictor = {'kind': 'forest', 'trees': export_trees(self.model, self.angle_range)}
        return {'version': 2, 'kind': 'image-angle-model', 'featureVersion': 2, 'candidate': self.candidate,
                'families': self.candidate['families'], 'angleRange': self.angle_range,
                'transform': {'columns': self.columns.tolist(), 'mean': self.mean.tolist(), 'scale': self.scale.tolist()},
                'predictor': predictor, 'provisional': True, 'validation': {'passed': False}}


def portable_predict(model, blocks):
    if model.get('kind') == 'scene-calibrated-model':
        raw, descriptor = portable_predict(model['baseModel'], blocks)
        return calibrated(raw, descriptor, model['calibrationFit'], model['angleRange']), descriptor
    if model['version'] == 1:
        z = ((np.asarray(blocks['legacy']) - model['normalization']['mean']) / model['normalization']['scale']).astype(np.float32)
        predictor = {'kind': 'forest', 'trees': model['trees']}
    elif model['version'] == 2:
        x = np.concatenate([blocks[name] for name in model['families']], axis=1)
        t = model['transform']; z = ((x[:, t['columns']] - t['mean']) / t['scale']).astype(np.float32)
        predictor = model['predictor']
    else:
        raise ValueError('Unsupported image predictor version')
    if not np.isfinite(z).all():
        raise ValueError('Invalid normalized features')
    if predictor['kind'] == 'ridge':
        prediction = z @ np.asarray(predictor['coefficients']) + predictor['intercept']
    elif predictor['kind'] == 'forest':
        predictions = []
        for tree in predictor['trees']:
            values = []
            for sample in z:
                index = 0
                for _ in range(len(tree)):
                    feature, threshold, left, right, value = tree[index]
                    if feature == -1:
                        values.append(value); break
                    index = int(left if sample[int(feature)] <= threshold else right)
                else:
                    raise ValueError('Invalid tree traversal')
            predictions.append(values)
        prediction = np.mean(predictions, axis=0)
    else:
        raise ValueError('Unknown image predictor kind')
    return np.clip(prediction, *model['angleRange']), z


def support_split(group, budget, repeat, config):
    # Predeclared angle coverage, ties vary by fixed seed. Never score references.
    hashes = np.asarray(group['hashes']); y = np.asarray(group['y'])
    if len(set(hashes)) < budget + config['calibrationMinQueries']:
        return None
    rng = np.random.default_rng(config['seed'] + repeat)
    order = rng.permutation(len(y)); chosen = []; used = set()
    for target in np.linspace(y.min(), y.max(), budget):
        candidates = [i for i in order if hashes[i] not in used]
        index = min(candidates, key=lambda i: abs(y[i] - target)); chosen.append(index); used.add(hashes[index])
    query = np.asarray([i for i in range(len(y)) if hashes[i] not in used], dtype=int)
    if len(query) < config['calibrationMinQueries']:
        return None
    return np.asarray(chosen, dtype=int), query


def kernel(a, b, width):
    distance = np.maximum(0, np.sum(a * a, axis=1)[:, None] + np.sum(b * b, axis=1)[None, :] - 2 * a @ b.T) / max(1, a.shape[1])
    return np.exp(-distance / (2 * width * width))


def affine_fit(raw, y, settings):
    # Same equal-angle-bin, robust, regularized fit as the existing SessionAdapter.
    bins = {}
    for z, angle in zip(raw, y):
        bins.setdefault(int(np.floor(angle / settings['binDegrees'])), []).append((z, angle))
    points = np.asarray([np.median(v, axis=0) for v in bins.values()])
    z, y = points.T; center = np.median(z); a = 1.; b = np.median(y - z)
    affine = len(points) >= settings['minBins'] and np.ptp(y) >= settings['minAngleSpan'] and np.ptp(z) >= settings['minPredictionSpan']
    for _ in range(settings['fitIterations']):
        w = np.minimum(1., settings['huberDegrees'] / np.maximum(np.abs(a * z + b - y), 1e-12)); x = z - center
        sw = w.sum(); sx = w @ x; sy = w @ y; sxx = settings['ridge'] + w @ (x*x); sxy = settings['ridge'] + w @ (x*y)
        if affine:
            determinant = sxx * sw - sx * sx
            if determinant <= 1e-9:
                return {'kind': 'affine', 'a': 1., 'b': float(np.median(y-z))}
            a = (sxy * sw - sx * sy) / determinant; b = (sy-a*sx) / sw-a*center
        else:
            b = np.sum(w * (y-z)) / sw
    if not np.isfinite(a+b) or not settings['minAbsScale'] <= abs(a) <= settings['maxAbsScale']:
        a, b = 1., np.median(y-z)
    return {'kind': 'affine', 'a': float(a), 'b': float(b)}


def fit_calibration(raw, descriptor, labels, candidate, settings):
    if candidate['kind'] == 'affine':
        return affine_fit(raw, labels, settings)
    if candidate['kind'] != 'residual':
        raise ValueError('Unknown scene calibration')
    k = kernel(descriptor, descriptor, candidate['width'])
    coefficients = np.linalg.solve(k + candidate['alpha'] * np.eye(len(k)), labels - raw)
    return {**candidate, 'references': descriptor.tolist(), 'coefficients': coefficients.tolist()}


def calibrated(raw, descriptor, fit, angle_range):
    if fit['kind'] == 'affine':
        result = raw * fit['a'] + fit['b']
    else:
        result = raw + kernel(descriptor, np.asarray(fit['references']), fit['width']) @ fit['coefficients']
    return np.clip(result, *angle_range)
