import json
from pathlib import Path
import unittest
import numpy as np
from sklearn.ensemble import ExtraTreesRegressor
from model_training import smooth, export_trees
CONFIG=json.loads((Path(__file__).resolve().parents[1]/'config.json').read_text())

class TrainingTests(unittest.TestCase):
    def test_export_repairs_only_endpoint_roundoff_without_changing_fitted_model(self):
        forest = ExtraTreesRegressor(n_estimators=1).fit([[0], [1]], [120, 120])
        leaf = forest.estimators_[0].tree_.value
        for raw, expected in [(120.00000000000006, 120), (9.999999999999998, 10), (45.45119355013919, 45.45119355013919)]:
            leaf[0, 0, 0] = raw
            self.assertEqual(export_trees(forest, [10, 120])[0][0][4], expected)
            self.assertEqual(leaf[0, 0, 0], raw)
        for raw in [120.001, 9.99, float('nan'), float('inf')]:
            leaf[0, 0, 0] = raw
            with self.assertRaisesRegex(ValueError, 'Tree prediction outside'):
                export_trees(forest, [10, 120])

    def test_filter_jitter_steps_and_dropped_frames(self):
        values = np.asarray([60+(-1)**i for i in range(100)]+[100]*8+[20])
        times = np.r_[np.arange(108)*65, 8000]
        outputs = smooth(values, times, CONFIG['filter'])
        self.assertLess(np.std(outputs[20:100]), 1)
        self.assertLess(abs(outputs[107]-100), 5)
        self.assertEqual(outputs[-1], 20)
