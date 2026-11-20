import * as hb from "harfbuzzjs";
import type { FontRegistry, LoadedFile } from "@post-studio/text";
import { base64, num } from "./util.ts";

/** Compact CSS unicode-range for a set of code points. */
export function unicodeRange(cps: Iterable<number>): string {
  const sorted = [...new Set(cps)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const a = sorted[i].toString(16).toUpperCase();
    parts.push(i === j ? `U+${a}` : `U+${a}-${sorted[j].toString(16).toUpperCase()}`);
    i = j + 1;
  }
  return parts.join(",");
}

const rawCache = new WeakMap<LoadedFile, string>();

function woffBase64(f: LoadedFile): string {
  let b = rawCache.get(f);
  if (!b) {
    if (!f.raw) throw new Error(`font file ${f.file} has no stored bytes to embed (pass fontFaceCss a src function)`);
    b = base64(f.raw);
    rawCache.set(f, b);
  }
  return b;
}

/**
 * @font-face rules for the faces used in a frame. Each face lists all of its subset files with a
 * unicode-range, declared in reverse lookup order: browsers try the last matching face first, so
 * the first file in the registry wins, exactly like packages/text picks a file per character.
 */
export function fontFaceCss(
  reg: FontRegistry,
  used: Array<{ family: string; weight: number }>,
  /** URL for a file instead of a data URI (the editor loads fonts from the server). */
  src?: (file: LoadedFile) => string,
): string {
  const specs = reg.faceSpecs();
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const u of used) {
    const spec = specs.find((s) => s.family === u.family && u.weight >= s.weights[0] && u.weight <= s.weights[1]);
    if (!spec) continue;
    const key = `${spec.family}@${spec.weights.join("-")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const files = reg.filesFor(u.family, u.weight);
    const weight = spec.weights[0] === spec.weights[1] ? `${spec.weights[0]}` : `${spec.weights[0]} ${spec.weights[1]}`;
    for (const f of [...files].reverse()) {
      const ext = f.file.endsWith(".woff2") ? "woff2" : f.file.endsWith(".otf") ? "opentype" : "truetype";
      const mime = ext === "woff2" ? "font/woff2" : ext === "opentype" ? "font/otf" : "font/ttf";
      rules.push(
        `@font-face{font-family:'${spec.family}';font-style:normal;font-weight:${weight};font-display:block;src:url(${src ? src(f) : `data:${mime};base64,${woffBase64(f)}`}) format('${ext}');unicode-range:${unicodeRange(f.unicodes)}}`,
      );
    }
  }
  return rules.join("\n");
}

/** Glyph outlines in font units (y up), cached per font instance and glyph. */
type Cmd = [string, ...number[]];
const outlineCache = new WeakMap<hb.Font, Map<number, Cmd[]>>();

function glyphCommands(font: hb.Font, gid: number): Cmd[] {
  let perFont = outlineCache.get(font);
  if (!perFont) {
    perFont = new Map();
    outlineCache.set(font, perFont);
  }
  let cmds = perFont.get(gid);
  if (cmds) return cmds;
  const out: Cmd[] = [];
  const funcs = new hb.DrawFuncs();
  funcs.setMoveToFunc((x, y) => void out.push(["M", x, y]));
  funcs.setLineToFunc((x, y) => void out.push(["L", x, y]));
  funcs.setQuadraticToFunc((cx, cy, x, y) => void out.push(["Q", cx, cy, x, y]));
  funcs.setCubicToFunc((c1x, c1y, c2x, c2y, x, y) => void out.push(["C", c1x, c1y, c2x, c2y, x, y]));
  funcs.setClosePathFunc(() => void out.push(["Z"]));
  font.drawGlyph(gid, funcs);
  cmds = out;
  perFont.set(gid, cmds);
  return cmds;
}

const n2 = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

/** Path data for one glyph placed at (ox, oy) baseline origin, `scale` px per font unit. */
export function glyphPath(font: hb.Font, gid: number, ox: number, oy: number, scale: number): string {
  let d = "";
  for (const c of glyphCommands(font, gid)) {
    d += c[0];
    const v = c as unknown as number[];
    for (let i = 1; i < v.length; i += 2) d += `${i > 1 ? " " : ""}${n2(ox + v[i] * scale)} ${n2(oy - v[i + 1] * scale)}`;
  }
  return d;
}

export type { LoadedFile };
export { num };
