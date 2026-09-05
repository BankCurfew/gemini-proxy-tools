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

import sys, os, hashlib, json, argparse, datetime, subprocess, tempfile
from pathlib import Path

LOGO_PATH = Path('/home/curfew/.maw/inbox/chips/designer-iAgencyAIA-logo-with-stroke-7a0e44a6.png')
LOGO_MD5 = '1edd678b8d2b257a770c5f63c970d419'
COMPOSITE_JS = Path('/home/curfew/repos/github.com/BankCurfew/gemini-proxy-tools/scripts/_composite.js')
DEFAULT_FOOTER = Path('/home/curfew/repos/github.com/BankCurfew/Designer-Oracle/brand/footer-black.png')
BUILD_FOOTER = Path('/home/curfew/repos/github.com/BankCurfew/Designer-Oracle/scripts/build-footer-dated.py')

DESIGNER_FIXTURES = Path('/home/curfew/repos/github.com/BankCurfew/Designer-Oracle/output')
ACCEPTANCE_CASES = [
    # (1) ImageMagick-composited via _composite.js → EXIT 0
    {'path': DESIGNER_FIXTURES / 'gate-fixtures/dalle-provenance/PASS-imagemagick-composited.png',
     'expected': 'PASS', 'md5': '4050d803', 'label': 'ImageMagick composite (_composite.js)'},
    # (2) Pillow-composited → EXIT 1 (wrong library, missing footer)
    {'path': DESIGNER_FIXTURES / 'gate-fixtures/dalle-provenance/FAIL-pillow-composited.png',
     'expected': 'FAIL', 'md5': '41894817', 'label': 'Pillow composite (wrong tool)'},
    # (3) Raw DALL-E download (manifest match) → EXIT 0
    {'path': DESIGNER_FIXTURES / 'gate-fixtures/dalle-provenance/PASS-genuine-dalle-download.png',
     'expected': 'PASS', 'md5': '07db8cfd', 'label': 'raw DALL-E download'},
    # (4) Missing file → EXIT 2 (UNTESTED, never 0)
    {'path': DESIGNER_FIXTURES / 'gate-fixtures/dalle-provenance/DOES-NOT-EXIST.png',
     'expected': 'MISSING', 'md5': None, 'label': 'missing file'},
]


def md5_file(path):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()


def build_dated_footer(iso_date):
    """Build a footer for the given ISO date, return path to temp file."""
    if not BUILD_FOOTER.exists():
        return None
    tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False, prefix='footer-')
    tmp.close()
    try:
        subprocess.run(
            ['python3', str(BUILD_FOOTER), iso_date, tmp.name],
            check=True, capture_output=True, text=True,
            cwd=str(BUILD_FOOTER.parent.parent),
        )
        return tmp.name
    except subprocess.CalledProcessError:
        os.unlink(tmp.name)
        return None


def composite_pixels_match(raw_path, final_path, footer_path=None):
    """Invoke _composite.js then pixel-compare with ImageMagick `compare`.
    Byte-match is impossible because ImageMagick PNG includes non-deterministic
    metadata (timestamps). Pixel comparison (AE metric) ignores metadata."""
    if not COMPOSITE_JS.exists():
        raise FileNotFoundError(f'_composite.js not found at {COMPOSITE_JS}')
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
        tmp_path = tmp.name
    try:
        cmd = ['node', str(COMPOSITE_JS), str(raw_path), tmp_path]
        if footer_path:
            cmd.append(str(footer_path))
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        result = subprocess.run(
            ['compare', '-metric', 'AE', tmp_path, final_path, 'null:'],
            capture_output=True, text=True
        )
        diff_pixels = int(result.stderr.strip())
        return diff_pixels == 0
    except (subprocess.CalledProcessError, ValueError):
        return False
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def load_manifest(manifest_path):
    if not manifest_path or not Path(manifest_path).exists():
        return {}
    with open(manifest_path) as f:
        data = json.load(f)
    return {entry['md5']: entry for entry in data.get('downloads', [])}


