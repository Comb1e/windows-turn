from dataclasses import asdict
import json
from pathlib import Path
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import cv2
import numpy as np
import pytest

from keyboard_hinge.annotation import Annotation, AnnotationStore, load_samples, serve, validate_corners
from keyboard_hinge.config import Limits


def label(angle=10):
    return {"item_id": "photo.png", "timestamp": 123., "angle_deg": angle, "source": "camera", "notes": "",
            "corner_mode": "physical", "edge": None,
            "corners": [[10., 10.], [90., 10.], [90., 70.], [10., 70.]]}


@pytest.fixture
def store(tmp_path):
    store = AnnotationStore(tmp_path / "images", tmp_path / "annotations.json")
    payload = cv2.imencode(".png", np.zeros((80, 100, 3), np.uint8))[1].tobytes()
    store.upload("photo.png", payload)
    return store


@pytest.mark.parametrize("angle", [10., 45.])
def test_roundtrip(store, angle):
    assert store.save(label(angle))["angle_deg"] == angle
    loaded = AnnotationStore(store.input_dir, store.output)
    assert asdict(loaded.annotations["photo.png"]) == label(angle)
    assert load_samples(store.output, store.input_dir, Limits())[0].size == (100, 80)


@pytest.mark.parametrize("value", [9.999, 45.001, float("nan"), float("inf"), True, "20"])
def test_invalid_angle(value):
    with pytest.raises(ValueError):
        Annotation(**label(value))


@pytest.mark.parametrize("points", [[], [[1, 2]] * 3, [[1, 2]] * 4, [[1, 1], [2, 2], [3, 3], [4, 4]],
                                    [[0, 0], [10, 10], [10, 0], [0, 10]], [[float("nan"), 0], [10, 0], [10, 10], [0, 10]],
                                    [[float("inf"), 0], [10, 0], [10, 10], [0, 10]], [[1], [2], [3], [4]], "bad"])
def test_invalid_corners(points):
    with pytest.raises(ValueError):
        validate_corners(points)


def test_custom_limits_and_legacy_annotations(store):
    store.limits = Limits(min_angle_deg=5, max_angle_deg=70)
    store.save(label(60))
    assert AnnotationStore(store.input_dir, store.output, store.limits).annotations["photo.png"].angle_deg == 60
    store.output.write_text(json.dumps({"schema_version": 1, "annotations": [{**label(), "corners": None}]}))
    loaded = AnnotationStore(store.input_dir, store.output)
    assert loaded.annotations["photo.png"].corners is None
    loaded.save(label())
    assert json.loads(store.output.read_text())["schema_version"] == 2


def test_atomic_updates_do_not_change_memory_or_disk_on_failure(store, monkeypatch):
    store.save(label(10))
    before = store.output.read_bytes()
    original_replace = Path.replace

    def fail_replace(path, target):
        if Path(target) == store.output:
            raise OSError("disk failure")
        return original_replace(path, target)

    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(OSError):
        store.save(label(20))
    assert store.output.read_bytes() == before
    assert store.annotations["photo.png"].angle_deg == 10
    assert not list(store.output.parent.glob("*.tmp"))
    monkeypatch.setattr(Path, "replace", original_replace)
    store.save(label(20))
    assert len(json.loads(store.output.read_text())["annotations"]) == 1


def test_image_validation_and_safe_paths(store):
    for item_id in ("../outside.png", "/outside.png", "..\\outside.png", "C:outside.png", "x.txt"):
        with pytest.raises(ValueError):
            store.upload(item_id, (store.input_dir / "photo.png").read_bytes())
    for payload in (b"", b"not image"):
        with pytest.raises(ValueError):
            store.upload("invalid.png", payload)
    with pytest.raises(ValueError, match="inside"):
        store.save({**label(), "corners": [[10, 10], [100, 10], [90, 70], [10, 70]]})
    with pytest.raises(OSError):
        store.save({**label(), "item_id": "missing.png"})
    duplicate = store.upload("photo.png", (store.input_dir / "photo.png").read_bytes())
    assert duplicate["id"] != "photo.png"
    (store.input_dir / "bad.png").write_bytes(b"bad")
    assert len(store.items()) == 2
    store.limits = Limits(annotation_max_image_pixels=10)
    with pytest.raises(ValueError, match="pixel limit"):
        store.upload("big.png", (store.input_dir / "photo.png").read_bytes())


def test_api_upload_listing_errors_and_media(store):
    server = serve(store, "127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    root = f"http://127.0.0.1:{server.server_port}"

    def request(path, body=None, content_type="application/json"):
        data = None if body is None else body
        return urlopen(Request(root + path, data=data, headers={"Content-Type": content_type}), timeout=5)

    try:
        assert b"pointerdown" in request("/").read()
        assert json.load(request("/api/config"))["min_angle_deg"] == 10
        assert json.load(request("/api/items"))[0]["id"] == "photo.png"
        assert request("/media/photo.png").status == 200
        assert json.load(request("/api/annotations", json.dumps(label()).encode()))["angle_deg"] == 10
        for body in (b"[]", b"null", b"{", b'{"bad":1}', json.dumps({**label(), "timestamp": float("inf")}).encode()):
            with pytest.raises(HTTPError) as exc:
                request("/api/annotations", body)
            assert exc.value.code == 400
        for path in ("/media/%2E%2E%2Foutside.png", "/media/../annotations.json", "/missing"):
            with pytest.raises(HTTPError) as exc:
                request(path)
            assert exc.value.code == 404
        def multipart(payload):
            return b'--test\r\nContent-Disposition: form-data; name="file"; filename="uploaded.png"\r\nContent-Type: image/png\r\n\r\n' + payload + b"\r\n--test--\r\n"
        image = (store.input_dir / "photo.png").read_bytes()
        response = request("/api/upload", multipart(image), "multipart/form-data; boundary=test")
        assert response.status == 201
        assert json.load(response)["id"] == "uploaded.png"
        with pytest.raises(HTTPError) as exc:
            request("/api/upload", multipart(b"junk"), "multipart/form-data; boundary=test")
        assert exc.value.code == 400
        assert request("/api/items").status == 200
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
