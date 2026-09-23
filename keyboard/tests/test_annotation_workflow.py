from dataclasses import asdict
import json

import cv2
import numpy as np
import pytest

from keyboard_hinge.annotation import load_samples
from keyboard_hinge.calibration import approximate_camera, calibrate_hinge_annotations
from keyboard_hinge.cli import main, parser
from keyboard_hinge.config import Config, Limits, write_json
from keyboard_hinge.evaluation import evaluate
from keyboard_hinge.geometry import Hinge, estimate, rotation_distance
from keyboard_hinge.tracking import State
from keyboard_hinge.uncalibrated import UncalibratedModel, UncalibratedSession, corner_features, fit_model


def test_hinge_annotations_and_independent_evaluation(dataset, tmp_path):
    directory, path, camera, hinge, config, frame, _ = dataset
    output = tmp_path / "hinge.json"
    fitted, residual = calibrate_hinge_annotations(config, camera, path, output, directory,
                                                   ["angle-10.png", "angle-45.png"])
    assert residual < .01
    assert rotation_distance(fitted.mount, hinge.mount) < .01
    assert Hinge.read(output, camera, config.points).sign == 1
    refs = json.loads(output.read_text())["reference_ids"]
    rows, metrics = evaluate(path, camera, config, fitted, directory, reference_ids=refs)
    assert len(rows) == 5
    assert metrics["count"] == metrics["success"] == 3
    assert metrics["mean_abs_error"] < .01
    for angle in (10., 20., 30., 45.):
        result = estimate(config.points, frame(angle)[1], camera, fitted, config.limits)
        assert result.angle_deg == pytest.approx(angle, abs=.01)
    for angle in (9.9, 45.1):
        assert estimate(config.points, frame(angle)[1], camera, fitted, config.limits).angle_deg is None
    (directory / "angle-18.png").write_bytes(b"malformed")
    rows, metrics = evaluate(path, camera, config, fitted, directory)
    assert metrics["failures"] == 1
    assert rows[1]["reason"]
    assert metrics["worst_cases"]


def test_hinge_fits_all_references_and_rejects_bad_middle_sample(dataset, tmp_path):
    directory, path, camera, hinge, config, frame, _ = dataset
    output = tmp_path / "hinge.json"
    _, residual = calibrate_hinge_annotations(config, camera, path, output, directory)
    assert residual < .01
    assert len(json.loads(output.read_text())["reference_ids"]) == 5
    data = json.loads(path.read_text())
    data["annotations"][2]["corners"] = frame(26, .3)[1].tolist()
    write_json(path, data)
    previous = output.read_bytes()
    with pytest.raises(ValueError, match="hinge-only"):
        calibrate_hinge_annotations(config, camera, path, output, directory)
    assert output.read_bytes() == previous
    data["annotations"][2]["corners"] = frame(26)[1][::-1].tolist()
    write_json(path, data)
    with pytest.raises(ValueError, match="corner order"):
        calibrate_hinge_annotations(config, camera, path, output, directory)


def test_hinge_insufficient_separation(dataset, tmp_path):
    directory, path, camera, _, config, _, _ = dataset
    with pytest.raises(ValueError, match="separated"):
        calibrate_hinge_annotations(config, camera, path, tmp_path / "hinge.json", directory,
                                    ["angle-10.png", "angle-18.png"])


def test_uncalibrated_fit_persistence_interpolation_envelope(dataset, tmp_path):
    directory, path, _, _, config, frame, _ = dataset
    samples = load_samples(path, directory, config.limits)
    model = fit_model(samples, config.limits)
    output = tmp_path / "model.json"
    model.save(output)
    loaded = UncalibratedModel.read(output)
    assert loaded.training_range == [10., 45.]
    assert loaded.validation["metrics"]["success"] == 5
    assert loaded.validation["metrics"]["mean_abs_error"] < 5
    for angle in (18., 22., 26., 31., 36.):
        result = loaded.predict(frame(angle)[1])
        assert result.angle_deg == pytest.approx(angle, abs=2.)
        assert result.confidence > 0
    assert loaded.predict(frame(5)[1]).angle_deg is None
    assert loaded.predict(frame(55)[1]).angle_deg is None
    assert loaded.predict(frame(26)[1][::-1]).angle_deg is None
    assert loaded.predict(frame(26)[1], Limits(min_angle_deg=30, max_angle_deg=45)).angle_deg is None
    assert len(loaded.training_fingerprint) == 64
    assert loaded.predict([[0, 0]] * 4).angle_deg is None


