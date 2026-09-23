import numpy as np
import pytest

from keyboard_hinge.annotation import load_samples
from keyboard_hinge.config import Limits
from keyboard_hinge.edge import EdgeSession, fit_edge_model
from keyboard_hinge.identity import IdentityResult, UnavailableVerifier, load_verifier
from keyboard_hinge.identity_vision import region_masks, pooled_mask
from test_edge import edge_dataset


class Gate:
    def __init__(self):
        self.status = 'accepted'; self.frames = 0; self.ended = 0; self.seen = []
        self.last = IdentityResult('unavailable')

    def start_frame(self, frame):
        self.frames += 1
        self.last = IdentityResult('unavailable')

    def verify(self, edge):
        self.seen.append(float(edge[:, 1].mean()))
        return IdentityResult(self.status, '' if self.status == 'accepted' else 'identity uncertain')

    def end_frame(self):
        self.ended += 1


def model_for(edge_dataset):
    directory, path, scene = edge_dataset
    limits = Limits()
    model = fit_edge_model(load_samples(path, directory, limits), directory, limits)
    return model, limits, scene


def test_identity_gate_preserves_raw_angle_but_clears_output_on_loss_and_reconfirms(edge_dataset):
    model, limits, scene = model_for(edge_dataset); gate = Gate()
    session = EdgeSession(model, limits, gate); frame, _ = scene(25)
    assert session.update(frame, 1.).angle_deg is None
    assert session.update(frame, 1.07).angle_deg is None
    accepted = session.update(frame, 1.14)
    raw, _ = model.predict_frame(frame, limits)
    assert accepted.angle_deg == raw.angle_deg
    gate.status = 'rejected'
    assert session.update(frame, 1.21).angle_deg is None
    assert session.corners is None
    gate.status = 'accepted'
    assert session.update(frame, 1.28).angle_deg is None
    assert session.update(frame, 1.35).angle_deg is None
    assert session.update(frame, 1.42).angle_deg == raw.angle_deg
    assert session.update(frame, 1.42).angle_deg is None  # stale timestamp
    assert gate.frames == gate.ended == 7


def test_unavailable_or_exception_cannot_bypass_identity(edge_dataset):
    model, limits, scene = model_for(edge_dataset); frame, _ = scene(25)
    gate = UnavailableVerifier('dino', 'Missing weights')
    result, edge = model.predict_frame(frame, limits, verifier=gate)
    assert result.angle_deg is None and edge is None
    assert 'Missing weights' in result.reason
    broken = Gate()
    def fail(_):
        raise RuntimeError('GPU lost')
    broken.start_frame = fail
    result, edge = model.predict_frame(frame, limits, verifier=broken)
    assert result.angle_deg is None and broken.last.status == 'unavailable' and broken.ended == 1
    assert load_verifier({}, (640, 480)) is None
    assert load_verifier({'method': 'dino', 'config': 'nonexistent-config.json'}, (640, 480)).last.status == 'unavailable'


def test_rejected_stronger_candidate_does_not_hide_weaker_verified_boundary(edge_dataset):
    model, limits, _ = model_for(edge_dataset)
    frame = np.full((480, 640, 3), 220, np.uint8)
    frame[290:] = 90; frame[390:] = 35
    class SelectLower(Gate):
        def verify(self, edge):
            y = float(edge[:, 1].mean()); self.seen.append(y)
            return IdentityResult('accepted' if y > 370 else 'rejected', 'wrong surface' if y <= 370 else '')
    gate = SelectLower()
    result, edge = model.predict_frame(frame, limits, verifier=gate)
    assert result.angle_deg is not None
    assert abs(edge[:, 1].mean() - 390) < 3
    assert any(y < 300 for y in gate.seen) and gate.last.status == 'accepted'


def test_real_pixel_masks_exclude_boundary_padding_and_thin_context():
    fg, bg = region_masks((480, 640), [[0, 470], [639, 470]], 3)
    assert fg.sum() == 6 * 640 and not (fg & bg).any()
    pooled = pooled_mask(fg, (336, 252), (24, 18), (336, 252))
    assert not (pooled >= .95).any()
    fg, _ = region_masks((471, 640), [[0, 465], [639, 465]], 3)
    padded = pooled_mask(fg, (336, 247), (24, 18), (336, 252))
    assert not (padded >= .95).any()
    with pytest.raises(ValueError):
        region_masks((480, 640), [[2, 2], [1, 2]], 3)
    with pytest.raises(ValueError):
        IdentityResult('accepted', scores={'score': float('nan')})
