"""Camera-free, loopback RGBA frame interface for the existing edge estimator."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import threading
import time
import uuid

import cv2
import numpy as np

from .edge import EdgeModel, EdgeSession, read_uncalibrated_model
from .identity import load_verifier


class ServiceError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class KeyboardService:
    def __init__(self, model, limits, settings, model_id="unknown"):
        if not isinstance(model, EdgeModel):
            raise ValueError("The frame service requires a moving-edge model")
        self.model, self.limits, self.settings = model, limits, settings
        self.model_id = model_id
        self.verifier = load_verifier(settings.get("identity", {}), model.image_size)
        self.lock = threading.Lock()
        self.session_id = None
        self.activity = 0

    def health(self):
        return {"version": 1, "service": "keyboard", "ready": True, "modelId": self.model_id,
                "boundaryValidation": "surface-context-and-temporal-confirmation-v3",
                "identity": self.verifier.info() if self.verifier else {"method": "disabled", "backend": "cpu", "available": True},
                "camera": {"width": self.model.image_size[0], "height": self.model.image_size[1],
                           "horizontalFovDegrees": self.model.horizontal_fov_deg},
                "angleRange": [max(self.model.training_range[0], self.limits.min_angle_deg),
                               min(self.model.training_range[1], self.limits.max_angle_deg)]}

    def create(self, camera):
        if (camera.get("width"), camera.get("height")) != self.model.image_size:
            raise ServiceError("Camera dimensions must match the keyboard model")
        if self.session_id and time.monotonic() - self.activity < self.settings["leaseIdleSeconds"]:
            raise ServiceError("Another session owns the keyboard service", 409)
        self.session_id = str(uuid.uuid4())
        self.session = EdgeSession(self.model, self.limits, self.verifier)
        self.sequence, self.timestamp = -1, -1
        self.activity = time.monotonic()
        return {**self.health(), "sessionId": self.session_id}

    def require(self, sid):
        if sid != self.session_id or not sid:
            raise ServiceError("Expired keyboard session", 409)
        self.activity = time.monotonic()

    def frame(self, sid, headers, raw):
        self.require(sid)
        try:
            frame_id = int(headers["X-Frame-Id"])
            timestamp = float(headers["X-Timestamp-Ms"])
            size = (int(headers["X-Width"]), int(headers["X-Height"]))
        except (KeyError, TypeError, ValueError):
            raise ServiceError("Missing or invalid frame metadata")
        if not 0 <= frame_id <= 2**53-1 or frame_id <= self.sequence or not math.isfinite(timestamp) or timestamp < 0 or timestamp <= self.timestamp:
            raise ServiceError("Frame IDs and capture timestamps must strictly increase")
        if size != self.model.image_size or len(raw) != size[0] * size[1] * 4:
            raise ServiceError("RGBA byte count or dimensions do not match the keyboard model")
        rgba = np.frombuffer(raw, np.uint8).reshape(size[1], size[0], 4)
        bgr = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGR)
        self.sequence, self.timestamp = frame_id, timestamp
        result = self.session.update(bgr, timestamp / 1000)
        return {"sessionId": sid, "frameId": frame_id, "timestampMs": timestamp,
                "angleDeg": result.angle_deg, "valid": result.angle_deg is not None,
                "state": self.session.state.value, "modelId": self.model_id,
                "quality": {"confidence": result.confidence, "reason": result.reason,
                            "identity": self.verifier.last.payload() if self.verifier else {"status": "disabled"}},
                "edge": self.session.record(timestamp / 1000).get("edge")}


def make_server(model_path, config, settings):
    path = Path(model_path)
    service = KeyboardService(read_uncalibrated_model(path), config.limits, settings,
                              hashlib.sha256(path.read_bytes()).hexdigest())

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, body):
            raw = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            self.reply(200, service.health()) if self.path == "/v1/health" else self.reply(404, {"error": "Not found"})

        def mutate(self):
            # Drain bounded uploads before replying, including rejected requests.
            # Closing a Windows socket with unread RGBA bytes can reset it and
            # discard the JSON error response before the client receives it.
            try:
                self.connection.settimeout(settings["readTimeoutSeconds"])
                size = int(self.headers.get("Content-Length", 0))
                if size < 0 or size > settings["maxBodyBytes"]:
                    raise ServiceError("Request too large", 413)
                raw = self.rfile.read(size)
                if len(raw) != size:
                    raise ServiceError("Incomplete request body")
            except (ValueError, OSError) as error:
                self.reply(getattr(error, "status", 400), {"error": str(error)})
                return
            origin = self.headers.get("Origin")
            if origin and origin != "http://" + self.headers.get("Host", ""):
                self.reply(403, {"error": "Same-origin requests only"})
                return
            if not service.lock.acquire(blocking=False):
                self.reply(409, {"error": "Keyboard busy; keep only the latest waiting frame"})
                return
            try:
                if self.path == "/v1/sessions" and self.command == "POST":
                    body = json.loads(raw or b"{}")
                    result = service.create(body.get("camera", {}))
                else:
                    parts = self.path.strip("/").split("/")
                    if len(parts) not in (3, 4) or parts[:2] != ["v1", "sessions"]:
                        raise ServiceError("Not found", 404)
                    sid = parts[2]
                    service.require(sid)
                    if len(parts) == 3 and self.command == "DELETE":
                        service.session_id = None
                        service.session = None
                        result = {"stopped": True}
                    elif parts[3:] == ["reset"] and self.command == "POST":
                        service.session_id = None
                        result = service.create({"width": service.model.image_size[0], "height": service.model.image_size[1]})
                    elif parts[3:] == ["frames"] and self.command == "POST":
                        if self.headers.get("Content-Type") != "application/octet-stream":
                            raise ServiceError("Use application/octet-stream RGBA8", 415)
                        result = service.frame(sid, self.headers, raw)
                    else:
                        raise ServiceError("Not found", 404)
                self.reply(200, result)
            except (ValueError, TypeError, KeyError, OSError) as error:
                self.reply(getattr(error, "status", 400), {"error": str(error)})
            finally:
                service.lock.release()

        do_POST = mutate
        do_DELETE = mutate

    server = ThreadingHTTPServer((settings["host"], settings["port"]), Handler)
    server.service = service
    return server
