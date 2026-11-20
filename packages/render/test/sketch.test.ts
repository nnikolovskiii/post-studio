// Hand-drawn shapes (node.sketch): deterministic plain-path geometry that draws the same in the
// editor canvas (Chrome), the resvg PNG / video, the plain SVG and the Figma SVG, inside the
// shape's box and in the shape's own (kit) colours.
import { beforeAll, describe, expect, it } from "vitest";
import { DocumentSchema, SCHEMA_VERSION, type Document, type Node } from "@post-studio/schema";
import { checkSvgPalette, getKit, paletteLane } from "@post-studio/brand";
import { FontRegistry } from "@post-studio/text";
import sharp from "sharp";
import {
  chromeRenderSvg,
  comparePng,
  createNodeRenderer,
  findChrome,
  flattenPath,
  hatchSegments,
  renderPng,
  renderSvg,
  seededRandom,
  sketchParams,
  sketchPaths,
  sketchSeed,
} from "../src/index.ts";

let fonts: FontRegistry;
beforeAll(async () => {
  fonts = await FontRegistry.load();
});
const assets = () => undefined;

function doc(children: Node[], extra: Partial<Document> = {}): Document {
  return DocumentSchema.parse({ schema: SCHEMA_VERSION, id: "prj_sketch1", title: "Sketch", lang: "mk", frames: [{ id: "f", name: "F", w: 400, h: 300, background: { color: "#FCFAF6" }, children }], ...extra }) as Document;
}

const bar = (over: Record<string, unknown> = {}): Node => ({ id: "bar", type: "rect", x: 40, y: 60, w: 300, h: 24, fill: "#3B8257", sketch: { fill: "hachure" }, ...over }) as Node;

