"""Shared photo-model schema, export, label validation, and metrics. No collection CLI."""
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]

def keyboard_label_validation(data, config=None, *, range_mode='model'):
    """Photo labels use the exact supported range returned by Keyboard."""
    if range_mode != 'model':
        raise ValueError('Only photo annotations with recorded keyboard metadata are supported')
    model = data.get('keyboardModel')
    bounds = model.get('angleRange') if isinstance(model, dict) else None
    if (not isinstance(model, dict) or not isinstance(model.get('modelId'), str) or not model['modelId'].strip()
            or not isinstance(bounds, list) or len(bounds) != 2
            or any(type(v) not in (int, float) or not np.isfinite(v) for v in bounds)
            or bounds[0] >= bounds[1]):
        raise ValueError('Invalid recorded keyboard model identity or angle range')
    return {'modelId': model['modelId'], 'angleRange': bounds, 'validationRange': list(bounds),
            'rangeSource': 'keyboard-service'}


def feature_names(config):
    names = ['mean', 'p10', 'p50', 'p90', 'contrast', 'saturation', 'red', 'green', 'blue', 'dark', 'clipped', 'red_ratio', 'green_ratio', 'blue_ratio']
    for i in range(config['columns'] * config['rows']):
        names += [f'cell{i}_{c}' for c in ['luma', 'relative', 'red', 'green', 'blue', 'saturation', 'red_ratio', 'green_ratio', 'blue_ratio']]
    names += ['bright_count', 'bright_area', 'bright_intensity', 'bright_x', 'bright_y']
    names += [f'bright_cell{i}' for i in range(config['columns'] * config['rows'])]
    return names


def validate_keyboard_angle(angle, binding, frame_id):
    low, high = binding['validationRange']
    if type(angle) not in (int, float) or not np.isfinite(angle) or not low <= angle <= high:
        raise ValueError(f'Keyboard label {angle!r} at frame {frame_id} outside accepted range '
                         f'{low:g}–{high:g} degrees ({binding["rangeSource"]})')


def smooth(values, timestamps, settings):
    result = []
    previous_t = previous_raw = value = None
    derivative = 0.
    for raw, timestamp in zip(values, timestamps):
        dt = None if previous_t is None else (timestamp-previous_t)/1000
        if dt is not None and dt <= 0:
            result.append(value)
            continue
        if dt is None or dt > settings['resetGapSeconds']:
            value, derivative = float(raw), 0.
        else:
            alpha = lambda cutoff: 1/(1+1/(2*np.pi*cutoff*dt))
            ad = alpha(settings['derivativeCutoff'])
            derivative = ad*(raw-previous_raw)/dt + (1-ad)*derivative
            a = alpha(settings['minCutoff']+settings['beta']*abs(derivative))
            value = a*raw+(1-a)*value
        previous_t, previous_raw = timestamp, raw
        result.append(value)
    return np.asarray(result)


def metrics(y, prediction):
    if not len(y):
        return {'count': 0, 'medianError': None, 'p95Error': None, 'within5': None}
    errors = np.abs(y-prediction)
    return {'count': len(y), 'medianError': float(np.median(errors)), 'p95Error': float(np.quantile(errors, .95)), 'within5': float(np.mean(errors <= 5))}


def export_trees(forest, angle_range):
    low, high = angle_range

    def value(raw):
        number = float(raw)
        bounded = min(high, max(low, number))
        # Weighted averages may exceed an endpoint by a few floating-point bits.
        # Repair only roundoff in exported predictions, never calibration labels.
        if not np.isfinite(number) or not np.isclose(number, bounded, rtol=1e-12, atol=0):
            raise ValueError('Tree prediction outside the model operating range')
        return bounded

    trees = []
    for estimator in forest.estimators_:
        t = estimator.tree_
        trees.append([[int(t.feature[i]) if t.children_left[i] != -1 else -1, float(t.threshold[i]),
                       int(t.children_left[i]), int(t.children_right[i]), value(t.value[i, 0, 0])] for i in range(t.node_count)])
    return trees
