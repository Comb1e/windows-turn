"""Reproducible image-identity comparison; no automatic model promotion.

Reference images and annotations remain immutable. A reviewed manifest describes
identity labels separately from angle labels. Original references are evaluated
leave-one-image-out (diagnostic only); other groups never enter the reference bank.
"""
import argparse
import json
from pathlib import Path
import platform
import sys
import time

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from keyboard_hinge.config import Config
from keyboard_hinge.edge import EdgeModel, EdgeSession, edge_coordinates
from keyboard_hinge.identity_vision import make_verifier, digest


def metrics(rows):
    positive = [r for r in rows if r['identity'] == 'present']
    negative = [r for r in rows if r['identity'] == 'absent']
    correct = [r for r in positive if r['correct']]
    acquisitions = [r['acquisitionMs'] for r in correct if r.get('acquisitionMs') is not None]
    false = sum(r['valid'] for r in negative) + sum(r['valid'] and not r['correct'] for r in positive)
    return {'positiveCount': len(positive), 'negativeCount': len(negative), 'correctPositives': len(correct),
            'positiveCoverage': len(correct) / len(positive) if positive else None,
            'falseAccepts': false, 'absentFalseAccepts': sum(r['valid'] for r in negative),
            'meanBoundaryErrorPixels': float(np.mean([r['boundaryErrorPixels'] for r in correct])) if correct else None,
            'medianAcquisitionMs': float(np.median(acquisitions)) if acquisitions else None,
            'p95ProcessingMs': float(np.percentile([r['processingMs'] for r in rows], 95)) if rows else None}


def load_manifest(path):
    manifest = json.loads(path.read_text()); seen = {}; groups = {}; rows = []
    for item in manifest['images']:
        image = (path.parent / item['image']).resolve()
        if digest(image) != item['sha256']:
            raise ValueError(f'Image hash mismatch: {image}')
        split = item.get('split', 'reference' if item.get('reference') else 'diagnostic')
        if groups.setdefault(item['group'], split) != split:
            raise ValueError('Capture group crosses evaluation roles')
        if item['sha256'] in seen:
            previous = seen[item['sha256']]
            if (previous['group'], previous.get('split'), previous['identity'], previous.get('edge')) != (item['group'], item.get('split'), item['identity'], item.get('edge')):
                raise ValueError('Duplicate image crosses partitions or has conflicting labels')
            continue
        seen[item['sha256']] = item; rows.append({**item, 'path': image})
    return manifest, rows


def evaluation_images(images, training_ids, training_hashes, partition):
    partitioned = any('split' in r for r in images)
    selected = []
    for row in images:
        if partitioned and row['split'] not in ('reference', partition):
            continue
        fitting = row['path'].name in training_ids or row['sha256'] in training_hashes
        selected.append({**row, 'angleModelFittingImage': fitting,
                         'independent': bool(row.get('independent')) and not fitting})
    return selected


