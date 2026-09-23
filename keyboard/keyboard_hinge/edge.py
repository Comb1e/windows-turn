"""Fast angle estimation from a moving boundary in the lower part of the image."""
from dataclasses import dataclass, field

import cv2
import numpy as np

from .annotation import decode_image, image_path, validate_edge
from .config import Limits, read_json, validate_angle, validate_fov, write_json
from .evaluation import dataset_fingerprint, error_statistics
from .edge_evidence import boundary_evidence
from .identity import IdentityResult
from .geometry import Estimate
from .tracking import State
from .uncalibrated import PixelPlane, regress

MODEL_TYPE = "uncalibrated-moving-edge"


def edge_coordinates(edge, size):
    points = np.asarray(validate_edge(edge, size), float)
    slope = (points[1, 1] - points[0, 1]) / (points[1, 0] - points[0, 0])
    return float(points[0, 1] + slope * (size[0] / 2 - points[0, 0])), float(slope)


def edge_features(y, size, fov):
    feature = [y / size[1]]
    if fov is not None:
        focal = size[0] / (2 * np.tan(np.deg2rad(validate_fov(fov)) / 2))
        feature.append(np.arctan((y - size[1] / 2) / focal))
    return np.asarray(feature)


def fit_edge_regression(features, angles, ridge):
    mean, scale, coefficients = regress(features, angles, ridge)
    # Anchor the fitted outputs at the two measured extremes. This avoids a
    # tiny ridge bias making an actual endpoint unavailable without extrapolating.
    predicted = np.column_stack([np.ones(len(angles)), (features - mean) / scale]) @ coefficients
    low, high = float(angles.min()), float(angles.max())
    p_low, p_high = predicted[angles == low].mean(), predicted[angles == high].mean()
    if abs(p_high - p_low) < 1e-8:
        raise ValueError("Boundary positions do not distinguish the measured openings")
    gain = (high - low) / (p_high - p_low)
    coefficients *= gain
    coefficients[0] += low - gain * p_low
    return mean, scale, coefficients


