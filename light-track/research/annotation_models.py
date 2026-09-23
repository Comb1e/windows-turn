"""Group-balanced, portable forest selection for existing screenshot features.

Selection holds out complete groups. Diagnostics repeat selection inside each
outer training partition; neither normalization nor tuning sees its test group.
"""
import numpy as np
from sklearn.ensemble import ExtraTreesRegressor, RandomForestRegressor

from model_training import export_trees, feature_names, metrics


def diagnostic_metrics(y, prediction):
    return {**metrics(y, prediction), 'meanAbsoluteError': float(np.mean(np.abs(y - prediction)))}


def feature_indices(names, feature_set):
    if feature_set == 'all':
        return np.arange(len(names))
    if feature_set not in ('chromaticity', 'relative-color'):
        raise ValueError(f'Unknown annotation feature set: {feature_set}')
    return np.asarray([i for i, name in enumerate(names)
                       if name.endswith('_ratio') or (feature_set == 'relative-color' and name.endswith('_relative'))])


def subset_group(group, keep):
    """Keep all row identities aligned when removing duplicate pixels."""
    return {**group, **{key: np.asarray(group[key])[keep] for key in ('x', 'y', 'hashes', 'sampleIds', 'sources') if key in group}}


def exclude_group(groups, held):
    held_hashes = set(held['hashes'])
    partition = []
    for group in groups:
        if group['groupId'] == held['groupId']:
            continue
        keep = np.asarray([digest not in held_hashes for digest in group['hashes']], dtype=bool)
        if keep.any():
            partition.append(subset_group(group, keep))
    return partition


def summarize_diagnostics(rows):
    valid = [row['metrics'] for row in rows if row.get('metrics') is not None]
    return {'evaluatedGroups': len(valid), 'skippedGroups': len(rows) - len(valid),
            'meanGroupMAE': float(np.mean([m['meanAbsoluteError'] for m in valid])) if valid else None,
            'meanGroupP95': float(np.mean([m['p95Error'] for m in valid])) if valid else None,
            'meanGroupWithin5': float(np.mean([m['within5'] for m in valid])) if valid else None}


class FittedForest:
    def __init__(self, groups, candidate, config):
        self.candidate = candidate
        self.columns = feature_indices(feature_names(config['features']), candidate['featureSet'])
        x = np.concatenate([g['x'] for g in groups]); y = np.concatenate([g['y'] for g in groups])
        # Every group retains equal total weight, including short manual sessions.
        weights = np.concatenate([np.full(len(g['y']), 1 / len(g['y'])) for g in groups])
        self.mean = np.average(x, weights=weights, axis=0)
        self.scale = np.maximum(np.sqrt(np.average((x - self.mean) ** 2, weights=weights, axis=0)), config['training']['scaleFloor'])
        settings = config['annotation']['training']
        self.parameters = dict(n_estimators=settings['treeCount'], max_depth=settings['maxDepth'],
                               min_samples_leaf=candidate['minSamplesLeaf'], max_features=float(candidate['maxFeatures']),
                               random_state=config['training']['seed'], n_jobs=settings.get('workers', 1))
        estimator = ExtraTreesRegressor if candidate['estimator'] == 'extra-trees' else RandomForestRegressor
        self.forest = estimator(**self.parameters).fit(self.normalize(x)[:, self.columns], y, sample_weight=weights)

    def normalize(self, x):
        return ((x - self.mean) / self.scale).astype(np.float32)

    def predict(self, x):
        return self.forest.predict(self.normalize(x)[:, self.columns])

    def spread(self, x):
        z = self.normalize(x)[:, self.columns]
        return np.std([tree.predict(z) for tree in self.forest.estimators_], axis=0)

    def export(self, angle_range):
        trees = export_trees(self.forest, angle_range)
        # Compile each chosen column back to the original v1 feature position.
        # Existing browsers and all historical models keep the same interface.
        for tree in trees:
            for node in tree:
                if node[0] != -1:
                    node[0] = int(self.columns[node[0]])
        return trees


