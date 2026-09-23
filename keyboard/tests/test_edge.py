from dataclasses import asdict
import json

import cv2
import numpy as np
import pytest

from keyboard_hinge.annotation import Annotation, AnnotationStore, load_samples, validate_edge
from keyboard_hinge.cli import main
from keyboard_hinge.config import Config, Limits, write_json
from keyboard_hinge.edge import EdgeModel, EdgeSession, fit_edge_model, read_uncalibrated_model
from keyboard_hinge.evaluation import evaluate
from keyboard_hinge.tracking import State


@pytest.fixture
def edge_dataset(tmp_path):
    size = (640, 480)
    limits = Limits()

    def scene(angle, boundary=True):
        y = 250 + (angle - 10) * 6
        yy, xx = np.mgrid[:480, :640]
        line = y + .006 * (xx - 320)
        gray = np.where(yy < line, 180, 35).astype(np.uint8) if boundary else np.full((480, 640), 90, np.uint8)
        image = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        edge = [[10., y + .006 * (10 - 320)], [629., y + .006 * (629 - 320)]]
        return image, edge

    directory, path = tmp_path / "images", tmp_path / "annotations.json"
    directory.mkdir()
    store = AnnotationStore(directory, path)
    for angle in (10, 20, 30, 45):
        image, edge = scene(angle)
        name = f"edge-{angle}.png"
        cv2.imwrite(str(directory / name), image)
        store.save(asdict(Annotation(name, 1, angle, "test", corner_mode="visible-edge", edge=edge)))
    return directory, path, scene


@pytest.mark.parametrize("bad", [None, [], [[1, 2]], [[0, 1], [0, 5]], [[10, 10], [1, 10]],
                                  [[float("nan"), 2], [10, 5]], [[1, 2], [10, float("inf")]],
                                  [[-1, 5], [10, 5]], [[1, 2], [640, 5]]])
def test_edge_endpoint_validation(bad):
    with pytest.raises(ValueError):
        validate_edge(bad, (640, 480))


def test_two_point_annotation_roundtrip(edge_dataset):
    directory, path, _ = edge_dataset
    samples = load_samples(path, directory, Limits())
    assert len(samples) == 4
    assert all(s.annotation.corners is None and len(s.annotation.edge) == 2 for s in samples)
    store = AnnotationStore(directory, path)
    assert store.items()[0]["annotation"]["corner_mode"] == "visible-edge"


@pytest.mark.parametrize("fov", [None, 60])
def test_edge_detector_model_interpolation_and_rejection(edge_dataset, tmp_path, fov):
    directory, path, scene = edge_dataset
    model = fit_edge_model(load_samples(path, directory, Limits()), directory, horizontal_fov_deg=fov)
    target = tmp_path / "model.json"
    model.save(target)
    loaded = read_uncalibrated_model(target)
    assert isinstance(loaded, EdgeModel)
    assert loaded.horizontal_fov_deg == fov
    assert loaded.validation["metrics"]["success"] == 4
    for angle in (10, 20, 25, 30, 40, 45):
        result, edge = loaded.predict_frame(scene(angle)[0])
        assert result.angle_deg == pytest.approx(angle, abs=.5)
        assert result.confidence > 0
        assert edge.shape == (2, 2)
    for angle in (9, 46):
        assert loaded.predict_frame(scene(angle)[0])[0].angle_deg is None
    assert loaded.predict_frame(scene(20, boundary=False)[0])[0].angle_deg is None
    assert loaded.predict_frame(np.zeros((720, 1280, 3), np.uint8))[0].angle_deg is None
    assert loaded.predict_frame(scene(20)[0], Limits(min_angle_deg=25, max_angle_deg=45))[0].angle_deg is None


def test_ambiguous_edges_and_manual_hint(edge_dataset):
    directory, path, scene = edge_dataset
    model = fit_edge_model(load_samples(path, directory, Limits()), directory)
    frame = scene(20)[0]
    frame[350:400] = 180
    edge, _, reason = model.detector.detect(frame)
    assert edge is None and "Multiple" in reason
    edge, _, reason = model.detector.detect(frame, (300, 320))
    assert edge is not None
    session = EdgeSession(model, Limits())
    assert session.initialize(frame, scene(20)[1], 0).angle_deg is None
    assert session.update(frame, .05).angle_deg is None
    assert session.update(frame, .1).angle_deg == pytest.approx(20, abs=.5)


def test_edge_session_automatic_start_loss_reacquisition(edge_dataset):
    directory, path, scene = edge_dataset
    model = fit_edge_model(load_samples(path, directory, Limits()), directory, horizontal_fov_deg=60)
    session = EdgeSession(model, Limits())
    assert session.state == State.WAITING
    assert session.update(scene(20)[0], 0).angle_deg is None
    assert session.update(scene(20)[0], .05).angle_deg is None
    assert session.update(scene(20)[0], .1).angle_deg == pytest.approx(20, abs=.5)
    assert session.update(scene(21)[0], .2).angle_deg == pytest.approx(21, abs=.5)
    assert session.update(scene(21, boundary=False)[0], .3).angle_deg is None
    assert session.state == State.LOST and session.corners is None
    assert session.record(.3)["confidence"] == 0
    assert session.update(scene(24)[0], .4).angle_deg is None
    assert session.update(scene(24)[0], .45).angle_deg is None
    assert session.update(scene(24)[0], .5).angle_deg == pytest.approx(24, abs=.5)
    assert session.update(np.zeros((100, 100, 3), np.uint8), .6).angle_deg is None


