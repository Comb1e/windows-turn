"""Device-specific empirical angle regression; no calibrated camera or physical dimensions."""
from dataclasses import dataclass

import cv2
import numpy as np

from .annotation import validate_corners
from .calibration import approximate_camera
from .config import Limits, read_json, validate_angle, validate_fov, write_json
from .geometry import Estimate
from .tracking import PlaneTracker, Session, State
from .evaluation import error_statistics, dataset_fingerprint

MODEL_VERSION = 1
FEATURE_VERSION = "centered-rms-corners-optional-fov-v1"
UNIT_RECTANGLE = np.array([[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]])


def corner_features(corners, width, height, horizontal_fov_deg=None):
    points = np.asarray(validate_corners(corners, (width, height)), dtype=np.float64)
    centered = points - points.mean(axis=0)
    scale = np.sqrt(np.mean(np.sum(centered ** 2, axis=1)))
    if scale < 1e-6:
        raise ValueError("Keyboard corners are too close together")
    # A single scale preserves aspect ratio; orientation is intentionally retained.
    features = (centered / scale).ravel()
    if horizontal_fov_deg is not None:
        camera = approximate_camera(width, height, horizontal_fov_deg)
        homography = cv2.getPerspectiveTransform(UNIT_RECTANGLE[:, :2].astype(np.float32), points.astype(np.float32))
        directions = np.linalg.solve(camera.matrix, homography)
        # Homography columns carry arbitrary rectangle widths, but their cross
        # product gives a normal without needing either physical dimension.
        normal = np.cross(directions[:, 0], directions[:, 1])
        norm = np.linalg.norm(normal)
        if not np.isfinite(norm) or norm < 1e-12:
            raise ValueError("Cannot derive a plane normal from these corners")
        normal /= norm
        features = np.r_[features, normal]
    return features


def regress(features, angles, ridge):
    mean = features.mean(axis=0)
    scale = np.maximum(features.std(axis=0), .01)
    normalized = (features - mean) / scale
    design = np.column_stack([np.ones(len(features)), normalized])
    penalty = np.eye(features.shape[1] + 1) * ridge
    penalty[0, 0] = 0.
    coefficients = np.linalg.solve(design.T @ design + penalty, design.T @ angles)
    return mean, scale, coefficients


def support_distance(point, samples):
    """Distance to the piecewise linear path through labeled reference shapes."""
    start, end = samples[:-1], samples[1:]
    delta = end - start
    length2 = np.sum(delta ** 2, axis=1)
    fraction = np.sum((point - start) * delta, axis=1) / np.maximum(length2, 1e-12)
    closest = start + np.clip(fraction, 0., 1.)[:, None] * delta
    return float(np.min(np.linalg.norm(point - closest, axis=1)))


