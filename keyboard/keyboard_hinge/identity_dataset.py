"""Reviewed identity data, separate from legacy angle annotations."""
import hashlib
import json
from pathlib import Path

from .annotation import decode_image, validate_edge
from .config import Limits, write_json


def build_dataset(sidecars, output, legacy_evaluation=None):
    records = []
    if legacy_evaluation:
        source = Path(legacy_evaluation).resolve()
        for row in json.loads(source.read_text())['images']:
            if row.get('reference'):
                records.append({**row, 'image': str((source.parent / row['image']).resolve()),
                                'split': 'reference', 'independent': False})
    for sidecar in sidecars:
        source = Path(sidecar).resolve()
        document = json.loads(source.read_text())
        if document.get('version') != 1:
            raise ValueError('Unsupported identity sidecar version')
        for row in document['images']:
            records.append({**row, 'image': str((source.parent / row['image']).resolve()),
                            'reference': row.get('split') == 'reference',
                            'independent': row.get('split') in ('validation', 'test')})
    groups, hashes, images, dimensions = {}, {}, [], set()
    for row in records:
        split, group, identity = row.get('split'), row.get('group'), row.get('identity')
        if split not in ('reference', 'validation', 'test') or identity not in ('present', 'absent', 'ambiguous'):
            raise ValueError('Invalid identity or role')
        if not isinstance(group, str) or not group.strip():
            raise ValueError('Every image needs a capture group')
        if groups.setdefault(group, split) != split:
            raise ValueError(f'Capture group crosses roles: {group}')
        payload = Path(row['image']).read_bytes()
        checksum = hashlib.sha256(payload).hexdigest()
        if checksum != row['sha256']:
            raise ValueError(f"Image hash changed: {row['image']}")
        frame = decode_image(payload, Limits()); size = (frame.shape[1], frame.shape[0])
        dimensions.add(size)
        edge = validate_edge(row.get('edge'), size) if identity == 'present' else None
        old = hashes.get(checksum)
        if old:
            if old['split'] != split or old['group'] != group:
                raise ValueError('Exact duplicate crosses groups or roles')
            if old['identity'] != identity or old.get('edge') != edge:
                raise ValueError('Duplicate image has conflicting reviews')
            continue
        row = {**row, 'edge': edge, 'imageSize': list(size), 'reference': split == 'reference'}
        hashes[checksum] = row; images.append(row)
    if len(dimensions) != 1:
        raise ValueError('Use one camera resolution for each dataset')
    references = [row for row in images if row['split'] == 'reference' and row['identity'] == 'present']
    if not references:
        raise ValueError('At least one reviewed positive reference is required')
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    evaluation = {'version': 1, 'review': 'Human identity sidecars; whole groups and duplicates isolated by role.', 'images': images}
    reference = {'version': 1, 'imageSize': list(next(iter(dimensions))),
                 'references': [{k: row[k] for k in ('image', 'sha256', 'edge')} for row in references]}
    write_json(output / 'evaluation.json', evaluation)
    write_json(output / 'references.json', reference)
    counts = {split: {label: sum(r['split'] == split and r['identity'] == label for r in images)
                      for label in ('present', 'absent', 'ambiguous')} for split in ('reference', 'validation', 'test')}
    summary = {'counts': counts, 'groups': groups, 'thresholdSelection': 'Validation only; freeze settings before scoring test.',
               'insufficient': [split for split in ('validation', 'test')
                                if not counts[split]['present'] or not counts[split]['absent']]}
    write_json(output / 'summary.json', summary)
    return summary
