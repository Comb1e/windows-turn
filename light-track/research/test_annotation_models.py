import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
from sklearn.ensemble import ExtraTreesRegressor

from annotation_models import AnnotationModelSelector, FittedForest, exclude_group, feature_indices
from model_training import ROOT, feature_names, smooth
from train_annotations import fit_model


class AnnotationModelTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / 'config.json').read_text(encoding='utf-8'))
        self.config['annotation']['training']['treeCount'] = 8
        self.names = feature_names(self.config['features'])
        self.columns = feature_indices(self.names, 'chromaticity')

    def groups(self, count=4):
        rng = np.random.default_rng(12)
        groups = []
        for i in range(count):
            y = np.linspace(12, 120, 18 + i)
            x = rng.uniform(-2, 2, (len(y), len(self.names))) + i * 2
            x[:, self.columns] = y[:, None] / 200 + rng.normal(0, .005, (len(y), len(self.columns)))
            ids = [f'{i}-{j}' for j in range(len(y))]
            groups.append({'groupId': str(i), 'metadata': {'device': 'test', 'lighting': 'same lamps'},
                           'capture': {'width': 16, 'height': 12, 'horizontalFovDegrees': 60},
                           'x': x, 'y': y, 'sampleIds': ids, 'hashes': ids, 'sources': ['manual'] * len(y)})
        return groups

    def test_sparse_and_disabled_selection_retain_original_predictions_and_group_weights(self):
        groups = self.groups(2)
        for enabled in (True, False):
            self.config['annotation']['training']['selection']['enabled'] = enabled
            selector = AnnotationModelSelector(self.config)
            candidate, report = selector.select(groups)
            self.assertEqual(candidate, selector.baseline)
            self.assertEqual(report['candidates'], [])
            fitted = selector.fit(groups, candidate)
            x = np.concatenate([g['x'] for g in groups]); y = np.concatenate([g['y'] for g in groups])
            weights = np.concatenate([np.full(len(g['y']), 1 / len(g['y'])) for g in groups])
            original = ExtraTreesRegressor(n_estimators=8, max_depth=10, min_samples_leaf=1, random_state=42, n_jobs=1)
            original.fit(fitted.normalize(x), y, sample_weight=weights)
            np.testing.assert_allclose(fitted.predict(x), original.predict(fitted.normalize(x)), atol=1e-12)
            np.testing.assert_allclose(fitted.mean, np.mean([g['x'].mean(axis=0) for g in groups], axis=0))

    def test_node_json_integer_spelling_keeps_feature_fraction_semantics(self):
        groups = self.groups(3)
        candidate = copy.deepcopy(self.config['annotation']['training']['selection']['candidates'][0])
        expected = FittedForest(groups[:2], candidate, self.config).predict(groups[2]['x'])
        # JSON.stringify in page training writes 1.0 as 1. Scikit-learn treats
        # integer 1 as one feature, but float 1.0 as every feature.
        candidate['maxFeatures'] = 1
        fitted = FittedForest(groups[:2], candidate, self.config)
        self.assertIs(type(fitted.parameters['max_features']), float)
        np.testing.assert_array_equal(fitted.predict(groups[2]['x']), expected)

    def test_color_features_improve_transfer_without_changing_feature_schema(self):
        groups = self.groups()
        model, report, _ = fit_model(groups, self.config)
        before = report['comparison']['baseline']['meanGroupMAE']
        after = report['comparison']['selectedProcedure']['meanGroupMAE']
        self.assertLess(after, before * .8)
        self.assertEqual(model['featureVersion'], 1)
        self.assertEqual(model['featureNames'], self.names)
        self.assertEqual(model['coverage']['screenshots'], sum(len(g['y']) for g in groups))
        self.assertFalse(model['validation']['passed'])

    def test_outer_test_data_cannot_change_inner_selection(self):
        groups = self.groups()
        _, first, _ = fit_model(groups, self.config)
        changed = copy.deepcopy(groups)
        changed[0]['x'] += 10000
        changed[0]['y'] += 70
        _, second, _ = fit_model(changed, self.config)
        a, b = first['excludedGroupDiagnostics'][0], second['excludedGroupDiagnostics'][0]
        self.assertEqual(a['selection'], b['selection'])
        for score in a['selection']['candidates']:
            for fold in score['folds']:
                self.assertNotEqual(fold['groupId'], '0')
                self.assertNotIn('0', fold['trainingGroups'])

    def test_duplicate_purge_keeps_nested_row_identities_aligned(self):
        groups = self.groups()
        groups[1]['hashes'] = list(groups[1]['hashes'])
        groups[1]['hashes'][0] = groups[0]['hashes'][0]
        partition = exclude_group(groups, groups[0])
        for group in partition:
            self.assertTrue(set(group['hashes']).isdisjoint(groups[0]['hashes']))
            for key in ('x', 'y', 'hashes', 'sampleIds', 'sources'):
                self.assertEqual(len(group[key]), len(group['y']))
        self.assertEqual(partition[0]['sampleIds'][0], groups[1]['sampleIds'][1])
        np.testing.assert_array_equal(partition[0]['y'], groups[1]['y'][1:])
        for held in partition:
            for group in exclude_group(partition, held):
                self.assertTrue(set(group['hashes']).isdisjoint(held['hashes']))

    def test_tuning_fold_limit_never_drops_final_data_or_outer_diagnostics(self):
        groups = self.groups(4)
        self.config['annotation']['training']['selection']['maxFolds'] = 3
        model, report, _ = fit_model(groups, self.config)
        self.assertEqual(len(report['excludedGroupDiagnostics']), 4)
        self.assertEqual(model['coverage']['sessions'], 4)
        self.assertTrue(all(len(s['folds']) == 3 for s in report['modelSelection']['candidates']))

    def test_both_forest_types_compile_subset_splits_with_browser_parity(self):
        groups = self.groups()
        model, _, _ = fit_model(groups[:1], self.config)
        rng = np.random.default_rng(31)
        # Include held data and perturbed, unseen feature vectors, not only leaves
        # occupied by training samples. Wrong subset indices must change outputs.
        probe = np.concatenate([groups[-1]['x'], groups[-1]['x'] + rng.normal(0, .01, groups[-1]['x'].shape)])
        for candidate in self.config['annotation']['training']['selection']['candidates']:
            fitted = FittedForest(groups[:-1], candidate, self.config)
            model.update(normalization={'mean': fitted.mean.tolist(), 'scale': fitted.scale.tolist()},
                         trees=fitted.export(model['angleRange']))
            self.assertTrue(all(node[0] in fitted.columns for tree in model['trees'] for node in tree if node[0] != -1))
            prediction = fitted.predict(probe); times = np.arange(len(probe)) * 100.
            parity = {'features': probe.tolist(), 'predictions': prediction.tolist(),
                      'filter': {'values': prediction.tolist(), 'timestamps': times.tolist(),
                                 'outputs': smooth(prediction, times, self.config['filter']).tolist()}}
            with tempfile.TemporaryDirectory() as directory:
                paths = [Path(directory) / name for name in ('model.json', 'parity.json')]
                for path, value in zip(paths, (model, parity)):
                    path.write_text(json.dumps(value, allow_nan=False), encoding='utf-8')
                result = subprocess.run(['node', str(ROOT / 'research/check-parity.mjs'), *map(str, paths)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_settings_and_insufficient_unique_groups_fail_or_fall_back(self):
        for key, value in [('minGroups', 1), ('maxFolds', 0), ('minRelativeImprovement', float('nan'))]:
            config = copy.deepcopy(self.config)
            config['annotation']['training']['selection'][key] = value
            with self.assertRaisesRegex(ValueError, 'selection'):
                AnnotationModelSelector(config)
        groups = self.groups(3)
        for group in groups:
            group['hashes'] = ['same-image'] * len(group['y'])
        selector = AnnotationModelSelector(self.config)
        selected, report = selector.select(groups)
        self.assertEqual(selected, selector.baseline)
        self.assertTrue(all(score['evaluatedGroups'] == 0 for score in report['candidates']))


if __name__ == '__main__':
    unittest.main()
