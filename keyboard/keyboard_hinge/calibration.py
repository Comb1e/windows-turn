import cv2
import numpy as np
from pathlib import Path

from .capture import WINDOW, freeze_base, keypress, open_camera, overlay, read_frame
from .config import validate_fov, write_json
from .geometry import Camera, Hinge, calibrate_hinge, planar_poses, rotation_x, rotation_distance
from .annotation import load_samples
from .evaluation import dataset_fingerprint

def approximate_camera(width, height, horizontal_fov_deg):
    horizontal_fov_deg = validate_fov(horizontal_fov_deg)
    if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
        raise ValueError("Image dimensions must be positive integers")
    fx = width / (2 * np.tan(np.deg2rad(horizontal_fov_deg) / 2))
    return Camera(np.array([[fx, 0., width / 2], [0., fx, height / 2], [0., 0., 1.]]), np.zeros(5), (int(width), int(height)))


def fit_camera(object_views, image_views, size, max_rms):
    if len(object_views) < 3 or len(object_views) != len(image_views):
        raise ValueError("At least three matching checkerboard views are required")
    rms, matrix, distortion, rvecs, tvecs = cv2.calibrateCamera(object_views, image_views, size, None, None)
    per_view = []
    for objects, pixels, rvec, tvec in zip(object_views, image_views, rvecs, tvecs):
        projected = cv2.projectPoints(objects, rvec, tvec, matrix, distortion)[0]
        per_view.append(float(np.sqrt(np.mean(np.sum((projected.reshape(-1, 2) - pixels.reshape(-1, 2)) ** 2, axis=1)))))
    if not np.isfinite(rms) or rms > max_rms or max(per_view) > 2 * max_rms:
        raise ValueError(f"Calibration error too large (RMS {rms:.2f}px); recapture sharp, varied checkerboard views")
    return Camera(matrix, distortion, size), float(rms), per_view


def capture_camera(config, columns, rows, square_mm, output):
    if columns < 3 or rows < 3 or not np.isfinite(square_mm) or square_mm <= 0:
        raise ValueError("Use at least 3x3 inner corners and a positive square size in millimeters")
    board = (columns, rows)
    objects = np.zeros((columns * rows, 3), np.float32)
    objects[:, :2] = np.mgrid[0:columns, 0:rows].T.reshape(-1, 2) * square_mm
    image_views, object_views = [], []
    size = None
    with open_camera(config) as capture:
        while True:
            frame = read_frame(capture)
            current_size = (frame.shape[1], frame.shape[0])
            if current_size != (config.width, config.height):
                raise ValueError(f"Webcam provides {current_size}; set that resolution in the config and retry")
            if size is not None and current_size != size:
                raise ValueError("Webcam resolution changed during calibration")
            size = current_size
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            found, corners = cv2.findChessboardCornersSB(gray, board)
            preview = frame.copy()
            if found:
                cv2.drawChessboardCorners(preview, board, corners, found)
            lines = [f"Checkerboard views: {len(image_views)}/{config.limits.camera_min_views} minimum",
                     "Space: capture | C: calibrate/save | Q/Esc: quit", "Move and tilt board across image; keep webcam settings fixed"]
            cv2.imshow(WINDOW, overlay(preview, lines))
            key = keypress()
            if key == 32:
                if not found:
                    print("All checkerboard inner corners must be visible.")
                    continue
                if any(np.sqrt(np.mean(np.sum((corners - old) ** 2, axis=2))) < config.limits.camera_duplicate_distance_px for old in image_views):
                    print("View too similar to a saved view; move or tilt the checkerboard.")
                    continue
                image_views.append(corners.astype(np.float32))
                object_views.append(objects.copy())
                print(f"Captured view {len(image_views)}")
            elif key == ord("c"):
                if len(image_views) < config.limits.camera_min_views:
                    print(f"Capture at least {config.limits.camera_min_views} varied views first.")
                    continue
                camera, rms, per_view = fit_camera(object_views, image_views, size, config.limits.camera_max_rms_px)
                data = camera.payload()
                data.update({"source": "checkerboard", "rms_px": rms, "per_view_rms_px": per_view, "checkerboard_inner_corners": board,
                             "square_mm": square_mm, "image_points": [v.reshape(-1, 2).tolist() for v in image_views]})
                write_json(output, data)
                print(f"Saved camera calibration to {output}; RMS {rms:.3f}px")
                return


