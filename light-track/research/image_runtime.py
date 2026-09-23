"""Shared offline/live model dispatch; never downloads or implicitly changes backend."""
import numpy as np
from scene_features import ImageFeatures, CONFIG_PATH, ROOT
from scene_models import portable_predict
import json


def base_model(model):
    return model['baseModel'] if model.get('kind') == 'scene-calibrated-model' else model


class ImagePredictor:
    def __init__(self, model, backend='cpu'):
        self.model = model; self.base = base_model(model)
        self.families = self.base.get('families', ['legacy'])
        config = self.base.get('featureConfig') if self.base.get('version') == 2 else json.loads(CONFIG_PATH.read_text())
        self.backend = backend if any(f in ('dino', 'depth') for f in self.families) else 'cpu'
        trusted = json.loads(CONFIG_PATH.read_text())
        if self.base.get('version') == 2 and config.get('sources') != trusted['sources']:
            raise ValueError('Image model requires unsupported encoder sources')
        # Model files describe preprocessing, never executable source locations.
        self.features = ImageFeatures(config, asset_root=ROOT / trusted['assetDirectory'], backend=self.backend)
        for family in self.families:
            if family in ('dino', 'depth'):
                expected = self.base['extractors'][family]['encoder']['sha256']
                if self.features.manifest(family)['encoder']['sha256'] != expected:
                    raise ValueError('Model encoder checksum differs from installed assets')
                self.features.model(family)

    def blocks(self, rgb, legacy, camera):
        blocks = {}
        for family in self.families:
            value = np.asarray(legacy, np.float64) if family == 'legacy' else self.features.extract(rgb, family, camera)
            if value.ndim != 1 or not np.isfinite(value).all():
                raise ValueError('Invalid image predictor input')
            blocks[family] = value[None, :]
        return blocks

    def predict(self, rgb, legacy, camera):
        prediction, _ = portable_predict(self.model, self.blocks(rgb, legacy, camera))
        if not np.isfinite(prediction).all():
            raise ValueError('Image predictor returned nonfinite angle')
        return float(prediction[0])
