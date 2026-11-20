# Font licences

All fonts in this folder are licensed under the **SIL Open Font License 1.1** (https://openfontlicense.org).
Embedding them in rendered images and redistributing them with this project is permitted. They may not be sold on their own.

| Family | Weights | Files | Source | Copyright |
|--------|---------|-------|--------|-----------|
| Bitter | 600, 700 | `Bitter-SemiBold.woff2`, `Bitter-Bold.woff2` | Copied from `landing1/site/fonts/` (subset Latin + Cyrillic, MKD locl kept; built 2026-10-15 from Google Fonts OFL sources) | 2011 The Bitter Project Authors (https://github.com/solmatas/BitterPro), RFN "Bitter Pro" |
| Source Sans 3 | 400, 600 | `SourceSans3-Regular.woff2`, `SourceSans3-SemiBold.woff2` | Copied from `landing1/site/fonts/` (same build) | 2010–2020 Adobe (http://www.adobe.com/), RFN "Source" |
| IBM Plex Sans | 400–600 (variable) | `IBMPlexSans-400-600-{cyrillic,cyrillic-ext,latin}.woff2` | Google Fonts, fetched 2026-10-17 by `tools/fetch_fonts.py` | 2017 IBM Corp., RFN "Plex" |
| IBM Plex Mono | 500, 600 | `IBMPlexMono-{500,600}-{cyrillic,cyrillic-ext,latin}.woff2` | Google Fonts, fetched 2026-10-17 | 2017 IBM Corp., RFN "Plex" |
| Rubik | 500–700 (variable) | `Rubik-500-700-{cyrillic,cyrillic-ext,latin}.woff2` | Google Fonts, fetched 2026-10-17 | 2015 The Rubik Project Authors (https://github.com/googlefonts/rubik) |

See also `OFL-NOTE.txt` (landing1's original note for Bitter and Source Sans 3).

Google Fonts CSS request (desktop Chrome User-Agent, so it returns woff2):
`https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&family=Rubik:wght@500;600;700&display=swap`
Only the `cyrillic`, `cyrillic-ext` and `latin` subsets are kept; their `unicode-range` lines are in `fonts.css`.
| Alegreya | 600, 700 | `Alegreya-SemiBold.woff2`, `Alegreya-Bold.woff2` | Copied from `landing1/site/fonts/` on 2026-10-26 (Mosaic live pair, subset Latin + Cyrillic) | 2011 The Alegreya Project Authors (https://github.com/huertatipografica/Alegreya) |
| Alegreya Sans | 400, Medium | `AlegreyaSans-Regular.woff2`, `AlegreyaSans-Medium.woff2` | Copied from `landing1/site/fonts/` on 2026-10-26 | 2013 The Alegreya Sans Project Authors (https://github.com/huertatipografica/Alegreya-Sans) |
