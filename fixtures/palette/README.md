# Palette parity fixtures (Phase 5)

Read-only copies from `social-posts` (2026-11-09), used to prove that Post Studio's palette rules
give the same verdicts as `social-posts/tools/check_palette.py`:

- `tools/check_palette.py`: the tool itself, unchanged. Tests run it with `python3` when it is installed.
- `tools/check_palette_kits.py`: a test-only wrapper that adds the Mosaic lane from `brand-kits/mosaic.json`
  (check_palette.py has none yet) and otherwise calls the original `check()`.
- `posts/<slug>/`: `post.svg`, `post-li.svg`, `copy.json` of real posts (LUX, Kites, old Studio pack, flavor pilots).
  LUX posts get the LUX `logo-light.png` in `source/` so the template importer finds it; Kites posts have no logo
  (its licence is unverified; the importer warns and the palette check does not look at rasters).
  `lux-1-leaderboard`, `lux-6-judge-compare` and `daily-2026-10-26-tochna-cena` are in `../social-posts/`.
- `golden.json`: check_palette.py's output for every fixture and mutation, so the tests also run without Python.
  Regenerate with `UPDATE_PALETTE_GOLDEN=1 pnpm exec vitest run packages/brand/test/check-svg.test.ts`.
