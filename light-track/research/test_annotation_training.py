import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

import cv2
import numpy as np

from model_training import ROOT, feature_names
from train_annotations import fit_model, load_groups

CONFIG = json.loads((ROOT / 'config.json').read_text(encoding='utf-8'))


class AnnotationTrainingTests(unittest.TestCase):
    def setUp(self):
        self.config = copy.deepcopy(CONFIG)
        self.config['annotation']['training']['treeCount'] = 4

    def group(self, name, angles, lighting='same lamps'):
        n = len(feature_names(self.config['features']))
        return {'groupId': name, 'metadata': {'device': 'laptop', 'lighting': lighting},
                'capture': {'width': 16, 'height': 12, 'horizontalFovDegrees': 60},
                'x': np.asarray([np.full(n, (a + 1) / 200) for a in angles]), 'y': np.asarray(angles),
                'sampleIds': [f'{name}-{i}' for i in range(len(angles))], 'hashes': [f'{name}-{i}' for i in range(len(angles))]}

    def test_sparse_arbitrary_angles_and_single_image_train_without_inventing_validation(self):
        for angles in [[37.5], [0, 43.25, 145.2]]:
            model, report, parity = fit_model([self.group('one', angles)], self.config)
            self.assertEqual(model['angleRange'], [min(angles), max(angles)])
            self.assertEqual(report['excludedGroupDiagnostics'], [])
            self.assertFalse(model['validation']['passed'])
            self.assertFalse(model['motionCalibration']['available'])
            with tempfile.TemporaryDirectory() as folder:
                paths = [Path(folder) / name for name in ['model.json', 'parity.json']]
                for path, value in zip(paths, [model, parity]):
                    path.write_text(json.dumps(value, allow_nan=False), encoding='utf-8')
                result = subprocess.run(['node', str(ROOT / 'research/check-parity.mjs'), *map(str, paths)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_groups_with_same_lighting_stay_separate_and_whole_in_diagnostics(self):
        groups = [self.group('first', [15, 30]), self.group('second', [20, 35, 80]), self.group('third', [25], 'daylight')]
        model, report, _ = fit_model(groups, self.config)
        self.assertEqual(model['coverage']['sessions'], 3)
        for row in report['excludedGroupDiagnostics']:
            self.assertNotIn(row['groupId'], row['trainingGroups'])
            self.assertEqual(len(row['trainingGroups']), 2)
            self.assertEqual(row['metrics']['count'], len(row['sampleIds']))
        # Equal session weight gives the mean of session means, not image means.
        expected = np.mean([g['x'].mean(axis=0) for g in groups], axis=0)
        np.testing.assert_allclose(model['normalization']['mean'], expected)

    def test_duplicate_images_in_other_sessions_do_not_leak_into_diagnostic_fits(self):
        groups = [self.group('first', [30]), self.group('second', [30])]
        groups[1]['hashes'] = groups[0]['hashes'][:]
        _, report, _ = fit_model(groups, self.config)
        self.assertTrue(all(row['metrics'] is None for row in report['excludedGroupDiagnostics']))

    def save_group(self, root, angles):
        group_id = str(uuid.uuid4()); directory = root / group_id; directory.mkdir()
        group = {'version': 1, 'kind': 'lighting-screenshot-group', 'state': 'CLOSED', 'groupId': group_id, 'revision': 3,
                 'featureVersion': 1, 'featureConfig': self.config['features'], 'featureNames': feature_names(self.config['features']),
                 'metadata': {'device': 'laptop', 'lighting': 'desk lamp'},
                 'capture': {'width': 16, 'height': 12, 'horizontalFovDegrees': 60}, 'samples': []}
        for i, angle in enumerate(angles):
            sample_id = str(uuid.uuid4()); name = sample_id + '.png'
            image = cv2.imencode('.png', np.full((12, 16, 3), 50 + i, dtype=np.uint8))[1].tobytes()
            (directory / name).write_bytes(image)
            group['samples'].append({'sampleId': sample_id, 'image': name, 'imageSha256': hashlib.sha256(image).hexdigest(),
                                     'angleDeg': angle, 'features': [.2 + i * .1] * len(group['featureNames'])})
        path = directory / 'group.json'; path.write_text(json.dumps(group), encoding='utf-8')
        return path, group

    def test_loader_skips_open_empty_and_unlabeled_groups_and_verifies_saved_images(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path, group = self.save_group(root, [37.5, None])
            self.save_group(root, [])
            self.save_group(root, [None])
            open_path, opened = self.save_group(root, [99]); opened['state'] = 'OPEN'
            open_path.write_text(json.dumps(opened), encoding='utf-8')
            groups, skipped, sources = load_groups(root, self.config)
            self.assertEqual(groups[0]['y'].tolist(), [37.5]); self.assertEqual(len(skipped), 3)
            self.assertEqual(len(sources), 1)
            (path.parent / group['samples'][0]['image']).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'hash changed'):
                load_groups(root, self.config)

    def test_loader_rejects_mixed_capture_and_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.save_group(root, [20])
            path, group = self.save_group(root, [80])
            group['capture']['horizontalFovDegrees'] = 65
            path.write_text(json.dumps(group), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'identical camera'):
                load_groups(root, self.config)
            group['samples'].append(group['samples'][0])
            path.write_text(json.dumps(group), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'duplicate'):
                load_groups(root, self.config)

    def test_keyboard_labels_preserve_provenance_and_allow_manual_corrections(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path, group = self.save_group(root, [45.123456789, 95.25])
            sample = group['samples'][0]
            reference = {'modelId': 'teacher', 'angleRange': [10, 46], 'angleDeg': sample['angleDeg'],
                         'camera': group['capture'], 'sessionId': 'keyboard-session', 'frameId': 12, 'timestampMs': 300.5}
            sample.update(source='camera', labelSource='keyboard', keyboardReference=reference, frameId=12, timestampMs=300.5)
            path.write_text(json.dumps(group), encoding='utf-8')
            groups, _, _ = load_groups(root, self.config)
            model, report, _ = fit_model(groups, self.config)
            self.assertEqual(groups[0]['y'][0], 45.123456789)
            self.assertEqual(model['coverage']['labelSources'], {'manual': 1, 'keyboard': 1})
            self.assertEqual(report['keyboardModels'][0]['angleRange'], [10, 46])
            self.assertFalse(report['independentValidationAvailable'])
            sample.update(angleDeg=100, labelSource='manual')
            path.write_text(json.dumps(group), encoding='utf-8')
            self.assertEqual(load_groups(root, self.config)[0][0]['y'][0], 100)
            sample.update(angleDeg=None, labelSource=None)
            path.write_text(json.dumps(group), encoding='utf-8')
            self.assertEqual(load_groups(root, self.config)[0][0]['y'].tolist(), [95.25])

    def test_keyboard_provenance_rejects_mismatch_and_uses_model_range_without_legacy_limits(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path, group = self.save_group(root, [5.5])
            sample = group['samples'][0]
            reference = {'modelId': 'future', 'angleRange': [2, 60], 'angleDeg': 5.5,
                         'camera': group['capture'], 'sessionId': 'keyboard-session', 'frameId': 12, 'timestampMs': 300.5}
            sample.update(source='camera', labelSource='keyboard', keyboardReference=reference, frameId=12, timestampMs=300.5)
            path.write_text(json.dumps(group), encoding='utf-8')
            self.assertEqual(load_groups(root, self.config)[0][0]['y'][0], 5.5)
            for key, value in [('frameId', 13), ('timestampMs', 0), ('angleDeg', 65), ('modelId', ''), ('camera', {})]:
                changed = copy.deepcopy(group)
                changed['samples'][0]['keyboardReference'][key] = value
                path.write_text(json.dumps(changed), encoding='utf-8')
                with self.assertRaises(ValueError):
                    load_groups(root, self.config)
if __name__ == '__main__':
    unittest.main()
