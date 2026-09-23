"""Offline validation shared by geometric and empirical estimators."""
import hashlib
import json
from pathlib import Path

import numpy as np

from .annotation import decode_image, image_path, load_sample, read_records
from .geometry import estimate


def dataset_fingerprint(samples):
    payload = [sample.fingerprint_payload() for sample in sorted(samples, key=lambda s: s.annotation.item_id)]
    return hashlib.sha256(json.dumps(payload, sort_keys=True, allow_nan=False).encode()).hexdigest()


def error_statistics(rows):
    valid = [row for row in rows if row["error"] is not None]
    errors = [float(row["error"]) for row in valid]
    return {"count": len(rows), "success": len(valid), "failures": len(rows) - len(valid),
            "mean_abs_error": float(np.mean(errors)) if errors else None,
            "median_abs_error": float(np.median(errors)) if errors else None,
            "max_abs_error": float(max(errors)) if errors else None,
            "worst_cases": sorted(valid, key=lambda row: row["error"], reverse=True)[:5]}


def evaluate(annotations, camera, config, hinge, input_dir=None, model=None, reference_ids=(), include_training=False):
    input_dir = Path(input_dir) if input_dir is not None else Path(annotations).with_suffix("")
    fitted = set(model.training_ids if model is not None else reference_ids)
    size = model.image_size if model is not None else camera.size
    rows = []
    for value in read_records(annotations):
        item_id = value.get("item_id", "<invalid>") if isinstance(value, dict) else "<invalid>"
        row = {"item_id": item_id, "expected": None, "estimated": None, "error": None,
               "reason": "", "used_for_fit": item_id in fitted}
        try:
            sample = load_sample(value, input_dir, config.limits, size)
            annotation = sample.annotation
            row["expected"] = annotation.angle_deg
            if model is None and annotation.corner_mode != "physical":
                raise ValueError("Moving-edge annotations require an uncalibrated model")
            if model is not None and getattr(model, "corner_mode", None) == "visible-edge":
                frame = decode_image(image_path(input_dir, annotation.item_id).read_bytes(), config.limits)
                result, _ = model.predict_frame(frame, config.limits)
            elif model is not None:
                if annotation.corner_mode != "physical":
                    raise ValueError("Two-point annotations require a moving-edge model")
                result = model.predict(annotation.corners, config.limits)
            else:
                result = estimate(config.points, np.asarray(annotation.corners), camera, hinge, config.limits)
            row.update(estimated=result.angle_deg,
                       error=abs(result.angle_deg - annotation.angle_deg) if result.angle_deg is not None else None,
                       reason=result.reason)
        except (ValueError, OSError, TypeError) as error:
            row["reason"] = str(error)
        rows.append(row)
    included = rows if include_training else [row for row in rows if not row["used_for_fit"]]
    metrics = error_statistics(included)
    metrics.update(total_images=len(rows), fitted_images=sum(row["used_for_fit"] for row in rows),
                   includes_training=include_training)
    return rows, metrics
