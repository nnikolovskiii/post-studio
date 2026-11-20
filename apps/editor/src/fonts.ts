// Fonts in the browser: the same registered files as the server. HarfBuzz shapes with the
// decompressed sfnt bytes (so wrapping and widths match the server and the PNG), and the live
// <text> on the canvas draws with @font-face rules pointing at the woff2 files.
import { fontFaceCss } from "@post-studio/render";
import { FontRegistry } from "@post-studio/text";
import { api } from "./api.ts";

interface Manifest {
  manifest: { families: Array<{ family: string; faces: Array<{ weights: [number, number]; axis?: string; files: string[] }> }> };
  files: Array<{ file: string; sha256: string; bytes: number }>;
}

let loading: Promise<FontRegistry> | undefined;

export function loadFonts(): Promise<FontRegistry> {
  return (loading ??= load().catch((e) => {
    loading = undefined;
    throw e;
  }));
}

async function load(): Promise<FontRegistry> {
  const m = await api<Manifest>("GET", "/v1/fonts/manifest");
  const info = new Map(m.files.map((f) => [f.file, f]));
  const bytes = new Map<string, Uint8Array>();
  await Promise.all(
    m.files.map(async (f) => {
      const buf = await api<ArrayBuffer>("GET", `/v1/fonts/sfnt/${encodeURIComponent(f.file)}?v=${f.sha256.slice(0, 12)}`);
      bytes.set(f.file, new Uint8Array(buf));
    }),
  );
  const reg = await FontRegistry.fromSources(m.manifest, async (file) => ({ sfnt: bytes.get(file)!, sha256: info.get(file)!.sha256, bytes: info.get(file)!.bytes }));
  const faces = reg.faceSpecs().map((f) => ({ family: f.family, weight: f.weights[0] }));
  const css = fontFaceCss(reg, faces, (f) => `/v1/fonts/files/${encodeURIComponent(f.file)}?v=${f.sha256.slice(0, 12)}`);
  const style = document.createElement("style");
  style.id = "post-studio-fonts";
  style.textContent = css;
  document.head.appendChild(style);
  // Load every face now (Latin + Cyrillic subsets) so the first paint already uses them.
  const sample = "AaЀЁЃЌЅЏЉЊабвгдѓќѕџљњ0123456789Ѣѣ";
  await Promise.all(
    reg.faceSpecs().flatMap((f) => {
      const weights = f.weights[0] === f.weights[1] ? [f.weights[0]] : [f.weights[0], f.weights[1]];
      return weights.map((w) => document.fonts.load(`${w} 40px '${f.family}'`, sample).catch(() => []));
    }),
  );
  return reg;
}

/** Weights a family offers: every 100 inside variable ranges plus the range ends. */
export function weightsOf(reg: FontRegistry, family: string): number[] {
  const out = new Set<number>();
  for (const f of reg.faceSpecs().filter((s) => s.family === family)) {
    out.add(f.weights[0]);
    out.add(f.weights[1]);
    for (let w = Math.ceil(f.weights[0] / 100) * 100; w <= f.weights[1]; w += 100) out.add(w);
  }
  return [...out].sort((a, b) => a - b);
}
