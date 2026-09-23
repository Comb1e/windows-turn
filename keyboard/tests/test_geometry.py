import cv2
import numpy as np
import pytest

from keyboard_hinge.config import Limits
from keyboard_hinge.geometry import Camera, Hinge, Pose, calibrate_hinge, estimate, planar_poses, rotation_distance, rotation_x


@pytest.fixture
def scene():
    camera = Camera(np.array([[900., 0, 640], [0, 910., 360], [0, 0, 1]]), np.array([-.12, .04, .001, -.002, 0]), (1280, 720))
    points = np.array([[0., 0, 0], [120, 0, 0], [120, 75, 0], [0, 75, 0]])
    hinge = Hinge(cv2.Rodrigues(np.array([0., .06, .1]))[0] @ rotation_x(80), 1)
    return camera, points, hinge, Limits(min_angle_deg=0, max_angle_deg=180)


def project(camera, points, rotation, translation=None):
    if translation is None:
        translation = np.array([-60., 35., 500.])
    return cv2.projectPoints(points, cv2.Rodrigues(rotation)[0], translation,
                             camera.matrix, camera.distortion)[0].reshape(-1, 2)


@pytest.mark.parametrize("angle", [65., 90., 110., 135.])
def test_signed_opening_with_distortion(scene, angle):
    camera, points, hinge, limits = scene
    pixels = project(camera, points, hinge.mount @ rotation_x(angle))
    result = estimate(points, pixels, camera, hinge, limits)
    assert result.angle_deg == pytest.approx(angle, abs=.01)
    assert result.confidence > .99
    assert result.pose.reprojection_px < .01


@pytest.mark.parametrize("sign,mount_angle", [(1, 80), (-1, 280)])
def test_two_references_recover_mount_and_opening_direction(scene, sign, mount_angle):
    camera, points, _, limits = scene
    mount = cv2.Rodrigues(np.array([0., .08, -.12]))[0] @ rotation_x(mount_angle)
    poses = [planar_poses(points, project(camera, points, mount @ rotation_x(sign * a)), camera, limits)[0]
             for a in (70, 110)]
    fitted, residual = calibrate_hinge(poses[0], 70, poses[1], 110, limits)
    assert fitted.sign == sign
    assert residual < .01
    assert rotation_distance(fitted.mount, mount) < .01
    result = estimate(points, project(camera, points, mount @ rotation_x(sign * 125)), camera, fitted, limits)
    assert result.angle_deg == pytest.approx(125., abs=.01)


def test_ransac_rejects_incorrect_correspondences(scene):
    camera, _, hinge, limits = scene
    rng = np.random.default_rng(12)
    points = np.column_stack([rng.uniform(0, 120, 60), rng.uniform(0, 75, 60), np.zeros(60)])
    pixels = project(camera, points, hinge.mount @ rotation_x(115))
    pixels += rng.normal(0, .15, pixels.shape)
    pixels[:10] = rng.uniform([100, 100], [1000, 600], (10, 2))
    result = estimate(points, pixels, camera, hinge, limits)
    assert result.angle_deg == pytest.approx(115., abs=1.)
    assert .7 < result.pose.inlier_ratio < .9


def test_nonhinge_motion_is_rejected(scene):
    camera, points, hinge, limits = scene
    rotation = hinge.mount @ rotation_x(110) @ cv2.Rodrigues(np.array([0., .3, 0.]))[0]
    result = estimate(points, project(camera, points, rotation), camera, hinge, limits)
    assert result.angle_deg is None
    assert result.confidence == 0


def test_impossible_speed_is_rejected(scene):
    camera, points, hinge, limits = scene
    pixels = project(camera, points, hinge.mount @ rotation_x(130))
    result = estimate(points, pixels, camera, hinge, limits, previous=90., elapsed=.05)
    assert result.angle_deg is None


def test_top_side_must_face_camera(scene):
    camera, points, _, limits = scene
    poses, reason = planar_poses(points, project(camera, points, rotation_x(20)), camera, limits)
    assert not poses
    assert "visible-side" in reason


def test_degenerate_and_tiny_observations_rejected(scene):
    camera, points, hinge, limits = scene
    collinear = np.array([[0., 0, 0], [20, 0, 0], [40, 0, 0], [60, 0, 0]])
    assert not planar_poses(collinear, project(camera, collinear, rotation_x(150)), camera, limits)[0]
    tiny = project(camera, points, hinge.mount @ rotation_x(110), np.array([0., 0., 10000.]))
    assert not planar_poses(points, tiny, camera, limits)[0]
    assert not planar_poses(points[:3], tiny[:3], camera, limits)[0]


def test_range_and_supplementary_angle_are_not_folded(scene):
    _, _, hinge, _ = scene
    limits = Limits(min_angle_deg=100, max_angle_deg=150)
    assert hinge.angle_and_residual(hinge.mount @ rotation_x(120), limits)[0] == pytest.approx(120)
    assert hinge.angle_and_residual(hinge.mount @ rotation_x(60), limits)[0] is None


def test_camera_and_model_changes_invalidate_hinge_file(scene, tmp_path):
    camera, points, hinge, _ = scene
    path = tmp_path / "hinge.json"
    hinge.save(path, camera, points, [70, 110])
    assert Hinge.read(path, camera, points).sign == 1
    with pytest.raises(ValueError, match="changed"):
        Hinge.read(path, camera, points * 2)
    camera.matrix[0, 0] += 1
    with pytest.raises(ValueError, match="changed"):
        Hinge.read(path, camera, points)
    with pytest.raises(ValueError, match="resolution"):
        camera.check_frame(np.zeros((480, 640, 3), np.uint8))


def test_reference_separation_and_motion_validation(scene):
    _, _, hinge, limits = scene
    a = Pose(hinge.mount @ rotation_x(70), np.zeros(3), 0, 1)
    b = Pose(hinge.mount @ rotation_x(110) @ cv2.Rodrigues(np.array([0., .4, 0.]))[0], np.zeros(3), 0, 1)
    with pytest.raises(ValueError, match="separated"):
        calibrate_hinge([a], 70, [a], 72, limits)
    with pytest.raises(ValueError, match="hinge-only"):
        calibrate_hinge([a], 70, [b], 110, limits)


def test_ambiguous_reference_mounts_are_rejected(scene):
    _, _, hinge, limits = scene
    alternate_mount = hinge.mount @ rotation_x(20)
    first = [Pose(m @ rotation_x(70), np.zeros(3), 0, 1) for m in (hinge.mount, alternate_mount)]
    second = [Pose(m @ rotation_x(110), np.zeros(3), 0, 1) for m in (hinge.mount, alternate_mount)]
    with pytest.raises(ValueError, match="Ambiguous"):
        calibrate_hinge(first, 70, second, 110, limits)


def test_equally_plausible_runtime_angles_are_rejected(scene, monkeypatch):
    camera, points, hinge, limits = scene
    candidates = [Pose(hinge.mount @ rotation_x(a), np.array([0., 0., 500.]), .1, 1.) for a in (90, 110)]
    monkeypatch.setattr("keyboard_hinge.geometry.planar_poses", lambda *args: (candidates, ""))
    result = estimate(points, np.zeros((4, 2)), camera, hinge, limits)
    assert result.angle_deg is None
    assert "Ambiguous" in result.reason