@dataclass
class UncalibratedModel:
    mean: np.ndarray
    scale: np.ndarray
    coefficients: np.ndarray
    support: np.ndarray
    image_size: tuple[int, int]
    angle_limits: tuple[float, float]
    training_range: tuple[float, float]
    feature_margin: float
    winding: int
    training_ids: list[str]
    training_fingerprint: str
    validation: dict
    horizontal_fov_deg: float | None = None

    def __post_init__(self):
        self.mean = np.asarray(self.mean, dtype=float)
        self.scale = np.asarray(self.scale, dtype=float)
        self.coefficients = np.asarray(self.coefficients, dtype=float)
        self.support = np.asarray(self.support, dtype=float)
        if self.horizontal_fov_deg is not None:
            validate_fov(self.horizontal_fov_deg)
        count = 8 if self.horizontal_fov_deg is None else 11
        if (self.mean.shape != (count,) or self.scale.shape != (count,)
                or self.coefficients.shape != (count + 1,) or self.support.ndim != 2
                or self.support.shape[1] != count or len(self.support) < 4
                or not all(np.isfinite(a).all() for a in (self.mean, self.scale, self.coefficients, self.support))
                or np.any(self.scale <= 0)):
            raise ValueError("Invalid uncalibrated model arrays")
        if len(self.image_size) != 2 or any(type(v) is not int or v <= 0 for v in self.image_size):
            raise ValueError("Invalid model image size")
        self.image_size = tuple(self.image_size)
        if (len(self.angle_limits) != 2 or len(self.training_range) != 2
                or not np.isfinite([*self.angle_limits, *self.training_range]).all()
                or not 0 <= self.angle_limits[0] <= self.training_range[0] < self.training_range[1] <= self.angle_limits[1] <= 360):
            raise ValueError("Invalid model angle limits or training range")
        if not np.isfinite(self.feature_margin) or self.feature_margin <= 0 or self.winding not in (-1, 1):
            raise ValueError("Invalid model support envelope")
        if (not isinstance(self.training_ids, list) or len(self.training_ids) != len(self.support)
                or any(not isinstance(item, str) for item in self.training_ids)
                or len(set(self.training_ids)) != len(self.training_ids)
                or not isinstance(self.training_fingerprint, str) or len(self.training_fingerprint) != 64
                or not isinstance(self.validation, dict)):
            raise ValueError("Invalid model training metadata")

    def check_frame(self, frame):
        if (frame.shape[1], frame.shape[0]) != self.image_size:
            raise ValueError(f"Camera resolution differs from the model; use {self.image_size}")

    def predict(self, corners, limits=None):
        try:
            feature = corner_features(corners, *self.image_size, self.horizontal_fov_deg)
            winding = np.sign(cv2.contourArea(np.asarray(corners, np.float32), oriented=True))
            if winding != self.winding:
                raise ValueError("Corner order differs from the training images")
        except (ValueError, cv2.error) as error:
            return Estimate(None, 0., str(error))
        normalized = (feature - self.mean) / self.scale
        margin = self.feature_margin
        distance = support_distance(normalized, self.support) / np.sqrt(len(self.mean))
        if (np.any(normalized < self.support.min(axis=0) - margin)
                or np.any(normalized > self.support.max(axis=0) + margin) or distance > margin):
            return Estimate(None, 0., "View is outside the annotated feature envelope")
        angle = float(np.r_[1., normalized] @ self.coefficients)
        low, high = self.training_range
        if limits is not None:
            low, high = max(low, limits.min_angle_deg), min(high, limits.max_angle_deg)
        if not np.isfinite(angle) or not low - 1e-7 <= angle <= high + 1e-7:
            return Estimate(None, 0., "Predicted angle is outside the annotated angle range")
        confidence = float(np.exp(-.5 * (distance / margin) ** 2))
        return Estimate(float(np.clip(angle, low, high)), confidence, "")

    def save(self, path):
        write_json(path, {"schema_version": MODEL_VERSION, "type": "uncalibrated-corner-regression",
                          "feature_version": FEATURE_VERSION, "mean": self.mean.tolist(), "scale": self.scale.tolist(),
                          "coefficients": self.coefficients.tolist(), "support": self.support.tolist(),
                          "image_size": list(self.image_size), "angle_limits": list(self.angle_limits),
                          "training_range": list(self.training_range), "feature_margin": self.feature_margin,
                          "winding": self.winding, "training_ids": self.training_ids,
                          "training_fingerprint": self.training_fingerprint, "validation": self.validation,
                          "horizontal_fov_deg": self.horizontal_fov_deg})

    @classmethod
    def read(cls, path):
        data = read_json(path)
        if (not isinstance(data, dict) or data.get("schema_version") != MODEL_VERSION
                or data.get("feature_version") != FEATURE_VERSION or data.get("type") != "uncalibrated-corner-regression"):
            raise ValueError("Unsupported uncalibrated model version")
        try:
            return cls(**{key: data[key] for key in cls.__dataclass_fields__})
        except (TypeError, KeyError) as error:
            raise ValueError(f"Malformed uncalibrated model: {error}") from error


def fit_model(samples, limits=None, horizontal_fov_deg=None):
    limits = limits or Limits()
    if len(samples) < limits.uncalibrated_min_images:
        raise ValueError(f"Need at least {limits.uncalibrated_min_images} valid annotated images")
    if len({sample.size for sample in samples}) != 1:
        raise ValueError("Training images must have the same resolution")
    records = [sample.annotation for sample in samples]
    y = np.array([validate_angle(a.angle_deg, limits) for a in records])
    if len(np.unique(y)) < limits.uncalibrated_min_angles:
        raise ValueError(f"Need at least {limits.uncalibrated_min_angles} distinct measured angles")
    features = np.array([corner_features(a.corners, *samples[0].size, horizontal_fov_deg) for a in records])
    winding = [int(np.sign(cv2.contourArea(np.asarray(a.corners, np.float32), oriented=True))) for a in records]
    if len(set(winding)) != 1:
        raise ValueError("Inconsistent corner order between training images")
    if np.max(features.std(axis=0)) < 1e-6:
        raise ValueError("Reference shapes do not change; capture distinct openings")
    for i in range(len(records)):
        if any(np.linalg.norm(features[i] - features[j]) < 1e-6 and abs(y[i] - y[j]) > .1 for j in range(i)):
            raise ValueError("Identical corner shapes have conflicting angle labels")
    mean, scale, coefficients = regress(features, y, limits.uncalibrated_ridge)
    design = np.column_stack([np.ones(len(y)), (features - mean) / scale])
    training_errors = np.abs(design @ coefficients - y)
    # Leave every photo with the held-out angle out together to avoid duplicate-angle leakage.
    rows = []
    for angle in np.unique(y):
        train = y != angle
        fold_mean, fold_scale, fold_coef = regress(features[train], y[train], limits.uncalibrated_ridge)
        for index in np.flatnonzero(~train):
            prediction = float(np.r_[1., (features[index] - fold_mean) / fold_scale] @ fold_coef)
            rows.append({"item_id": records[index].item_id, "expected": float(y[index]), "estimated": prediction,
                         "error": abs(prediction - y[index]), "reason": ""})
    validation = {"method": "leave-one-angle-out (raw regression, including endpoint extrapolation)",
                  "metrics": error_statistics(rows), "rows": rows, "training_mae_deg": float(training_errors.mean()),
                  "warning_threshold_deg": limits.uncalibrated_max_validation_mae_deg}
    ordered = np.argsort(y, kind="stable")
    model = UncalibratedModel(mean, scale, coefficients, ((features - mean) / scale)[ordered], samples[0].size,
                             (limits.min_angle_deg, limits.max_angle_deg), (float(y.min()), float(y.max())),
                             limits.uncalibrated_feature_margin, winding[0], [records[i].item_id for i in ordered],
                             dataset_fingerprint(samples), validation, horizontal_fov_deg)
    return model


