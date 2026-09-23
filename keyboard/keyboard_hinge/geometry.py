"""Calibrated planar pose, signed hinge fitting, and conservative rejection."""
from dataclasses import dataclass
import hashlib
import json

import cv2
import numpy as np

from .config import Limits, read_json, write_json


def rotation_x(degrees):
    a = np.deg2rad(degrees)
    c, s = np.cos(a), np.sin(a)
    return np.array([[1., 0., 0.], [0., c, -s], [0., s, c]])


def rotation_distance(a, b):
    return float(np.rad2deg(np.arccos(np.clip((np.trace(a.T @ b) - 1) / 2, -1, 1))))


def valid_rotation(value):
    matrix = np.asarray(value, dtype=np.float64)
    if matrix.shape != (3, 3) or not np.isfinite(matrix).all():
        raise ValueError("Expected a finite 3x3 rotation")
    if not np.allclose(matrix.T @ matrix, np.eye(3), atol=1e-5) or not np.isclose(np.linalg.det(matrix), 1):
        raise ValueError("Invalid rotation matrix")
    return matrix


@dataclass
class Camera:
    matrix: np.ndarray
    distortion: np.ndarray
    size: tuple[int, int]

    def __post_init__(self):
        self.matrix = np.asarray(self.matrix, dtype=np.float64)
        self.distortion = np.asarray(self.distortion, dtype=np.float64).reshape(-1)
        self.size = tuple(self.size)
        if self.matrix.shape != (3, 3) or not np.isfinite(self.matrix).all():
            raise ValueError("Invalid camera matrix")
        if min(self.matrix[0, 0], self.matrix[1, 1]) <= 0 or not np.allclose(self.matrix[2], [0, 0, 1]):
            raise ValueError("Invalid camera intrinsics")
        if self.distortion.size not in (4, 5, 8, 12, 14) or not np.isfinite(self.distortion).all():
            raise ValueError("Invalid distortion coefficients")
        if len(self.size) != 2 or any(not isinstance(v, int) or v <= 0 for v in self.size):
            raise ValueError("Invalid camera resolution")

    @classmethod
    def read(cls, path):
        data = read_json(path)
        return cls(data["matrix"], data["distortion"], tuple(data["image_size"]))

    def payload(self):
        return {"matrix": self.matrix.tolist(), "distortion": self.distortion.tolist(), "image_size": list(self.size)}

    def fingerprint(self):
        return hashlib.sha256(json.dumps(self.payload(), sort_keys=True).encode()).hexdigest()

    def check_frame(self, frame):
        if (frame.shape[1], frame.shape[0]) != self.size:
            raise ValueError(f"Camera resolution changed; calibration requires {self.size}")

    def undistort(self, pixels):
        return cv2.undistortPoints(np.asarray(pixels, np.float64).reshape(-1, 1, 2), self.matrix,
                                   self.distortion, P=self.matrix).reshape(-1, 2)


@dataclass
class Pose:
    rotation: np.ndarray
    translation: np.ndarray
    reprojection_px: float
    inlier_ratio: float


def planar_poses(objects, pixels, camera, limits):
    objects = np.asarray(objects, np.float64)
    pixels = np.asarray(pixels, np.float64)
    if objects.ndim != 2 or objects.shape[1] != 3 or pixels.shape != (len(objects), 2) or len(objects) < 4:
        return [], "Need at least four matching points"
    if not np.isfinite(objects).all() or not np.isfinite(pixels).all() or not np.allclose(objects[:, 2], 0):
        return [], "Invalid planar correspondences"
    if np.linalg.matrix_rank(objects[:, :2] - objects[:, :2].mean(axis=0)) < 2:
        return [], "Collinear model points"
    if np.any(pixels < 0) or np.any(pixels[:, 0] >= camera.size[0]) or np.any(pixels[:, 1] >= camera.size[1]):
        return [], "Points outside the camera image"
    flat = camera.undistort(pixels)
    homography, mask = cv2.findHomography(objects[:, :2], flat, cv2.RANSAC, limits.ransac_px)
    if homography is None or mask is None:
        return [], "Degenerate homography"
    inliers = mask.ravel().astype(bool)
    ratio = float(inliers.mean())
    if inliers.sum() < 4 or ratio < limits.min_inlier_ratio:
        return [], "Too few consistent base points"
    area = cv2.contourArea(cv2.convexHull(pixels[inliers].astype(np.float32)))
    if area / (camera.size[0] * camera.size[1]) < limits.min_area_fraction:
        return [], "Base too small or viewed too edge-on"
    obj, img = np.ascontiguousarray(objects[inliers]), np.ascontiguousarray(flat[inliers])
    result = cv2.solvePnPGeneric(obj, img, camera.matrix, None, flags=cv2.SOLVEPNP_IPPE)
    poses = []
    if not result[0]:
        return poses, "Planar pose solver failed"
    for rvec, tvec in zip(result[1], result[2]):
        rotation = cv2.Rodrigues(rvec)[0]
        translation = tvec.reshape(3)
        camera_points = (rotation @ obj.T).T + translation
        # Positive z is the visible top of the base; its normal must face the camera.
        if np.min(camera_points[:, 2]) <= 0 or np.dot(rotation[:, 2], -translation) <= 0:
            continue
        projected = cv2.projectPoints(obj, rvec, tvec, camera.matrix, camera.distortion)[0].reshape(-1, 2)
        error = float(np.sqrt(np.mean(np.sum((projected - pixels[inliers]) ** 2, axis=1))))
        if np.isfinite(error) and error <= limits.max_reprojection_px:
            poses.append(Pose(rotation, translation, error, ratio))
    return poses, "" if poses else "Pose failed reprojection or visible-side checks"


