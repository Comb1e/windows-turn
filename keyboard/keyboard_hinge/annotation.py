"""Validated image datasets shared by annotation, fitting, and evaluation."""
from dataclasses import InitVar, asdict, dataclass
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import mimetypes
from pathlib import Path
import threading
from urllib.parse import quote, unquote, urlparse
import uuid

import cv2
import numpy as np

from .config import CORNER_MODES, DEFAULT_LABELS, EDGE_LABELS, Limits, read_json, validate_angle, write_bytes, write_json

SCHEMA_VERSION = 2
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def image_path(directory, item_id):
    if (not isinstance(item_id, str) or not item_id or item_id in {".", ".."}
            or any(c in item_id for c in '/\\:\x00') or Path(item_id).suffix.lower() not in IMAGE_EXTENSIONS):
        raise ValueError("item_id must be an image filename without directories")
    root = Path(directory).resolve()
    target = root / item_id
    if target.resolve().parent != root:
        raise ValueError("Image must be inside the input directory")
    return target


def validate_corners(corners, size=None):
    try:
        points = np.asarray(corners, dtype=np.float64)
    except (TypeError, ValueError) as error:
        raise ValueError("corners must contain four finite [x, y] points") from error
    if points.shape != (4, 2) or not np.isfinite(points).all():
        raise ValueError("corners must contain four finite [x, y] points")
    contour = points.astype(np.float32).reshape(-1, 1, 2)
    if not np.isfinite(contour).all() or abs(cv2.contourArea(contour)) < 1e-6 or not cv2.isContourConvex(contour):
        raise ValueError("corners must form a non-collinear convex perimeter")
    if np.any(points < 0) or (size is not None and np.any(points >= np.asarray(size))):
        raise ValueError("Corners must lie inside the image")
    return points.tolist()


def decode_image(payload, limits):
    if not payload:
        raise ValueError("Empty image")
    try:
        frame = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
    except cv2.error as error:
        raise ValueError("File is not a valid image") from error
    if frame is None:
        raise ValueError("File is not a valid image")
    if frame.shape[0] * frame.shape[1] > limits.annotation_max_image_pixels:
        raise ValueError("Image dimensions exceed the configured pixel limit")
    return frame


