// SVG → layers for the editor's paste / drop (packages/import/src/paste.ts): what becomes a
// shape, a text, a group or a small picture, and that the result draws like the original SVG.
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import { validateDocument } from "@post-studio/ops";
import { comparePng, rasterize, renderPng } from "@post-studio/render";
import { SCHEMA_VERSION, type Document, type Node, type TextNode } from "@post-studio/schema";
import { prepareAsset } from "@post-studio/server";
import { FontRegistry, layout } from "@post-studio/text";
import { pathBounds } from "../src/geometry.ts";
import { parsePath, pathBoundsPure } from "../src/path-bounds.ts";
import { makeGroup, PasteError, PLACEHOLDER_ASSET, svgToNodes, TooComplex, type PasteResult } from "../src/paste.ts";
import { parseTransform, rigidAngle } from "../src/svg-common.ts";

let fonts: FontRegistry;
beforeAll(async () => {
  fonts = await FontRegistry.load();
});

const ser = new XMLSerializer();
function convert(svg: string, taken: string[] = []): PasteResult {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement as any;
  return svgToNodes(root, { fonts, lang: "mk", taken, serialize: (e) => ser.serializeToString(e as any) });
}
const all = (ns: Node[]): Node[] => ns.flatMap((n) => (n.type === "group" ? [n, ...all(n.children)] : [n]));
const text = (n: TextNode) => n.spans.map((s) => s.text).join("");

/** Figma "Copy as SVG" of a 1080 × 1080 frame with text not outlined (its usual shape). */
const FIGMA = `<svg width="1080" height="1080" viewBox="0 0 1080 1080" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#clip0_1_2)">
<rect width="1080" height="1080" fill="#FCFAF6"/>
<rect id="Badge" x="135" y="600" width="300" height="120" rx="12" fill="#AC1922"/>
<circle cx="800" cy="300" r="80" fill="#23487F" fill-opacity="0.5"/>
<path d="M135 800C200 750 300 850 400 800" stroke="#190F0B" stroke-width="4"/>
<rect x="500" y="500" width="100" height="50" transform="rotate(-30 500 500)" fill="#190F0B"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M10 10H100V100H10Z M30 30H60V60H30Z" fill="#190F0B"/>
<rect x="600" y="700" width="200" height="200" fill="url(#paint0_linear_1_2)"/>
<g filter="url(#filter0_d)"><rect x="100" y="900" width="200" height="80" fill="white"/></g>
<line x1="135" y1="1000" x2="945" y2="1000" stroke="#190F0B" stroke-width="2"/>
<text fill="#190F0B" xml:space="preserve" style="white-space: pre" font-family="IBM Plex Sans" font-size="64" font-weight="600" letter-spacing="-0.01em"><tspan x="135" y="217.6">Исти модели,</tspan><tspan x="135" y="294.4">различни </tspan><tspan x="430" y="294.4" fill="#AC1922">резултати</tspan></text>
</g>
<defs>
<filter id="filter0_d" x="96" y="900" width="208" height="88" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/><feOffset dy="4"/><feGaussianBlur stdDeviation="2"/><feComposite in2="hardAlpha" operator="out"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow"/><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape"/></filter>
<linearGradient id="paint0_linear_1_2" x1="600" y1="700" x2="800" y2="900" gradientUnits="userSpaceOnUse"><stop stop-color="#AC1922"/><stop offset="1" stop-color="#23487F"/></linearGradient>
<clipPath id="clip0_1_2"><rect width="1080" height="1080" fill="white"/></clipPath>
</defs>
</svg>`;