/** Every x / y pair in path data (absolute commands only, which is all the sketch writes). */
function points(d: string): Array<[number, number]> {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

describe("sketch geometry", () => {
  it("is deterministic: same document → byte-identical SVG; the seed and nothing else changes the hand", () => {
    const a = renderSvg(doc([bar()]), { fonts, assets }).svg;
    const b = renderSvg(doc([bar()]), { fonts, assets }).svg;
    expect(a).toBe(b);
    const seeded = renderSvg(doc([bar({ sketch: { fill: "hachure", seed: 7 } })]), { fonts, assets }).svg;
    expect(seeded).not.toBe(a);
    expect(renderSvg(doc([bar({ sketch: { fill: "hachure", seed: 7 } })]), { fonts, assets }).svg).toBe(seeded);
    // The default seed is the id's hash: stable, and different layers get different hands.
    expect(sketchParams(bar() as any).seed).toBe(sketchSeed("bar"));
    expect(sketchSeed("gen-sol-bar")).not.toBe(sketchSeed("gen-terra-bar"));
    const r = seededRandom(42);
    const seq = [r(), r(), r()];
    const r2 = seededRandom(42);
    expect([r2(), r2(), r2()]).toEqual(seq);
  });

  it("draws plain paths in the shape's colour: no rect, filter, pattern, clip or gradient", () => {
    const svg = renderSvg(doc([bar()]), { fonts, assets }).svg;
    expect(svg).toMatch(/<g id="bar">/);
    expect(svg).not.toMatch(/<rect[^>]*width="300"/);
    for (const bad of ["<filter", "<pattern", "<clipPath", "Gradient", "url("]) expect(svg).not.toContain(bad);
    expect(svg).toContain('stroke="#3B8257"');
    // The default tint: a light flat fill under the hatch.
    expect(svg).toMatch(/<path d="M[^"]+" fill="#3B8257" fill-opacity="0.3"\/>/);
  });

  it("keeps the ink inside the shape's box, give or take a pen width", () => {
    const n = bar() as any;
    const sp = sketchPaths(n, true, false);
    const slack = sp.params.weight * 1.5 + 3;
    for (const d of [sp.hatch!, sp.edge!, sp.tint!]) {
      const pts = points(d);
      expect(pts.length).toBeGreaterThan(10);
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThan(40 - slack);
        expect(x).toBeLessThan(340 + slack);
        expect(y).toBeGreaterThan(60 - slack);
        expect(y).toBeLessThan(84 + slack);
      }
    }
  });

  it("fill kinds: hachure = lines, cross-hatch = more lines, solid = one filled shape, tint 0 = lines only", () => {
    const n = (s: object) => bar({ sketch: s }) as any;
    const h = sketchPaths(n({ fill: "hachure" }), true, false);
    const c = sketchPaths(n({ fill: "cross-hatch" }), true, false);
    const s = sketchPaths(n({ fill: "solid" }), true, false);
    const lines = (d?: string) => (d?.match(/M/g) ?? []).length;
    expect(lines(h.hatch)).toBeGreaterThan(30);
    expect(lines(c.hatch)).toBeGreaterThan(lines(h.hatch) * 1.5);
    expect(s.hatch).toBeUndefined();
    expect(s.fill).toMatch(/^M.*Z$/);
    expect(sketchPaths(n({ tint: 0 }), true, false).tint).toBeUndefined();
    // A denser gap draws more lines; a stroke on the shape replaces the fill-coloured edge.
    expect(lines(sketchPaths(n({ gap: 3 }), true, false).hatch)).toBeGreaterThan(lines(sketchPaths(n({ gap: 9 }), true, false).hatch));
    const stroked = sketchPaths(n({}), true, true);
    expect(stroked.edge).toBeUndefined();
    expect(stroked.stroke).toBeTruthy();
  });

  it("roughness 0 draws ruled hatch lines exactly inside the outline", () => {
    const segs = hatchSegments([[[0, 0], [100, 0], [100, 20], [0, 20]]], 5, 0);
    expect(segs.length).toBe(4);
    for (const [a, b] of segs) {
      expect(a[0]).toBeCloseTo(0, 6);
      expect(b[0]).toBeCloseTo(100, 6);
      expect(a[1]).toBeCloseTo(b[1], 6);
    }
    const sp = sketchPaths(bar({ sketch: { roughness: 0, gap: 6, angle: 0 } }) as any, true, false);
    for (const [, y] of points(sp.hatch!)) expect(y).toBeGreaterThanOrEqual(60);
  });

  it("ellipses, lines, rounded rects and paths (curves, arcs, holes) all sketch", () => {
    const shapes: Node[] = [
      { id: "e", type: "ellipse", x: 10, y: 10, w: 80, h: 60, fill: "#23487F", sketch: {} },
      { id: "l", type: "line", x: 10, y: 120, w: 200, h: 30, stroke: { color: "#190F0B", width: 3 }, sketch: { roughness: 2 } },
      { id: "rr", type: "rect", x: 120, y: 10, w: 120, h: 60, radius: 16, fill: "#AC1922", stroke: { color: "#190F0B", width: 2 }, sketch: { fill: "solid" } },
      { id: "p", type: "path", x: 260, y: 10, w: 100, h: 100, viewBox: [0, 0, 50, 50], d: "M5 5 H45 V45 H5 Z M15 15 A10 10 0 1 0 35 15 Q25 30 15 15 Z c 1 2 3 4 5 6", fill: "#3B8257", sketch: { fill: "cross-hatch" } },
    ] as Node[];
    const r = renderSvg(doc(shapes), { fonts, assets });
    expect(r.warnings).toEqual([]);
    for (const id of ["e", "l", "rr", "p"]) expect(r.svg).toContain(`<g id="${id}">`);
    const subs = flattenPath("M5 5 H45 V45 H5 Z M15 15 A10 10 0 1 0 35 15 Q25 30 15 15 Z");
    expect(subs.map((s) => s.closed)).toEqual([true, true]);
    const p = sketchPaths(shapes[3] as any, true, false);
    for (const [x, y] of points(p.hatch!)) {
      expect(x).toBeGreaterThan(255);
      expect(x).toBeLessThan(365);
      expect(y).toBeGreaterThan(5);
      expect(y).toBeLessThan(115);
    }
    // Rotation and opacity still apply to the whole sketched layer.
    const rot = renderSvg(doc([bar({ rotation: 10, opacity: 0.5 })]), { fonts, assets }).svg;
    expect(rot).toMatch(/<g id="bar" transform="rotate\(10 190 72\)" opacity="0.5">/);
  });

  it("a huge shape stays cheap (hatch lines are capped)", () => {
    const big = sketchPaths({ id: "big", type: "rect", x: 0, y: 0, w: 20000, h: 20000, fill: "#000000", sketch: { gap: 1 } } as any, true, false);
    expect((big.hatch!.match(/M/g) ?? []).length).toBeLessThanOrEqual(1600);
  });
});

