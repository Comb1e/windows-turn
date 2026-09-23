"""Frozen, optional identity verifiers. No angle labels enter visual features.

DINO uses dense foreground/background reference matching inspired by Matcher,
not a reproduction of its SAM pipeline. PerSAM uses its pinned official model
implementation and target guidance. YOLO is a semantic-plus-boundary baseline.
"""
import hashlib
import json
import sys
import time
import uuid

import cv2
import numpy as np

from .identity import IdentityResult, file_sha256 as digest

EXTRACTOR_VERSION = 1


def region_masks(shape, edge, inset):
    h, w = shape[:2]; points = np.asarray(edge, dtype=float)
    if points.shape != (2, 2) or not np.isfinite(points).all() or points[1, 0] <= points[0, 0]:
        raise ValueError('Invalid identity boundary')
    yy, xx = np.mgrid[:h, :w]
    line = points[0, 1] + (points[1, 1] - points[0, 1]) * (xx - points[0, 0]) / (points[1, 0] - points[0, 0])
    inside = (xx >= points[0, 0]) & (xx <= points[1, 0])
    return inside & (yy > line + inset), inside & (yy < line - inset)


def pooled_mask(mask, resized_size, grid_size, padded_size):
    """Area support from real image pixels only; padding supplies no evidence."""
    width, height = resized_size; padded_w, padded_h = padded_size
    value = cv2.resize(mask.astype(np.float32), (width, height), interpolation=cv2.INTER_AREA)
    value = cv2.copyMakeBorder(value, 0, padded_h - height, 0, padded_w - width, cv2.BORDER_CONSTANT, value=0)
    return cv2.resize(value, grid_size, interpolation=cv2.INTER_AREA)


class VisionVerifier:
    def __init__(self, method, config, root, image_size):
        dependencies = root / config['dependencies']
        if dependencies.exists():
            sys.path.insert(0, str(dependencies))
        import torch
        self.torch = torch
        self.method, self.config, self.root = method, config, root
        self.image_size = image_size
        if tuple(config['imageSize']) != image_size:
            raise ValueError('Identity camera dimensions differ from the angle model')
        self.backend = config['backend']
        if self.backend not in {'cpu', 'cuda'} or (self.backend == 'cuda' and not torch.cuda.is_available()):
            raise ValueError(f'Requested identity backend {self.backend} is unavailable')
        torch.set_num_threads(config['threads'])
        self.frame = None; self.prepared = None; self.processing_ms = 0
        self.last = IdentityResult('unavailable', 'No current identity evidence')
        self.assets = root / config['assets']

    def references(self):
        path = self.root / self.config['references']
        manifest = json.loads(path.read_text())
        if manifest.get('version') != 1 or tuple(manifest['imageSize']) != self.image_size:
            raise ValueError('Incompatible identity reference manifest')
        records = manifest['references']
        if not 1 <= len(records) <= self.config['maxReferences']:
            raise ValueError('Identity reference count is outside its configured limit')
        result = []
        for item in records:
            image = (path.parent / item['image']).resolve()
            if digest(image) != item['sha256']:
                raise ValueError('Identity reference image checksum changed')
            bgr = cv2.imread(str(image))
            if bgr is None or (bgr.shape[1], bgr.shape[0]) != self.image_size:
                raise ValueError('Invalid identity reference image')
            result.append((item, bgr))
        return result

    def asset(self):
        manifest = json.loads((self.assets / f'{self.method}.json').read_text())
        if manifest['source'] != self.config['sources'][self.method]:
            raise ValueError('Identity asset source version changed')
        for name, checksum in manifest.get('sourceHashes', {}).items():
            if digest(self.assets / manifest['sourceDirectory'] / name) != checksum:
                raise ValueError('Identity source checksum changed')
        weights = self.assets / manifest['weightsFile']
        if digest(weights) != manifest['sha256']:
            raise ValueError('Identity weight checksum changed')
        self.weight_hash = manifest['sha256']
        return manifest, weights

    def start_frame(self, frame):
        self.frame = None; self.prepared = None
        self.last = IdentityResult('unavailable', 'No structurally supported identity candidate')
        if frame.ndim != 3 or frame.shape[2] != 3 or frame.dtype != np.uint8 or (frame.shape[1], frame.shape[0]) != self.image_size:
            raise ValueError('Identity frame differs from reference camera')
        self.frame = frame; self.started = time.perf_counter()

    def end_frame(self):
        self.frame = None; self.prepared = None
        if hasattr(self, 'started'):
            self.processing_ms = (time.perf_counter() - self.started) * 1000

    def info(self):
        return {'method': self.method, 'backend': self.backend, 'available': True,
                'device': self.torch.cuda.get_device_name(0) if self.backend == 'cuda' else 'CPU',
                'weightSha256': self.weight_hash, 'extractorVersion': EXTRACTOR_VERSION}


