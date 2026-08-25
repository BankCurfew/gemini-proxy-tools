#!/usr/bin/env python3
"""T894 Poster Provenance Gate — assert DALL-E origin via option (c).

Mechanism: require the raw DALL-E download to exist. The gate re-runs
the canonical logo composite and asserts byte-match with the final file.
A Pillow text overlay changes bytes in ways the canonical composite cannot
reproduce, so it fails.

Two valid states:
  1. File IS a raw DALL-E download (md5 in manifest) → PASS
  2. File derives from raw + canonical logo composite → PASS
     (raw companion must exist, composite(raw, logo) must byte-match)

Usage:
  python3 provenance-gate.py <file_or_dir> [--manifest path] [--raw-dir path]
  python3 provenance-gate.py --acceptance   # run 3-way acceptance test
"""

import sys, os, hashlib, json, argparse
from pathlib import Path

LOGO_PATH = Path('/home/curfew/.maw/inbox/chips/designer-iAgencyAIA-logo-with-stroke-7a0e44a6.png')
LOGO_MD5 = '1edd678b8d2b257a770c5f63c970d419'
LOGO_WIDTH = 240
LOGO_OFFSET = (810, 35)
POSTER_SIZE = (1080, 1920)

DESIGNER_FIXTURES = Path('/home/curfew/repos/github.com/BankCurfew/Designer-Oracle/output')
ACCEPTANCE_CASES = [
    {'path': DESIGNER_FIXTURES / 'gate-fixtures/dalle-provenance/FAIL-pillow-composited.png',
     'expected': 'FAIL', 'md5': '41894817', 'label': 'Pillow TEXT composite'},
    {'path': DESIGNER_FIXTURES / 'gate-fixtures/dalle-provenance/PASS-genuine-dalle-download.png',
     'expected': 'PASS', 'md5': '07db8cfd', 'label': 'raw DALL-E download'},
    {'path': DESIGNER_FIXTURES / '25aug-motivation/motivation-25aug-dalle-final.png',
     'expected': 'PASS', 'md5': '8bd3054f', 'label': 'DALL-E + canonical logo'},
]


def md5_file(path):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()


def composite_raw_with_logo(raw_path):
    from PIL import Image
    raw = Image.open(raw_path).convert('RGBA')
    raw_resized = raw.resize(POSTER_SIZE, Image.LANCZOS)
    logo = Image.open(LOGO_PATH).convert('RGBA')
    aspect = logo.height / logo.width
    logo_resized = logo.resize((LOGO_WIDTH, int(LOGO_WIDTH * aspect)), Image.LANCZOS)
    result = raw_resized.copy()
    result.paste(logo_resized, LOGO_OFFSET, logo_resized)
    return result.convert('RGB')


def composite_md5(raw_path):
    from io import BytesIO
    result = composite_raw_with_logo(raw_path)
    buf = BytesIO()
    result.save(buf, format='PNG')
    return hashlib.md5(buf.getvalue()).hexdigest()


def load_manifest(manifest_path):
    if not manifest_path or not Path(manifest_path).exists():
        return {}
    with open(manifest_path) as f:
        data = json.load(f)
    return {entry['md5']: entry for entry in data.get('downloads', [])}


def check_file(file_path, manifest, raw_dir=None):
    file_md5 = md5_file(file_path)

    if file_md5 in manifest:
        return 'PASS', f'raw DALL-E download (manifest match)'

    raw_candidates = []
    if raw_dir and Path(raw_dir).is_dir():
        raw_candidates = list(Path(raw_dir).glob('*.png'))
    search_dir = Path(file_path).parent
    raw_candidates += [p for p in search_dir.glob('*.png') if p != Path(file_path)]
    parent_raw = search_dir.parent / 'raw'
    if parent_raw.is_dir():
        raw_candidates += list(parent_raw.glob('*.png'))

    for raw_file in set(raw_candidates):
        raw_md5 = md5_file(raw_file)
        if raw_md5 in manifest:
            comp_md5 = composite_md5(raw_file)
            if comp_md5 == file_md5:
                return 'PASS', f'composite(raw={raw_file.name}, logo) matches'

    if manifest:
        for entry_md5, entry in manifest.items():
            for raw_file in set(raw_candidates):
                if md5_file(raw_file) == entry_md5:
                    comp_md5 = composite_md5(raw_file)
                    if comp_md5 == file_md5:
                        return 'PASS', f'composite(raw={raw_file.name}, logo) matches'

    for raw_file in set(raw_candidates):
        try:
            comp_md5 = composite_md5(raw_file)
            if comp_md5 == file_md5:
                return 'PASS', f'composite(raw={raw_file.name}, logo) matches (no manifest)'
        except Exception:
            continue

    return 'FAIL', f'no raw companion produces this file via canonical composite'


