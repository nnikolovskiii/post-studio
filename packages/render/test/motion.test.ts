// Motion Part 2 (PLAN-motion.md §5.2): render at a time. One wrapper <g> per animated node (the
// node's own markup is unchanged), text reveal from the existing layout, and no change at all for
// still documents or renders without a time.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { sampleNode } from "@post-studio/motion";
import { DocumentSchema, SCHEMA_VERSION, type Document, type Node } from "@post-studio/schema";
import { FontRegistry, layoutNode } from "@post-studio/text";
import { animAttrs, contactSheet, contactTimes, nodeBox, renderPng, renderSvg, revealCut, type AssetData } from "../src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
const still = JSON.parse(readFileSync(new URL("fixtures/lux-6-square.hand.json", ROOT), "utf8")) as Document;
const motion = JSON.parse(readFileSync(new URL("fixtures/lux-6-motion.json", ROOT), "utf8")) as Document;
const logo = readFileSync(new URL("fixtures/assets/logo-on-paper.png", ROOT));
const logoSha = createHash("sha256").update(logo).digest("hex");
const assets = (s: string): AssetData | undefined => (s === logoSha ? { mime: "image/png", bytes: logo } : undefined);

let fonts: FontRegistry;
beforeAll(async () => {
  fonts = await FontRegistry.load();
});

const MOTION = { duration: 2000, fps: 30 as const };
function doc(children: Node[], extra: Partial<Document> = {}): Document {
  return DocumentSchema.parse({ schema: SCHEMA_VERSION, id: "prj_motion1", title: "T", lang: "mk", motion: MOTION, frames: [{ id: "f", name: "F", w: 400, h: 300, background: { color: "#FCFAF6" }, children }], ...extra }) as Document;
}
const rect = (anim?: Node["anim"], over: Partial<Node> = {}): Node => ({ id: "r", type: "rect", x: 100, y: 50, w: 80, h: 40, fill: "#AC1922", ...(anim ? { anim } : {}), ...over }) as Node;
const text = (s: string, anim?: Node["anim"]): Node =>
  ({ id: "t", type: "text", x: 20, y: 30, w: 360, h: 120, box: "fixed-width", align: "left", style: { font: "IBM Plex Sans", weight: 500, size: 24, fill: "#190F0B" }, spans: [{ text: s }], ...(anim ? { anim } : {}) }) as Node;
const svgOf = (d: Document, time?: number, text: "live" | "outlined" = "live") => renderSvg(d, { fonts, assets, title: false, embedFonts: false, text, ...(time !== undefined ? { time } : {}) }).svg;

