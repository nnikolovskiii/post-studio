// Phase 2 "done when": the social-posts fixtures import with roles set, and their exported PNGs
// match the existing post.png and a headless-Chrome render of the exported post.svg within a
// measured tolerance. Method of job 239 (LUX-6 Figma pack): mean channel error (mean |a−b| / 255
// over RGB) and the share of pixels whose largest channel error is above 16.
//
// Why the originals can't match exactly (see REPORT-post-studio-phase-2.md):
// - LUX-6 post.png was drawn by Pillow (FreeType hinting, unantialiased lines 1 px off the SVG).
// - LUX-1 / daily post.png came from headless Chrome on Linux, which rounds every glyph advance to
//   a whole pixel. Post Studio lays out with exact HarfBuzz advances (like Figma / macOS), so long
//   lines end a few px apart. The imported document drawn the same way Chrome drew the original
//   (one x per line) reproduces those PNGs exactly; that is checked below too.
// - resvg fills glyph outlines as plain paths; Chrome darkens text edges (text gamma).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeRenderSvg, comparePng, exportProject, findChrome, renderSvg, type PixelDiff } from "@post-studio/render";
import { assetResolver, Store } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { importSocialPost } from "../src/index.ts";

const fixtures = new URL("../../../fixtures/social-posts/", import.meta.url).pathname;

interface Limit {
  mean: number;
  over16: number;
}
/** Measured 2026-11-09 (scripts/phase2-evidence.ts → test-artifacts/phase2/evidence.json); limits ≈ measured + 25 %. */
const LIMITS: Record<string, { original: Limit; chrome: Limit; lineChromeExact?: boolean; vsOriginalSvg?: Limit }> = {
  // measured: original mean 0.0100 / 3.93 %; chrome(post.svg) 0.0087 / 3.17 %;
  // line SVG vs the original post.svg, both in Chrome: 0.0066 / 1.72 % (only centred / right-aligned
  // lines move: Chrome's whole-pixel widths shift their anchor; shapes and left-aligned text are identical)
  "lux-6-judge-compare/post": { original: { mean: 0.0125, over16: 0.049 }, chrome: { mean: 0.011, over16: 0.04 }, vsOriginalSvg: { mean: 0.0085, over16: 0.022 } },
  // measured: original 0.0081 / 3.20 %; chrome 0.0070 / 2.54 %; vs original post-li.svg 0.0053 / 1.38 %
  "lux-6-judge-compare/post-li": { original: { mean: 0.0105, over16: 0.04 }, chrome: { mean: 0.009, over16: 0.032 }, vsOriginalSvg: { mean: 0.007, over16: 0.018 } },
  // measured: original 0.0102 / 2.87 %; chrome 0.0043 / 1.96 %; line SVG in Chrome vs original 1.4e-6 / 0
  "lux-1-leaderboard/post": { original: { mean: 0.0125, over16: 0.036 }, chrome: { mean: 0.0055, over16: 0.025 }, lineChromeExact: true },
  // measured: original 0.0081 / 2.29 %; chrome 0.0035 / 1.57 %; line SVG in Chrome vs original 1.1e-6 / 0
  "lux-1-leaderboard/post-li": { original: { mean: 0.0105, over16: 0.029 }, chrome: { mean: 0.0045, over16: 0.02 }, lineChromeExact: true },
  // measured: original 0.0077 / 0.91 %; chrome 0.0047 / 0.52 %; line SVG in Chrome vs original 0 / 0
  "daily-2026-10-26-tochna-cena/post": { original: { mean: 0.0095, over16: 0.012 }, chrome: { mean: 0.006, over16: 0.0065 }, lineChromeExact: true },
};

let fonts: FontRegistry;
let dataDir: string;
let store: Store;
const actor = { author: "agent:test" };

beforeAll(async () => {
  fonts = await FontRegistry.load();
  dataDir = mkdtempSync(join(tmpdir(), "pstudio-pixels-"));
  store = new Store({ dataDir, fonts });
});
afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const fmt = (d: PixelDiff) => `mean ${d.meanChannelError.toFixed(5)}, over16 ${(d.pixelsOverFraction * 100).toFixed(3)} %`;

async function importAndExport(slug: string) {
  const { doc, report } = await importSocialPost(join(fixtures, slug), { fonts, upload: async (b, name) => store.addAsset(b, actor, name) });
  const created = store.createProject(doc, actor, `import ${slug}`); // server-side validation
  const stored = store.getProject(created.project).doc;
  const exp = await exportProject(stored, { fonts, assets: assetResolver(store), project: created.project, rev: 0 });
  return { stored, report, exp };
}