def run_acceptance():
    logo_md5 = md5_file(LOGO_PATH)
    if logo_md5 != LOGO_MD5:
        print(f'ABORT: logo md5 mismatch — expected {LOGO_MD5}, got {logo_md5}')
        sys.exit(2)

    manifest = {}
    raw_path = ACCEPTANCE_CASES[1]['path']
    if raw_path.exists():
        manifest[md5_file(raw_path)] = {'md5': md5_file(raw_path), 'source': 'acceptance-fixture'}

    evaluated = 0
    passed = 0
    failed = 0
    results = []

    for case in ACCEPTANCE_CASES:
        if not case['path'].exists():
            print(f'ABORT: fixture not found: {case["path"]}')
            sys.exit(2)

        file_md5 = md5_file(case['path'])
        if not file_md5.startswith(case['md5']):
            print(f'ABORT: fixture md5 mismatch for {case["label"]}: expected {case["md5"]}..., got {file_md5[:8]}...')
            sys.exit(2)

        raw_dir = str(ACCEPTANCE_CASES[1]['path'].parent)
        verdict, reason = check_file(str(case['path']), manifest, raw_dir=raw_dir)
        evaluated += 1
        correct = (verdict == case['expected'])

        if correct:
            passed += 1
            mark = '✓'
        else:
            failed += 1
            mark = '✗'

        results.append(f"  {mark} {case['label']} (md5 {case['md5']}...): {verdict} — {reason} [expected {case['expected']}]")

    print(f'\nT894 Provenance Gate — Acceptance Test')
    print(f'=' * 50)
    for r in results:
        print(r)
    print(f'\nEvaluated: {evaluated} of {len(ACCEPTANCE_CASES)}')
    print(f'Correct: {passed}/{evaluated}')

    if evaluated == 0:
        print('0 of 0 evaluated — NO FILES CHECKED, gate is blind')
        sys.exit(3)

    if failed > 0:
        print(f'ACCEPTANCE FAILED — {failed} case(s) gave wrong verdict')
        sys.exit(1)

    print('ACCEPTANCE PASSED — all 3 cases correct')
    sys.exit(0)


def main():
    parser = argparse.ArgumentParser(description='T894 Poster Provenance Gate')
    parser.add_argument('target', nargs='?', help='File or directory to check')
    parser.add_argument('--manifest', help='Path to provenance manifest JSON')
    parser.add_argument('--raw-dir', help='Directory containing raw DALL-E downloads')
    parser.add_argument('--acceptance', action='store_true', help='Run 3-way acceptance test')
    args = parser.parse_args()

    if args.acceptance:
        run_acceptance()
        return

    if not args.target:
        parser.print_help()
        sys.exit(1)

    manifest = load_manifest(args.manifest)
    target = Path(args.target)

    if target.is_dir():
        files = sorted(target.glob('*.png'))
    elif target.is_file():
        files = [target]
    else:
        print(f'Not found: {target}')
        sys.exit(1)

    if not files:
        print(f'0 of 0 evaluated — NO FILES FOUND in {target}, gate is blind')
        sys.exit(3)

    evaluated = 0
    passed = 0
    refused = 0

    for f in files:
        verdict, reason = check_file(str(f), manifest, raw_dir=args.raw_dir)
        evaluated += 1
        mark = 'PASS' if verdict == 'PASS' else 'REFUSE'
        if verdict == 'PASS':
            passed += 1
        else:
            refused += 1
        print(f'  [{mark}] {f.name} — {reason}')

    print(f'\nEvaluated: {evaluated} of {len(files)}')
    print(f'Passed: {passed}, Refused: {refused}')

    if refused > 0:
        sys.exit(1)


if __name__ == '__main__':
    main()