@dataclass
class Hinge:
    mount: np.ndarray
    sign: int

    def __post_init__(self):
        self.mount = valid_rotation(self.mount)
        if self.sign not in (-1, 1):
            raise ValueError("Hinge sign must be -1 or +1")

    def save(self, path, camera, points, reference_angles, reference_ids=None):
        write_json(path, {"mount": self.mount.tolist(), "sign": self.sign,
                          "camera_fingerprint": camera.fingerprint(), "points_mm": points.tolist(),
                          "reference_angles_deg": reference_angles, "reference_ids": reference_ids or []})

    @classmethod
    def read(cls, path, camera, points):
        data = read_json(path)
        if data["camera_fingerprint"] != camera.fingerprint() or not np.array_equal(data["points_mm"], points):
            raise ValueError("Camera calibration or base model changed; repeat hinge calibration")
        return cls(data["mount"], data["sign"])

    def angle_and_residual(self, rotation, limits):
        relative = self.mount.T @ rotation
        raw = self.sign * np.rad2deg(np.arctan2(relative[2, 1] - relative[1, 2], relative[1, 1] + relative[2, 2]))
        options = [raw + shift for shift in (-360, 0, 360)]
        options = [a for a in options if limits.min_angle_deg - 1e-7 <= a <= limits.max_angle_deg + 1e-7]
        if len(options) != 1:
            return None, float("inf")
        angle = float(np.clip(options[0], limits.min_angle_deg, limits.max_angle_deg))
        return angle, rotation_distance(rotation, self.mount @ rotation_x(self.sign * angle))


def calibrate_hinge(first, angle_first, second, angle_second, limits):
    if not all(np.isfinite(a) and limits.min_angle_deg <= a <= limits.max_angle_deg for a in (angle_first, angle_second)):
        raise ValueError("Reference angles must lie in the configured opening range")
    separation = abs(angle_second - angle_first)
    if not limits.min_reference_separation_deg <= separation <= 180 - limits.min_reference_separation_deg:
        raise ValueError("Use two reference angles separated by at least the configured minimum and well below 180 degrees")
    choices = []
    for a in first:
        for b in second:
            for sign in (-1, 1):
                m1 = a.rotation @ rotation_x(-sign * angle_first)
                m2 = b.rotation @ rotation_x(-sign * angle_second)
                residual = rotation_distance(m1, m2)
                u, _, vt = np.linalg.svd(m1 + m2)
                mount = u @ np.diag([1, 1, np.linalg.det(u @ vt)]) @ vt
                choices.append((residual, a.reprojection_px + b.reprojection_px, Hinge(mount, sign)))
    choices = [item for item in choices if item[0] <= limits.max_hinge_residual_deg]
    choices.sort(key=lambda item: item[0] / limits.max_hinge_residual_deg + item[1] / (2 * limits.max_reprojection_px))
    if not choices:
        raise ValueError("Reference poses do not agree with hinge-only motion; check angles and corner order")
    best = choices[0]
    for alternative in choices[1:]:
        materially_different = alternative[2].sign != best[2].sign or rotation_distance(alternative[2].mount, best[2].mount) > limits.ambiguity_separation_deg
        similar_fit = abs(alternative[0] - best[0]) <= limits.ambiguity_margin_deg
        similar_reprojection = abs(alternative[1] - best[1]) <= 2 * limits.ambiguity_reprojection_margin_px
        if similar_fit and similar_reprojection and materially_different:
            raise ValueError("Ambiguous reference poses; use clearer, more oblique base views")
    return best[2], best[0]


@dataclass
class Estimate:
    angle_deg: float | None
    confidence: float
    reason: str
    pose: Pose | None = None
    hinge_residual_deg: float | None = None


def estimate(objects, pixels, camera, hinge, limits, previous=None, elapsed=None):
    poses, reason = planar_poses(objects, pixels, camera, limits)
    candidates = []
    for pose in poses:
        angle, residual = hinge.angle_and_residual(pose.rotation, limits)
        if angle is None or residual > limits.max_hinge_residual_deg:
            continue
        if previous is not None and (elapsed is None or elapsed <= 0 or abs(angle - previous) > limits.max_speed_deg_s * elapsed):
            continue
        score = residual / limits.max_hinge_residual_deg + pose.reprojection_px / limits.max_reprojection_px
        candidates.append((score, angle, residual, pose))
    candidates.sort(key=lambda candidate: candidate[0])
    if not candidates:
        return Estimate(None, 0., reason or "Pose violates hinge, range, or motion constraints")
    best = candidates[0]
    if best[3].reprojection_px > min(pose.reprojection_px for pose in poses) + limits.ambiguity_reprojection_margin_px:
        return Estimate(None, 0., "Better image fit violates hinge, range, or motion constraints")
    for other in candidates[1:]:
        similar_reprojection = abs(other[3].reprojection_px - best[3].reprojection_px) <= limits.ambiguity_reprojection_margin_px
        if (abs(other[1] - best[1]) > limits.ambiguity_separation_deg
                and abs(other[2] - best[2]) <= limits.ambiguity_margin_deg and similar_reprojection):
            return Estimate(None, 0., "Ambiguous planar pose; select a clearer base view")
    _, angle, residual, pose = best
    confidence = pose.inlier_ratio * np.exp(-0.5 * (pose.reprojection_px / limits.max_reprojection_px) ** 2 - 0.5 * (residual / limits.max_hinge_residual_deg) ** 2)
    return Estimate(angle, float(confidence), "", pose, residual)
