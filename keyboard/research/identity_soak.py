"""Bounded 15 Hz identity replay with optional Hinge Glass at 60 Hz.

Saved frames exercise allocations/lifecycle, not fresh-camera physical accuracy.
"""
import argparse
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import subprocess
import sys
import time

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(ROOT))
from keyboard_hinge.config import Config
from keyboard_hinge.edge import EdgeModel, EdgeSession
from keyboard_hinge.identity_vision import make_verifier
from keyboard_hinge.identity import file_sha256


def memory():
    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [(n, ctypes.c_size_t) for n in
            ['PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage', 'PrivateUsage']]
    counters = Counters(); counters.cb = ctypes.sizeof(counters)
    ctypes.windll.kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    handle = ctypes.windll.kernel32.GetCurrentProcess()
    ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    if not ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
        raise ctypes.WinError()
    return {'workingSetBytes': counters.WorkingSetSize, 'privateBytes': counters.PrivateUsage}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(ROOT / 'identity-config.json'))
    parser.add_argument('--manifest', required=True); parser.add_argument('--output', required=True)
    parser.add_argument('--method', default='dino', choices=['dino', 'persam', 'yolo'])
    parser.add_argument('--backend', default='cuda', choices=['cpu', 'cuda'])
    parser.add_argument('--seconds', type=float); parser.add_argument('--renderer', action='store_true')
    args = parser.parse_args(); path = Path(args.config).resolve(); config = json.loads(path.read_text()); config['backend'] = args.backend
    args.seconds = args.seconds if args.seconds is not None else config['evaluation']['memorySeconds']
    if args.seconds <= 0:
        raise ValueError('Replay duration must be positive')
    app = Config.read(ROOT / 'config.json', require_measurements=False); model = EdgeModel.read(ROOT / 'data/angle-model.json')
    verifier = make_verifier(args.method, config, path.parent, model.image_size)
    manifest_path = Path(args.manifest).resolve(); manifest = json.loads(manifest_path.read_text())
    frames = [cv2.imread(str((manifest_path.parent / r['image']).resolve())) for r in manifest['images']]
    output = Path(args.output).resolve(); output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError('Choose a new output report')
    renderer = None; renderer_report = output.with_suffix('.renderer.json')
    try:
        if args.renderer:
            executable = ROOT.parent / 'renderer/build/Release/HingeGlass.exe'
            renderer = subprocess.Popen([str(executable), '--smoke', '--synthetic', '--seconds', str(int(args.seconds + 20)), '--fps', '60', '--angle', '85', '--no-preferences', '--report', str(renderer_report)], creationflags=subprocess.CREATE_NO_WINDOW)
        session = EdgeSession(model, app.limits, verifier)
        for _ in range(config['evaluation']['warmup']):
            session.update(frames[0], time.perf_counter())
        samples = []; histogram = np.zeros(10001, dtype=np.int64); maximum = 0; resets = 0; missed = 0; count = 0; valid = 0
        begin = time.perf_counter(); next_sample = begin; next_progress = begin
        while time.perf_counter() - begin < args.seconds:
            now = time.perf_counter(); frame = frames[(count // 45) % len(frames)]
            if count and count % 900 == 0:
                session = EdgeSession(model, app.limits, verifier); resets += 1
            result = session.update(frame, now); elapsed = (time.perf_counter() - now) * 1000
            histogram[min(10000, int(elapsed * 10))] += 1; maximum = max(maximum, elapsed)
            valid += result.angle_deg is not None; count += 1
            if now >= next_sample:
                sample = {'elapsedSeconds': now - begin, **memory()}
                if args.backend == 'cuda':
                    sample.update(gpuAllocatedBytes=verifier.torch.cuda.memory_allocated(), gpuReservedBytes=verifier.torch.cuda.memory_reserved())
                samples.append(sample); next_sample = now + 5
            if now >= next_progress:
                print(json.dumps({'seconds': round(now - begin), 'frames': count, 'valid': valid, **samples[-1]}), flush=True); next_progress = now + 60
            remaining = begin + count / config['evaluation']['fps'] - time.perf_counter()
            if remaining > 0:
                time.sleep(min(remaining, 1 / config['evaluation']['fps']))
            else:
                missed += 1
        duration = time.perf_counter() - begin; cumulative = histogram.cumsum()
        report = {'kind': 'saved-image identity/session memory replay', 'seconds': duration, 'frames': count, 'valid': valid,
                  'config': config, 'manifestHash': file_sha256(manifest_path), 'modelHash': file_sha256(ROOT / 'data/angle-model.json'),
                  'fps': count / duration, 'p95Ms': float(np.searchsorted(cumulative, count * .95) / 10), 'maxMs': maximum,
                  'missedDeadlines': missed, 'sessionResets': resets, 'maxInFlight': 1, 'pendingFrames': 0,
                  'identity': verifier.info(), 'memory': samples,
                  'privateGrowthAfterWarmupBytes': samples[-1]['privateBytes'] - samples[12]['privateBytes'] if len(samples) > 13 else None,
                  'rendererCapHz': 60 if renderer else None, 'rendererReport': str(renderer_report) if renderer else None,
                  'physicalCameraAcceptance': False}
        output.write_text(json.dumps(report, indent=2)); print(json.dumps({k: v for k, v in report.items() if k != 'memory'}, indent=2), flush=True)
        if renderer:
            try:
                renderer.wait(timeout=40)
            except subprocess.TimeoutExpired:
                renderer.terminate()
    finally:
        if renderer and renderer.poll() is None:
            renderer.terminate(); renderer.wait(timeout=10)


if __name__ == '__main__':
    main()
