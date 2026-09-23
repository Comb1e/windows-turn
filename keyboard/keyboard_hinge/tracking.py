"""Track calibrated plane features without inventing a pose after losing the base."""
from enum import Enum

import cv2
import numpy as np

from .geometry import Estimate, estimate


class State(str, Enum):
    WAITING = "waiting_for_base"
    TRACKING = "tracking"
    LOST = "base_not_visible"
    UNRELIABLE = "unreliable_pose"


class PlaneTracker:
    def __init__(self, camera, limits):
        self.camera = camera
        self.limits = limits
        self.clear()

    def clear(self):
        self.previous_gray = None
        self.pixels = None
        self.objects = None
        self.started = None

    def initialize(self, frame, model, corners, timestamp):
        self.clear()
        self.camera.check_frame(frame)
        corners = np.asarray(corners, np.float32).reshape(-1, 2)
        if corners.shape != (4, 2) or not np.isfinite(corners).all():
            raise ValueError("Select four corners in the configured order")
        contour = corners.reshape(-1, 1, 2)
        if not cv2.isContourConvex(contour):
            raise ValueError("The corners must form a convex rectangle in perimeter order")
        area = cv2.contourArea(contour)
        if area / (self.camera.size[0] * self.camera.size[1]) < self.limits.min_area_fraction:
            raise ValueError("Selected base is too small or too edge-on")
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        mask = np.zeros_like(gray)
        cv2.fillConvexPoly(mask, corners.astype(np.int32), 255)
        features = cv2.goodFeaturesToTrack(gray, self.limits.max_tracking_points,
                                           self.limits.feature_quality, self.limits.feature_spacing_px, mask=mask)
        if features is None or len(features) < self.limits.min_tracking_points:
            raise ValueError("Not enough texture inside the rectangle; select a visible keyboard region")
        pixels = features.reshape(-1, 2)
        homography = cv2.getPerspectiveTransform(self.camera.undistort(corners).astype(np.float32),
                                                 np.asarray(model[:, :2], np.float32))
        xy = cv2.perspectiveTransform(self.camera.undistort(pixels).reshape(-1, 1, 2), homography).reshape(-1, 2)
        self.objects = np.column_stack([xy, np.zeros(len(xy))])
        self.pixels = pixels.astype(np.float32)
        self.previous_gray = gray
        self.started = timestamp

    def update(self, frame, timestamp):
        self.camera.check_frame(frame)
        if self.previous_gray is None:
            return None, None, "Select the base with S"
        if timestamp - self.started >= self.limits.max_tracking_age_s:
            self.clear()
            return None, None, "Reselect the base with S to limit optical-flow drift"
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        options = dict(winSize=(self.limits.lk_window_px, self.limits.lk_window_px),
                       maxLevel=self.limits.lk_pyramid_levels)
        forward, ok1, _ = cv2.calcOpticalFlowPyrLK(self.previous_gray, gray, self.pixels, None, **options)
        if forward is None or ok1 is None:
            self.clear()
            return None, None, "Base not visible: optical flow failed"
        backward, ok2, _ = cv2.calcOpticalFlowPyrLK(gray, self.previous_gray, forward, None, **options)
        if backward is None or ok2 is None:
            self.clear()
            return None, None, "Base not visible: reverse optical flow failed"
        valid = ok1.ravel().astype(bool) & ok2.ravel().astype(bool)
        valid &= np.isfinite(forward).all(axis=1) & np.isfinite(backward).all(axis=1)
        valid &= np.linalg.norm(self.pixels - backward, axis=1) <= self.limits.forward_backward_px
        valid &= (forward[:, 0] >= 0) & (forward[:, 0] < gray.shape[1])
        valid &= (forward[:, 1] >= 0) & (forward[:, 1] < gray.shape[0])
        if valid.sum() < self.limits.min_tracking_points:
            self.clear()
            return None, None, "Base not visible: too few tracked features; press S to reselect"
        self.objects = self.objects[valid]
        self.pixels = forward[valid]
        self.previous_gray = gray
        return self.objects, self.pixels, ""


class Session:
    """Every failed observation clears the output angle and requires reinitialization."""

    def __init__(self, camera, hinge, limits):
        self.camera, self.hinge, self.limits = camera, hinge, limits
        self.tracker = PlaneTracker(camera, limits)
        self.state = State.WAITING
        self.result = Estimate(None, 0., "Select the visible base with S")
        self.last_time = None

    def reject(self, state, reason):
        self.state = state
        self.result = Estimate(None, 0., reason)
        self.last_time = None
        self.tracker.clear()
        return self.result

    def initialize(self, frame, model, corners, timestamp):
        result = estimate(model, corners, self.camera, self.hinge, self.limits)
        if result.angle_deg is None:
            return self.reject(State.UNRELIABLE, result.reason)
        try:
            self.tracker.initialize(frame, model, corners, timestamp)
        except ValueError as error:
            return self.reject(State.UNRELIABLE, str(error))
        self.state, self.result, self.last_time = State.TRACKING, result, timestamp
        return result

    def update(self, frame, timestamp):
        if self.state != State.TRACKING:
            return self.result
        objects, pixels, reason = self.tracker.update(frame, timestamp)
        if objects is None:
            return self.reject(State.LOST, reason)
        result = estimate(objects, pixels, self.camera, self.hinge, self.limits,
                          previous=self.result.angle_deg, elapsed=timestamp - self.last_time)
        if result.angle_deg is None:
            return self.reject(State.UNRELIABLE, result.reason)
        self.result, self.last_time = result, timestamp
        return result

    def record(self, timestamp):
        result = self.result
        return {"timestamp_monotonic_s": timestamp, "state": self.state.value,
                "angle_deg": result.angle_deg, "confidence": result.confidence,
                "reprojection_px": result.pose.reprojection_px if result.pose else None,
                "hinge_residual_deg": result.hinge_residual_deg, "reason": result.reason}
