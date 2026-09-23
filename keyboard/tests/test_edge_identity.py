"""Regression scenes for table trim, touchpad seams, and identity loss.

These deliberately rendered cases test failure mechanisms, not semantic accuracy
or reconstruction of the user's cropped screenshots.
"""
from dataclasses import asdict, replace

import cv2
import numpy as np
import pytest

from keyboard_hinge.annotation import Annotation, AnnotationStore, load_samples
from keyboard_hinge.config import Limits, write_json
from keyboard_hinge.edge import EdgeModel, EdgeSession, fit_edge_model
from keyboard_hinge.tracking import State
from test_edge import edge_dataset


@pytest.fixture
def model(edge_dataset):
    directory, path, _ = edge_dataset
    return fit_edge_model(load_samples(path, directory, Limits()), directory)


def distractor(kind, y=340):
    gray = np.full((480, 640), 140, np.uint8)
    if kind == "table-trim":
        yy, xx = np.mgrid[:480-y, :640]
        gray[y:] = np.where((xx + yy * 2) % 36 < 15, 190, 220)
        gray[y-12:y] = 255
    elif kind == "touchpad-seam":
        gray[y:y+6] = 35
    elif kind == "central-segment":
        gray[y:, 90:550] = 35
    elif kind == "textured-surface":
        gray[:y] = 230
        gray[y:] = np.where(np.arange(640) % 40 < 20, 35, 135)
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


@pytest.mark.parametrize("kind", ["table-trim", "touchpad-seam", "central-segment", "textured-surface"])
@pytest.mark.parametrize("y", [275, 340, 430, 470])
def test_distractor_rejected_even_with_manual_search_hint(model, kind, y):
    frame = distractor(kind, y)
    for hint in (None, (y-4, y+4)):
        edge, confidence, reason = model.detector.detect(frame, hint)
        assert edge is None and confidence == 0 and reason


def test_stronger_seam_does_not_hide_supported_boundary(model, edge_dataset):
    _, _, scene = edge_dataset
    frame, _ = scene(30)
    frame = np.clip(frame.astype(float) * .5 + 70, 0, 255).astype(np.uint8)
    frame[280:285] = 255
    result, edge = model.predict_frame(frame)
    assert result.angle_deg == pytest.approx(30, abs=.5)
    assert edge is not None


def test_stronger_curved_background_does_not_hide_straight_base(model):
    yy, xx = np.mgrid[:480, :640]
    frame = np.where(yy < 370, 125, 80).astype(np.uint8)
    curve = 280 + 4 * np.sin(4 * np.pi * xx / 640)
    frame[yy < curve] = 255
    frame[(yy >= curve) & (yy < 320)] = 10
    result, edge = model.predict_frame(cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR))
    assert result.angle_deg == pytest.approx(30, abs=.5)
    assert edge is not None


@pytest.mark.parametrize("gain,offset", [(1., 0.), (.5, 20.), (.75, 50.)])
def test_sustained_boundary_survives_exposure_changes(model, edge_dataset, gain, offset):
    _, _, scene = edge_dataset
    for angle in (10, 25, 45):
        frame = np.clip(scene(angle)[0].astype(float) * gain + offset, 0, 255).astype(np.uint8)
        assert model.predict_frame(frame)[0].angle_deg == pytest.approx(angle, abs=.5)


@pytest.mark.parametrize("angle", [10, 25, 45])
def test_broad_shading_is_not_misclassified_as_surface_texture(model, edge_dataset, monkeypatch, angle):
    import keyboard_hinge.edge_evidence as evidence
    _, _, scene = edge_dataset
    shading = 100 * (1 - np.linspace(-1, 1, 640)**2)
    frame = (scene(angle)[0].astype(float) * .4 + 10 + shading[None, :, None]).astype(np.uint8)
    with monkeypatch.context() as old:
        old.setattr(evidence, "surface_texture_span", lambda samples, _: np.quantile(samples, .9, axis=-1) - np.quantile(samples, .1, axis=-1))
        assert model.predict_frame(frame)[0].angle_deg is None
    assert model.predict_frame(frame)[0].angle_deg == pytest.approx(angle, abs=.5)