describe("render at a time: one wrapper per animated node", () => {
  it("still documents ignore the time: byte-identical output", () => {
    const base = renderSvg(still, { fonts, assets }).svg;
    for (const t of [0, 500, 59_999]) expect(renderSvg(still, { fonts, assets, time: t }).svg).toBe(base);
  });

  it("a motion document without a time renders its rest pose, exactly like the still it came from", () => {
    const named = { ...still, title: motion.title };
    for (const mode of ["live", "outlined"] as const) expect(renderSvg(motion, { fonts, assets, text: mode }).svg).toBe(renderSvg(named, { fonts, assets, text: mode }).svg);
  });

  it("keyframes without document motion draw nothing extra (motion-off)", () => {
    const d = doc([rect({ tracks: { dx: { a: { t: 0, v: 50 } } } })]);
    const off = { ...d, motion: undefined };
    expect(svgOf(off, 0)).toBe(svgOf(off));
    expect(svgOf(d, 0)).not.toBe(svgOf(d));
  });

  it("wraps the unchanged node markup in <g transform opacity>, for every moment", () => {
    const d = doc([rect({ tracks: { dx: { a: { t: 0, v: -80, ease: "linear" }, b: { t: 1000, v: 0 } }, opacity: { a: { t: 0, v: 0, ease: "linear" }, b: { t: 1000, v: 1 } } } })]);
    const rest = svgOf(d);
    const inner = /<rect id="r"[^>]*\/>/.exec(rest)![0];
    expect(svgOf(d, 500)).toContain(`<g transform="translate(-40 0)" opacity="0.5">${inner}</g>`);
    // At the rest values the wrapper stays (stable structure for playback) but carries nothing.
    expect(svgOf(d, 1500)).toContain(`<g>${inner}</g>`);
    // Opacity 0 → drawn with opacity 0 and no transform.
    expect(svgOf(d, 0)).toContain(`<g opacity="0">${inner}</g>`);
  });

  it("scales and rotates around the origin anchor of the node's box", () => {
    const box = { x: 100, y: 50, w: 80, h: 40 };
    const s = (o: Partial<ReturnType<typeof sampleNode>>) => ({ ...sampleNode(undefined, 0), ...o });
    expect(animAttrs(s({ scale: 0.5 }), box, "center")).toEqual({ transform: "translate(140 70) scale(0.5 0.5) translate(-140 -70)" });
    expect(animAttrs(s({ scaleX: 0.25 }), box, "left")).toEqual({ transform: "translate(100 70) scale(0.25 1) translate(-100 -70)" });
    expect(animAttrs(s({ rotate: 90, dx: 10 }), box, "bottom-right")).toEqual({ transform: "translate(190 90) rotate(90) translate(-180 -90)" });
    expect(animAttrs(s({ scale: 2, scaleY: 0.5, opacity: 0.25 }), box, "top-left")).toEqual({ transform: "translate(100 50) scale(2 1) translate(-100 -50)", opacity: "0.25" });
    expect(animAttrs(s({ scaleX: 0 }), box)).toEqual({ opacity: "0" });
    expect(animAttrs(s({ scaleX: 0.000012 }), box, "left").transform).toContain("scale(0.00001 1)");
  });

  it("lines with a negative width anchor on their normalized box (a right-to-left bar grows from its left end)", () => {
    expect(nodeBox({ x: 769.95, y: 10, w: -115.7, h: 0 })).toEqual({ x: 654.25, y: 10, w: 115.7, h: 0 });
    const out = renderSvg(motion, { fonts, assets, time: 1150 }).svg;
    const g = /<g transform="([^"]+)"><line id="row-1-track"/.exec(out)!;
    expect(g[1]).toMatch(/^translate\(654\.25 10\) scale\([\d.]+ 1\) translate\(-654\.25 -10\)$/);
  });

  it("an animated group wraps the group, so its children move with it", () => {
    const out = renderSvg(motion, { fonts, assets, time: 1100 }).svg;
    expect(out).toMatch(/<g opacity="[\d.]+"><g id="chart" transform="translate\(135 340\)">/);
  });

  it("puts the wrapper outside the accent object's <g id=\"accent\">", () => {
    const d = doc([rect({ tracks: { dy: { a: { t: 0, v: 20 } } } }, { accent: true } as Partial<Node>)]);
    expect(svgOf(d, 0)).toMatch(/^<g transform="translate\(0 20\)"><g id="accent"><rect id="r"/m);
  });

  it("text uses the laid-out box for its origin (auto-width text has no fixed w)", () => {
    const n = { ...text("Исти модели."), box: "auto-width", w: 10, h: 10, anim: { tracks: { scale: { a: { t: 0, v: 0.5 } } } } } as Node;
    const L = layoutNode(fonts, n as Extract<Node, { type: "text" }>, "mk");
    const out = svgOf(doc([n]), 0);
    const ox = 20 + L.boxW / 2;
    const m = /<g transform="translate\(([\d.]+) ([\d.]+)\) scale/.exec(out)!;
    expect(Number(m[1])).toBeCloseTo(ox, 2);
    expect(Number(m[2])).toBeCloseTo(30 + L.boxH / 2, 2);
  });
});

