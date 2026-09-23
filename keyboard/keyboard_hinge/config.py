from dataclasses import dataclass, fields
import json
from pathlib import Path
import os
import tempfile

import numpy as np


@dataclass(frozen=True)
class Limits:
    min_angle_deg: float = 10.0
    max_angle_deg: float = 45.0
    max_reprojection_px: float = 3.0
    ransac_px: float = 3.0
    min_inlier_ratio: float = 0.65
    min_area_fraction: float = 0.002
    max_hinge_residual_deg: float = 5.0
    ambiguity_margin_deg: float = 0.5
    ambiguity_reprojection_margin_px: float = 0.25
    ambiguity_separation_deg: float = 3.0
    max_speed_deg_s: float = 120.0
    min_reference_separation_deg: float = 15.0
    min_tracking_points: int = 8
    max_tracking_points: int = 160
    forward_backward_px: float = 1.0
    feature_quality: float = 0.01
    feature_spacing_px: int = 8
    lk_window_px: int = 21
    lk_pyramid_levels: int = 3
    max_tracking_age_s: float = 30.0
    camera_min_views: int = 12
    camera_max_rms_px: float = 1.0
    camera_duplicate_distance_px: float = 20.0
    uncalibrated_min_images: int = 4
    uncalibrated_min_angles: int = 3
    uncalibrated_ridge: float = 0.01
    uncalibrated_feature_margin: float = 0.3
    uncalibrated_max_validation_mae_deg: float = 5.0
    annotation_max_upload_mb: int = 20
    annotation_max_image_pixels: int = 16000000
    edge_search_min_y_fraction: float = 0.5
    edge_search_max_y_fraction: float = 0.99
    edge_min_contrast: float = 8.0
    edge_ambiguity_ratio: float = 0.8
    edge_min_support: float = 0.6
    edge_search_margin_fraction: float = 0.05
    edge_context_near_fraction: float = 0.02
    edge_context_far_fraction: float = 0.03333333333333333
    edge_min_sustained_ratio: float = 0.5
    edge_support_regions: int = 4
    edge_min_region_support: float = 0.6
    edge_max_surface_variation_ratio: float = 0.5
    edge_surface_trend_degree: int = 2
    edge_min_visible_context_fraction: float = 0.008333333333333333
    edge_max_line_residual_px: float = 2.0
    edge_line_inlier_ratio: float = 0.9
    edge_max_candidates: int = 64
    edge_annotation_tolerance_fraction: float = 0.01
    edge_confirmation_frames: int = 3
    edge_confirmation_seconds: float = 0.1
    edge_reacquire_memory_s: float = 0.5
    edge_confirmation_gap_s: float = 0.25

    def __post_init__(self):
        for f in fields(self):
            value = getattr(self, f.name)
            if not isinstance(value, (int, float)) or not np.isfinite(value):
                raise ValueError(f"{f.name} must be finite and numeric")
            if f.name not in {"min_angle_deg", "max_angle_deg"} and value <= 0:
                raise ValueError(f"{f.name} must be positive")
            if f.type is int and (not isinstance(value, int) or isinstance(value, bool)):
                raise ValueError(f"{f.name} must be an integer")
        if not 0 <= self.min_angle_deg < self.max_angle_deg <= 360:
            raise ValueError("Opening range must lie within 0..360 degrees")
        if not 0 < self.min_inlier_ratio <= 1 or not 0 < self.feature_quality < 1:
            raise ValueError("Invalid ratio or feature quality")
        if not 0 < self.min_area_fraction < 1:
            raise ValueError("min_area_fraction must lie within 0..1")
        if not 0 < self.edge_search_min_y_fraction < self.edge_search_max_y_fraction <= 1:
            raise ValueError("Invalid edge search interval")
        if not 0 < self.edge_ambiguity_ratio < 1 or not 0 < self.edge_min_support <= 1 or not 0 < self.edge_search_margin_fraction < .5:
            raise ValueError("Invalid edge detection ratios")
        if not 0 < self.edge_context_near_fraction < self.edge_context_far_fraction < .1:
            raise ValueError("Invalid edge context depths")
        if self.edge_surface_trend_degree not in (1, 2):
            raise ValueError("Surface shading trend must be linear or quadratic")
        if (not 0 < self.edge_min_visible_context_fraction < self.edge_context_near_fraction
                or not 0 < self.edge_line_inlier_ratio <= 1 or self.edge_max_candidates < 2
                or not 0 < self.edge_annotation_tolerance_fraction < .05):
            raise ValueError("Invalid visible-context, line-consistency or annotation settings")
        if (not 0 < self.edge_min_sustained_ratio <= 1 or not 0 < self.edge_min_region_support <= 1
                or not 2 <= self.edge_support_regions <= 16 or self.edge_confirmation_frames < 2
                or self.edge_confirmation_seconds > self.edge_reacquire_memory_s
                or self.edge_confirmation_gap_s > self.edge_reacquire_memory_s):
            raise ValueError("Invalid edge evidence or reacquisition settings")
        if not 4 <= self.min_tracking_points <= self.max_tracking_points:
            raise ValueError("Tracking needs at least four points")
        if self.camera_min_views < 3:
            raise ValueError("Camera calibration needs at least three views")
        if not 3 <= self.uncalibrated_min_angles <= self.uncalibrated_min_images or self.uncalibrated_min_images < 4:
            raise ValueError("Uncalibrated fitting needs at least four images and three angles")


