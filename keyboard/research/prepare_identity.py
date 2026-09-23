"""Explicit, reproducible asset download. Live detection never downloads assets."""
import argparse
import json
from pathlib import Path
import shutil
import urllib.request
import zipfile
import time
import sys
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from keyboard_hinge.identity import file_sha256 as sha


def download(url, target):
    if target.exists():
        return
    temporary = target.with_suffix(target.suffix + '.download')
    print('Downloading', url, flush=True)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'keyboard-identity-research'}), timeout=30) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output)
            temporary.replace(target)
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1)


def checkpoint(url, target):
    """Verify completeness, including servers that end a response without error."""
    if target.exists() and zipfile.is_zipfile(target):
        with zipfile.ZipFile(target) as archive:
            if archive.testzip() is None:
                return
    with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=30) as response:
        length = int(response.headers['Content-Length'])
        resolved_url = response.geturl()
    parts = target.parent / (target.name + '.parts'); parts.mkdir(exist_ok=True)
    chunk_size = 1024 * 1024
    def part(start):
        end = min(length, start + chunk_size) - 1; path = parts / str(start)
        if path.exists() and path.stat().st_size == end - start + 1:
            return path
        for attempt in range(5):
            try:
                request = urllib.request.Request(resolved_url, headers={'Range': f'bytes={start}-{end}', 'User-Agent': 'keyboard-research'})
                with urllib.request.urlopen(request, timeout=30) as response:
                    if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{length}':
                        raise ValueError('Asset server did not honor the requested range')
                    data = response.read()
                if len(data) != end - start + 1:
                    raise ValueError('Truncated checkpoint chunk')
                path.write_bytes(data)
                print(f'{target.name}: verified chunk {start // chunk_size + 1}/{(length + chunk_size - 1) // chunk_size}', flush=True)
                return path
            except Exception:
                if attempt == 4:
                    raise
        raise AssertionError('Unreachable')
    print('Preparing complete checkpoint', target.name, length, flush=True)
    with ThreadPoolExecutor(max_workers=4) as workers:
        paths = list(workers.map(part, range(0, length, chunk_size)))
    temporary = target.with_suffix('.verified-download')
    with temporary.open('wb') as output:
        for path in paths:
            output.write(path.read_bytes())
    with zipfile.ZipFile(temporary) as archive:
        if archive.testzip() is not None:
            raise ValueError('Checkpoint CRC mismatch')
    temporary.replace(target)
    for path in paths:
        path.unlink()
    parts.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(ROOT / 'identity-config.json'))
    args = parser.parse_args()
    path = Path(args.config).resolve(); config = json.loads(path.read_text()); assets = path.parent / config['assets']
    assets.mkdir(parents=True, exist_ok=True)
    source = config['sources']['persam']
    directory = assets / f"Personalize-SAM-{source['commit']}"
    tree_url = f"https://api.github.com/repos/{source['repo']}/git/trees/{source['commit']}?recursive=1"
    tree_path = assets / f"persam-tree-{source['commit']}.json"
    download(tree_url, tree_path)
    tree = json.loads(tree_path.read_text())['tree']
    files = [v['path'] for v in tree if v['type'] == 'blob' and (v['path'].startswith('per_segment_anything/') and v['path'].endswith('.py') or v['path'] == 'LICENSE.txt')]
    def source_file(name):
        target = directory / name; target.parent.mkdir(parents=True, exist_ok=True)
        download(f"https://raw.githubusercontent.com/{source['repo']}/{source['commit']}/{name}", target)
        return name, sha(target)
    with ThreadPoolExecutor(max_workers=4) as workers:
        hashes = dict(workers.map(source_file, files))
    weights = directory / 'weights/mobile_sam.pt'
    weights.parent.mkdir(parents=True, exist_ok=True)
    checkpoint(config['sources']['mobileSam']['weights'], weights)
    manifest = {'source': source, 'sourceDirectory': directory.name, 'sourceHashes': hashes,
                'weightsFile': str(weights.relative_to(assets)), 'sha256': sha(weights)}
    (assets / 'persam.json').write_text(json.dumps(manifest, indent=2) + '\n')
    source = config['sources']['yolo']; weights = assets / 'yolov8s-worldv2.pt'
    checkpoint(source['weights'], weights)
    (assets / 'yolo.json').write_text(json.dumps({'source': source, 'weightsFile': weights.name, 'sha256': sha(weights)}, indent=2) + '\n')
    print(json.dumps({'assets': str(assets), 'status': 'ready'}, indent=2))


if __name__ == '__main__':
    main()
