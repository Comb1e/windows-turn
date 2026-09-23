"""Optional object-identity evidence; angle regression remains independent.

Every candidate must pass before it can participate in boundary ranking. A
missing encoder or reference bank is unavailable, never implicit permission.
"""
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Protocol
import json
import math
import hashlib


def file_sha256(path):
    checksum = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


@dataclass(frozen=True)
class IdentityResult:
    status: str
    reason: str = ""
    scores: dict = field(default_factory=dict)

    def __post_init__(self):
        if self.status not in {"accepted", "rejected", "unavailable"}:
            raise ValueError("Invalid identity result")
        if any(not isinstance(v, (float, int)) or not math.isfinite(v) for v in self.scores.values()):
            raise ValueError("Identity scores must be finite numbers")

    def payload(self):
        return asdict(self)


class IIdentityVerifier(Protocol):
    last: IdentityResult

    def start_frame(self, frame): ...
    def verify(self, edge) -> IdentityResult: ...
    def end_frame(self): ...
    def info(self) -> dict: ...


class UnavailableVerifier:
    def __init__(self, method, reason, backend="unavailable"):
        self.method, self.reason, self.backend = method, reason, backend
        self.last = IdentityResult("unavailable", reason)

    def start_frame(self, frame):
        self.last = IdentityResult("unavailable", self.reason)

    def verify(self, edge):
        return self.last

    def end_frame(self):
        pass

    def info(self):
        return {"method": self.method, "backend": self.backend, "available": False, "reason": self.reason}


def load_verifier(settings, image_size):
    """Explicit opt-in, compatible with old services and saved angle models."""
    if settings.get("method", "disabled") == "disabled":
        return None
    method = settings["method"]
    try:
        path = Path(settings.get("config", "identity-config.json")).resolve()
        config = json.loads(path.read_text(encoding="utf-8"))
        config.update({k: v for k, v in settings.items() if k != "config"})
        from .identity_vision import make_verifier
        return make_verifier(method, config, path.parent, tuple(image_size))
    except Exception as error:
        return UnavailableVerifier(method, f"Keyboard identity unavailable: {error}")
