#!/usr/bin/env python3
"""Test-only wrapper around check_palette.py (copied unchanged next to this file).

Usage: check_palette_kits.py LANE FILE.svg [--art]
       check_palette_kits.py --batch < jobs.json      (JSON [[lane, file, art], ...] → JSON error lists)
       check_palette_kits.py --lanes                  (LANES as JSON)
Same as check_palette.py, plus every Post Studio brand kit that has no check_palette lane
(today: mosaic) as an extra lane built from brand-kits/<id>.json. `--lanes` prints LANES as JSON.
"""
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check_palette  # noqa: E402

KITS = HERE.parent.parent.parent / "brand-kits"
for f in sorted(KITS.glob("*.json")):
    kit = json.loads(f.read_text(encoding="utf-8"))
    if kit.get("checkPaletteLane"):
        continue
    hexes = {c["name"]: c["hex"] for c in kit["colors"]}
    hexes.update({a: hexes[t] for a, t in kit["aliases"].items()})
    check_palette.LANES[kit["id"]] = {
        "paper": hexes[kit["paper"]],
        "accent": hexes[kit["accent"]],
        "colors": {c["hex"]: c["label"] for c in kit["colors"]},
    }

if sys.argv[1:] == ["--batch"]:
    # stdin: JSON [[lane, file, art], ...] → stdout: JSON [[error, ...], ...] (one Python start for many files)
    jobs = json.load(sys.stdin)
    print(json.dumps([check_palette.check(lane, path, bool(art)) for lane, path, art in jobs], ensure_ascii=False))
    sys.exit(0)
if sys.argv[1:] == ["--lanes"]:
    print(json.dumps(check_palette.LANES, ensure_ascii=False))
    sys.exit(0)
check_palette.main()