@dataclass
class EdgeDetector:
    image_size: tuple
    x_range: list
    y_range: list
    slope_range: list
    polarity: int
    min_contrast: float
    min_support: float
    ambiguity_ratio: float

    def __post_init__(self):
        self.image_size = tuple(self.image_size)
        if len(self.image_size) != 2 or any(type(v) is not int or v <= 0 for v in self.image_size):
            raise ValueError("Invalid edge detector resolution")
        for interval in (self.x_range, self.y_range, self.slope_range):
            if len(interval) != 2 or not np.isfinite(interval).all() or interval[0] >= interval[1]:
                raise ValueError("Invalid edge detector search interval")
        if (not 0 <= self.x_range[0] < self.x_range[1] < self.image_size[0]
                or not 0 <= self.y_range[0] < self.y_range[1] < self.image_size[1]
                or max(abs(v) for v in self.slope_range) > .5
                or self.polarity not in (-1, 1) or not np.isfinite(self.min_contrast) or self.min_contrast <= 0
                or not 0 < self.min_support <= 1 or not 0 < self.ambiguity_ratio < 1):
            raise ValueError("Invalid edge detector settings")

    def _prepare_frame(self, frame):
        if (frame.shape[1], frame.shape[0]) != self.image_size:
            raise ValueError(f"Camera provides {frame.shape[1]}x{frame.shape[0]}; model needs {self.image_size[0]}x{self.image_size[1]}")
        factor = min(1., 640 / self.image_size[0])
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if factor < 1:
            gray = cv2.resize(gray, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
        gray = cv2.GaussianBlur(gray.astype(np.float32), (5, 5), 0)
        xs = np.linspace(*np.asarray(self.x_range) * factor, 64).astype(int)
        return gray, factor, xs

    def _refine_line(self, gray, expected, xs, factor, limits=None):
        """Shared local gradient refinement; this alone does not grant identity."""
        limits = limits or Limits()
        height = gray.shape[0]
        gap = max(2, round(height * .006))
        # Include a guard sample on either side. A peak beyond the refinement
        # window is not a supported point at the window's clipped endpoint.
        offsets = np.arange(-gap - 1, gap + 2)
        rows = np.rint(expected[:, None] + offsets).astype(int)
        differences = self.polarity * (gray[np.clip(rows - gap, 0, height - 1), xs[:, None]]
                                      - gray[np.clip(rows + gap, 0, height - 1), xs[:, None]])
        differences[(rows - gap < 0) | (rows + gap >= height)] = -np.inf
        peaks = np.argmax(differences, axis=1)
        observed = rows[np.arange(len(xs)), peaks]
        valid = (differences[np.arange(len(xs)), peaks] >= self.min_contrast) & (abs(offsets[peaks]) <= gap)
        if valid.sum() < len(xs) * self.min_support:
            return None, "Insufficient boundary support near the selected line"
        if any(region.mean() < limits.edge_min_region_support for region in np.array_split(valid, limits.edge_support_regions)):
            return None, "Boundary lacks local gradient support across its width"
        vx, vy, x0, y0 = cv2.fitLine(np.column_stack([xs[valid], observed[valid]]).astype(np.float32),
                                    cv2.DIST_HUBER, 0, .01, .01).ravel()
        if abs(vx) < 1e-5:
            return None, "Boundary is not approximately horizontal"
        slope = float(vy / vx)
        if not self.slope_range[0] <= slope <= self.slope_range[1]:
            return None, "Boundary tilt is outside the annotated range"
        residual = abs(observed[valid] - (float(y0) + slope * (xs[valid] - float(x0))))
        if np.mean(residual <= limits.edge_max_line_residual_px) < limits.edge_line_inlier_ratio:
            return None, "Boundary is curved or its gradient points do not form a consistent line"
        edge = [[x, (float(y0) + slope * (x * factor - float(x0))) / factor] for x in self.x_range]
        try:
            validate_edge(edge, self.image_size)
        except ValueError as error:
            return None, str(error)
        return np.asarray(edge), ""

    def refine_annotation(self, frame, annotated_edge, limits=None):
        """Refine the human reference during fitting, without granting live validity.

        Refine within three pixels at 640-wide processing resolution. This may
        fit a locally visible edge; training only succeeds if full-frame
        automatic detection subsequently recognizes every annotated boundary.
        """
        try:
            gray, factor, xs = self._prepare_frame(frame)
            y, slope = edge_coordinates(annotated_edge, self.image_size)
        except ValueError as error:
            return None, str(error)
        expected = y * factor + slope * (xs - gray.shape[1] / 2)
        return self._refine_line(gray, expected, xs, factor, limits)

    def detect(self, frame, hint=None, limits=None, identity=None):
        limits = limits or Limits()
        try:
            gray, factor, xs = self._prepare_frame(frame)
        except ValueError as error:
            return None, 0., str(error)
        height, width = gray.shape
        gap = max(2, round(height * .006))
        lo, hi = np.asarray(self.y_range) * factor
        if hint is not None:
            lo, hi = max(lo, hint[0] * factor), min(hi, hint[1] * factor)
        ys = np.arange(max(gap, int(np.ceil(lo))), min(height - gap, int(np.floor(hi)) + 1))
        if not len(ys):
            return None, 0., "No edge search area"
        scores, supports, slopes = [], [], []
        has_contrast = False
        for slope in np.linspace(*self.slope_range, 9):
            rows = np.rint(ys[:, None] + slope * (xs - width / 2)).astype(int)
            good = (rows - gap >= 0) & (rows + gap < height)
            above = gray[np.clip(rows - gap, 0, height - 1), xs]
            below = gray[np.clip(rows + gap, 0, height - 1), xs]
            difference = self.polarity * (above - below)
            score = np.quantile(difference, .3, axis=1)
            score[~good.all(axis=1)] = -np.inf
            support = np.mean(difference >= self.min_contrast, axis=1)
            has_contrast |= bool(np.any((score >= self.min_contrast) & (support >= self.min_support)))
            score[support < self.min_support] = -np.inf
            scores.append(score)
            supports.append(support)
            slopes.append(slope)
        scores, supports = np.asarray(scores), np.asarray(supports)
        if not has_contrast:
            return None, 0., "Moving boundary not visible or contrast too weak"
        # Propose local peaks, then validate the refined lines before deciding
        # which candidates compete. A bad high-scoring line must not terminate
        # detection or make a supported weaker line appear ambiguous.
        padded = np.pad(scores, ((0, 0), (gap, gap)), constant_values=-np.inf)
        maxima = np.maximum.reduce([padded[:, offset:offset + len(ys)] for offset in range(2 * gap + 1)])
        candidates = np.argwhere((scores >= self.min_contrast) & (scores == maxima))
        ordered = sorted(candidates, key=lambda index: scores[tuple(index)], reverse=True)
        best = None
        reason = "Boundary lacks sustained contrast, full-width support, or consistent laptop-side surface"
        for index, (s, row) in enumerate(ordered):
            strength, support = float(scores[s, row]), float(supports[s, row])
            if best is not None and strength < best[2] * self.ambiguity_ratio:
                break
            if index >= limits.edge_max_candidates:
                return None, 0., "Too many competing boundary candidates"
            expected = ys[row] + slopes[s] * (xs - width / 2)
            edge, refinement_reason = self._refine_line(gray, expected, xs, factor, limits)
            if edge is None:
                reason = refinement_reason
                continue
            y, slope = edge_coordinates(edge, self.image_size)
            refined_rows = np.rint(y * factor + slope * (xs - width / 2)).astype(int)
            if not boundary_evidence(gray, refined_rows, xs, self.polarity, self.min_contrast, np.asarray(strength), limits):
                continue
            verdict = None
            if identity is not None:
                try:
                    verdict = identity.verify(edge)
                except Exception as error:
                    verdict = IdentityResult("unavailable", f"Keyboard identity failed: {error}")
                identity.last = verdict
                if verdict.status != "accepted":
                    reason = verdict.reason or "Keyboard identity is uncertain"
                    continue
            if best is None:
                best = (edge, y, strength, support, verdict)
            elif abs(y - best[1]) * factor > max(6, height * .025):
                if identity is not None:
                    identity.last = IdentityResult("rejected", "Multiple verified boundaries are ambiguous")
                return None, 0., "Multiple plausible boundaries; use S to select the moving edge"
        if best is None:
            if identity is not None and identity.last.reason and identity.last.status != 'accepted':
                reason = identity.last.reason
            return None, 0., reason
        edge, _, strength, support, verdict = best
        if identity is not None:
            identity.last = verdict
        confidence = min(1., strength / (self.min_contrast * 3)) * support
        return edge, confidence, ""


@dataclass
class EdgeModel:
    image_size: tuple
    mean: np.ndarray
    scale: np.ndarray
    coefficients: np.ndarray
    training_range: list
    position_range: list
    detector: EdgeDetector
    training_ids: list
    training_fingerprint: str
    validation: dict
    horizontal_fov_deg: float | None = None
    corner_mode: str = field(default="visible-edge", init=False)

    def __post_init__(self):
        self.image_size = tuple(self.image_size)
        if self.horizontal_fov_deg is not None:
            validate_fov(self.horizontal_fov_deg)
        count = 1 if self.horizontal_fov_deg is None else 2
        self.mean, self.scale, self.coefficients = (np.asarray(v, float) for v in (self.mean, self.scale, self.coefficients))
        if (self.mean.shape != (count,) or self.scale.shape != (count,) or self.coefficients.shape != (count + 1,)
                or not all(np.isfinite(v).all() for v in (self.mean, self.scale, self.coefficients)) or np.any(self.scale <= 0)
                or self.image_size != self.detector.image_size):
            raise ValueError("Invalid moving-edge model arrays or resolution")
        for interval in (self.training_range, self.position_range):
            if len(interval) != 2 or not np.isfinite(interval).all() or interval[0] >= interval[1]:
                raise ValueError("Invalid edge model range")
        if not 0 <= self.training_range[0] < self.training_range[1] <= 360:
            raise ValueError("Invalid edge model angle range")
        if not isinstance(self.training_ids, list) or len(self.training_ids) < 4 or len(set(self.training_ids)) != len(self.training_ids):
            raise ValueError("Invalid edge training IDs")
        if not isinstance(self.validation, dict) or not isinstance(self.training_fingerprint, str) or len(self.training_fingerprint) != 64:
            raise ValueError("Invalid edge model metadata")

    def predict(self, edge, limits=None):
        try:
            y, _ = edge_coordinates(edge, self.image_size)
        except ValueError as error:
            return Estimate(None, 0., str(error))
        if not self.position_range[0] - 1e-6 <= y <= self.position_range[1] + 1e-6:
            return Estimate(None, 0., "Boundary is outside the annotated position range")
        angle = float(np.r_[1., (edge_features(y, self.image_size, self.horizontal_fov_deg) - self.mean) / self.scale] @ self.coefficients)
        lo, hi = self.training_range
        if limits is not None:
            lo, hi = max(lo, limits.min_angle_deg), min(hi, limits.max_angle_deg)
        if not lo - 1e-6 <= angle <= hi + 1e-6:
            return Estimate(None, 0., "Predicted angle is outside the annotated angle range")
        return Estimate(float(np.clip(angle, lo, hi)), 1., "")

    def predict_frame(self, frame, limits=None, hint=None, verifier=None):
        try:
            if verifier is not None:
                verifier.start_frame(frame)
            edge, confidence, reason = self.detector.detect(frame, hint, limits, verifier)
        except Exception as error:
            if verifier is None:
                raise
            verifier.last = IdentityResult("unavailable", f"Keyboard identity failed: {error}")
            return Estimate(None, 0., verifier.last.reason), None
        finally:
            if verifier is not None:
                verifier.end_frame()
        if edge is None:
            return Estimate(None, 0., reason), None
        result = self.predict(edge, limits)
        result.confidence *= confidence
        return result, edge if result.angle_deg is not None else None

    def save(self, path):
        from dataclasses import asdict
        data = asdict(self)
        for name in ("mean", "scale", "coefficients"):
            data[name] = getattr(self, name).tolist()
        write_json(path, {**data, "schema_version": 1, "type": MODEL_TYPE})

    @classmethod
    def read(cls, path):
        data = read_json(path)
        if not isinstance(data, dict) or data.get("type") != MODEL_TYPE or data.get("schema_version") != 1:
            raise ValueError("Unsupported moving-edge model")
        try:
            data["detector"] = EdgeDetector(**data["detector"])
            return cls(**{key: data[key] for key, f in cls.__dataclass_fields__.items() if f.init})
        except (TypeError, KeyError) as error:
            raise ValueError(f"Malformed moving-edge model: {error}") from error


def annotation_edge(annotation):
    # Existing cropped-region labels already mark the moving boundary first.
    return annotation.edge if annotation.edge is not None else annotation.corners[:2]


def fit_edge_model(samples, input_dir, limits=None, horizontal_fov_deg=None):
    limits = limits or Limits()
    if len(samples) < limits.uncalibrated_min_images or len({s.annotation.angle_deg for s in samples}) < limits.uncalibrated_min_angles:
        raise ValueError("Edge fitting needs at least four photos and three distinct measured angles")
    if len({s.size for s in samples}) != 1:
        raise ValueError("Edge reference photos must have the same resolution")
    size = samples[0].size
    edges = [validate_edge(annotation_edge(s.annotation), size) for s in samples]
    positions, slopes = np.array([edge_coordinates(edge, size) for edge in edges]).T
    search_low, search_high = limits.edge_search_min_y_fraction * size[1], limits.edge_search_max_y_fraction * size[1]
    if np.any(positions < search_low) or np.any(positions > search_high):
        raise ValueError("Mark the moving boundary in the configured lower-half search area")
    if np.ptp(positions) < max(4, size[1] * .02):
        raise ValueError("The edge barely moves; mark the moving boundary, not the photo bottom")
    if np.any(np.abs(slopes) > .25):
        raise ValueError("The moving boundary must be approximately horizontal")
    x_range = [max(edge[0][0] for edge in edges), min(edge[1][0] for edge in edges)]
    span = x_range[1] - x_range[0]
    if span < size[0] * .25:
        raise ValueError("Mark a wide boundary segment spanning at least a quarter of the image")
    x_range = [x_range[0] + span * .05, x_range[1] - span * .05]
    frames = [decode_image(image_path(input_dir, s.annotation.item_id).read_bytes(), limits) for s in samples]
    contrasts = []
    for frame, position, slope in zip(frames, positions, slopes):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(float)
        xs = np.linspace(*x_range, 64).astype(int)
        rows = np.rint(position + slope * (xs - size[0] / 2)).astype(int)
        gap = max(3, round(size[1] * .012))
        contrasts.append(float(np.median(gray[np.clip(rows - gap, 0, size[1] - 1), xs] -
                                        gray[np.clip(rows + gap, 0, size[1] - 1), xs])))
    if abs(np.median(contrasts)) < limits.edge_min_contrast:
        raise ValueError("Annotated boundary has too little contrast; mark its visible transition")
    polarity = 1 if np.median(contrasts) > 0 else -1
    if any(contrast * polarity < limits.edge_min_contrast for contrast in contrasts):
        raise ValueError("Boundary contrast direction differs between reference photos")
    margin = size[1] * limits.edge_search_margin_fraction
    detector = EdgeDetector(size, x_range, [max(search_low, positions.min() - margin), min(search_high, positions.max() + margin)],
                            [float(slopes.min() - .03), float(slopes.max() + .03)], polarity,
                            limits.edge_min_contrast, limits.edge_min_support, limits.edge_ambiguity_ratio)
    refined, refinement_rows = [], []
    for sample, frame, position, annotated_edge in zip(samples, frames, positions, edges):
        edge, _, reason = detector.detect(frame, (position - max(6, size[1] * .02), position + max(6, size[1] * .02)), limits)
        source = "automatic-detection"
        if edge is None:
            source = "annotation-local-refinement"
            edge, refinement_reason = detector.refine_annotation(frame, annotated_edge, limits)
            if edge is None:
                raise ValueError(f"{sample.annotation.item_id}: {refinement_reason}. Automatic detection: {reason}")
        refined.append(edge_coordinates(edge, size)[0])
        refinement_rows.append({"item_id": sample.annotation.item_id, "source": source,
                                "annotated_y": float(position), "refined_y": refined[-1], "automatic_reason": reason})
    y = np.array([validate_angle(sample.annotation.angle_deg, limits) for sample in samples])
    order = np.argsort(refined)
    differences = np.diff(y[order])
    if np.any(differences > 0) and np.any(differences < 0):
        raise ValueError("Boundary height and angle labels are inconsistent; review the marked edge")
    features = np.array([edge_features(position, size, horizontal_fov_deg) for position in refined])
    mean, scale, coefficients = fit_edge_regression(features, y, limits.uncalibrated_ridge)
    rows = []
    for angle in np.unique(y):
        train = y != angle
        fm, fs, fc = fit_edge_regression(features[train], y[train], limits.uncalibrated_ridge)
        for i in np.flatnonzero(~train):
            estimate = float(np.r_[1., (features[i] - fm) / fs] @ fc)
            rows.append({"item_id": samples[i].annotation.item_id, "expected": float(y[i]), "estimated": estimate,
                         "error": abs(estimate - y[i]), "reason": ""})
    training_error = abs(np.column_stack([np.ones(len(y)), (features - mean) / scale]) @ coefficients - y)
    validation = {"method": "leave-one-angle-out using refined annotated boundary positions", "metrics": error_statistics(rows),
                  "rows": rows, "training_mae_deg": float(training_error.mean()),
                  "warning_threshold_deg": limits.uncalibrated_max_validation_mae_deg,
                  "boundary_refinement": refinement_rows}
    model = EdgeModel(size, mean, scale, coefficients, [float(y.min()), float(y.max())],
                     [float(min(refined)), float(max(refined))], detector,
                     [s.annotation.item_id for s in samples], dataset_fingerprint(samples), validation, horizontal_fov_deg)
    automatic_rows = []
    tolerance = max(1., size[1] * limits.edge_annotation_tolerance_fraction)
    for sample, frame, annotated_edge in zip(samples, frames, edges):
        result, detected_edge = model.predict_frame(frame, limits)
        expected = sample.annotation.angle_deg
        boundary_error = None
        if detected_edge is not None:
            detected_y, detected_slope = edge_coordinates(detected_edge, size)
            annotated_y, annotated_slope = edge_coordinates(annotated_edge, size)
            boundary_error = float(max(abs(detected_y - annotated_y + (detected_slope - annotated_slope) * (x - size[0] / 2))
                                       for x in detector.x_range))
        automatic_rows.append({"item_id": sample.annotation.item_id, "expected": expected,
                               "estimated": result.angle_deg, "reason": result.reason,
                               "boundary_error_px": boundary_error,
                               "recognized": boundary_error is not None and boundary_error <= tolerance,
                               "error": abs(result.angle_deg - expected) if result.angle_deg is not None else None})
    validation["automatic_detection"] = {"method": "full-frame detection on fitting images; not independent validation",
                                         "annotation_tolerance_px": tolerance,
                                         "metrics": error_statistics(automatic_rows), "rows": automatic_rows}
    failed = [row for row in automatic_rows if not row["recognized"]]
    if failed:
        descriptions = [f"{row['item_id']}: {row['reason'] or 'detected a different boundary from the annotation'}" for row in failed]
        raise ValueError("Training requires automatic recognition of every annotated boundary. " + "; ".join(descriptions))
    return model


class EdgeSession:
    """Nullable output with retained identity and confirmed acquisition after loss."""
    def __init__(self, model, limits, verifier=None):
        self.model, self.limits = model, limits
        self.verifier = verifier
        self.camera = PixelPlane(model.image_size)
        self.hint = None
        self.last_time = self.last_y = self.last_angle = self.input_time = None
        self.pending = None
        self.reject(State.WAITING, "Looking for the moving boundary in the lower half")

    def reject(self, state, reason, clear_pending=True):
        self.state, self.result = state, Estimate(None, 0., reason)
        self.corners = None
        if clear_pending:
            self.pending = None
        # A failure clears public output, not the last accepted identity. Otherwise
        # one bad frame disables the speed gate and allows a different line to win.
        return self.result

    def initialize(self, frame, edge, timestamp):
        try:
            y, _ = edge_coordinates(edge, self.model.image_size)
        except ValueError as error:
            return self.reject(State.UNRELIABLE, str(error))
        margin = self.model.image_size[1] * self.limits.edge_search_margin_fraction
        self.hint = (y - margin, y + margin)
        self.last_time = self.last_y = self.last_angle = self.input_time = None
        self.reject(State.WAITING, "Searching near selected boundary")
        return self.update(frame, timestamp)

    def update(self, frame, timestamp):
        if not np.isfinite(timestamp) or (self.input_time is not None and timestamp <= self.input_time):
            return self.reject(State.UNRELIABLE, "Frame timestamps must strictly increase")
        self.input_time = timestamp
        hint = self.hint
        self.hint = None
        remembered = self.last_time is not None and timestamp - self.last_time <= self.limits.edge_reacquire_memory_s
        if remembered:
            margin = self.model.image_size[1] * self.limits.edge_search_margin_fraction
            hint = (self.last_y - margin, self.last_y + margin)
        elif self.pending is not None and timestamp - self.pending["time"] <= self.limits.edge_confirmation_gap_s:
            margin = self.model.image_size[1] * self.limits.edge_search_margin_fraction
            hint = (self.pending["y"] - margin, self.pending["y"] + margin)
        result, edge = self.model.predict_frame(frame, self.limits, hint, self.verifier)
        if result.angle_deg is None:
            return self.reject(State.LOST, result.reason)
        if remembered:
            elapsed = timestamp - self.last_time
            if abs(result.angle_deg - self.last_angle) > self.limits.max_speed_deg_s * elapsed:
                return self.reject(State.UNRELIABLE, "Boundary motion exceeds the configured speed limit")
        y = edge_coordinates(edge, self.model.image_size)[0]
        if self.state != State.TRACKING or not remembered:
            pending = self.pending
            if (pending is None or timestamp - pending["time"] > self.limits.edge_confirmation_gap_s
                    or abs(result.angle_deg - pending["angle"]) > self.limits.max_speed_deg_s * (timestamp - pending["time"])):
                pending = {"start": timestamp, "count": 0}
            pending.update(time=timestamp, angle=result.angle_deg, y=y, count=pending["count"] + 1)
            self.pending = pending
            if (pending["count"] < self.limits.edge_confirmation_frames
                    or timestamp - pending["start"] + 1e-9 < self.limits.edge_confirmation_seconds):
                return self.reject(State.WAITING, "Confirming laptop boundary across consecutive frames", clear_pending=False)
        self.state, self.result, self.corners = State.TRACKING, result, edge
        self.last_time, self.last_y, self.last_angle = timestamp, y, result.angle_deg
        self.pending = None
        return result

    def record(self, timestamp):
        return {"timestamp_monotonic_s": timestamp, "state": self.state.value, "mode": "moving-edge",
                "angle_deg": self.result.angle_deg, "confidence": self.result.confidence,
                "reason": self.result.reason, "edge": self.corners.tolist() if self.corners is not None else None}


def read_uncalibrated_model(path):
    from .uncalibrated import UncalibratedModel
    return EdgeModel.read(path) if read_json(path).get("type") == MODEL_TYPE else UncalibratedModel.read(path)