def test_legacy_four_corner_labels_and_photobottom_rejection(edge_dataset):
    directory, path, scene = edge_dataset
    data = json.loads(path.read_text())
    for record in data["annotations"]:
        p0, p1 = record["edge"]
        record.update(corner_mode="physical", edge=None, corners=[p0, p1, [p1[0], 479], [p0[0], 479]])
    write_json(path, data)
    model = fit_edge_model(load_samples(path, directory, Limits()), directory)
    assert model.predict_frame(scene(25)[0])[0].angle_deg == pytest.approx(25, abs=.5)
    for record in data["annotations"]:
        record.update(corner_mode="visible-edge", corners=None, edge=[[10., 470.], [629., 470.]])
    write_json(path, data)
    with pytest.raises(ValueError, match="barely moves"):
        fit_edge_model(load_samples(path, directory, Limits()), directory)


def test_frame_evaluation_measures_detector_not_only_manual_points(edge_dataset, tmp_path):
    directory, path, scene = edge_dataset
    model = fit_edge_model(load_samples(path, directory, Limits()), directory)
    image, edge = scene(25)
    cv2.imwrite(str(directory / "heldout.png"), image)
    store = AnnotationStore(directory, path)
    store.save(asdict(Annotation("heldout.png", 2, 25, "test", corner_mode="visible-edge", edge=edge)))
    cfg = tmp_path / "config.json"
    write_json(cfg, {"camera": {"index": 0, "width": 1280, "height": 720}})
    config = Config.read(cfg, require_measurements=False)
    rows, metrics = evaluate(path, None, config, None, directory, model=model)
    assert metrics["count"] == metrics["success"] == 1
    assert metrics["mean_abs_error"] < .2
    cv2.imwrite(str(directory / "heldout.png"), scene(25, boundary=False)[0])
    rows, metrics = evaluate(path, None, config, None, directory, model=model)
    assert metrics["failures"] == 1


def test_cli_edge_mode_and_model_resolution_precedence(edge_dataset, tmp_path, monkeypatch, capsys):
    from keyboard_hinge import cli
    directory, path, scene = edge_dataset
    cfg, output = tmp_path / "config.json", tmp_path / "model.json"
    write_json(cfg, {"camera": {"index": 0, "width": 1280, "height": 720, "horizontal_fov_deg": 60},
                     "uncalibrated": {"method": "edge", "use_fov": True}})
    args = ["--config", str(cfg)]
    assert main(args + ["train-uncalibrated", "--annotations", str(path), "--input", str(directory), "--output", str(output)]) == 0
    assert main(args + ["evaluate-annotations", "--annotations", str(path), "--input", str(directory),
                        "--model", str(output), "--include-training"]) == 0
    seen = []
    def run(config, camera, session, jsonl, mode):
        seen.append((config.width, config.height))
        assert camera.size == (640, 480)
        assert isinstance(session, EdgeSession)
    monkeypatch.setattr(cli, "run_live", run)
    assert main(args + ["run-uncalibrated", "--model", str(output)]) == 0
    assert seen == [(640, 480)]
    assert "instead of configured 1280x720" in capsys.readouterr().out
    assert json.loads(cfg.read_text())["camera"]["width"] == 1280


def test_legacy_corner_model_also_uses_saved_resolution(dataset, tmp_path, monkeypatch):
    from keyboard_hinge import cli
    from keyboard_hinge.uncalibrated import fit_model
    directory, path, _, _, config, _, cfg = dataset
    target = tmp_path / "legacy.json"
    fit_model(load_samples(path, directory, config.limits)).save(target)
    data = json.loads(cfg.read_text())
    data["camera"]["width"], data["camera"]["height"] = 640, 480
    write_json(cfg, data)
    seen = []
    monkeypatch.setattr(cli, "run_live", lambda config, *args: seen.append((config.width, config.height)))
    assert main(["--config", str(cfg), "run-uncalibrated", "--model", str(target)]) == 0
    assert seen == [(1280, 720)]


def test_edge_live_preview_logging_and_camera_failure(edge_dataset, tmp_path, monkeypatch):
    from contextlib import contextmanager
    from keyboard_hinge import cli
    directory, path, scene = edge_dataset
    model = fit_edge_model(load_samples(path, directory, Limits()), directory)
    session = EdgeSession(model, Limits())
    config = Config(0, 640, 480, np.zeros((4, 3)), [], Limits())
    frames = iter([scene(20)[0], scene(20)[0], scene(20)[0], scene(21)[0], scene(21, boundary=False)[0]])
    closed, lines = [], []

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

    times = iter([0, .05, .1, .2, .3, .4])
    monkeypatch.setattr(cli, "open_camera", camera)
    monkeypatch.setattr(cli, "read_frame", read)
    monkeypatch.setattr(cli, "keypress", lambda: 0)
    monkeypatch.setattr(cli.time, "monotonic", lambda: next(times))
    monkeypatch.setattr(cli.cv2, "imshow", lambda *args: None)
    monkeypatch.setattr(cli, "overlay", lambda frame, text: (lines.append(text) or frame.copy()))
    target = tmp_path / "measurements.jsonl"
    with pytest.raises(ValueError, match="disconnected"):
        cli.run_live(config, session.camera, session, target, "approximate / moving edge")
    records = [json.loads(line) for line in target.read_text().splitlines()]
    assert records[0]["angle_deg"] is None and records[0]["edge"] is None
    assert records[2]["angle_deg"] == pytest.approx(20, abs=.5)
    assert len(records[2]["edge"]) == 2
    assert records[-1]["angle_deg"] is None and records[-1]["confidence"] == 0
    assert lines[-1][1] == "Angle unavailable"
    assert closed == [True]