class PixelPlane:
    """Image coordinate adapter for PlaneTracker, with no lens correction or intrinsics."""
    def __init__(self, size):
        self.size = size

    def check_frame(self, frame):
        if (frame.shape[1], frame.shape[0]) != self.size:
            raise ValueError(f"Camera resolution differs from the model; use {self.size}")

    def undistort(self, pixels):
        return np.asarray(pixels, dtype=np.float64).reshape(-1, 2)


class UncalibratedSession(Session):
    def __init__(self, model, limits):
        self.model, self.limits = model, limits
        self.camera = PixelPlane(model.image_size)
        self.tracker = PlaneTracker(self.camera, limits)
        self.corners = None
        self.reject(State.WAITING, "Select four keyboard corners with S")

    def reject(self, state, reason):
        self.corners = None
        return super().reject(state, reason)

    def initialize(self, frame, corners, timestamp):
        try:
            self.camera.check_frame(frame)
            result = self.model.predict(corners, self.limits)
            if result.angle_deg is None:
                return self.reject(State.UNRELIABLE, result.reason)
            self.tracker.initialize(frame, UNIT_RECTANGLE, corners, timestamp)
        except (ValueError, cv2.error) as error:
            return self.reject(State.UNRELIABLE, str(error))
        self.corners = np.asarray(corners, float)
        self.state, self.result, self.last_time = State.TRACKING, result, timestamp
        return result

    def update(self, frame, timestamp):
        try:
            self.camera.check_frame(frame)
            if self.state != State.TRACKING:
                return self.result
            objects, pixels, reason = self.tracker.update(frame, timestamp)
            if objects is None:
                return self.reject(State.LOST, reason)
            homography, mask = cv2.findHomography(objects[:, :2], pixels, cv2.RANSAC, self.limits.ransac_px)
            if homography is None or mask is None or mask.sum() < self.limits.min_tracking_points or mask.mean() < self.limits.min_inlier_ratio:
                return self.reject(State.UNRELIABLE, "Tracked keyboard points are inconsistent")
            projected = cv2.perspectiveTransform(objects[:, :2].reshape(-1, 1, 2), homography).reshape(-1, 2)
            inliers = mask.ravel().astype(bool)
            rms = np.sqrt(np.mean(np.sum((projected[inliers] - pixels[inliers]) ** 2, axis=1)))
            if not np.isfinite(rms) or rms > self.limits.max_reprojection_px:
                return self.reject(State.UNRELIABLE, "Tracked keyboard reprojection error is too large")
            corners = cv2.perspectiveTransform(UNIT_RECTANGLE[:, :2].reshape(-1, 1, 2), homography).reshape(-1, 2)
            result = self.model.predict(corners, self.limits)
            if cv2.contourArea(corners.astype(np.float32)) / np.prod(self.model.image_size) < self.limits.min_area_fraction:
                return self.reject(State.UNRELIABLE, "Keyboard is too small or too edge-on")
            if result.angle_deg is None:
                return self.reject(State.UNRELIABLE, result.reason)
            elapsed = timestamp - self.last_time
            if elapsed <= 0 or abs(result.angle_deg - self.result.angle_deg) > self.limits.max_speed_deg_s * elapsed:
                return self.reject(State.UNRELIABLE, "Angle motion exceeds the configured speed limit")
            result.confidence *= float(mask.mean() * np.exp(-.5 * (rms / self.limits.max_reprojection_px) ** 2))
            self.corners, self.result, self.last_time = corners, result, timestamp
            return result
        except (ValueError, cv2.error) as error:
            return self.reject(State.LOST, str(error))

    def record(self, timestamp):
        return {**super().record(timestamp), "mode": "uncalibrated"}
