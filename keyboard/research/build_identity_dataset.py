"""Export reviewed identity sidecars without modifying images or angle labels."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from keyboard_hinge.identity_dataset import build_dataset

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sidecar', nargs='+', required=True)
    parser.add_argument('--legacy-evaluation', help='Optionally retain only the reference entries of an existing diagnostic manifest')
    parser.add_argument('--output', required=True, help='New immutable output directory')
    args = parser.parse_args()
    print(json.dumps(build_dataset(args.sidecar, args.output, args.legacy_evaluation), indent=2))