describe("sketch in every output", () => {
  it("the editor's node renderer, the plain SVG and the Figma SVG carry the same sketch markup", () => {
    const d = doc([bar()]);
    const plain = renderSvg(d, { fonts, assets }).svg;
    const figma = renderSvg(d, { fonts, assets, embedFonts: false, positioning: "line" }).svg;
    const node = createNodeRenderer(d, { fonts, assets }).node(d.frames[0].children[0]);
    expect(plain).toContain(node);
    expect(figma).toContain(node);
  });

  it("stays on the brand palette (check_palette.py rules), accent object included", () => {
    const kit = getKit("lux")!;
    const d = doc(
      [
        bar({ fill: { token: "lux.chart-green" } }),
        { id: "acc", type: "rect", x: 40, y: 120, w: 200, h: 24, fill: { token: "lux.mark" }, accent: true, sketch: { fill: "cross-hatch", roughness: 2 } } as Node,
      ],
      { brandKit: "lux" },
    );
    d.frames[0].background = { color: { token: "lux.paper" } };
    const svg = renderSvg(d, { fonts, assets, text: "outlined" }).svg;
    expect(checkSvgPalette(svg, paletteLane(kit)).errors).toEqual([]);
  });

  it("moves with motion: the sketch sits inside the motion wrapper, unchanged", () => {
    const d = doc([bar({ anim: { tracks: { scaleX: { a: { t: 0, v: 0.5 }, b: { t: 1000, v: 1 } } } } })], { motion: { duration: 2000, fps: 30 } });
    const still = createNodeRenderer(d, { fonts, assets }).node(d.frames[0].children[0]);
    const mid = createNodeRenderer(d, { fonts, assets, time: 500 }).node(d.frames[0].children[0]);
    expect(mid).toContain(still);
    expect(mid).toMatch(/^<g transform="[^"]*scale\(/);
  });

  it("PNG (resvg): the bar's ink is where the plain bar was, with a lighter, textured inside", async () => {
    const plain = await renderPng(doc([bar({ sketch: undefined })]), { fonts, assets });
    const sk = await renderPng(doc([bar()]), { fonts, assets });
    const ink = async (png: Buffer) => {
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      let n = 0, sx = 0, sy = 0;
      for (let y = 0; y < info.height; y++)
        for (let x = 0; x < info.width; x++) {
          const i = (y * info.width + x) * info.channels;
          if (data[i + 1] - data[i] > 40) {
            // greenish
            n++;
            sx += x;
            sy += y;
          }
        }
      return { n, cx: sx / n, cy: sy / n };
    };
    const a = await ink(plain.png);
    const b = await ink(sk.png);
    expect(Math.abs(a.cx - b.cx)).toBeLessThan(3);
    expect(Math.abs(a.cy - b.cy)).toBeLessThan(2);
    expect(b.n).toBeGreaterThan(a.n * 0.35);
    expect(b.n).toBeLessThan(a.n * 1.1);
    // Same document, same pixels.
    expect((await renderPng(doc([bar()]), { fonts, assets })).png.equals(sk.png)).toBe(true);
  });
});

// The editor canvas is Chrome drawing the live SVG; the export is resvg drawing the outlined SVG.
describe.skipIf(!findChrome())("sketch: editor (Chrome) = export (resvg)", () => {
  it("draws the same pixels", async () => {
    const d = doc([
      bar({ sketch: { fill: "hachure", roughness: 1.5 } }),
      { id: "e", type: "ellipse", x: 60, y: 120, w: 120, h: 90, fill: "#23487F", stroke: { color: "#190F0B", width: 2 }, sketch: { fill: "cross-hatch" } } as Node,
      { id: "s", type: "rect", x: 220, y: 130, w: 140, h: 70, fill: "#AC1922", sketch: { fill: "solid", roughness: 2 } } as Node,
    ]);
    const png = await renderPng(d, { fonts, assets });
    const chrome = await chromeRenderSvg(renderSvg(d, { fonts, assets }).svg, 400, 300, { hinting: false });
    const diff = await comparePng(png.png, chrome);
    expect(diff.meanChannelError).toBeLessThan(0.004);
    // Measured 2026-11-13: mean 0.0017, blurred 0.06 % (anti-aliasing only).
    expect(diff.blurredPixelsOverFraction).toBeLessThan(0.003);
  });
});
