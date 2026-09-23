"""Versioned image descriptors shared by research and the local inference worker.

Source PNGs and v1 annotation vectors are never modified. Optional network access
is confined to the explicit asset preparation command, never live inference.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import urllib.request
import zipfile
import io

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(__file__).with_name('scene-config.json')
EXTRACTOR_VERSION = 1


def digest_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def signature(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def read_rgb(path):
    image = cv2.imdecode(np.frombuffer(Path(path).read_bytes(), np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim != 3 or image.shape[2] not in (3, 4):
        raise ValueError('A decoded RGB/RGBA screenshot is required')
    return cv2.cvtColor(image, cv2.COLOR_BGRA2RGB if image.shape[2] == 4 else cv2.COLOR_BGR2RGB)


def resize(image, side):
    height, width = image.shape[:2]
    if min(height, width) < 1 or image.dtype != np.uint8 or image.shape != (height, width, 3):
        raise ValueError('Expected nonempty RGB8 image')
    scale = min(1., side / max(height, width))
    return cv2.resize(image, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_AREA)


def cells(image, pyramid):
    height, width = image.shape[:2]
    for count in pyramid:
        if min(height, width) < count:
            raise ValueError('Image too small for descriptor pyramid')
        for y in range(count):
            for x in range(count):
                yield image[y * height // count:(y + 1) * height // count,
                            x * width // count:(x + 1) * width // count]


def lighting_features(rgb, config):
    rgb = resize(rgb, config['maxSide']).astype(np.float32) / 255
    eps = config['epsilon']; y = rgb @ np.array([.299, .587, .114], np.float32)
    logs = np.log(rgb + eps)
    ratios = np.stack([logs[:, :, 0] - logs[:, :, 1], logs[:, :, 2] - logs[:, :, 1]], axis=-1)
    chroma = rgb / np.maximum(rgb.sum(axis=-1, keepdims=True), eps)
    stack = np.dstack([y, rgb, ratios, chroma])
    features = []
    for cell in cells(stack, config['pyramid']):
        values = cell.reshape(-1, cell.shape[-1]); luminance = cell[:, :, 0]
        features.extend(np.quantile(values, config['quantiles'], axis=0).ravel())
        features.extend(values.std(axis=0))
        features.extend([np.mean(luminance < .04), np.mean(np.max(cell[:, :, 1:4], axis=-1) > .98),
                         np.mean(luminance > .8), np.std(luminance) / max(float(np.mean(luminance)), eps)])
        dx = np.diff(luminance, axis=1); dy = np.diff(luminance, axis=0)
        features.extend([dx.mean() if dx.size else 0, dy.mean() if dy.size else 0,
                         np.abs(dx).mean() if dx.size else 0, np.abs(dy).mean() if dy.size else 0])
    return np.asarray(features, np.float64)


def texture_features(rgb, config):
    gray = cv2.cvtColor(resize(rgb, config['maxSide']), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
    mean = cv2.GaussianBlur(gray, (0, 0), 3)
    variance = np.maximum(0, cv2.GaussianBlur(gray * gray, (0, 0), 3) - mean * mean)
    normalized = (gray - mean) / np.maximum(np.sqrt(variance), config['epsilon'])
    dx = cv2.Sobel(normalized, cv2.CV_32F, 1, 0); dy = cv2.Sobel(normalized, cv2.CV_32F, 0, 1)
    magnitude = np.hypot(dx, dy); orientation = np.mod(np.arctan2(dy, dx), np.pi)
    # Rotation-sensitive uniform LBP retains orientation; rotation is part of the signal.
    mapping = np.full(256, 58, dtype=np.uint8); next_bin = 0
    for code in range(256):
        bits = [(code >> i) & 1 for i in range(8)]
        if sum(bits[i] != bits[(i + 1) % 8] for i in range(8)) <= 2:
            mapping[code] = next_bin; next_bin += 1
    codes = []
    for radius in (1, 2):
        padded = cv2.copyMakeBorder(gray, radius, radius, radius, radius, cv2.BORDER_REFLECT_101)
        code = np.zeros(gray.shape, np.uint8)
        for bit, (y, x) in enumerate([(-1,-1),(-1,0),(-1,1),(0,1),(1,1),(1,0),(1,-1),(0,-1)]):
            shifted = padded[radius+y*radius:radius+y*radius+gray.shape[0], radius+x*radius:radius+x*radius+gray.shape[1]]
            code |= (shifted >= gray).astype(np.uint8) << bit
        codes.append(mapping[code])
    features = []
    for cell in cells(np.dstack([magnitude, orientation, dx, dy, *codes]), config['pyramid']):
        mag, angle = cell[:, :, 0], cell[:, :, 1]
        hist = np.histogram(angle, bins=config['gradientBins'], range=(0, np.pi), weights=mag)[0]
        features.extend(hist / max(float(np.linalg.norm(hist)), config['epsilon']))
        features.extend([np.abs(cell[:, :, 2]).mean(), np.abs(cell[:, :, 3]).mean(), mag.mean(), mag.std()])
        for index in (4, 5):
            counts = np.bincount(cell[:, :, index].astype(int).ravel(), minlength=59)
            features.extend(counts / counts.sum())
    return np.asarray(features, np.float64)


def metadata_features(camera, config):
    features = []
    for key in config['metadataFields']:
        value = camera.get(key); available = type(value) in (int, float) and np.isfinite(value)
        features.extend([float(value) if available else 0., float(available)])
    for key in config['metadataModes']:
        value = camera.get(key)
        features.extend([float(value == mode) for mode in ('manual', 'continuous', 'single-shot')])
        features.append(float(isinstance(value, str)))
    return np.asarray(features)


def prepare_assets(config, asset_root):
    asset_root = Path(asset_root); asset_root.mkdir(parents=True, exist_ok=True)
    for family, spec in config['sources'].items():
        source = asset_root / (family + '-' + spec['commit'])
        if not source.exists():
            print('Downloading pinned source:', family, flush=True)
            url = f"https://codeload.github.com/{spec['repo']}/zip/{spec['commit']}"
            with urllib.request.urlopen(url, timeout=120) as response:
                archive = zipfile.ZipFile(io.BytesIO(response.read()))
            staging = asset_root / (family + '-source-pending'); staging.mkdir(exist_ok=True)
            for member in archive.infolist():
                parts = Path(member.filename).parts[1:]
                if not parts or member.is_dir():
                    continue
                path = staging.joinpath(*parts)
                if not path.resolve().is_relative_to(staging.resolve()):
                    raise ValueError('Invalid source archive member')
                path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(archive.read(member))
            staging.rename(source)
        weights = asset_root / (family + '.pth')
        if not weights.exists():
            print('Downloading official weights:', family, flush=True)
            temporary = weights.with_suffix('.pending')
            with urllib.request.urlopen(spec['weights'], timeout=180) as response, temporary.open('wb') as output:
                for chunk in iter(lambda: response.read(1024 * 1024), b''):
                    output.write(chunk)
            temporary.rename(weights)
        manifest = {**spec, 'sha256': digest_file(weights), 'sourceDirectory': source.name, 'weightsFile': weights.name}
        (asset_root / (family + '.json')).write_text(json.dumps(manifest, indent=2))
        print(f"{family}: {manifest['sha256']}", flush=True)


class ImageFeatures:
    def __init__(self, config, asset_root=None, backend='cpu'):
        self.config = config; self.asset_root = Path(asset_root or ROOT / config['assetDirectory'])
        self.backend = backend; self.models = {}; self.manifests = {}

    def manifest(self, family):
        if family not in ('dino', 'depth'):
            return {'version': EXTRACTOR_VERSION, 'family': family, 'config': self.config}
        if family not in self.manifests:
            path = self.asset_root / (family + '.json')
            if not path.exists():
                raise ValueError(f'{family} weights unavailable; run scene_features.py --prepare-assets')
            manifest = json.loads(path.read_text())
            if any(manifest.get(k) != v for k, v in self.config['sources'][family].items()):
                raise ValueError('Pretrained source differs from the configured version')
            if digest_file(self.asset_root / manifest['weightsFile']) != manifest['sha256']:
                raise ValueError('Pretrained weight checksum differs')
            self.manifests[family] = manifest
        return {'version': EXTRACTOR_VERSION, 'family': family, 'config': self.config, 'encoder': self.manifests[family]}

    def model(self, family):
        if family not in self.models:
            self.manifest(family)
            try:
                import torch
            except ImportError as error:
                raise ValueError('Optional image encoder dependencies unavailable; install requirements-vision.txt') from error
            torch.set_num_threads(self.config['visionThreads'])
            if self.backend == 'cuda' and not torch.cuda.is_available():
                raise ValueError('CUDA requested but unavailable; no silent CPU substitution')
            manifest = self.manifests[family]; source = self.asset_root / manifest['sourceDirectory']
            if family == 'dino':
                model = torch.hub.load(str(source), 'dinov2_vits14', source='local', pretrained=False)
            else:
                sys.path.insert(0, str(source))
                from depth_anything_v2.dpt import DepthAnythingV2
                model = DepthAnythingV2(encoder='vits', features=64, out_channels=[48, 96, 192, 384])
            model.load_state_dict(torch.load(self.asset_root / manifest['weightsFile'], map_location='cpu', weights_only=True))
            self.models[family] = model.eval().to(self.backend)
        return self.models[family]

    def extract(self, rgb, family, camera=None):
        if family == 'lighting':
            result = lighting_features(rgb, self.config)
        elif family == 'texture':
            result = texture_features(rgb, self.config)
        elif family == 'metadata':
            result = metadata_features(camera or {}, self.config)
        elif family in ('dino', 'depth'):
            import torch
            model = self.model(family)
            with torch.inference_mode():
                if family == 'dino':
                    image = resize(rgb, self.config['visionSide']).astype(np.float32) / 255
                    height, width = image.shape[:2]
                    # Pad to the next patch boundary, without stretching/cropping the scene.
                    image = cv2.copyMakeBorder(image, 0, (-height) % 14, 0, (-width) % 14, cv2.BORDER_REPLICATE)
                    tensor = torch.from_numpy(image.transpose(2, 0, 1).copy()).unsqueeze(0).to(self.backend)
                    mean = tensor.new_tensor([.485, .456, .406]).view(1, 3, 1, 1)
                    std = tensor.new_tensor([.229, .224, .225]).view(1, 3, 1, 1)
                    output = model.forward_features((tensor - mean) / std)
                    grid = output['x_norm_patchtokens'].reshape(image.shape[0] // 14, image.shape[1] // 14, -1).cpu().numpy()
                    result = np.concatenate([output['x_norm_clstoken'].cpu().numpy().ravel(),
                                             *[cell.mean(axis=(0, 1)) for cell in cells(grid, [1, 2])]])
                else:
                    # Explicit backend: the upstream convenience helper selects CUDA
                    # automatically, which would make a CPU benchmark misleading.
                    image = resize(rgb, self.config['depthSide']).astype(np.float32) / 255
                    height, width = image.shape[:2]
                    image = cv2.copyMakeBorder(image, 0, (-height) % 14, 0, (-width) % 14, cv2.BORDER_REPLICATE)
                    tensor = torch.from_numpy(image.transpose(2, 0, 1).copy()).unsqueeze(0).to(self.backend)
                    mean = tensor.new_tensor([.485, .456, .406]).view(1, 3, 1, 1)
                    std = tensor.new_tensor([.229, .224, .225]).view(1, 3, 1, 1)
                    depth = model((tensor - mean) / std)[0, :height, :width].cpu().numpy()
                    q10, q90 = np.quantile(depth, [.1, .9]); depth = (depth - q10) / max(float(q90 - q10), self.config['epsilon'])
                    result = []
                    for cell in cells(depth, self.config['pyramid']):
                        result.extend(np.quantile(cell, self.config['quantiles']))
                        dx = np.diff(cell, axis=1); dy = np.diff(cell, axis=0)
                        result.extend([cell.mean(), cell.std(), np.abs(dx).mean() if dx.size else 0, np.abs(dy).mean() if dy.size else 0])
            result = np.asarray(result, np.float64)
        else:
            raise ValueError('Unknown feature family: ' + family)
        if result.ndim != 1 or not np.isfinite(result).all():
            raise ValueError('Feature extraction produced an invalid vector')
        return result

    def cached(self, rgb, family, image_hash, camera, directory):
        key = signature({'image': image_hash, 'extractor': self.manifest(family),
                         'camera': metadata_features(camera, self.config).tolist() if family == 'metadata' else None,
                         'backend': self.backend if family in ('dino', 'depth') else 'cpu'})
        path = Path(directory) / (key + '.npy')
        if path.exists():
            value = np.load(path, allow_pickle=False)
        else:
            value = self.extract(rgb, family, camera); path.parent.mkdir(parents=True, exist_ok=True)
            np.save(path, value, allow_pickle=False)
        if value.ndim != 1 or not np.isfinite(value).all():
            raise ValueError('Invalid feature cache entry')
        return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=CONFIG_PATH)
    parser.add_argument('--prepare-assets', action='store_true')
    args = parser.parse_args(); config = json.loads(args.config.read_text())
    if args.prepare_assets:
        prepare_assets(config, ROOT / config['assetDirectory'])
