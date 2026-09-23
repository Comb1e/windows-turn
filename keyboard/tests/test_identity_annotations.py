import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from keyboard_hinge.annotation import AnnotationStore
from keyboard_hinge.identity_dataset import build_dataset
from research.evaluate_identity import evaluation_images


@pytest.fixture
def store(tmp_path):
    target = AnnotationStore(tmp_path / 'images', tmp_path / 'annotations.json')
    for index in range(4):
        payload = cv2.imencode('.png', np.full((80, 100, 3), index, np.uint8))[1].tobytes()
        target.upload(f'photo{index}.png', payload)
    return target


def review(index=0, **changes):
    return {'item_id': f'photo{index}.png', 'revision': 0, 'identity': 'present', 'edge': [[0, 55], [99, 55]],
            'group': f'scene-{index}', 'split': 'reference', **changes}


def test_identity_sidecar_preserves_images_and_legacy_angle_bytes(store):
    store.output.write_bytes(b'{"schema_version": 1, "annotations": []}\n')
    before = store.output.read_bytes(); photo = (store.input_dir / 'photo0.png').read_bytes()
    record = store.save_identity(review())
    assert record['sha256'] == hashlib.sha256(photo).hexdigest()
    assert record['revision'] == 1 and store.output.read_bytes() == before
    assert (store.input_dir / 'photo0.png').read_bytes() == photo
    loaded = AnnotationStore(store.input_dir, store.output)
    assert loaded.items()[0]['identity'] == record
    with pytest.raises(ValueError, match='another tab'):
        store.save_identity(review())
    assert store.save_identity(review(revision=1, identity='absent', edge=None))['edge'] is None
    assert store.save_identity(review(1, identity='ambiguous', edge=None))['identity'] == 'ambiguous'
    assert store.output.read_bytes() == before


@pytest.mark.parametrize('changes', [dict(item_id='../outside.png'), dict(group=''), dict(split='training'),
                                    dict(identity='keyboard'), dict(edge=None), dict(edge=[[0, 55], [100, 55]])])
def test_identity_validation(store, changes):
    with pytest.raises(ValueError):
        store.save_identity(review(**changes))
    assert not store.identity_output.exists()


def test_failed_sidecar_write_does_not_publish_revision(store, monkeypatch):
    store.save_identity(review()); before = store.identity_output.read_bytes()
    def fail(*_):
        raise OSError('disk full')
    monkeypatch.setattr('keyboard_hinge.annotation.write_json', fail)
    with pytest.raises(OSError):
        store.save_identity(review(revision=1, identity='absent'))
    assert store.identity_output.read_bytes() == before and store.identity_reviews['photo0.png']['revision'] == 1


def test_export_keeps_roles_separate_and_reports_insufficient_labels(store, tmp_path):
    store.save_identity(review())
    store.save_identity(review(1, split='validation', identity='absent'))
    store.save_identity(review(2, split='test'))
    store.save_identity(review(3, split='test', group='scene-2', identity='absent'))
    summary = build_dataset([store.identity_output], tmp_path / 'export')
    assert summary['insufficient'] == ['validation']
    references = json.loads((tmp_path / 'export/references.json').read_text())
    assert len(references['references']) == 1
    with pytest.raises(FileExistsError):
        build_dataset([store.identity_output], tmp_path / 'export')
    store.save_identity(review(2, revision=1, group='scene-0', split='test'))
    with pytest.raises(ValueError, match='group crosses roles'):
        build_dataset([store.identity_output], tmp_path / 'bad')


def test_export_rejects_duplicate_leakage_and_mutated_images(store, tmp_path):
    source = store.input_dir / 'photo0.png'; duplicate = store.input_dir / 'photo1.png'
    duplicate.write_bytes(source.read_bytes())
    store.save_identity(review()); store.save_identity(review(1, split='test'))
    with pytest.raises(ValueError, match='duplicate crosses'):
        build_dataset([store.identity_output], tmp_path / 'bad')
    source.write_bytes(cv2.imencode('.png', np.ones((80, 100, 3), np.uint8))[1].tobytes())
    with pytest.raises(ValueError, match='hash changed'):
        build_dataset([store.identity_output], tmp_path / 'changed')


def test_role_cannot_make_regressor_training_images_independent():
    rows = [dict(path=Path(name), sha256=checksum, split=split, independent=True)
            for name, checksum, split in [('fit.png', 'a', 'test'), ('renamed.png', 'b', 'test'),
                                         ('new.png', 'c', 'test'), ('tuning.png', 'd', 'validation')]]
    selected = evaluation_images(rows, ['fit.png'], {'b'}, 'test')
    assert [r['independent'] for r in selected] == [False, False, True]
    assert len(evaluation_images(rows, [], set(), 'validation')) == 1
