"""Synthetic software fixtures only; never hardware accuracy evidence."""
from dataclasses import asdict
import json
from pathlib import Path
import sys

import cv2
import numpy as np

workspace = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(workspace/'keyboard'))
from keyboard_hinge.annotation import Annotation, AnnotationStore, load_samples
from keyboard_hinge.config import Limits
from keyboard_hinge.edge import fit_edge_model

output = Path(sys.argv[1]).resolve()
images = output/'images'
images.mkdir(parents=True, exist_ok=True)
labels = output/'annotations.json'
store = AnnotationStore(images, labels)


def scene(angle):
    y = 250+(angle-10)*6
    yy, xx = np.mgrid[:480, :640]
    gray = np.where(yy < y+.006*(xx-320), 180, 35).astype(np.uint8)
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR), [[10., y+.006*(10-320)], [629., y+.006*(629-320)]]


for angle in [10, 20, 30, 45]:
    frame, edge = scene(angle)
    name = f'{angle}.png'
    cv2.imwrite(str(images/name), frame)
    store.save(asdict(Annotation(name, 1, angle, 'synthetic', corner_mode='visible-edge', edge=edge)))
fit_edge_model(load_samples(labels, images, Limits()), images).save(output/'keyboard-model.json')
(output/'keyboard-config.json').write_text(json.dumps({'camera': {'index': 0, 'width': 640, 'height': 480}}))
(output/'visible.rgba').write_bytes(cv2.cvtColor(scene(25)[0], cv2.COLOR_BGR2RGBA).tobytes())
rng = np.random.default_rng(42)
hidden = rng.integers(60, 180, (480, 640, 3), dtype=np.uint8)
(output/'hidden.rgba').write_bytes(cv2.cvtColor(hidden, cv2.COLOR_BGR2RGBA).tobytes())
print('Synthetic API fixtures ready', flush=True)