DEFAULT_LABELS = ["front left", "front right", "rear right", "rear left"]
DEFAULT_HORIZONTAL_FOV_DEG = 60.0
CORNER_MODES = ("physical", "visible-edge")
EDGE_LABELS = ["left end of moving boundary", "right end of moving boundary"]


def validate_fov(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value) or not 10 <= value <= 170:
        raise ValueError("camera.horizontal_fov_deg must be between 10 and 170 degrees")
    return float(value)


def validate_angle(angle, limits):
    if isinstance(angle, bool) or not isinstance(angle, (int, float)) or not np.isfinite(angle):
        raise ValueError("angle_deg must be a finite number")
    if not limits.min_angle_deg <= angle <= limits.max_angle_deg:
        raise ValueError(f"angle_deg must be between {limits.min_angle_deg:g} and {limits.max_angle_deg:g} degrees")
    return float(angle)


@dataclass
class Config:
    camera_index: int
    width: int
    height: int
    points: np.ndarray
    labels: list[str]
    limits: Limits
    horizontal_fov_deg: float = DEFAULT_HORIZONTAL_FOV_DEG
    uncalibrated_use_fov: bool = False
    uncalibrated_method: str = "corners"

    @classmethod
    def read(cls, path, require_measurements=True):
        data = read_json(path)
        base = data.get("base", {})
        if require_measurements and base.get("measurements_confirmed") is not True:
            raise ValueError("Measure your rectangle, edit points_mm, and set measurements_confirmed to true")
        # Camera capture and empirical fitting do not consume physical dimensions.
        points = np.asarray(base["points_mm"] if require_measurements else
                            [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], dtype=np.float64)
        # The capture UI uses one convex rectangle, ordered around its perimeter.
        if points.shape != (4, 3) or not np.isfinite(points).all():
            raise ValueError("points_mm must contain four finite XYZ points")
        if not np.allclose(points[:, 2], 0):
            raise ValueError("All model points must lie on z=0")
        w, h = points[1, 0], points[2, 1]
        expected = np.array([[0, 0, 0], [w, 0, 0], [w, h, 0], [0, h, 0]])
        if w <= 0 or h <= 0 or not np.allclose(points, expected):
            raise ValueError("Use [0,0,0], [width,0,0], [width,depth,0], [0,depth,0]")
        labels = base.get("point_labels", DEFAULT_LABELS)
        if len(labels) != 4 or any(not isinstance(s, str) or not s for s in labels):
            raise ValueError("Provide four nonempty point_labels")
        cam = data["camera"]
        if any(type(cam[k]) is not int for k in ("index", "width", "height")):
            raise ValueError("Camera index and dimensions must be integers")
        if cam["index"] < 0 or min(cam["width"], cam["height"]) <= 0:
            raise ValueError("Invalid camera index or dimensions")
        fov = validate_fov(cam.get("horizontal_fov_deg", cls.horizontal_fov_deg))
        use_fov = data.get("uncalibrated", {}).get("use_fov", False)
        if type(use_fov) is not bool:
            raise ValueError("uncalibrated.use_fov must be true or false")
        method = data.get("uncalibrated", {}).get("method", "corners")
        if method not in ("corners", "edge"):
            raise ValueError("uncalibrated.method must be corners or edge")
        return cls(cam["index"], cam["width"], cam["height"], points, labels,
                   Limits(**data.get("limits", {})), float(fov), use_fov, method)


def read_json(path):
    with Path(path).open(encoding="utf-8-sig") as stream:
        return json.load(stream)


def write_json(path, value):
    write_bytes(path, (json.dumps(value, indent=2, allow_nan=False) + "\n").encode("utf-8"))


def write_bytes(path, value):
    """Commit a complete file atomically; failed writes leave the prior file intact."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + ".", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