def test_feature_translation_and_scale_invariance(dataset):
    _, _, _, _, _, frame, _ = dataset
    points = frame(26)[1]
    f = corner_features(points, 1280, 720)
    transformed = (points - points.mean(axis=0)) * .8 + points.mean(axis=0) + [20, -10]
    assert np.allclose(f, corner_features(transformed, 1280, 720))


def test_uncalibrated_requires_varied_labels_and_shapes(dataset):
    directory, path, _, _, config, _, _ = dataset
    samples = load_samples(path, directory, config.limits)
    with pytest.raises(ValueError, match="four|4"):
        fit_model(samples[:3])
    for sample in samples:
        sample.annotation.angle_deg = 20.
    with pytest.raises(ValueError, match="distinct"):
        fit_model(samples)
    for i, sample in enumerate(samples):
        sample.annotation.angle_deg = 10 + i * 5
        sample.annotation.corners = samples[0].annotation.corners
    with pytest.raises(ValueError, match="shapes"):
        fit_model(samples)


def test_uncalibrated_model_validation(dataset, tmp_path):
    directory, path, _, _, config, _, _ = dataset
    model = fit_model(load_samples(path, directory, config.limits))
    target = tmp_path / "model.json"
    model.save(target)
    original = json.loads(target.read_text())
    for key, value in [("schema_version", 999), ("scale", [0] * 8), ("coefficients", [float("inf")] * 9),
                       ("image_size", [-1, 200]), ("training_range", [45, 10]), ("support", [])]:
        target.write_text(json.dumps({**original, key: value}))
        with pytest.raises(ValueError):
            UncalibratedModel.read(target)


def test_uncalibrated_tracking_loss_deadline_recovery(dataset):
    directory, path, _, _, config, frame, _ = dataset
    model = fit_model(load_samples(path, directory, config.limits))
    session = UncalibratedSession(model, config.limits)
    image, corners = frame(26)
    assert session.state == State.WAITING
    assert session.initialize(image, corners, 0).angle_deg is not None
    moved, _ = frame(27)
    result = session.update(moved, .1)
    assert result.angle_deg == pytest.approx(27, abs=2.)
    assert session.state == State.TRACKING
    assert session.update(np.zeros_like(image), .2).angle_deg is None
    assert session.state in {State.LOST, State.UNRELIABLE}
    assert session.record(.2)["confidence"] == 0
    assert session.update(image, .3).angle_deg is None
    session.initialize(image, corners, .4)
    assert session.state == State.TRACKING
    assert session.update(image, 31).angle_deg is None
    assert session.state == State.LOST
    assert session.corners is None
    assert session.initialize(np.zeros_like(image), corners, 32).angle_deg is None
    session.initialize(image, corners, 33)
    assert session.update(np.zeros((100, 100, 3), np.uint8), 34).angle_deg is None


def test_dataset_missing_corners_images_and_size(dataset):
    directory, path, _, _, config, _, _ = dataset
    with pytest.raises(ValueError, match="resolution"):
        load_samples(path, directory, config.limits, (800, 600))
    data = json.loads(path.read_text())
    data["annotations"][0]["corners"] = None
    write_json(path, data)
    with pytest.raises(ValueError, match="Missing corners"):
        load_samples(path, directory, config.limits)


@pytest.mark.parametrize("command", ["calibrate-hinge-annotations", "evaluate-annotations", "train-uncalibrated", "run-uncalibrated", "annotate"])
def test_parser_commands(command):
    assert parser().parse_args([command]).command == command