describe("text reveal", () => {
  const words = "Исти модели. Различни оценки.";
  const reveal = (by: "char" | "word" | "line", v: number) => ({ revealBy: by, tracks: { reveal: { a: { t: 0, v } } } });
  const drawn = (out: string) => [...out.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]).join("");

  it("reveal 1 draws exactly the rest markup inside the wrapper; reveal 0 draws no text", () => {
    const restInner = /<text[\s\S]*<\/text>/.exec(svgOf(doc([text(words)])))![0];
    expect(svgOf(doc([text(words, reveal("char", 1))]), 0)).toContain(`<g>${restInner}</g>`);
    expect(svgOf(doc([text(words, reveal("char", 0))]), 0)).toContain("<g></g>");
    expect(svgOf(doc([text(words, reveal("char", 0))]), 0, "outlined")).toContain("<g></g>");
  });

  it("counts characters (not spaces), words or lines from the layout", () => {
    // 26 visible characters, 4 words: 0.2 × 26 = 5.2 → 5 characters.
    expect(drawn(svgOf(doc([text(words, reveal("char", 0.2))]), 0))).toBe("Исти м");
    expect(drawn(svgOf(doc([text(words, reveal("word", 0.5))]), 0))).toBe("Исти модели. ");
    expect(drawn(svgOf(doc([text(words, reveal("word", 0.49))]), 0))).toBe("Исти ");
    const narrow = { ...text(words), w: 200 } as Node;
    const L = layoutNode(fonts, narrow as Extract<Node, { type: "text" }>, "mk");
    expect(L.lines.length).toBeGreaterThan(1);
    const first = { ...narrow, anim: reveal("line", 1 / L.lines.length + 0.01) } as Node;
    expect(drawn(svgOf(doc([first]), 0)).trim()).toBe(L.lines[0].text.trim());
  });

  it("revealCut: N = floor(reveal × units), Infinity when everything shows", () => {
    const n = text(words) as Extract<Node, { type: "text" }>;
    const L = layoutNode(fonts, n, "mk");
    expect(revealCut(L, words, "char", 1)).toBe(Infinity);
    expect(revealCut(L, words, "char", 0)).toBe(0);
    expect(revealCut(L, words, "word", 0.75)).toBe(words.indexOf("оценки."));
    expect(revealCut(L, words, "char", 25.5 / 26)).toBe(words.length - 1);
  });

  it("outlined and live text show the same characters", async () => {
    const d = doc([text(words, reveal("char", 0.4))]);
    const a = await renderPng(d, { fonts, assets, time: 0 });
    // 0.4 × 26 = 10.4 → 10 characters: the live tspans and the outlined glyphs both stop there.
    const shown = drawn(svgOf(d, 0));
    expect(shown).toBe("Исти модели");
    const only = doc([text(shown)]);
    const b = await renderPng(only, { fonts, assets });
    expect(a.png.equals(b.png)).toBe(true);
  });
});

describe("raster at a time", () => {
  it("the LUX-6 motion fixture: headline invisible at 0 s, settled after 1 s, the status gone at the end", async () => {
    const at = async (t: number) => (await sharp((await renderPng(motion, { fonts, assets, time: t })).png).removeAlpha().raw().toBuffer({ resolveWithObject: true }));
    const restPx = await sharp((await renderPng(motion, { fonts, assets })).png).removeAlpha().raw().toBuffer();
    const ink = (buf: Buffer, x0: number, y0: number, x1: number, y1: number) => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (buf[(y * 1080 + x) * 3] < 128) n++;
      return n;
    };
    const t0 = await at(0);
    expect(ink(t0.data, 135, 100, 945, 212)).toBe(0); // headline faded out
    expect(ink(restPx, 135, 100, 945, 212)).toBeGreaterThan(1000);
    const settled = await at(2000);
    expect(ink(settled.data, 135, 100, 945, 212)).toBe(ink(restPx, 135, 100, 945, 212));
    const end = await at(5967);
    const status = (b: Buffer) => {
      let n = 0;
      for (let y = 1033; y < 1061; y++) for (let x = 720; x < 945; x++) if (b[(y * 1080 + x) * 3 + 1] < 100) n++;
      return n;
    };
    expect(status(restPx)).toBeGreaterThan(100);
    expect(status(end.data)).toBe(0);
  });
});

describe("contact sheet", () => {
  it("12 moments from the first to the last frame, snapped to frame times, in one PNG", async () => {
    expect(contactTimes({ duration: 6000, fps: 30 })).toEqual([0, 533, 1100, 1633, 2167, 2700, 3267, 3800, 4333, 4867, 5433, 5967]);
    expect(contactTimes({ duration: 500, fps: 24 })).toHaveLength(12);
    const c = await contactSheet(motion, { fonts, assets, cellWidth: 200 });
    const m = await sharp(c.png).metadata();
    expect([m.format, m.width, m.height]).toEqual(["png", 12 + 4 * 212, 12 + 3 * (200 + 26 + 12)]);
    await expect(contactSheet(still, { fonts, assets })).rejects.toThrow(/still post/);
  });
});