describe("SVG → layers (paste / drop)", () => {
  it("turns a Figma frame into shapes, editable text and small pictures for the rest", () => {
    const r = convert(FIGMA, ["rect"]);
    expect(r.viewBox).toEqual([0, 0, 1080, 1080]);
    const ns = all(r.nodes);
    const byType = (t: string) => ns.filter((n) => n.type === t);
    // Flat shapes become shapes; the frame clip (a rect over the whole SVG) is dropped as a no-op.
    expect(byType("rect").length).toBe(3);
    const badge = ns.find((n) => n.name === "Badge")!;
    expect(badge).toMatchObject({ type: "rect", x: 135, y: 600, w: 300, h: 120, radius: 12, fill: "#AC1922" });
    expect(badge.id).toBe("Badge");
    expect(ns.find((n) => n.type === "ellipse")).toMatchObject({ x: 720, y: 220, w: 160, h: 160, fill: "#23487F80" });
    // A rotated rect keeps its box and gets its rotation (about its centre, as post-studio draws it).
    const rot = ns.find((n) => n.type === "rect" && n.rotation)!;
    expect(rot.rotation).toBe(-30);
    expect(rot.w).toBe(100);
    const c = { x: rot.x + 50, y: rot.y + 25 };
    const a = (-30 * Math.PI) / 180;
    expect(c.x).toBeCloseTo(500 + 50 * Math.cos(a) - 25 * Math.sin(a), 2);
    expect(c.y).toBeCloseTo(500 + 50 * Math.sin(a) + 25 * Math.cos(a), 2);
    expect(byType("line")[0]).toMatchObject({ x: 135, y: 1000, w: 810, h: 0, stroke: { color: "#190F0B", width: 2 } });
    // The curve's box is exact (the same as resvg measures it).
    const curve = byType("path")[0] as Extract<Node, { type: "path" }>;
    const rb = pathBounds(curve.d)!;
    expect(curve.viewBox[0]).toBeCloseTo(rb.x, 2);
    expect(curve.viewBox[1]).toBeCloseTo(rb.y, 2);
    expect(curve.w).toBeCloseTo(rb.w, 2);
    expect(curve.h).toBeCloseTo(rb.h, 2);
    expect(curve.fill).toBe(null);
    // Ids never clash with the document's ('rect' was taken).
    expect(new Set(ns.map((n) => n.id)).size).toBe(ns.length);
    expect(ns.some((n) => n.id === "rect")).toBe(false);
  });

  it("keeps Figma's multi-line text as one editable text with its coloured word and spacing", () => {
    const r = convert(FIGMA);
    const t = all(r.nodes).filter((n): n is TextNode => n.type === "text");
    expect(t.length).toBe(1);
    expect(text(t[0])).toBe("Исти модели,\nразлични резултати");
    expect(t[0].spans.find((s) => s.fill === "#AC1922")?.text).toBe("резултати");
    expect(t[0].style).toMatchObject({ font: "IBM Plex Sans", weight: 600, size: 64, fill: "#190F0B" });
    expect(t[0].style.letterSpacing).toBeCloseTo(-0.64, 3);
    expect(t[0].style.lineHeight! * 64).toBeCloseTo(76.8, 3);
    expect(t[0].x).toBe(135);
    expect(t[0].align).toBe("left");
    expect(r.report.texts).toBe(1);
  });

  it("cuts each picture to its own box, with only the definitions it uses", () => {
    const r = convert(FIGMA);
    expect(r.pieces.length).toBe(3);
    const [holes, gradient, shadow] = r.pieces;
    expect(holes.why).toEqual(["shape with holes (even-odd)"]);
    expect(holes.node).toMatchObject({ type: "svg", x: 9, y: 9, w: 92, h: 92, asset: PLACEHOLDER_ASSET });
    expect(holes.markup).not.toContain("<defs>");
    expect(gradient.why).toEqual(["gradient or pattern fill"]);
    expect(gradient.markup).toContain('id="paint0_linear_1_2"');
    expect(gradient.markup).not.toContain("filter0_d");
    // Figma's effect region (filterUnits userSpaceOnUse) bounds the shadow.
    expect(shadow.node).toMatchObject({ x: 95, y: 899, w: 210, h: 90 });
    expect(shadow.markup).toContain('id="filter0_d"');
    // Every piece passes the server's upload path (sniffing + sanitizer) unchanged in meaning.
    for (const p of r.pieces) {
      const up = prepareAsset(new TextEncoder().encode(p.markup));
      expect(up.mime).toBe("image/svg+xml");
    }
    expect(r.report.pictures).toEqual({ "shape with holes (even-odd)": 1, "gradient or pattern fill": 1, "shadow or blur effect": 1 });
  });

  it("draws like the original SVG (pixels, through the real upload and the PNG renderer)", async () => {
    const draw = async (svg: string) => {
      const r = convert(svg);
      const stored = new Map<string, { mime: string; bytes: Buffer }>();
      for (const p of r.pieces) {
        const up = prepareAsset(new TextEncoder().encode(p.markup));
        stored.set(up.sha256, { mime: up.mime, bytes: up.bytes });
        p.node.asset = `sha256:${up.sha256}`;
      }
      const doc: Document = { schema: SCHEMA_VERSION, id: "prj_paste", title: "paste", lang: "mk", frames: [{ id: "f", name: "F", w: 1080, h: 1080, children: [makeGroup("pasted", r.nodes)] }] };
      expect(validateDocument(doc).ok).toBe(true);
      const ours = await renderPng(doc, { fonts, assets: (sha) => stored.get(sha) });
      return comparePng(ours.png, (await rasterize(svg, fonts)).asPng());
    };
    // Shapes, the rotated rect and the three pictures (gradient, holes, shadow): the same pixels.
    const shapes = await draw(FIGMA.replace(/<text[\s\S]*?<\/text>/, ""));
    expect(shapes.shiftTolerantPixelsOver).toBe(0);
    expect(shapes.meanChannelError).toBeLessThan(0.0002);
    // With the text: resvg (the reference) cannot set a variable font's weight, so compare at 400.
    // Our text is HarfBuzz outlines, resvg's is its own text: glyph edges differ, nothing moves.
    const withText = await draw(FIGMA.replace('font-weight="600"', 'font-weight="400"'));
    expect(withText.shiftTolerantPixelsOverFraction).toBeLessThan(0.003);
    expect(withText.meanChannelError).toBeLessThan(0.002);
  });

  it("finds centred and right-aligned paragraphs from where Figma starts each line", () => {
    const line = (x: number, y: number, s: string) => `<tspan x="${x}" y="${y}">${s}</tspan>`;
    const svg = (anchor: (w: number) => number) => {
      const words = ["Прва линија", "втора", "и трета подолга линија"];
      const ws = words.map(widthOf);
      return `<svg width="1000" height="600" viewBox="0 0 1000 600" fill="none" xmlns="http://www.w3.org/2000/svg"><text fill="#000000" xml:space="preserve" style="white-space: pre" font-family="IBM Plex Sans" font-size="40">${words.map((w, i) => line(anchor(ws[i]), 100 + i * 50, w)).join("")}</text></svg>`;
    };
    const centred = convert(svg((w) => 500 - w / 2)).nodes[0] as TextNode;
    expect(centred.type).toBe("text");
    expect(centred.align).toBe("center");
    expect(centred.x + centred.w / 2).toBeCloseTo(500, 0);
    expect(text(centred).split("\n").length).toBe(3);
    const right = convert(svg((w) => 900 - w)).nodes[0] as TextNode;
    expect(right.align).toBe("right");
    expect(right.x + right.w).toBeCloseTo(900, 0);
    // Ragged starts that line up with nothing: one text per line, each where it was.
    const ragged = convert(svg((w) => 100 + (w % 37) * 3));
    expect(ragged.nodes.length).toBe(3);
  });

  it("maps fonts to registered ones and says so; mixed sizes become one text per line", () => {
    const r = convert(`<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg"><text font-family="Inter" font-size="30" font-weight="bold" fill="#111111"><tspan x="10" y="40">Hello</tspan></text><text font-family="IBMPlexMono" font-size="20" fill="#111111" x="10" y="100">code</text><text font-family="Georgia" font-size="20" font-style="italic" fill="#111111"><tspan x="10" y="150">Big</tspan><tspan x="10" y="190" font-size="12">small</tspan></text></svg>`);
    const t = all(r.nodes).filter((n): n is TextNode => n.type === "text");
    expect(t.map((n) => [text(n), n.style.font, n.style.weight])).toEqual([
      ["Hello", "IBM Plex Sans", 600],
      ["code", "IBM Plex Mono", 500],
      ["Big", "Bitter", 600],
      ["small", "Bitter", 600],
    ]);
    expect(r.report.fonts).toEqual(expect.arrayContaining(["Inter → IBM Plex Sans", "IBM Plex Sans 700 → 600", "Georgia → Bitter", "italic shown upright"]));
    expect(r.report.fonts.some((f) => f.startsWith("IBMPlexMono"))).toBe(false);
  });

  it("keeps named groups and opacity, drops hidden layers, uploads embedded images", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const r = convert(`<svg width="300" height="300" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <g id="Card" opacity="0.5" transform="translate(10 20)"><rect width="100" height="50" fill="#FF0000"/><rect y="60" width="100" height="50" fill="#00FF00"/></g>
      <g id="Group 7"><path d="M0 0L10 10" stroke="#000"/></g>
      <rect width="10" height="10" fill="#000" style="display:none"/>
      <image x="200" y="200" width="50" height="50" xlink:href="data:image/png;base64,${png}"/>
      <image x="0" y="0" width="5" height="5" href="https://example.com/x.png"/>
    </svg>`);
    const card = r.nodes[0];
    expect(card).toMatchObject({ type: "group", id: "Card", name: "Card", opacity: 0.5, x: 10, y: 20 });
    expect((card as any).children.map((c: Node) => [c.x, c.y])).toEqual([[0, 0], [0, 60]]);
    // A named group around one shape keeps the shape and its name.
    expect(r.nodes[1]).toMatchObject({ type: "path", name: "Group 7", id: "Group-7" });
    expect(r.rasters.length).toBe(1);
    expect(r.rasters[0].node).toMatchObject({ type: "image", x: 200, y: 200, w: 50, h: 50, fit: "contain" });
    expect(r.report.skipped).toEqual(expect.arrayContaining(["hidden <rect>", expect.stringMatching(/^image linked from outside/)]));
  });

  it("refuses what is not SVG, and very large SVGs (the editor then inserts one picture)", () => {
    expect(() => convert(`<html xmlns="http://www.w3.org/1999/xhtml"/>`)).toThrow(PasteError);
    expect(() => convert(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`)).toThrow(/no size/);
    const many = `<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg">${'<rect width="1" height="1" fill="#000"/>'.repeat(30)}</svg>`;
    const root = new DOMParser().parseFromString(many, "image/svg+xml").documentElement as any;
    expect(() => svgToNodes(root, { fonts, lang: "mk", serialize: (e) => ser.serializeToString(e as any), maxNodes: 20 })).toThrow(TooComplex);
  });
});

describe("path bounds without a renderer", () => {
  it("match resvg on curves, arcs, relative and implicit commands", () => {
    for (const d of [
      "M135 800C200 750 300 850 400 800",
      "m10 10 c20-30 40 30 60 0 s40 30 60 0z",
      "M80 80 A 45 45, 0, 0, 0, 125 125 L 125 80 Z",
      "M10 10h50v40H10z M20 20 l5 5 5-5",
      "M1e1 2e1L3.5.5",
      "M0 0a10 20 30 1 1 50 40",
    ]) {
      const a = pathBoundsPure(d)!;
      const b = pathBounds(d)!;
      expect([a.x, a.y, a.w, a.h].map((v) => Math.round(v * 10) / 10)).toEqual([b.x, b.y, b.w, b.h].map((v) => Math.round(v * 10) / 10));
    }
    // Quadratic + smooth quadratic: exact extrema (resvg's own box is looser here: 27.5 … 132.5).
    const q = pathBoundsPure("M10 80 Q 52.5 10, 95 80 T 180 80")!;
    expect([q.x, q.y, q.w, q.h]).toEqual([10, 45, 170, 70]);
    expect(parsePath("M0 0a1 1 0 01 1 1")).toEqual([{ cmd: "M", args: [0, 0] }, { cmd: "a", args: [1, 1, 0, 0, 1, 1, 1] }]);
    expect(pathBoundsPure("garbage")).toBeUndefined();
  });

  it("transforms parse and rotations are recognised", () => {
    expect(rigidAngle(parseTransform("rotate(-30 500 500)")!)).toBe(-30);
    expect(rigidAngle(parseTransform("translate(10 20)")!)).toBe(0);
    expect(rigidAngle(parseTransform("scale(2)")!)).toBeUndefined();
    expect(rigidAngle(parseTransform("matrix(0.866025 0.5 -0.5 0.866025 10 10)")!)).toBeCloseTo(30, 2);
    expect(parseTransform("translate(10 20) bogus")).toBeUndefined();
  });
});

/** Width of one line as packages/text (and so the converter) measures it. */
const widthOf = (s: string) => layout(fonts, { spans: [{ text: s }], style: { font: "IBM Plex Sans", weight: 400, size: 40 }, box: "auto-width", align: "left", w: 0, h: 0 }, "mk").width;