describe.each(["lux-6-judge-compare", "lux-1-leaderboard", "daily-2026-10-26-tochna-cena"])("%s", (slug) => {
  let r: Awaited<ReturnType<typeof importAndExport>>;
  beforeAll(async () => {
    r = await importAndExport(slug);
  }, 120_000);

  it("imports with roles set and exports every frame", () => {
    const roles = new Set(r.report.frames.flatMap((f) => Object.keys(f.roles)));
    expect(roles.has("headline")).toBe(true);
    if (slug.startsWith("lux")) for (const role of ["kicker", "source", "footer", "logo"]) expect(roles.has(role)).toBe(true);
    const stems = r.exp.frames.map((f) => f.stem);
    expect(stems).toEqual(slug.startsWith("lux") ? ["post", "post-li"] : ["post"]);
    for (const stem of stems) for (const f of [`${stem}.svg`, `${stem}.png`, `${stem}.jpg`, `figma/${stem}.figma-ready.svg`, `figma/${stem}.outlined.svg`]) expect(r.exp.files.some((x) => x.path === f)).toBe(true);
  });

  it("exported PNGs match the existing post.png within the measured tolerance", async () => {
    for (const fr of r.exp.frames) {
      const lim = LIMITS[`${slug}/${fr.stem}`];
      const ours = r.exp.files.find((f) => f.path === `${fr.stem}.png`)!.bytes;
      const d = await comparePng(ours, readFileSync(join(fixtures, slug, `${fr.stem}.png`)));
      expect([d.width, d.height]).toEqual([fr.w, fr.h]);
      expect(d.meanChannelError, `${slug}/${fr.stem} vs original: ${fmt(d)}`).toBeLessThan(lim.original.mean);
      expect(d.pixelsOverFraction, `${slug}/${fr.stem} vs original: ${fmt(d)}`).toBeLessThan(lim.original.over16);
    }
  }, 120_000);

  it.skipIf(!findChrome())(
    "exported PNGs match headless Chrome rendering the exported post.svg",
    async () => {
      for (const fr of r.exp.frames) {
        const lim = LIMITS[`${slug}/${fr.stem}`];
        const ours = r.exp.files.find((f) => f.path === `${fr.stem}.png`)!.bytes;
        const svg = r.exp.files.find((f) => f.path === `${fr.stem}.svg`)!.bytes.toString("utf8");
        const d = await comparePng(ours, await chromeRenderSvg(svg, fr.w, fr.h, { lang: r.stored.lang }));
        expect(d.meanChannelError, `${slug}/${fr.stem} vs Chrome: ${fmt(d)}`).toBeLessThan(lim.chrome.mean);
        expect(d.pixelsOverFraction, `${slug}/${fr.stem} vs Chrome: ${fmt(d)}`).toBeLessThan(lim.chrome.over16);
      }
    },
    180_000,
  );

  it.skipIf(!findChrome())(
    "nothing was lost: drawn the way the original was drawn, the imported document reproduces it",
    async () => {
      for (const fr of r.exp.frames) {
        const lim = LIMITS[`${slug}/${fr.stem}`];
        const line = renderSvg(r.stored, { fonts, assets: assetResolver(store), frame: fr.id, positioning: "line" });
        const ours = await chromeRenderSvg(line.svg, fr.w, fr.h, { lang: r.stored.lang });
        if (lim.lineChromeExact) {
          // The original post.png was Chrome's render of post.svg.
          const d = await comparePng(ours, readFileSync(join(fixtures, slug, `${fr.stem}.png`)));
          expect(d.meanChannelError, fmt(d)).toBeLessThan(1e-4);
          expect(d.maxChannelError, fmt(d)).toBeLessThanOrEqual(8);
          expect(d.pixelsOver).toBe(0);
        } else {
          // LUX-6: post.png came from Pillow; compare with the original post.svg (fonts embedded) in Chrome.
          const orig = await chromeRenderSvg(readFileSync(join(fixtures, slug, `${fr.stem}.svg`), "utf8"), fr.w, fr.h, { lang: r.stored.lang });
          const d = await comparePng(ours, orig);
          expect(d.meanChannelError, fmt(d)).toBeLessThan(lim.vsOriginalSvg!.mean);
          expect(d.pixelsOverFraction, fmt(d)).toBeLessThan(lim.vsOriginalSvg!.over16);
        }
      }
    },
    180_000,
  );
});