def test_cli_empirical_workflow_without_camera_or_base(dataset, tmp_path, capsys):
    directory, path, _, _, config, _, _ = dataset
    cfg = tmp_path / "minimal.json"
    write_json(cfg, {"camera": {"index": 0, "width": 1280, "height": 720}})
    model, report = tmp_path / "model.json", tmp_path / "report.json"
    args = ["--config", str(cfg)]
    assert main(args + ["train-uncalibrated", "--annotations", str(path), "--input", str(directory),
                        "--output", str(model), "--items", "angle-10.png", "angle-18.png", "angle-36.png", "angle-45.png"]) == 0
    assert main(args + ["evaluate-annotations", "--annotations", str(path), "--input", str(directory),
                        "--model", str(model), "--report", str(report)]) == 0
    metrics = json.loads(report.read_text())["metrics"]
    assert metrics["count"] == 1
    assert metrics["success"] == 1
    assert "used for fit" in capsys.readouterr().out


def test_cli_geometric_workflow(dataset, tmp_path, capsys):
    directory, path, camera, _, _, _, cfg = dataset
    camera_path, hinge_path = tmp_path / "camera.json", tmp_path / "hinge.json"
    write_json(camera_path, {**camera.payload(), "source": "approximate", "horizontal_fov_deg": 60})
    args = ["--config", str(cfg)]
    shared = ["--annotations", str(path), "--input", str(directory), "--camera", str(camera_path)]
    assert main(args + ["calibrate-hinge-annotations", *shared, "--output", str(hinge_path),
                        "--references", "angle-10.png", "angle-45.png"]) == 0
    assert main(args + ["evaluate-annotations", *shared, "--hinge", str(hinge_path)]) == 0
    assert "approximate intrinsics" in capsys.readouterr().out


def test_fov_config_default_override_and_invalidation(tmp_path):
    cfg, output = tmp_path / "config.json", tmp_path / "camera.json"
    base = {"camera": {"index": 0, "width": 1280, "height": 720}}
    write_json(cfg, base)
    assert Config.read(cfg, require_measurements=False).horizontal_fov_deg == 60
    args = ["--config", str(cfg), "camera-approximate", "--output", str(output)]
    assert main(args) == 0
    before = json.loads(output.read_text())
    assert before["horizontal_fov_deg"] == 60
    assert before["matrix"][0][0] == pytest.approx(1280 / (2 * np.tan(np.deg2rad(30))))
    base["camera"]["horizontal_fov_deg"] = 65
    write_json(cfg, base)
    assert main(args) == 0
    assert json.loads(output.read_text())["horizontal_fov_deg"] == 65
    assert main(args + ["--horizontal-fov-deg", "75"]) == 0
    assert json.loads(output.read_text())["horizontal_fov_deg"] == 75
    assert main(args + ["--horizontal-fov-deg", "nan"]) == 2
    for fov in [0, 180, float("nan"), "60", True]:
        cfg.write_text(json.dumps({**base, "camera": {**base["camera"], "horizontal_fov_deg": fov}}))
        with pytest.raises(ValueError, match="FOV|fov"):
            Config.read(cfg, require_measurements=False)
    camera60, camera65 = approximate_camera(1280, 720, 60), approximate_camera(1280, 720, 65)
    from keyboard_hinge.geometry import rotation_x
    points = np.array([[0., 0, 0], [120, 0, 0], [120, 75, 0], [0, 75, 0]])
    Hinge(rotation_x(140), 1).save(tmp_path / "hinge.json", camera60, points, [10, 45])
    with pytest.raises(ValueError, match="changed"):
        Hinge.read(tmp_path / "hinge.json", camera65, points)