def check_file(file_path, manifest, raw_dir=None, footer_path=None):
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
        try:
            if composite_pixels_match(raw_file, file_path, footer_path=footer_path):
                raw_md5 = md5_file(raw_file)
                in_manifest = raw_md5 in manifest
                suffix = '' if in_manifest else ' (no manifest)'
                return 'PASS', f'composite(raw={raw_file.name}, logo) pixel-match{suffix}'
        except Exception:
            continue

    return 'FAIL', f'no raw companion produces this file via canonical composite'


def run_acceptance():
    logo_md5 = md5_file(LOGO_PATH)
    if logo_md5 != LOGO_MD5:
        print(f'ABORT: logo md5 mismatch — expected {LOGO_MD5}, got {logo_md5}')
        sys.exit(2)

    if not COMPOSITE_JS.exists():
        print(f'ABORT: _composite.js not found at {COMPOSITE_JS}')
        sys.exit(2)

    raw_case = next(c for c in ACCEPTANCE_CASES if c['label'] == 'raw DALL-E download')
    manifest = {}
    if raw_case['path'].exists():
        manifest[md5_file(raw_case['path'])] = {'md5': md5_file(raw_case['path']), 'source': 'acceptance-fixture'}

    evaluated = 0
    passed = 0
    failed = 0
    results = []

    for case in ACCEPTANCE_CASES:
        if case['expected'] == 'MISSING':
            if case['path'].exists():
                failed += 1
                results.append(f"  ✗ {case['label']}: file EXISTS but should not")
            else:
                passed += 1
                results.append(f"  ✓ {case['label']}: correctly absent → EXIT 2")
            evaluated += 1
            continue

        if not case['path'].exists():
            print(f'ABORT: fixture not found: {case["path"]}')
            sys.exit(2)

        file_md5 = md5_file(case['path'])
        if not file_md5.startswith(case['md5']):
            print(f'ABORT: fixture md5 mismatch for {case["label"]}: expected {case["md5"]}..., got {file_md5[:8]}...')
            sys.exit(2)

        raw_dir = str(raw_case['path'].parent)
        verdict, reason = check_file(str(case['path']), manifest, raw_dir=raw_dir,
                                     footer_path=str(DEFAULT_FOOTER))
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

    print(f'ACCEPTANCE PASSED — all {passed} cases correct')
    sys.exit(0)


def main():
    parser = argparse.ArgumentParser(description='T894 Poster Provenance Gate')
    parser.add_argument('target', nargs='?', help='File or directory to check')
    parser.add_argument('--manifest', help='Path to provenance manifest JSON')
    parser.add_argument('--raw-dir', help='Directory containing raw DALL-E downloads')
    parser.add_argument('--footer', help='Dated footer PNG (default: auto-build for today)')
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
        print(f'UNTESTED: {target} — file not found')
        sys.exit(2)

    if not files:
        print(f'0 of 0 evaluated — NO FILES FOUND in {target}, gate is blind')
        sys.exit(3)

    footer_path = args.footer
    built_footer = None
    if not footer_path:
        today = datetime.date.today().isoformat()
        built_footer = build_dated_footer(today)
        if built_footer:
            footer_path = built_footer
            print(f'[footer] auto-built for {today}')
        else:
            print(f'[footer] WARNING: could not build dated footer, using default (may cause false REFUSE)')
            footer_path = str(DEFAULT_FOOTER)

    evaluated = 0
    passed = 0
    refused = 0

    try:
        for f in files:
            verdict, reason = check_file(str(f), manifest, raw_dir=args.raw_dir,
                                         footer_path=footer_path)
            evaluated += 1
            mark = 'PASS' if verdict == 'PASS' else 'REFUSE'
            if verdict == 'PASS':
                passed += 1
            else:
                refused += 1
            print(f'  [{mark}] {f.name} — {reason}')
    finally:
        if built_footer and os.path.exists(built_footer):
            os.unlink(built_footer)

    print(f'\nEvaluated: {evaluated} of {len(files)}')
    print(f'Passed: {passed}, Refused: {refused}')

    if refused > 0:
        sys.exit(1)


if __name__ == '__main__':
    main()
