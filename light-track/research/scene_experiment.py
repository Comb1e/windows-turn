"""Reproducible nested feature/calibration ablations. Never publishes live models."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import platform
import time
import hashlib

import cv2
import numpy as np
import sklearn
from threadpoolctl import threadpool_limits

from annotation_models import AnnotationModelSelector
from train_annotations import load_groups
from scene_features import ROOT, CONFIG_PATH, ImageFeatures, read_rgb, signature, digest_file
from scene_models import ImageRegressor, matrix, scores, aggregate, promotion, support_split, fit_calibration, calibrated


def subset(group, indices):
    result = dict(group)
    for key in ('x', 'y', 'sampleIds', 'hashes', 'sources'):
        result[key] = np.asarray(group[key])[indices]
    result['blocks'] = {key: value[indices] for key, value in group['blocks'].items()}
    return result


def partition(groups, held):
    ids = {g['groupId'] for g in held}; hashes = {h for g in held for h in g['hashes']}
    output = []
    for group in groups:
        if group['groupId'] in ids:
            continue
        keep = np.asarray([i for i, h in enumerate(group['hashes']) if h not in hashes], dtype=int)
        if len(keep):
            output.append(subset(group, keep))
    return output


def folds(groups, protocol):
    if protocol == 'group':
        return [[g] for g in groups]
    names = sorted({g['metadata']['lighting'].strip().casefold() for g in groups})
    return [[g for g in groups if g['metadata']['lighting'].strip().casefold() == name] for name in names]


def load_features(directory, app_config, config, backend, families):
    groups, skipped, fingerprints = load_groups(directory, app_config)
    extractor = ImageFeatures(config, backend=backend); metadata = {}; failures = {}; timings = {}
    available = []
    for family in families:
        try:
            metadata[family] = extractor.manifest(family)
            if family in ('dino', 'depth'):
                extractor.model(family)
            available.append(family)
        except (ImportError, ValueError, RuntimeError) as error:
            failures[family] = str(error)
    for group in groups:
        manifest = json.loads((directory / group['groupId'] / 'group.json').read_text())
        samples = {s['sampleId']: s for s in manifest['samples']}; blocks = {f: [] for f in available}
        print('Extracting', group['groupId'], len(group['y']), 'images', flush=True)
        for sample_id in group['sampleIds']:
            sample = samples[sample_id]; rgb = read_rgb(directory / group['groupId'] / sample['image'])
            for family in available:
                start = time.perf_counter()
                blocks[family].append(extractor.cached(rgb, family, sample['imageSha256'], sample.get('camera', {}), ROOT / config['cacheDirectory']))
                timings.setdefault(family, []).append((time.perf_counter() - start) * 1000)
        group['blocks'] = {'legacy': group['x'], **{f: np.asarray(v) for f, v in blocks.items()}}
    return groups, {'sources': fingerprints, 'skippedGroups': skipped, 'extractors': metadata, 'unavailable': failures,
                    'cacheReadOrExtractMs': {f: float(np.sum(v)) for f, v in timings.items()}}, extractor


class Baseline:
    def __init__(self, groups, candidate, app_config):
        selector = AnnotationModelSelector(app_config)
        chosen = selector.baseline if candidate['id'] == 'legacy' else selector.select(groups)[0]
        self.fit = selector.fit(groups, chosen); self.candidate = candidate
        y = np.concatenate([g['y'] for g in groups]); self.angle_range = [float(y.min()), float(y.max())]
    def predict(self, group):
        return self.fit.predict(group['x'])
    def descriptor(self, group):
        return self.fit.normalize(group['x']).astype(np.float64)


class Experiment:
    def __init__(self, groups, app_config, config):
        self.groups = groups; self.app_config = app_config; self.config = config; self.cache = {}; self.validation = {}
        self.candidates = []
        available = set(groups[0]['blocks'])
        for families in config['featureSets']:
            if not set(families) <= available:
                continue
            for index, head in enumerate(config['heads']):
                self.candidates.append({'id': '+'.join(families) + ':' + str(index), 'families': families, 'head': head})
        self.baselines = [{'id': name} for name in ('legacy', 'current')]

    def key(self, groups):
        return tuple((g['groupId'], tuple(g['sampleIds'])) for g in groups)

    def fit(self, groups, candidate):
        key = (self.key(groups), candidate['id'])
        if key not in self.cache:
            self.cache[key] = (Baseline(groups, candidate, self.app_config) if candidate['id'] in ('legacy', 'current')
                               else ImageRegressor(groups, candidate, self.config))
        return self.cache[key]

    def evaluate(self, groups, candidate):
        key = (self.key(groups), candidate['id'])
        if key not in self.validation:
            rows = []
            for held in groups:
                train = partition(groups, [held])
                if train:
                    rows.append({'metrics': scores(held['y'], self.fit(train, candidate).predict(held))})
            self.validation[key] = aggregate(rows)['mae']
        return self.validation[key]

    def select(self, groups, candidates):
        if len(groups) < 2:
            return candidates[0]
        values = [(self.evaluate(groups, c), c) for c in candidates]
        eligible = [(value, c) for value, c in values if value is not None]
        return min(eligible, key=lambda pair: (pair[0], pair[1]['id']))[1] if eligible else candidates[0]

    def rows(self, protocol):
        result = {c['id']: [] for c in self.baselines}
        sets = sorted({tuple(c['families']) for c in self.candidates})
        methods = {'+'.join(f): [c for c in self.candidates if tuple(c['families']) == f] for f in sets}
        methods['selected-procedure'] = self.candidates
        result.update({name: [] for name in methods}); choices = {}
        for held in folds(self.groups, protocol):
            train = partition(self.groups, held)
            print(protocol, 'holdout', ','.join(g['groupId'][:8] for g in held), flush=True)
            if not train:
                continue
            selected = {**{c['id']: c for c in self.baselines}, **{name: self.select(train, candidates) for name, candidates in methods.items()}}
            choices[held[0]['groupId']] = {'trainingGroups': [g['groupId'] for g in train], 'selected': selected}
            for method, candidate in selected.items():
                fitted = self.fit(train, candidate)
                for group in held:
                    prediction = fitted.predict(group)
                    result[method].append({'groupId': group['groupId'], 'sampleIds': list(group['sampleIds']),
                                           'trainingGroups': [g['groupId'] for g in train], 'selected': candidate,
                                           'angles': group['y'].tolist(), 'predictions': prediction.tolist(),
                                           'metrics': scores(group['y'], prediction)})
        return result, choices

    def calibration_candidates(self):
        return [{'kind': 'affine'}] + [{'kind': 'residual', 'alpha': a, 'width': w}
                                     for a in self.config['calibrationAlphas'] for w in self.config['calibrationWidths']]

    def calibrate_group(self, fitted, group, budget, candidate):
        raw = fitted.predict(group); descriptor = fitted.descriptor(group)
        all_y, all_prediction, ids, references = [], [], [], []
        for repeat in range(self.config['calibrationRepeats']):
            split = support_split(group, budget, repeat, self.config)
            if split is None:
                return None
            support, query = split
            fit = fit_calibration(raw[support], descriptor[support], group['y'][support], candidate, self.app_config['sceneAdapter'])
            bounds = [min(fitted.angle_range[0], float(group['y'][support].min())), max(fitted.angle_range[1], float(group['y'][support].max()))]
            prediction = calibrated(raw[query], descriptor[query], fit, bounds)
            all_y.extend(group['y'][query]); all_prediction.extend(prediction)
            ids.extend(f'{repeat}:{group["sampleIds"][i]}' for i in query)
            references.append([group['sampleIds'][i] for i in support])
        return {'groupId': group['groupId'], 'sampleIds': ids, 'referenceIds': references,
                'angles': list(map(float, all_y)), 'predictions': list(map(float, all_prediction)),
                'metrics': scores(all_y, all_prediction)}

    def select_calibration(self, train, base_candidate, budget):
        results = []
        for candidate in self.calibration_candidates():
            rows = []
            for held in train:
                fitting = partition(train, [held])
                if fitting:
                    row = self.calibrate_group(self.fit(fitting, base_candidate), held, budget, candidate)
                    if row:
                        rows.append(row)
            score = aggregate(rows)
            results.append({'candidate': candidate, 'metrics': score})
        eligible = [r for r in results if r['metrics']['groups'] >= 2]
        chosen = min(eligible, key=lambda r: r['metrics']['mae'])['candidate'] if eligible else {'kind': 'affine'}
        return chosen, results

    def calibration_rows(self, protocol, choices):
        results = {}
        for budget in self.config['calibrationBudgets']:
            output = {'current-affine': [], 'current-selected-calibration': [], 'selected-procedure-calibrated': [], 'skipped': []}
            for held in folds(self.groups, protocol):
                train = partition(self.groups, held)
                if not train:
                    continue
                current = {'id': 'current'}; selected = choices[held[0]['groupId']]['selected']['selected-procedure']
                current_cal, _ = self.select_calibration(train, current, budget)
                selected_cal, _ = self.select_calibration(train, selected, budget)
                for name, base, calibration in [('current-affine', current, {'kind': 'affine'}),
                                                ('current-selected-calibration', current, current_cal),
                                                ('selected-procedure-calibrated', selected, selected_cal)]:
                    fitted = self.fit(train, base)
                    for group in held:
                        row = self.calibrate_group(fitted, group, budget, calibration)
                        if row:
                            output[name].append({**row, 'baseCandidate': base, 'calibration': calibration,
                                                 'trainingGroups': [g['groupId'] for g in train]})
                        elif name == 'current-affine':
                            output['skipped'].append({'groupId': group['groupId'], 'reason': f'Need {budget} distinct references plus {self.config["calibrationMinQueries"]} disjoint queries'})
            output['summaries'] = {name: aggregate(rows) for name, rows in output.items() if name != 'skipped'}
            output['promotion'] = {name: promotion(output[name], output['current-affine'], self.config['promotion'])
                                   for name in ('current-selected-calibration', 'selected-procedure-calibrated')}
            results[str(budget)] = output
            print(protocol, 'calibration', budget, {k: round(v['mae'], 3) if v['mae'] is not None else None for k, v in output['summaries'].items()}, flush=True)
        return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--config', type=Path, default=CONFIG_PATH)
    parser.add_argument('--app-config', type=Path, default=ROOT / 'config.json')
    parser.add_argument('--backend', choices=['cpu', 'cuda'], default='cpu')
    parser.add_argument('--families', nargs='+', default=['lighting', 'texture', 'metadata', 'dino', 'depth'])
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('Output exists; use a new experiment directory')
    args.output.mkdir(parents=True)
    config = json.loads(args.config.read_text()); app = json.loads(args.app_config.read_text())
    app['sceneAdapter'] = json.loads((ROOT / 'service-config.json').read_text())['adaptation']
    started = time.perf_counter()
    with threadpool_limits(limits=4):
        groups, provenance, extractor = load_features(args.directory, app, config, args.backend, args.families)
        exp = Experiment(groups, app, config)
        report = {'version': 1, 'kind': 'scene-feature-evaluation', 'createdAt': datetime.now(timezone.utc).isoformat(),
                  'config': config, 'provenance': provenance, 'backend': args.backend,
                  'software': {'python': platform.python_version(), 'numpy': np.__version__, 'sklearn': sklearn.__version__, 'opencv': cv2.__version__},
                  'independentValidationAvailable': False, 'protocols': {}, 'featureDimensions': {f: x.shape[1] for f, x in groups[0]['blocks'].items()}}
        report['implementationHashes']={p.name:digest_file(p) for p in [Path(__file__),Path(__file__).with_name('scene_features.py'),Path(__file__).with_name('scene_models.py')]}
        for protocol in ('group', 'lighting-description'):
            rows, choices = exp.rows(protocol)
            entry = {'rows': rows, 'summaries': {name: aggregate(r) for name, r in rows.items()},
                     'promotion': promotion(rows['selected-procedure'], rows['current'], config['promotion']), 'choices': choices}
            entry['calibration'] = exp.calibration_rows(protocol, choices)
            report['protocols'][protocol] = entry
            (args.output / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False))
        selected = exp.select(groups, exp.candidates); fitted = exp.fit(groups, selected)
        model = fitted.export()
        model.update(featureConfig=config, extractors={f: extractor.manifest(f) for f in selected['families'] if f != 'legacy'},
                     capture=groups[0]['capture'], sourceGroups=provenance['sources'], filter=app['filter'],
                     modelId=signature({'candidate': selected, 'sources': provenance['sources'], 'featureConfig': config}),
                     calibration={'residual95': report['protocols']['group']['summaries']['selected-procedure']['p95']})
        report['selectedCandidate'] = selected
        model['coverage'] = {'device':groups[0]['metadata']['device'],'sessions':len(groups),
                             'screenshots':sum(len(g['y']) for g in groups),'trainingAngleRange':model['angleRange'],
                             'labelSources':{source:sum(list(g['sources']).count(source) for g in groups) for source in ('manual','keyboard')}}
        report['promotionPassed'] = all(p['promotion']['passed'] for p in report['protocols'].values())
        report['elapsedSeconds'] = time.perf_counter() - started
        for source in provenance['sources']:
            if digest_file(args.directory / source['groupId'] / 'group.json') != source['sha256']:
                raise ValueError('Annotations changed during evaluation; results not publishable')
        model['promotionPassed'] = report['promotionPassed']
        from scene_models import portable_predict
        parity_blocks={f:np.concatenate([g['blocks'][f] for g in groups]) for f in selected['families']}
        exported,_=portable_predict(model,parity_blocks)
        expected=np.concatenate([fitted.predict(g) for g in groups])
        if not np.allclose(exported,expected,atol=1e-4,rtol=0):
            raise ValueError('Exported predictor parity failed')
        report['exportParityMaxError']=float(np.max(np.abs(exported-expected)))
        (args.output / 'candidate-model.json').write_text(json.dumps(model, allow_nan=False))
        (args.output / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False))
        print(json.dumps({'selected': selected, 'promotionPassed': report['promotionPassed'], 'elapsedSeconds': report['elapsedSeconds'],
                          'metrics': {k: v['summaries']['selected-procedure'] for k, v in report['protocols'].items()}}, indent=2), flush=True)


if __name__ == '__main__':
    main()