def test_optional_fov_features_use_plane_normal_without_physical_size(dataset, tmp_path):
    directory, path, _, _, config, frame, _ = dataset
    samples = load_samples(path, directory, config.limits)
    plain = fit_model(samples)
    assisted = fit_model(samples, horizontal_fov_deg=60)
    assert plain.horizontal_fov_deg is None
    assert len(plain.mean) == 8
    assert len(assisted.mean) == 11
    corners = frame(26)[1]
    f60 = corner_features(corners, 1280, 720, 60)
    f80 = corner_features(corners, 1280, 720, 80)
    assert np.allclose(f60[:8], f80[:8])
    assert not np.allclose(f60[8:], f80[8:])
    assert np.linalg.norm(f60[8:]) == pytest.approx(1)
    output = tmp_path / "fov-model.json"
    assisted.save(output)
    loaded = UncalibratedModel.read(output)
    assert loaded.horizontal_fov_deg == 60
    for angle in (18, 22, 26, 30, 36):
        assert loaded.predict(frame(angle)[1]).angle_deg == pytest.approx(angle, abs=2)
    assert loaded.predict(frame(55)[1]).angle_deg is None
    session = UncalibratedSession(loaded, config.limits)
    image, points = frame(26)
    assert session.initialize(image, points, 0).angle_deg is not None
    assert session.update(frame(27)[0], .1).angle_deg == pytest.approx(27, abs=2)
    with pytest.raises(ValueError, match="FOV|fov"):
        fit_model(samples, horizontal_fov_deg=180)


def test_cli_fov_options_override_configuration_without_camera_calibration(dataset, tmp_path):
    directory, path, _, _, _, _, cfg = dataset
    data = json.loads(cfg.read_text())
    data.pop("base")
    data["camera"]["horizontal_fov_deg"] = 60
    data["uncalibrated"] = {"use_fov": True}
    write_json(cfg, data)
    output = tmp_path / "model.json"
    args = ["--config", str(cfg), "train-uncalibrated", "--annotations", str(path),
            "--input", str(directory), "--output", str(output)]
    for flags, expected_fov in [([], 60), (["--no-fov"], None), (["--use-fov"], 60), (["--horizontal-fov-deg", "65"], 65)]:
        assert main(args + flags) == 0
        assert UncalibratedModel.read(output).horizontal_fov_deg == expected_fov
    assert main(args + ["--horizontal-fov-deg", "999"]) == 2


def test_live_preview_and_jsonl_clear_on_camera_failure(dataset, tmp_path, monkeypatch):
    from contextlib import contextmanager
    from keyboard_hinge import cli
    directory, path, _, _, config, frame, _ = dataset
    session = UncalibratedSession(fit_model(load_samples(path, directory, config.limits)), config.limits)
    image, corners = frame(26)
    frames = iter([image, frame(27)[0], np.zeros_like(image)])
    preview_lines = []
    closed = []

    @contextmanager
    def camera(*args):
        try:
            yield object()
        finally:
            closed.append(True)

    def read(*args):
        try:
            return next(frames)
        except StopIteration:
            raise ValueError("Camera disconnected")

    ticks = iter([0., .1, .2, .3])
    keys = iter([ord("s"), 0, 0])
    monkeypatch.setattr(cli, "open_camera", camera)
    monkeypatch.setattr(cli, "read_frame", read)
    monkeypatch.setattr(cli, "keypress", lambda: next(keys))
    monkeypatch.setattr(cli, "select_corners", lambda *args: corners)
    monkeypatch.setattr(cli.time, "monotonic", lambda: next(ticks))
    monkeypatch.setattr(cli.cv2, "imshow", lambda *args: None)
    monkeypatch.setattr(cli, "overlay", lambda image, lines: (preview_lines.append(lines) or image.copy()))
    output = tmp_path / "measurements.jsonl"
    with pytest.raises(ValueError, match="disconnected"):
        cli.run_live(config, session.camera, session, output, "approximate / uncalibrated")
    rows = [json.loads(line) for line in output.read_text().splitlines()]
    assert any(row["angle_deg"] is not None for row in rows)
    assert rows[-1]["angle_deg"] is None
    assert rows[-1]["confidence"] == 0
    assert rows[-1]["reason"] == "Camera disconnected"
    assert preview_lines[-1][1] == "Angle unavailable"
    assert closed == [True]
