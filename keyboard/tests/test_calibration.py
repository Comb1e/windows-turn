import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from keyboard_hinge.calibration import fit_camera
from keyboard_hinge.config import Config, Limits


def test_camera_calibration_from_varied_synthetic_checkerboards():
    matrix = np.array([[850., 0, 640], [0, 860., 360], [0, 0, 1]])
    distortion = np.array([-.1, .03, .001, -.001, 0.])
    objects = np.zeros((54, 3), np.float32)
    objects[:, :2] = np.mgrid[0:9, 0:6].T.reshape(-1, 2) * 18
    rng = np.random.default_rng(21)
    views = []
    for _ in range(16):
        rvec = rng.uniform(-.45, .45, 3)
        translation = rng.uniform([-140, -100, 380], [30, 30, 650])
        pixels = cv2.projectPoints(objects, rvec, translation, matrix, distortion)[0]
        views.append(pixels)
    camera, rms, per_view = fit_camera([objects] * len(views), views, (1280, 720), 1.)
    assert rms < .001
    assert max(per_view) < .001
    assert np.allclose(camera.matrix, matrix, atol=.1)
    assert np.allclose(camera.distortion, distortion, atol=.001)


def test_placeholder_dimensions_cannot_be_used(tmp_path):
    data = json.loads((Path(__file__).parents[1] / "config.example.json").read_text())
    path = tmp_path / "config.json"
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="Measure"):
        Config.read(path)
    data["base"]["measurements_confirmed"] = True
    path.write_text(json.dumps(data))
    assert Config.read(path).points.shape == (4, 3)
    data["base"]["points_mm"][2][2] = 1
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="z=0"):
        Config.read(path)


@pytest.mark.parametrize("options", [{"max_speed_deg_s": float("nan")}, {"min_angle_deg": 180, "max_angle_deg": 90},
                                      {"min_inlier_ratio": 1.1}, {"max_tracking_points": 3}, {"lk_window_px": 2.5}])
def test_invalid_quality_settings_are_rejected(options):
    with pytest.raises(ValueError):
        Limits(**options)