def test_cropped_annotation_is_automatically_recognized_after_training(edge_dataset, tmp_path, capsys):
    from keyboard_hinge.cli import main
    directory, path, scene = edge_dataset
    image, edge = scene(47)
    cv2.imwrite(str(directory / "cropped.png"), image)
    limits = Limits(max_angle_deg=48)
    store = AnnotationStore(directory, path, limits)
    store.save(asdict(Annotation("cropped.png", 3, 47, "test", corner_mode="visible-edge", edge=edge, limits=limits)))
    original_annotations = path.read_bytes()
    config, output = tmp_path / "config.json", tmp_path / "model.json"
    write_json(config, {"camera": {"index": 0, "width": 640, "height": 480}, "limits": {"max_angle_deg": 48}})
    assert main(["--config", str(config), "train-uncalibrated", "--method", "edge", "--annotations", str(path),
                 "--input", str(directory), "--output", str(output)]) == 0
    assert "Automatic detection on fitting photos: 5/5 recognized" in capsys.readouterr().out
    model = EdgeModel.read(output)
    assert model.training_range == [10, 47]
    assert model.validation["metrics"]["count"] == 5
    fallback = next(r for r in model.validation["boundary_refinement"] if r["item_id"] == "cropped.png")
    assert fallback["source"] == "automatic-detection" and not fallback["automatic_reason"]
    diagnostic = next(r for r in model.validation["automatic_detection"]["rows"] if r["item_id"] == "cropped.png")
    assert diagnostic["recognized"] and diagnostic["error"] < .5
    assert model.predict_frame(image)[0].angle_deg == pytest.approx(47, abs=.5)
    session = EdgeSession(model, limits)
    assert session.initialize(image, edge, 0).angle_deg is None
    assert session.update(image, .05).angle_deg is None
    assert session.update(image, .1).angle_deg == pytest.approx(47, abs=.5)
    assert path.read_bytes() == original_annotations
    # Human annotation is no substitute for a visible local intensity transition.
    cv2.imwrite(str(directory / "cropped.png"), scene(47, boundary=False)[0])
    with pytest.raises(ValueError):
        fit_edge_model(load_samples(path, directory, limits), directory, limits)


@pytest.mark.parametrize("ambiguous", [False, True])
def test_training_cannot_publish_a_model_that_misses_an_annotation(edge_dataset, tmp_path, capsys, ambiguous):
    from keyboard_hinge.cli import main
    directory, path, scene = edge_dataset
    output, config = tmp_path / "model.json", tmp_path / "config.json"
    fit_edge_model(load_samples(path, directory, Limits()), directory).save(output)
    previous = output.read_bytes()
    write_json(config, {"camera": {"index": 0, "width": 640, "height": 480}})
    frame, _ = scene(20)
    frame[350:390] = 180 if ambiguous else 230
    frame[390:] = 35 if ambiguous else 0
    cv2.imwrite(str(directory / "edge-20.png"), frame)
    assert main(["--config", str(config), "train-uncalibrated", "--method", "edge", "--annotations", str(path),
                 "--input", str(directory), "--output", str(output)]) == 2
    assert "automatic recognition of every annotated boundary" in capsys.readouterr().err
    assert output.read_bytes() == previous


def test_loss_cannot_erase_speed_reference_or_publish_unconfirmed_labels(model, edge_dataset):
    _, _, scene = edge_dataset
    session = EdgeSession(model, Limits())
    for timestamp in (0., .05, .1):
        session.update(scene(20)[0], timestamp)
    assert session.result.angle_deg == pytest.approx(20, abs=.5)
    assert session.update(scene(20, boundary=False)[0], .105).angle_deg is None
    for timestamp in (.11, .12):
        assert session.update(scene(23)[0], timestamp).angle_deg is None
        assert session.last_time == .1
        assert session.state == State.UNRELIABLE
    for timestamp in (.15, .20):
        assert session.update(scene(20)[0], timestamp).angle_deg is None
        assert session.record(timestamp)["edge"] is None
    result = session.update(scene(20.5)[0], .25)
    assert result.angle_deg == model.predict_frame(scene(20.5)[0])[0].angle_deg


def test_expired_identity_requires_consecutive_observations(model, edge_dataset):
    _, _, scene = edge_dataset
    session = EdgeSession(model, Limits())
    for timestamp in (0., .05, .1):
        session.update(scene(20)[0], timestamp)
    assert session.update(scene(40)[0], 1.).angle_deg is None
    assert session.update(scene(40)[0], 1.3).angle_deg is None  # gap restarts confirmation
    assert session.update(scene(40)[0], 1.35).angle_deg is None
    assert session.update(scene(40)[0], 1.4).angle_deg == pytest.approx(40, abs=.5)
    assert session.update(scene(40)[0], 1.4).angle_deg is None


@pytest.mark.parametrize("settings", [dict(edge_context_far_fraction=.01), dict(edge_min_sustained_ratio=2),
    dict(edge_support_regions=1), dict(edge_confirmation_frames=1), dict(edge_confirmation_gap_s=1),
    dict(edge_surface_trend_degree=3), dict(edge_min_visible_context_fraction=.1),
    dict(edge_line_inlier_ratio=1.1), dict(edge_max_candidates=1), dict(edge_annotation_tolerance_fraction=.1)])
def test_invalid_evidence_configuration_rejected(settings):
    with pytest.raises(ValueError):
        replace(Limits(), **settings)