class DinoVerifier(VisionVerifier):
    def __init__(self, config, root, image_size):
        super().__init__('dino', config, root, image_size)
        path = (root / config['dino']['assetManifest']).resolve()
        manifest = json.loads(path.read_text()); weights = path.parent / manifest['weightsFile']
        self.source_version = manifest['repo'] + '@' + manifest['commit']
        if digest(weights) != manifest['sha256']:
            raise ValueError('DINO reference weights checksum changed')
        self.weight_hash = manifest['sha256']
        self.model = self.torch.hub.load(str(path.parent / manifest['sourceDirectory']), 'dinov2_vits14', source='local', pretrained=False)
        self.model.load_state_dict(self.torch.load(weights, weights_only=True, map_location='cpu'))
        self.model.eval().to(self.backend)
        foreground, background = [], []
        for item, bgr in self.references():
            grid = self.reference_grid(item, bgr)
            fg, bg = self.masks(bgr.shape, item['edge'])
            for bank, mask in ((foreground, fg), (background, bg)):
                values = grid[mask]; limit = config['maxPrototypePatchesPerReference']
                if len(values) > limit:
                    values = values[np.linspace(0, len(values) - 1, limit).astype(int)]
                bank.extend(values)
        if not foreground or not background:
            raise ValueError('Reference masks contain insufficient real image patches')
        self.foreground = self.torch.from_numpy(np.asarray(foreground, np.float32).T.copy()).to(self.backend)
        self.background = self.torch.from_numpy(np.asarray(background, np.float32).T.copy()).to(self.backend)

    def dimensions(self, shape):
        h, w = shape[:2]; factor = min(1., self.config['maxSide'] / max(h, w))
        width, height = max(1, round(w * factor)), max(1, round(h * factor))
        return (width, height), (width + (-width) % 14, height + (-height) % 14)

    def encode(self, bgr):
        torch = self.torch; (w, h), (pw, ph) = self.dimensions(bgr.shape)
        rgb = cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), (w, h), interpolation=cv2.INTER_AREA)
        rgb = cv2.copyMakeBorder(rgb, 0, ph - h, 0, pw - w, cv2.BORDER_REPLICATE)
        with torch.inference_mode():
            tensor = torch.from_numpy(rgb.transpose(2, 0, 1).copy()).unsqueeze(0).to(self.backend).float() / 255
            mean = tensor.new_tensor([.485, .456, .406]).view(1, 3, 1, 1)
            std = tensor.new_tensor([.229, .224, .225]).view(1, 3, 1, 1)
            tokens = self.model.forward_features((tensor - mean) / std)['x_norm_patchtokens']
            grid = torch.nn.functional.normalize(tokens, dim=-1).reshape(ph // 14, pw // 14, -1).cpu().numpy()
        return grid

    def reference_grid(self, item, bgr):
        cache = self.root / 'data/identity-cache'; cache.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(json.dumps({'image': item['sha256'], 'weights': self.weight_hash, 'version': EXTRACTOR_VERSION,
                                       'maxSide': self.config['maxSide'], 'source': self.source_version,
                                       'backend': self.backend}, sort_keys=True).encode()).hexdigest()
        path = cache / (key + '.npz')
        if path.exists():
            with np.load(path, allow_pickle=False) as saved:
                grid = saved['grid']
            _, padded = self.dimensions(bgr.shape)
            if grid.shape != (padded[1] // 14, padded[0] // 14, 384) or not np.isfinite(grid).all():
                raise ValueError('Invalid derived reference cache')
            return grid
        grid = self.encode(bgr)
        temporary = path.with_suffix('.' + uuid.uuid4().hex + '.tmp')
        try:
            with temporary.open('xb') as output:
                np.savez_compressed(output, grid=grid)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        return grid

    def masks(self, shape, edge):
        masks = region_masks(shape, edge, self.config['maskInsetPixels'])
        size, padded = self.dimensions(shape); grid = (padded[0] // 14, padded[1] // 14)
        return tuple(pooled_mask(mask, size, grid, padded) >= self.config['minPatchOccupancy'] for mask in masks)

    def verify(self, edge):
        foreground, _ = self.masks(self.frame.shape, edge)
        columns = np.array_split(np.arange(foreground.shape[1]), self.config['regions'])
        if any(foreground[:, xs].sum() < self.config['minPatchesPerRegion'] for xs in columns):
            return IdentityResult('unavailable', 'Visible laptop strip is too thin for independent identity patches')
        if self.prepared is None:
            grid = self.encode(self.frame)
            # Compute once per frame, independently of the number of proposed edges.
            with self.torch.inference_mode():
                tokens = self.torch.from_numpy(grid).to(self.backend)
                fg = (tokens @ self.foreground).amax(dim=-1)
                bg = (tokens @ self.background).amax(dim=-1)
                self.prepared = fg.cpu().numpy(), (fg - bg).cpu().numpy()
        similarity, margin = self.prepared; settings = self.config['dino']
        supported = (similarity >= settings['minSimilarity']) & (margin >= settings['minForegroundMargin'])
        support = min(float(supported[:, xs][foreground[:, xs]].mean()) for xs in columns)
        scores = {'similarity': float(similarity[foreground].mean()), 'foregroundMargin': float(margin[foreground].mean()), 'minimumRegionSupport': support}
        accepted = support >= settings['minRegionSupport']
        return IdentityResult('accepted' if accepted else 'rejected', '' if accepted else 'Visible surface does not distinguish the laptop from reference backgrounds', scores)


class PerSamVerifier(VisionVerifier):
    def __init__(self, config, root, image_size):
        super().__init__('persam', config, root, image_size)
        manifest, weights = self.asset(); sys.path.insert(0, str(self.assets / manifest['sourceDirectory']))
        from per_segment_anything import sam_model_registry, SamPredictor
        # TinyViT caches attention bias on eval(); build that cache on the target device.
        self.predictor = SamPredictor(sam_model_registry['vit_t'](checkpoint=str(weights)).to(self.backend).eval())
        self.references_embedded = []
        with self.torch.inference_mode():
            for item, bgr in self.references():
                mask, _ = region_masks(bgr.shape, item['edge'], config['maskInsetPixels'])
                self.predictor.set_image(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
                feat = self.predictor.features[0].permute(1, 2, 0)
                ih, iw = self.predictor.input_size; side = self.predictor.model.image_encoder.img_size
                support = pooled_mask(mask, (iw, ih), (feat.shape[1], feat.shape[0]), (side, side))
                valid = self.torch.from_numpy(support >= config['minPatchOccupancy']).to(self.backend)
                if valid.any():
                    self.references_embedded.append(feat[valid].mean(0))
        if not self.references_embedded:
            raise ValueError('No supported PerSAM reference mask')
        self.predictor.reset_image()

    def segment(self):
        torch = self.torch; predictor = self.predictor
        with torch.inference_mode():
            predictor.set_image(cv2.cvtColor(self.frame, cv2.COLOR_BGR2RGB))
            feat = torch.nn.functional.normalize(predictor.features[0], dim=0)
            targets = torch.stack(self.references_embedded)
            similarities = torch.nn.functional.normalize(targets, dim=-1) @ feat.reshape(feat.shape[0], -1)
            # Select a reference from image evidence alone, never its angle.
            reference = int(similarities.max(dim=1).values.argmax())
            sim = similarities[reference].reshape(1, 1, *feat.shape[1:])
            sim = torch.nn.functional.interpolate(sim, scale_factor=4, mode='bilinear', align_corners=False)
            sim = predictor.model.postprocess_masks(sim, predictor.input_size, predictor.original_size).squeeze()
            peak = float(sim.max()); h, w = sim.shape
            high, low = int(sim.argmax()), int(sim.argmin())
            points = np.array([[high % w, high // w], [low % w, low // w]])
            labels = np.array([1, 0])
            guidance = (sim - sim.mean()) / sim.std().clamp_min(1e-6)
            attention = torch.nn.functional.interpolate(guidance[None, None], size=(64, 64), mode='bilinear', align_corners=False).sigmoid().unsqueeze(0).flatten(3)
            masks, scores, logits, _ = predictor.predict(point_coords=points, point_labels=labels, multimask_output=False,
                                                       attn_sim=attention, target_embedding=targets[reference][None, None])
            masks, scores, logits, _ = predictor.predict(point_coords=points, point_labels=labels, mask_input=logits[:1], multimask_output=True)
            best = int(np.argmax(scores)); yy, xx = np.nonzero(masks[best])
            if len(xx):
                box = np.array([[xx.min(), yy.min(), xx.max(), yy.max()]])
                masks, scores, logits, _ = predictor.predict(point_coords=points, point_labels=labels, box=box, mask_input=logits[best:best + 1], multimask_output=True)
                best = int(np.argmax(scores))
            return masks[best], float(scores[best]), peak

    def verify(self, edge):
        if self.prepared is None:
            self.prepared = self.segment()
        mask, score, similarity = self.prepared
        below, above = region_masks(mask.shape, edge, self.config['maskInsetPixels'])
        if not below.any() or not above.any():
            return IdentityResult('unavailable', 'Insufficient real pixels around candidate')
        lower = float(mask[below].mean()); upper = float(mask[above].mean()); c = self.config['persam']
        accepted = score >= c['minMaskScore'] and similarity >= c['minSimilarity'] and lower >= c['minBelowCoverage'] and upper <= c['maxAboveCoverage']
        return IdentityResult('accepted' if accepted else 'rejected', '' if accepted else 'Reference-conditioned mask does not support this boundary',
                              {'maskScore': score, 'similarity': similarity, 'belowCoverage': lower, 'aboveCoverage': upper})

    def end_frame(self):
        super().end_frame(); self.predictor.reset_image()


class YoloVerifier(VisionVerifier):
    def __init__(self, config, root, image_size):
        super().__init__('yolo', config, root, image_size)
        manifest, weights = self.asset()
        import ultralytics
        if ultralytics.__version__ != config['sources']['yolo']['version']:
            raise ValueError('YOLO package version differs from configured version')
        self.model = ultralytics.YOLOWorld(str(weights))
        self.weight_hash = manifest['sha256']
        self.classes = {k for k, name in self.model.names.items() if name in config['yolo']['classes']}
        if not self.classes:
            raise ValueError('YOLO checkpoint lacks configured laptop/keyboard classes')

    def verify(self, edge):
        c = self.config['yolo']
        if self.prepared is None:
            result = self.model.predict(self.frame, device=0 if self.backend == 'cuda' else 'cpu', imgsz=640,
                                        conf=c['confidence'], classes=sorted(self.classes), verbose=False)[0]
            self.prepared = result.boxes.data.cpu().numpy()
        left, right = np.asarray(edge); width = right[0] - left[0]
        best = 0.
        for x1, y1, x2, y2, confidence, cls in self.prepared:
            coverage = max(0., min(right[0], x2) - max(left[0], x1)) / width
            error = max(abs(left[1] - y1), abs(right[1] - y1))
            if coverage >= c['minWidthCoverage'] and error <= c['boundaryTolerancePixels'] and y2 > max(left[1], right[1]):
                best = max(best, float(confidence))
        return IdentityResult('accepted' if best else 'rejected', '' if best else 'No detected laptop/keyboard region aligns with this boundary', {'confidence': best})


def make_verifier(method, config, root, image_size):
    return {'dino': DinoVerifier, 'persam': PerSamVerifier, 'yolo': YoloVerifier}[method](config, root, image_size)