def validate_edge(edge, size=None):
    try:
        points = np.asarray(edge, dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError("edge must contain two finite [x, y] endpoints") from error
    if points.shape != (2, 2) or not np.isfinite(points).all() or points[1, 0] - points[0, 0] < 1:
        raise ValueError("edge must contain two finite endpoints ordered left to right")
    if np.any(points < 0) or (size is not None and np.any(points >= size)):
        raise ValueError("Edge endpoints must lie inside the image")
    return points.tolist()


@dataclass
class Annotation:
    item_id: str
    timestamp: float
    angle_deg: float
    source: str
    notes: str = ""
    corners: list | None = None
    corner_mode: str = "physical"
    edge: list | None = None
    limits: InitVar[Limits | None] = None

    def __post_init__(self, limits):
        image_path(".", self.item_id)
        if isinstance(self.timestamp, bool) or not isinstance(self.timestamp, (int, float)) or not np.isfinite(self.timestamp):
            raise ValueError("timestamp must be a finite number")
        self.angle_deg = validate_angle(self.angle_deg, limits or Limits())
        if not isinstance(self.source, str) or not self.source or not isinstance(self.notes, str):
            raise ValueError("source must be nonempty and notes must be text")
        if self.corner_mode not in CORNER_MODES:
            raise ValueError("corner_mode must be physical or visible-edge")
        if self.corners is not None:
            self.corners = validate_corners(self.corners)
        if self.edge is not None:
            self.edge = validate_edge(self.edge)

    @classmethod
    def from_payload(cls, value, limits):
        if not isinstance(value, dict) or "limits" in value:
            raise ValueError("Annotation must be a JSON object")
        try:
            return cls(**value, limits=limits)
        except TypeError as error:
            raise ValueError(f"Malformed annotation: {error}") from error


def read_records(path):
    document = read_json(path)
    if not isinstance(document, dict) or document.get("schema_version") not in (1, SCHEMA_VERSION):
        raise ValueError("Unsupported annotation schema version")
    records = document.get("annotations")
    if not isinstance(records, list):
        raise ValueError("annotations must be a list")
    ids = [record.get("item_id") for record in records if isinstance(record, dict)]
    if any(ids.count(item) > 1 for item in ids):
        raise ValueError("Duplicate image identifiers in annotation document")
    return records


@dataclass
class Sample:
    annotation: Annotation
    size: tuple[int, int]
    image_sha256: str

    def fingerprint_payload(self):
        return {"annotation": asdict(self.annotation), "image_size": self.size, "image_sha256": self.image_sha256}


def load_sample(value, input_dir, limits, expected_size=None):
    annotation = Annotation.from_payload(value, limits)
    payload = image_path(input_dir, annotation.item_id).read_bytes()
    frame = decode_image(payload, limits)
    size = (frame.shape[1], frame.shape[0])
    if expected_size is not None and size != tuple(expected_size):
        raise ValueError(f"Image resolution {size} differs from required {tuple(expected_size)}")
    if annotation.corner_mode == "visible-edge":
        validate_edge(annotation.edge, size)
    else:
        if annotation.corners is None:
            raise ValueError("Missing corners; open annotate and select four corners")
        validate_corners(annotation.corners, size)
    return Sample(annotation, size, hashlib.sha256(payload).hexdigest())


def load_samples(path, input_dir, limits, expected_size=None, item_ids=None):
    records = read_records(path)
    if item_ids is not None:
        missing = set(item_ids) - {r.get("item_id") for r in records if isinstance(r, dict)}
        if missing:
            raise ValueError(f"Unknown reference images: {', '.join(sorted(missing))}")
        records = [r for r in records if isinstance(r, dict) and r.get("item_id") in item_ids]
    samples = []
    for record in records:
        try:
            sample = load_sample(record, input_dir, limits, expected_size)
        except (ValueError, OSError) as error:
            name = record.get("item_id", "<invalid>") if isinstance(record, dict) else "<invalid>"
            raise ValueError(f"{name}: {error}") from error
        if samples and sample.size != samples[0].size:
            raise ValueError("All images must use the same resolution, camera, and crop")
        samples.append(sample)
    return samples


class AnnotationStore:
    def __init__(self, input_dir, output, limits=None):
        self.input_dir, self.output = Path(input_dir), Path(output)
        self.limits = limits or Limits()
        self._lock = threading.Lock()
        self.annotations = {}
        self.identity_output = self.output.with_name(self.output.stem + '.identity.json')
        self.identity_reviews = {}
        if self.identity_output.exists():
            identity = read_json(self.identity_output)
            if identity.get('version') != 1:
                raise ValueError('Unsupported identity review schema')
            self.identity_reviews = {r['item_id']: r for r in identity['images']}
        if self.output.exists():
            for value in read_records(self.output):
                annotation = Annotation.from_payload(value, self.limits)
                self.annotations[annotation.item_id] = annotation

    def items(self):
        with self._lock:
            result = []
            for path in sorted(self.input_dir.glob("*")):
                if path.suffix.lower() not in IMAGE_EXTENSIONS or not path.is_file():
                    continue
                try:
                    target = image_path(self.input_dir, path.name)
                    frame = decode_image(target.read_bytes(), self.limits)
                except (ValueError, OSError):
                    continue
                annotation = self.annotations.get(path.name)
                result.append({"id": path.name, "url": "/media/" + quote(path.name),
                               "width": frame.shape[1], "height": frame.shape[0],
                               "annotation": asdict(annotation) if annotation else None,
                               "identity": self.identity_reviews.get(path.name)})
            return result

    def save(self, value):
        sample = load_sample(value, self.input_dir, self.limits)
        annotation = sample.annotation
        with self._lock:
            updated = {**self.annotations, annotation.item_id: annotation}
            write_json(self.output, {"schema_version": SCHEMA_VERSION,
                                    "annotations": [asdict(x) for x in updated.values()]})
            self.annotations = updated
        return asdict(annotation)

    def save_identity(self, value):
        if not isinstance(value, dict):
            raise ValueError('Identity review must be an object')
        item_id = value.get('item_id'); path = image_path(self.input_dir, item_id)
        payload = path.read_bytes(); frame = decode_image(payload, self.limits)
        identity, split, group = value.get('identity'), value.get('split'), value.get('group')
        if identity not in ('present', 'absent', 'ambiguous') or split not in ('reference', 'validation', 'test'):
            raise ValueError('Choose a valid identity and dataset role')
        if not isinstance(group, str) or not group.strip() or len(group) > 120:
            raise ValueError('Enter a scene/capture group (up to 120 characters)')
        if type(value.get('revision')) is not int or value['revision'] < 0:
            raise ValueError('Identity revision must be a nonnegative integer')
        edge = validate_edge(value.get('edge'), (frame.shape[1], frame.shape[0])) if identity == 'present' else None
        with self._lock:
            old = self.identity_reviews.get(item_id, {})
            if value.get('revision') != old.get('revision', 0):
                raise ValueError('Identity review changed in another tab; reload before saving')
            record = {'item_id': item_id, 'image': str(path.resolve()), 'sha256': hashlib.sha256(payload).hexdigest(),
                      'identity': identity, 'edge': edge, 'imageSize': [frame.shape[1], frame.shape[0]],
                      'group': group.strip(), 'split': split, 'revision': old.get('revision', 0) + 1,
                      'review': 'User-reviewed object identity; no automatic angle used'}
            updated = {**self.identity_reviews, item_id: record}
            write_json(self.identity_output, {'version': 1, 'images': list(updated.values())})
            self.identity_reviews = updated
        return record

    def upload(self, name, payload):
        if len(payload) > self.limits.annotation_max_upload_mb * 1024 * 1024:
            raise ValueError("Upload exceeds configured size limit")
        frame = decode_image(payload, self.limits)
        target = image_path(self.input_dir, name)
        with self._lock:
            if target.exists():
                target = image_path(self.input_dir, target.stem + "-" + uuid.uuid4().hex[:12] + target.suffix)
            write_bytes(target, payload)
        return {"id": target.name, "width": frame.shape[1], "height": frame.shape[0]}


def serve(store, host, port, config=None):
    class Handler(BaseHTTPRequestHandler):
        def send_data(self, payload, content_type, code=200):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def send_json(self, value, code=200):
            self.send_data(json.dumps(value, allow_nan=False).encode(), "application/json", code)

        def do_GET(self):
            path = urlparse(self.path).path
            try:
                if path == "/":
                    self.send_data(Path(__file__).with_name("annotation.html").read_bytes(), "text/html; charset=utf-8")
                elif path == "/api/config":
                    self.send_json({"min_angle_deg": store.limits.min_angle_deg, "max_angle_deg": store.limits.max_angle_deg,
                                    "labels": config.labels if config else DEFAULT_LABELS,
                                    "corner_mode": "visible-edge" if config and config.uncalibrated_method == "edge" else "physical",
                                    "edge_labels": EDGE_LABELS,
                                    "width": config.width if config else 1280, "height": config.height if config else 720})
                elif path == "/api/items":
                    self.send_json(store.items())
                elif path.startswith("/media/"):
                    target = image_path(store.input_dir, unquote(path[7:]))
                    payload = target.read_bytes()
                    decode_image(payload, store.limits)
                    self.send_data(payload, mimetypes.guess_type(target.name)[0] or "application/octet-stream")
                else:
                    self.send_json({"error": "Not found"}, 404)
            except (ValueError, OSError):
                self.send_json({"error": "Image not found or invalid"}, 404)

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= store.limits.annotation_max_upload_mb * 1024 * 1024 + 65536:
                    self.send_json({"error": "Invalid or oversized request"}, 413)
                    return
                body = self.rfile.read(length)
                if self.path == "/api/annotations":
                    self.send_json(store.save(json.loads(body)))
                elif self.path == "/api/identity":
                    self.send_json(store.save_identity(json.loads(body)))
                elif self.path == "/api/upload":
                    content_type = self.headers.get("Content-Type", "")
                    message = BytesParser(policy=default).parsebytes(
                        b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body)
                    part = next((p for p in message.iter_attachments()
                                 if p.get_param("name", header="content-disposition") == "file"), None)
                    if part is None:
                        raise ValueError("A multipart image file is required")
                    self.send_json(store.upload(part.get_filename() or "frame.jpg", part.get_payload(decode=True) or b""), 201)
                else:
                    self.send_json({"error": "Not found"}, 404)
            except (ValueError, TypeError, KeyError, UnicodeError) as error:
                self.send_json({"error": str(error)}, 400)
            except OSError:
                self.send_json({"error": "Could not persist the file"}, 500)

        def log_message(self, *args):
            pass

    return ThreadingHTTPServer((host, port), Handler)
