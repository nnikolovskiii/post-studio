// Phase 5 validation: brand-kit palette rules on every write, warnings by default, errors in
// strict mode (only for problems the write introduces), and the strict switch is Nikola's.
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type Document, type Node } from "@post-studio/schema";
import { apply, checkPins, validateDocument } from "../src/index.ts";
import { loadFixture } from "./helpers.ts";

const PAPER = "#FCFAF6";
function doc(children: Node[], extra: Partial<Document> = {}): Document {
  return { schema: SCHEMA_VERSION, id: "prj_test1", title: "t", lang: "en", brandKit: "lux", frames: [{ id: "square", name: "Square", w: 1080, h: 1080, background: { color: PAPER }, children }], ...extra };
}
const codes = (r: ReturnType<typeof validateDocument>) => [...r.errors, ...r.warnings].map((i) => `${i.node}:${i.code}`).sort();

describe("brand-kit palette in validateDocument", () => {
  it("the hand-written LUX-6 fixture passes (tokens, paper, one accent object)", () => {
    const r = validateDocument(loadFixture());
    expect(r.warnings).toEqual([]);
    expect(r.palette).toMatchObject({ kit: "lux", ok: true, frames: [{ frame: "square", ok: true, accentObjects: 1 }] });
  });

  it("warns about off-palette colours, the accent outside the accent object and a missing paper", () => {
    const r2 = validateDocument(
      doc([
        { id: "a", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#123456" },
        { id: "b", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: { token: "lux.mark" } },
        { id: "c", type: "line", x: 0, y: 0, w: 10, h: 0, stroke: { color: "#AC1922CC", width: 2 }, accent: true },
        { id: "d", type: "text", x: 0, y: 0, w: 10, h: 10, box: "auto-width", align: "left", style: { font: "IBM Plex Sans", weight: 400, size: 20, fill: { token: "lux.ink" } }, spans: [{ text: "x" }, { text: "y", fill: "#ac1922" }] },
        { id: "e", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#AC1922", visible: false },
      ]),
    );
    expect(r2.ok).toBe(true);
    expect(codes(r2)).toEqual(["a:palette", "b:accent-outside", "d:accent-outside"]);
    expect(r2.warnings.find((w) => w.node === "a")!.message).toBe("#123456 is not in the lux palette");
  });

  it("checks the paper: frame background, or a full-frame paper rect as the bottom layer", () => {
    const bad = validateDocument(doc([], { frames: [{ id: "square", name: "S", w: 1080, h: 1080, background: { color: "#FFFFFF" }, children: [] }] }));
    expect(codes(bad)).toEqual(["square:palette", "square:paper"]);
    const rect = validateDocument(doc([], { frames: [{ id: "square", name: "S", w: 1080, h: 1080, children: [{ id: "p", type: "rect", x: 0, y: 0, w: 1080, h: 1080, fill: { token: "lux.paper" } }] }] }));
    expect(codes(rect)).toEqual([]);
    const none = validateDocument(doc([], { frames: [{ id: "square", name: "S", w: 1080, h: 1080, children: [{ id: "p", type: "rect", x: 0, y: 0, w: 1000, h: 1080, fill: PAPER }] }] }));
    expect(codes(none)).toEqual(["square:paper"]);
  });

  it("allows one accent object per frame (accent: true, role accent or a group with id accent)", () => {
    const two = validateDocument(
      doc([
        { id: "x", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#AC1922", accent: true },
        { id: "y", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#190F0B", role: "accent" },
        { id: "accent", type: "group", x: 0, y: 0, w: 10, h: 10, children: [{ id: "z", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#AC1922" }] },
      ]),
    );
    expect(codes(two)).toEqual(["square:accent-count"]);
    expect(two.warnings[0].message).toContain("3 accent objects (x, y, accent)");
    const none = validateDocument(doc([]));
    expect(none.warnings).toEqual([]);
    expect(none.palette!.advice.map((a) => a.code)).toEqual(["accent-missing"]);
  });

  it("checks svg art after its recolour map, with the accent allowed only inside the accent object", () => {
    const art = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#305880"/><path stroke="#AC1922"/><linearGradient id="g"/></svg>';
    const svgAsset = () => art;
    const node = (extra: Partial<Node>) => ({ id: "s", type: "svg", asset: `sha256:${"a".repeat(64)}`, x: 0, y: 0, w: 10, h: 10, ...extra }) as Node;
    const plain = validateDocument(doc([node({})]), { svgAsset });
    expect(plain.warnings.map((w) => w.message)).toEqual([
      'SVG art line 1: <path> stroke=#AC1922: lane accent outside <g id="accent">',
      "SVG art line 1: <lineargradient> is not allowed (no gradients or filters)",
    ]);
    const inAccent = validateDocument(doc([node({ accent: true, recolor: { "#305880": "#123456" } })]), { svgAsset });
    expect(inAccent.warnings.map((w) => w.message)).toEqual(["SVG art line 1: <rect> fill=#123456: #123456 is not in the lux palette", "SVG art line 1: <lineargradient> is not allowed (no gradients or filters)"]);
    const unread = validateDocument(doc([node({})]));
    expect(unread.palette!.advice.map((a) => a.code)).toContain("svg-unchecked");
  });

  it("strict mode: new problems are errors, problems already there stay warnings", () => {
    const before = doc([{ id: "old", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#123456" }], { strictPalette: true });
    expect(validateDocument(before).ok).toBe(false); // created like this: everything is new
    const next = apply(before, [{ op: "set", node: "old", path: "w", value: 20 }]).doc;
    const keep = validateDocument(next, { previous: before });
    expect(keep.ok).toBe(true);
    expect(keep.warnings[0].message).toBe("#123456 is not in the lux palette (already there before this change)");
    const worse = apply(before, [{ op: "insert", parent: "square", index: 1, node: { id: "new", type: "rect", x: 0, y: 0, w: 1, h: 1, fill: "#AC1922" } }]).doc;
    const r = validateDocument(worse, { previous: before });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => `${e.node}:${e.code}`)).toEqual(["new:accent-outside"]);
    expect(r.errors[0].message).toMatch(/\(strict palette\)$/);
    // Fixing it is allowed.
    const fixed = apply(before, [{ op: "set", node: "old", path: "fill", value: { token: "lux.ink" } }]).doc;
    expect(validateDocument(fixed, { previous: before })).toMatchObject({ ok: true, warnings: [] });
  });

  it("an unknown kit is an error; no kit means no palette rules", () => {
    expect(validateDocument(doc([], { brandKit: "acme" })).errors.map((e) => e.code)).toEqual(["brand-kit"]);
    const free = validateDocument(doc([{ id: "a", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#123456" }], { brandKit: null }));
    expect(free).toMatchObject({ ok: true, warnings: [] });
    expect(free.palette).toBeUndefined();
  });

  it("only Nikola switches strict mode: an agent op on strictPalette is blocked like a pin", () => {
    const d = doc([]);
    const r = checkPins(d, [{ op: "set", node: "$doc", path: "strictPalette", value: false }], []);
    expect(r.ok).toBe(false);
    expect(r.blocked[0].message).toContain("'strictPalette' on '$doc' belongs to the human");
    expect(checkPins(d, [{ op: "set", node: "$doc", path: "brandKit", value: "kites" }], []).ok).toBe(true);
  });
});
