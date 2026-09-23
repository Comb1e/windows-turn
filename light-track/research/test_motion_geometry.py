import copy
import json
from pathlib import Path
import unittest

import cv2
import numpy as np

from motion_geometry import camera_matrix, estimate_motion, rotation_distance

CONFIG = json.loads((Path(__file__).resolve().parents[1]/'config.json').read_text(encoding='utf-8'))


def rotation(degrees):
    return cv2.Rodrigues(np.array([np.radians(degrees), 0., 0.]))[0]


def project(x, k):
    p = x @ k.T
    return p[:, :2] / p[:, 2:]


def panorama():
    rng = np.random.default_rng(12)
    texture = rng.integers(0, 256, (1024, 2048), dtype=np.uint8)
    return cv2.GaussianBlur(texture, (3, 3), 0)


def scene(texture, degrees, width=320, height=180, fov=65):
    k = camera_matrix(width, height, fov)
    yy, xx = np.mgrid[:height, :width]
    p = np.c_[xx.ravel(), yy.ravel(), np.ones(width*height)] @ np.linalg.inv(k).T @ rotation(degrees)
    p /= np.linalg.norm(p, axis=1, keepdims=True)
    u = (np.arctan2(p[:, 0], p[:, 2])/(2*np.pi)+.5)*texture.shape[1]
    v = (np.arcsin(p[:, 1])/np.pi+.5)*texture.shape[0]
    return cv2.remap(texture, u.reshape(height, width).astype(np.float32), v.reshape(height, width).astype(np.float32), cv2.INTER_LINEAR)


class GeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cv2.setNumThreads(1)
        cv2.setRNGSeed(42)
        cls.texture = panorama()

    def test_translation_aware_rotation_with_moving_foreground(self):
        rng = np.random.default_rng(2)
        k = camera_matrix(640, 360, 65)
        x = np.c_[rng.uniform(-1.5, 1.5, 400), rng.uniform(-.7, .7, 400), rng.uniform(2, 5, 400)]
        r = rotation(9)
        hinge = np.array([0., -.3, 0.])
        t = (np.eye(3)-r) @ hinge
        p, q = project(x, k), project(x @ r.T+t, k)
        good = (np.abs(p[:, 0]-320)<310) & (np.abs(q[:, 0]-320)<310) & (np.abs(p[:, 1]-180)<170) & (np.abs(q[:, 1]-180)<170)
        p, q = p[good], q[good]
        q += rng.normal(0, .1, q.shape)
        q[:len(q)//5] += rng.normal(0, 30, (len(q)//5, 2))
        found, quality = estimate_motion(p, q, k, (360, 640), CONFIG['tracking'], np.array([1., 0, 0]))
        self.assertIsNotNone(found, quality)
        self.assertLess(rotation_distance(found, r), 1)
        self.assertIn(quality['method'], ['essential', 'homography'])

    def test_planar_motion_recovers_or_rejects_ambiguity(self):
        k = camera_matrix(640, 360, 65)
        yy, xx = np.mgrid[-.6:.7:.1, -1.1:1.2:.1]
        x = np.c_[xx.ravel(), yy.ravel(), np.full(xx.size, 3)]
        r = rotation(7)
        p, q = project(x, k), project(x @ r.T + [0, .05, .08], k)
        found, quality = estimate_motion(p, q, k, (360, 640), CONFIG['tracking'], np.array([1., 0, 0]))
        if found is None:
            self.assertIn('reason', quality)
        else:
            self.assertLess(rotation_distance(found, r), 2)


if __name__ == '__main__':
    unittest.main()