def capture_hinge(config, camera, angles, output):
    # Validate reference angles before opening the webcam.
    separation = abs(angles[1] - angles[0])
    if not all(np.isfinite(a) and config.limits.min_angle_deg <= a <= config.limits.max_angle_deg for a in angles):
        raise ValueError("Reference angles must be within the configured opening range")
    if not config.limits.min_reference_separation_deg <= separation <= 180 - config.limits.min_reference_separation_deg:
        raise ValueError(f"Reference angles must be separated by at least {config.limits.min_reference_separation_deg:g} degrees and well below 180 degrees")
    samples, records = [], []
    with open_camera(config, camera) as capture:
        for angle in angles:
            while True:
                _, corners = freeze_base(capture, camera, config.labels, f"Set opening angle to {angle:g} deg (measure from closed = 0)")
                poses, reason = planar_poses(config.points, corners, camera, config.limits)
                if poses:
                    samples.append(poses)
                    records.append({"angle_deg": angle, "image_points": corners.tolist()})
                    break
                print(f"Rejected: {reason}. Try again.")
        hinge, residual = calibrate_hinge(samples[0], angles[0], samples[1], angles[1], config.limits)
        hinge.save(output, camera, config.points, list(angles))
        write_json(str(output) + ".observations.json", {"references": records, "mount_agreement_deg": residual})
        print(f"Saved hinge calibration to {output}; mount agreement {residual:.3f} deg")


def calibrate_hinge_annotations(config, camera, annotations_path, output, input_dir=None, reference_ids=None):
    input_dir = input_dir or Path(annotations_path).with_suffix("")
    samples = load_samples(annotations_path, input_dir, config.limits, camera.size, reference_ids)
    if len(samples) < 2:
        raise ValueError("Need at least two annotated references with four corners")
    if any(sample.annotation.corner_mode != "physical" for sample in samples):
        raise ValueError("Geometric calibration requires the same physical rectangle; use train-uncalibrated for moving-edge labels")
    samples.sort(key=lambda sample: sample.annotation.angle_deg)
    records = [sample.annotation for sample in samples]
    if len({np.sign(cv2.contourArea(np.asarray(a.corners, np.float32), oriented=True)) for a in records}) != 1:
        raise ValueError("Inconsistent corner order between reference images")
    candidates = []
    for annotation in records:
        poses, reason = planar_poses(config.points, annotation.corners, camera, config.limits)
        if not poses:
            raise ValueError(f"{annotation.item_id}: {reason}")
        candidates.append(poses)
    hinge, _ = calibrate_hinge(candidates[0], records[0].angle_deg, candidates[-1], records[-1].angle_deg, config.limits)
    mounts = []
    for annotation, poses in zip(records, candidates):
        choices = [(rotation_distance(hinge.mount, pose.rotation @ rotation_x(-hinge.sign * annotation.angle_deg)),
                    pose.reprojection_px, pose.rotation @ rotation_x(-hinge.sign * annotation.angle_deg)) for pose in poses]
        choices.sort(key=lambda item: item[0] / config.limits.max_hinge_residual_deg + item[1] / config.limits.max_reprojection_px)
        best = choices[0]
        if best[0] > config.limits.max_hinge_residual_deg:
            raise ValueError(f"{annotation.item_id}: reference does not agree with hinge-only motion; check angle and corner order")
        for alternative in choices[1:]:
            if (abs(alternative[0] - best[0]) <= config.limits.ambiguity_margin_deg
                    and abs(alternative[1] - best[1]) <= config.limits.ambiguity_reprojection_margin_px
                    and rotation_distance(alternative[2], best[2]) > config.limits.ambiguity_separation_deg):
                raise ValueError(f"{annotation.item_id}: ambiguous reference pose")
        mounts.append(best[2])
    u, _, vt = np.linalg.svd(np.sum(mounts, axis=0))
    hinge = Hinge(u @ np.diag([1., 1., np.linalg.det(u @ vt)]) @ vt, hinge.sign)
    residual = max(rotation_distance(hinge.mount, mount) for mount in mounts)
    if residual > config.limits.max_hinge_residual_deg:
        raise ValueError("References disagree after fitting; check corner order and measured angles")
    hinge.save(output, camera, config.points, [a.angle_deg for a in records], [a.item_id for a in records])
    write_json(str(output) + ".observations.json",
               {"references": [sample.fingerprint_payload() for sample in samples],
                "training_fingerprint": dataset_fingerprint(samples), "mount_agreement_deg": residual})
    return hinge, residual