class AnnotationModelSelector:
    def __init__(self, config):
        self.config = config
        settings = config['annotation']['training']
        self.settings = settings.get('selection', {'enabled': False})
        self.baseline = {'id': 'legacy-extra-trees', 'estimator': 'extra-trees', 'featureSet': 'all',
                         'minSamplesLeaf': settings['minSamplesLeaf'], 'maxFeatures': 1.0}
        self.candidates = [self.baseline] + (self.settings.get('candidates', []) if self.settings['enabled'] else [])
        if (type(settings['treeCount']) is not int or not 1 <= settings['treeCount'] <= 256
                or type(settings['maxDepth']) is not int or not 1 <= settings['maxDepth'] <= 12):
            raise ValueError('Annotation forests require 1–256 trees and a maximum depth of 1–12')
        if len(self.candidates) > 12 or len({c['id'] for c in self.candidates}) != len(self.candidates):
            raise ValueError('Annotation selection needs unique candidate IDs and at most 12 candidates')
        for candidate in self.candidates:
            if (not isinstance(candidate['id'], str) or not candidate['id']
                    or candidate['estimator'] not in ('extra-trees', 'random-forest')
                    or type(candidate['minSamplesLeaf']) is not int or candidate['minSamplesLeaf'] < 1
                    or type(candidate['maxFeatures']) not in (int, float) or not 0 < candidate['maxFeatures'] <= 1):
                raise ValueError('Invalid annotation forest candidate')
            feature_indices(feature_names(config['features']), candidate['featureSet'])
        if self.settings['enabled'] and (
                type(self.settings.get('minGroups')) is not int or self.settings['minGroups'] < 3
                or type(self.settings.get('maxFolds')) is not int or self.settings['maxFolds'] < 3
                or type(self.settings.get('minRelativeImprovement')) not in (int, float)
                or not 0 <= self.settings['minRelativeImprovement'] < 1):
            raise ValueError('Invalid annotation selection group limits or improvement threshold')
        self.cache = {}

    def fit(self, groups, candidate):
        return FittedForest(groups, candidate, self.config)

    def evaluate(self, groups, candidate):
        rows = []
        # Bound tuning cost while preserving complete groups. The outer
        # diagnostic still evaluates every group; the final fit uses all rows.
        folds = groups
        limit = self.settings.get('maxFolds', len(groups))
        if len(folds) > limit:
            indices = np.linspace(0, len(groups) - 1, limit, dtype=int)
            folds = [groups[i] for i in indices]
        for held in folds:
            partition = exclude_group(groups, held)
            key = (candidate['id'], tuple((g['groupId'], tuple(g['sampleIds'])) for g in partition),
                   held['groupId'], tuple(held['sampleIds']))
            if key not in self.cache:
                self.cache[key] = diagnostic_metrics(held['y'], self.fit(partition, candidate).predict(held['x'])) if partition else None
            rows.append({'groupId': held['groupId'], 'trainingGroups': [g['groupId'] for g in partition], 'metrics': self.cache[key]})
        return {'candidate': candidate, **summarize_diagnostics(rows), 'folds': rows}

    def select(self, groups):
        reason = None
        if not self.settings['enabled']:
            reason = 'Model selection disabled; original trainer retained'
        elif len(groups) < self.settings['minGroups']:
            reason = 'Too few groups for model selection; original trainer retained'
        if reason:
            return self.baseline, {'selectedCandidate': self.baseline, 'reason': reason, 'candidates': []}
        scores = [self.evaluate(groups, candidate) for candidate in self.candidates]
        eligible = [score for score in scores if score['evaluatedGroups'] >= self.settings['minGroups']]
        winner = min(eligible, key=lambda score: score['meanGroupMAE']) if eligible else scores[0]
        baseline_score = scores[0]['meanGroupMAE']
        if (not eligible or baseline_score is None or baseline_score <= 0
                or winner['meanGroupMAE'] >= baseline_score * (1 - self.settings['minRelativeImprovement'])):
            winner = scores[0]
            reason = 'Insufficient group evidence or improvement; original trainer retained'
        else:
            reason = 'Lowest mean group MAE with the configured improvement over the original trainer'
        return winner['candidate'], {'selectedCandidate': winner['candidate'], 'reason': reason,
                                     'objective': 'meanGroupMAE', 'candidates': scores,
                                     'scope': 'Tuning scores, not independent validation'}
