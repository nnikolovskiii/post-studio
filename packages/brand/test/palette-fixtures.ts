// Shared helpers: the fixture SVGs, synthetic mutations and a check_palette.py runner.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export const ROOT = new URL("../../../", import.meta.url).pathname;
export const FIX = join(ROOT, "fixtures/palette");
export const PY_TOOL = join(FIX, "tools/check_palette_kits.py");

export const hasPython = (() => {
  const r = spawnSync("python3", ["-c", "import xml.parsers.expat"], { encoding: "utf8" });
  return r.status === 0;
})();

/** check_palette.py's error lines for a file (the last 'OK …' / 'FAIL …' line dropped). */
export function runPython(lane: string, file: string, art = false): string[] {
  const r = spawnSync("python3", [PY_TOOL, lane, file, ...(art ? ["--art"] : [])], { encoding: "utf8" });
  if (r.status !== 0 && r.status !== 1) throw new Error(`check_palette.py failed: ${r.stderr}`);
  const lines = r.stdout.trimEnd().split("\n");
  const last = lines.pop() ?? "";
  if (!/^(OK|FAIL) /.test(last)) throw new Error(`unexpected check_palette.py output: ${r.stdout}`);
  return lines.filter(Boolean);
}

/** Many files in one Python run: [lane, path, art] → error lists (paths as given, cwd = repo root). */
export function runPythonBatch(jobs: Array<[string, string, boolean]>): string[][] {
  const r = spawnSync("python3", [PY_TOOL, "--batch"], { encoding: "utf8", input: JSON.stringify(jobs), cwd: ROOT, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`check_palette.py --batch failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Every real post SVG in the fixtures: [repo-relative path, lane]. */
export function fixtureSvgs(): Array<{ file: string; lane: string }> {
  const out: Array<{ file: string; lane: string }> = [];
  const dirs = [join(FIX, "posts"), join(ROOT, "fixtures/social-posts")];
  for (const d of dirs) {
    for (const slug of readdirSync(d).sort()) {
      for (const f of ["post.svg", "post-li.svg"]) {
        const p = join(d, slug, f);
        if (!existsSync(p)) continue;
        const lane = slug.startsWith("daily-") ? "mosaic" : slug.split("-")[0];
        out.push({ file: relative(ROOT, p), lane });
      }
    }
  }
  const t = join(ROOT, "brand-kits/templates/source");
  for (const lane of readdirSync(t).sort()) for (const f of readdirSync(join(t, lane)).sort()) out.push({ file: relative(ROOT, join(t, lane, f)), lane });
  return out;
}

const PAPER = '<rect width="1080" height="1080" fill="#FCFAF6"/>';
const svg = (body: string, head = PAPER) => `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">\n${head}\n${body}\n</svg>\n`;

/** One SVG per rule of check_palette.py (LUX lane), passing and failing. */
export const MUTATIONS: Record<string, { svg: string; art?: boolean }> = {
  "clean": { svg: svg('<g id="type"><text x="135" y="184" fill="#190F0B">ok</text></g>\n<g id="accent"><rect x="135" y="300" width="40" height="40" fill="#AC1922"/></g>') },
  "off-palette": { svg: svg('<rect x="1" y="1" width="2" height="2" fill="#123456"/>') },
  "short-hex": { svg: svg('<rect x="1" y="1" width="2" height="2" fill="#fff"/><rect fill="#E2DDD5" stroke="#abc"/>') },
  "named-color": { svg: svg('<rect x="1" y="1" width="2" height="2" fill="red"/><text fill="it\'s"/>') },
  "eight-digit-hex": { svg: svg('<rect fill="#190F0B80"/>') },
  "keywords": { svg: svg('<rect fill="none" stroke="currentColor"/><g fill="transparent" stroke="inherit"/>') },
  "paint-server": { svg: svg('<defs><linearGradient id="g"><stop offset="0" stop-color="#FCFAF6"/></linearGradient></defs><rect fill="url(#g)"/>') },
  "radial-and-filter": { svg: svg('<radialGradient id="r"/><filter id="f"><feFlood flood-color="#000000"/></filter><g filter="url(#f)"><rect fill="#190F0B"/></g>') },
  "filter-none": { svg: svg('<g filter="none" style="filter: none"><rect fill="#190F0B"/></g>') },
  "style-attr": { svg: svg('<rect style="fill: #305880; stroke:#999999; filter: blur(2px)" fill="#190F0B"/>') },
  "accent-outside": { svg: svg('<rect fill="#AC1922"/><g id="art"><text fill="#ac1922">x</text></g>') },
  "accent-on-group-itself": { svg: svg('<g id="accent" fill="#AC1922"><rect fill="#AC1922"/></g>') },
  "two-accent-groups": { svg: svg('<g id="accent"><rect fill="#AC1922"/></g>\n<g id="accent"></g>') },
  "nested-accent": { svg: svg('<g id="accent"><g id="inner"><g><rect stroke="#AC1922"/></g></g></g>') },
  "style-block": { svg: svg('<style>\n.a { fill: #190F0B; stroke:#123456 }\n.b{color:#AC1922;filter: none}\n  .c { fill: none; stop-color: url(#x) }\n</style><rect class="a"/>') },
  "style-cdata": { svg: svg('<style><![CDATA[\n.a { fill: #FCFAF6 }\n.b { flood-color: #AC1922 }\n]]></style>') },
  "no-paper": { svg: svg('<rect width="1080" height="1080" fill="#FEFDFC"/>', "") },
  "paper-not-first": { svg: svg(PAPER, '<title>t</title><defs/><g/>') },
  "paper-after-nonpaint": { svg: svg('<rect fill="#190F0B"/>', '<title>t</title><desc>d</desc><metadata/><style>.x{}</style><defs><rect fill="#FCFAF6"/></defs><rect x="0" y="0" width="100%" height="100%" style="fill:#fcfaf6"/>') },
  "paper-too-small": { svg: svg("", '<rect width="1000" height="1080" fill="#FCFAF6"/>') },
  "paper-offset": { svg: svg("", '<rect x="5" width="1080" height="1080" fill="#FCFAF6"/>') },
  "paper-px": { svg: svg("", '<rect x="0px" width="1080px" height="1090" fill="#FCFAF6"/>') },
  "art-mode": { svg: svg('<rect fill="#305880"/><g id="accent"><path fill="#AC1922"/></g>', ""), art: true },
  "art-mode-bad": { svg: svg('<rect fill="#305881"/><path stroke="#AC1922"/>', ""), art: true },
  "namespaced": { svg: svg('<svg:rect xmlns:svg="http://www.w3.org/2000/svg" fill="#190F0B"/><svg:linearGradient xmlns:svg="http://www.w3.org/2000/svg"/>') },
  "multiline-attrs": { svg: svg('<rect\n  x="1"\n  fill="#123456"\n  stroke="\n#190F0B\n"/>\n<!-- a comment\nover lines -->\n<text fill="#AC1922">a\nb</text>') },
  "entities": { svg: svg('<rect fill="&#35;190F0B"/><text fill="#FCFAF6">&amp;&lt;</text>') },
  "upper-attr": { svg: svg('<rect FILL="#123456" Stroke="#190F0B"/>') },
  "lighting": { svg: svg('<filter id="l"><feDiffuseLighting lighting-color="#FFFFFF"/></filter>') },
};

/** Writes the mutations to a temp dir; returns name → path. */
export function writeMutations(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "ps-palette-"));
  const out: Record<string, string> = {};
  for (const [k, m] of Object.entries(MUTATIONS)) writeFileSync((out[k] = join(dir, `${k}.svg`)), m.svg);
  return out;
}
