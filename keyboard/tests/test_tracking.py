import cv2
import numpy as np

from keyboard_hinge.config import Limits
from keyboard_hinge.geometry import Camera, Hinge, rotation_x
from keyboard_hinge.tracking import Session, State


def make_scene():
    camera = Camera([[900., 0, 640], [0, 900., 360], [0, 0, 1]], np.zeros(5), (1280, 720))
    model = np.array([[0., 0, 0], [120, 0, 0], [120, 75, 0], [0, 75, 0]])
    hinge = Hinge(rotation_x(80), 1)
    texture = np.full((150, 240, 3), 80, np.uint8)
    rng = np.random.default_rng(9)
    for point in rng.integers([10, 10], [230, 140], (100, 2)):
        cv2.circle(texture, tuple(point), 2, (240, 240, 240), -1)

    def frame(angle):
        corners = cv2.projectPoints(model, cv2.Rodrigues(hinge.mount @ rotation_x(angle))[0],
                                    np.array([-60., 35., 500.]), camera.matrix, camera.distortion)[0].reshape(-1, 2)
        homography = cv2.getPerspectiveTransform(np.array([[0, 0], [239, 0], [239, 149], [0, 149]], np.float32), corners.astype(np.float32))
        return cv2.warpPerspective(texture, homography, camera.size), corners

    return camera, model, hinge, frame


def test_tracks_motion_then_clears_angle_when_base_disappears():
    camera, model, hinge, frame = make_scene()
    session = Session(camera, hinge, Limits(min_angle_deg=0, max_angle_deg=180))
    image, corners = frame(110)
    assert session.state == State.WAITING
    assert session.initialize(image, model, corners, 0.).angle_deg is not None
    moved, _ = frame(111)
    result = session.update(moved, .1)
    assert result.angle_deg is not None
    assert abs(result.angle_deg - 111) < 1
    assert session.state == State.TRACKING
    session.update(np.zeros_like(image), .2)
    assert session.state in (State.LOST, State.UNRELIABLE)
    assert session.record(.2)["angle_deg"] is None
    assert session.record(.2)["confidence"] == 0
    session.update(image, .3)
    assert session.result.angle_deg is None  # No automatic reuse of stale correspondences.
    session.initialize(image, model, corners, .4)
    assert session.state == State.TRACKING


def test_drift_deadline_requires_manual_reselection():
    camera, model, hinge, frame = make_scene()
    session = Session(camera, hinge, Limits(min_angle_deg=0, max_angle_deg=180, max_tracking_age_s=1.))
    image, corners = frame(110)
    session.initialize(image, model, corners, 0.)
    assert session.update(image, 1.1).angle_deg is None
    assert session.state == State.LOST
    assert "drift" in session.result.reason


def test_textureless_base_is_unreliable():
    camera, model, hinge, frame = make_scene()
    image, corners = frame(110)
    session = Session(camera, hinge, Limits(min_angle_deg=0, max_angle_deg=180))
    session.initialize(np.zeros_like(image), model, corners, 0.)
    assert session.state == State.UNRELIABLE
    assert session.result.angle_deg is None