def run(args):
    config_path = Path(args.config).resolve(); config = json.loads(config_path.read_text()); config['backend'] = args.backend
    manifest_path = Path(args.manifest).resolve(); manifest, images = load_manifest(manifest_path)
    partitioned = any('split' in r for r in images)
    output = Path(args.output).resolve(); output.mkdir(parents=True, exist_ok=False)
    app = Config.read(ROOT / 'config.json', require_measurements=False)
    model = EdgeModel.read(ROOT / 'data/angle-model.json')
    training_hashes = {digest(ROOT / 'data/annotations' / item) for item in model.training_ids
                       if (ROOT / 'data/annotations' / item).is_file()}
    images = evaluation_images(images, model.training_ids, training_hashes, args.partition)
    references = [r for r in images if r.get('reference') and r['identity'] == 'present']
    reference_manifest = output / 'references.json'
    def save_references(exclude=None):
        records = [{'image': str(r['path']), 'sha256': r['sha256'], 'edge': r['edge']} for r in references if r['sha256'] != exclude]
        reference_manifest.write_text(json.dumps({'version': 1, 'imageSize': list(model.image_size), 'references': records}, indent=2))
    save_references(); config['references'] = str(reference_manifest)
    results = {}; availability = {}; latencies = {}
    for method in ['baseline'] + args.methods:
        print('Evaluating', method, args.backend, flush=True)
        verifier = None; rows = []
        try:
            if method != 'baseline':
                verifier = make_verifier(method, config, config_path.parent, model.image_size)
                availability[method] = verifier.info()
            for item in images:
                bgr = cv2.imread(str(item['path']))
                current = verifier
                if item.get('reference') and method != 'baseline':
                    save_references(item['sha256'])
                    current = make_verifier(method, config, config_path.parent, model.image_size)
                    save_references()
                started = time.perf_counter()
                result, edge = model.predict_frame(bgr, app.limits, verifier=current)
                elapsed = (time.perf_counter() - started) * 1000
                error = None
                if edge is not None and item.get('edge'):
                    y, slope = edge_coordinates(edge, model.image_size); ry, rs = edge_coordinates(item['edge'], model.image_size)
                    error = float(max(abs(y - ry + (slope - rs) * (x - model.image_size[0] / 2)) for x in model.detector.x_range))
                row = {k: v for k, v in item.items() if k != 'path'}
                row.update(valid=result.angle_deg is not None, angleDeg=result.angle_deg,
                           referenceEdge=item.get('edge'), detectedEdge=edge.tolist() if edge is not None else None, boundaryErrorPixels=error,
                           correct=error is not None and error <= config['evaluation']['boundaryTolerancePixels'],
                           reason=result.reason, processingMs=elapsed,
                           evidence=current.last.payload() if current else None)
                if args.acquisition and row['correct']:
                    session = EdgeSession(model, app.limits, current); begin = time.perf_counter()
                    row['acquisitionMs'] = None
                    for attempt in range(config['evaluation']['acquisitionFrames']):
                        if session.update(bgr, time.perf_counter()).angle_deg is not None:
                            row['acquisitionMs'] = (time.perf_counter() - begin) * 1000
                            break
                        remaining = begin + (attempt + 1) / config['evaluation']['fps'] - time.perf_counter()
                        if remaining > 0:
                            time.sleep(remaining)
                rows.append(row)
                if current is not verifier:
                    del current
            warm = cv2.imread(str(references[0]['path'])); times = []
            for i in range(config['evaluation']['warmup'] + config['evaluation']['iterations']):
                started = time.perf_counter(); model.predict_frame(warm, app.limits, verifier=verifier)
                if i >= config['evaluation']['warmup']:
                    times.append((time.perf_counter() - started) * 1000)
            latencies[method] = {'p50Ms': float(np.median(times)), 'p95Ms': float(np.percentile(times, 95)), 'iterations': len(times)}
            results[method] = {'rows': rows, 'metrics': metrics(rows),
                               'referenceDiagnostic': metrics([r for r in rows if r.get('reference')]),
                               'heldOutGroups': metrics([r for r in rows if not r.get('reference')]),
                               'thinStrip': metrics([r for r in rows if r.get('thinStrip')])}
            (output / (method + '.json')).write_text(json.dumps(results[method], indent=2))
        except Exception as error:
            availability[method] = {'available': False, 'reason': f'{type(error).__name__}: {error}'}
            print(method, availability[method], flush=True)
        finally:
            save_references()
            del verifier
    # No threshold is selected using scored images. These runs use predeclared
    # thresholds; nested calibration requires independently labeled negatives.
    independent = [r for r in images if r.get('independent') and r['identity'] != 'ambiguous' and (not partitioned or r['split'] == 'test')]
    groups = {r['group'] for r in independent}
    sufficient = len(groups) >= config['evaluation']['minIndependentGroups'] and all(any(r['identity'] == label for r in independent) for label in ('present', 'absent'))
    promotion = {}
    for method in args.methods:
        if method not in results:
            promotion[method] = {'passed': False, 'reason': 'Candidate unavailable'}; continue
        eligible = {r['sha256'] for r in independent} if partitioned else {r['sha256'] for r in images}
        base = {r['sha256']: r for r in results['baseline']['rows'] if r['sha256'] in eligible}
        scored = [r for r in results[method]['rows'] if r['sha256'] in eligible]
        base_metrics, candidate_metrics = metrics(list(base.values())), metrics(scored)
        positive = [r for r in scored if r['identity'] == 'present' and base[r['sha256']]['correct']]
        retained = [r for r in positive if r['correct']]
        checks = {'independentEvidence': sufficient,
                  'fewerFalseAccepts': candidate_metrics['falseAccepts'] < base_metrics['falseAccepts'],
                  'noKnownNegativeAccepted': results[method]['metrics']['absentFalseAccepts'] == 0,
                  'retainsPositiveCoverage': len(retained) >= len(positive) * config['evaluation']['positiveRetention'] if positive else False,
                  'noBoundaryErrorRegression': bool(retained) and all(r['boundaryErrorPixels'] <= base[r['sha256']]['boundaryErrorPixels'] + 1e-6 for r in retained),
                  'runtime': latencies[method]['p95Ms'] < config['evaluation']['p95BudgetMs']}
        promotion[method] = {'passed': all(checks.values()), 'checks': checks}
    report = {'version': 1, 'manifestHash': digest(manifest_path), 'modelHash': digest(ROOT / 'data/angle-model.json'),
              'config': config, 'python': platform.python_version(), 'opencv': cv2.__version__, 'numpy': np.__version__,
              'partition': args.partition if partitioned else 'diagnostic',
              'protocol': 'Frozen thresholds; reference images leave-one-image-out; whole groups held out. Validation never scores test images. Existing angle fit is not independently tested.',
              'review': manifest.get('review'), 'availability': availability, 'latencies': latencies,
              'metrics': {k: v['metrics'] for k, v in results.items()}, 'promotion': promotion, 'defaultChanged': False}
    (output / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({k: report[k] for k in ['availability', 'latencies', 'metrics', 'promotion']}, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(ROOT / 'identity-config.json'))
    parser.add_argument('--manifest', required=True); parser.add_argument('--output', required=True)
    parser.add_argument('--backend', choices=['cpu', 'cuda'], default='cpu')
    parser.add_argument('--partition', choices=['validation', 'test'], default='test', help='For exported sidecars, isolate validation from the final held-out test')
    parser.add_argument('--acquisition', action='store_true', help='Time fresh-session acquisition of correctly accepted static images at configured replay cadence')
    parser.add_argument('--methods', nargs='+', choices=['dino', 'persam', 'yolo'], default=['dino', 'persam', 'yolo'])
    run(parser.parse_args())
