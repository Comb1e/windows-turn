import json
from dataclasses import asdict

import cv2
import numpy as np
import pytest

from keyboard_hinge.annotation import Annotation, AnnotationStore, load_samples
from keyboard_hinge.config import Config, Limits, write_json
from keyboard_hinge.geometry import Camera, Hinge, rotation_x


@pytest.fixture
def dataset(tmp_path):
    camera = Camera([[900., 0, 640], [0, 900., 360], [0, 0, 1]], np.zeros(5), (1280, 720))
    points = np.array([[0., 0., 0.], [120, 0, 0], [120, 75, 0], [0, 75, 0]])
    hinge = Hinge(rotation_x(140), 1)
    config = Config(0, 1280, 720, points, ["front left", "front right", "rear right", "rear left"], Limits())
    texture = np.full((150, 240, 3), 60, np.uint8)
    rng = np.random.default_rng(9)
    for point in rng.integers([10, 10], [230, 140], (120, 2)):
        cv2.circle(texture, tuple(point), 2, (240, 240, 240), -1)

    def frame(angle, off_axis=0):
        rotation = hinge.mount @ rotation_x(angle) @ cv2.Rodrigues(np.array([0., off_axis, 0.]))[0]
        corners = cv2.projectPoints(points, cv2.Rodrigues(rotation)[0], np.array([-60., 35., 500.]),
                                    camera.matrix, camera.distortion)[0].reshape(-1, 2)
        homography = cv2.getPerspectiveTransform(np.array([[0, 0], [239, 0], [239, 149], [0, 149]], np.float32),
                                                 corners.astype(np.float32))
        return cv2.warpPerspective(texture, homography, camera.size), corners

    directory, path = tmp_path / "images", tmp_path / "annotations.json"
    directory.mkdir()
    store = AnnotationStore(directory, path)
    for angle in (10, 18, 26, 36, 45):
        image, corners = frame(angle)
        item_id = f"angle-{angle}.png"
        cv2.imwrite(str(directory / item_id), image)
        store.save(asdict(Annotation(item_id, 1., angle, "test", corners=corners.tolist())))
    config_path = tmp_path / "config.json"
    write_json(config_path, {"camera": {"index": 0, "width": 1280, "height": 720},
                             "base": {"points_mm": points.tolist(), "point_labels": config.labels, "measurements_confirmed": True}})
    return directory, path, camera, hinge, config, frame, config_path
