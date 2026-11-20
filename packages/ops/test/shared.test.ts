// Multi-select editing (shared properties): which fields several layers share, "mixed" values, the
// plain ops that set one field on all of them (one batch = one revision), and "select matching".
import { describe, expect, it } from "vitest";
import { DocumentSchema, findItem, SCHEMA_VERSION, validateStructure, type Document, type Node } from "@post-studio/schema";
import { apply, FIELD_KEYS, idsOfType, invert, matchingIds, setFieldOps, sharedFields, sharedValue, typeCounts } from "../src/index.ts";

function doc(): Document {
  const bar = (id: string, y: number, fill: unknown, extra: object = {}): Node => ({ id, type: "rect", x: 300, y, w: 200, h: 24, fill, ...extra }) as Node;
  const label = (id: string, y: number, size: number, fill: unknown): Node => ({ id, type: "text", x: 135, y, w: 10, h: 10, box: "auto-width", align: "left", style: { font: "IBM Plex Sans", weight: 500, size, fill }, spans: [{ text: id }] }) as Node;
  return DocumentSchema.parse({
    schema: SCHEMA_VERSION,
    id: "prj_sharedtest",
    title: "Shared",
    lang: "mk",
    frames: [
      {
        id: "square",
        name: "Square",
        w: 1080,
        h: 1080,
        children: [
          bar("a", 100, "#305880"),
          bar("b", 150, "#305880", { opacity: 0.5, stroke: { color: "#190F0B", width: 2 } }),
          bar("c", 200, "#AC1922"),
          label("l1", 100, 28, "#305880"),
          label("l2", 150, 32, "#655B56"),
          { id: "rule", type: "line", x: 0, y: 500, w: 1080, h: 0, stroke: { color: "#190F0B", width: 1 } },
          { id: "grp", type: "group", x: 0, y: 600, w: 0, h: 0, children: [bar("g1", 0, "#305880"), bar("locked", 40, "#305880", { locked: true })] },
          { id: "hid", type: "group", x: 0, y: 0, w: 0, h: 0, visible: false, children: [bar("ghost", 0, "#305880")] },
        ],
      },
      { id: "li", name: "LinkedIn", w: 1080, h: 1350, children: [bar("other", 100, "#305880")] },
    ],
  }) as Document;
}

const nodes = (d: Document, ...ids: string[]) => ids.map((id) => findItem(d, id)!.item as Node);
const get = (d: Document, id: string) => findItem(d, id)!.item as any;
/** Apply like the server (validated) and check one inverse restores the document (one undo). */
function run(d: Document, ops: ReturnType<typeof setFieldOps>): Document {
  const r = apply(d, ops);
  expect(validateStructure(r.doc).ok).toBe(true);
  expect(apply(r.doc, invert(d, ops)).doc).toEqual(d);
  return r.doc;
}

describe("shared fields of several layers", () => {
  it("one value when they agree, mixed (with the distinct values) when they differ", () => {
    const d = doc();
    expect(sharedValue(nodes(d, "a", "b"), "fill")).toEqual({ mixed: false, value: "#305880" });
    expect(sharedValue(nodes(d, "a", "c"), "fill")).toEqual({ mixed: true, values: ["#305880", "#AC1922"] });
    // Defaults count: a has no opacity (= 1), b has 0.5.
    expect(sharedValue(nodes(d, "a", "c"), "opacity")).toEqual({ mixed: false, value: 1 });
    expect(sharedValue(nodes(d, "a", "b"), "opacity")).toMatchObject({ mixed: true });
    expect(sharedValue(nodes(d, "l1", "l2"), "size")).toEqual({ mixed: true, values: [28, 32] });
    expect(sharedValue(nodes(d, "l1", "l2"), "font")).toEqual({ mixed: false, value: "IBM Plex Sans" });
    expect(sharedValue(nodes(d, "a"), "size")).toBeUndefined();
  });

  it("fill covers shape fill and text colour; type-only fields say which layers have them", () => {
    const d = doc();
    const f = new Map(sharedFields(nodes(d, "a", "l1", "rule")).map((x) => [x.key, x]));
    // Bar a and label l1 are both #305880: "fill" is shared across a rect and a text.
    expect(f.get("fill")).toMatchObject({ ids: ["a", "l1"], all: false, value: { mixed: false, value: "#305880" } });
    expect(f.get("opacity")).toMatchObject({ all: true });
    expect(f.get("size")).toMatchObject({ ids: ["l1"], all: false });
    expect(f.get("stroke.color")).toMatchObject({ ids: ["a", "rule"], value: { mixed: true } });
    expect(f.has("fit")).toBe(false);
    expect(typeCounts(nodes(d, "a", "b", "l1"))).toEqual({ rect: 2, text: 1 });
    expect(FIELD_KEYS).toContain("letterSpacing");
  });
});

describe("setFieldOps: one field on many layers, one batch", () => {
  it("maps fill per type, skips layers that already have it and layers without the property", () => {
    const d = doc();
    const ops = setFieldOps(d, ["a", "b", "c", "l1", "l2", "rule"], "fill", { token: "lux.ink" });
    expect(ops).toEqual([
      { op: "set", node: "a", path: "fill", value: { token: "lux.ink" } },
      { op: "set", node: "b", path: "fill", value: { token: "lux.ink" } },
      { op: "set", node: "c", path: "fill", value: { token: "lux.ink" } },
      { op: "set", node: "l1", path: "style.fill", value: { token: "lux.ink" } },
      { op: "set", node: "l2", path: "style.fill", value: { token: "lux.ink" } },
    ]);
    const after = run(d, ops);
    expect(setFieldOps(after, ["a", "l1"], "fill", { token: "lux.ink" })).toEqual([]);
  });

  it("no fill drops shape fills but never a text colour", () => {
    const d = doc();
    const ops = setFieldOps(d, ["a", "l1"], "fill", null);
    expect(ops).toEqual([{ op: "set", node: "a", path: "fill", value: null }]);
    expect(setFieldOps(d, ["l1"], "fill", undefined)).toEqual([]);
    run(d, ops);
  });

  it("text fields: size, weight, align, letter spacing (0 = default = unset)", () => {
    const d = doc();
    const after = run(d, [...setFieldOps(d, ["l1", "l2", "a"], "size", 40), ...setFieldOps(d, ["l1", "l2"], "align", "center"), ...setFieldOps(d, ["l1", "l2"], "letterSpacing", 2)]);
    expect([get(after, "l1").style.size, get(after, "l2").style.size, get(after, "l1").align, get(after, "l2").style.letterSpacing]).toEqual([40, 40, "center", 2]);
    const back = setFieldOps(after, ["l1", "l2"], "letterSpacing", 0);
    expect(back).toEqual([
      { op: "unset", node: "l1", path: "style.letterSpacing" },
      { op: "unset", node: "l2", path: "style.letterSpacing" },
    ]);
    run(after, back);
  });

  it("opacity 1 unsets, a value sets on every layer type", () => {
    const d = doc();
    expect(setFieldOps(d, ["a", "b"], "opacity", 1)).toEqual([{ op: "unset", node: "b", path: "opacity" }]);
    const ops = setFieldOps(d, ["a", "b", "l1", "rule", "grp"], "opacity", 0.4);
    expect(ops.map((o) => (o as { node: string }).node)).toEqual(["a", "b", "l1", "rule", "grp"]);
    run(d, ops);
  });

  it("stroke: a colour on a shape without a stroke adds one; none keeps a line's stroke", () => {
    const d = doc();
    const ops = setFieldOps(d, ["a", "b", "rule"], "stroke.color", "#AC1922");
    expect(ops).toEqual([
      { op: "set", node: "a", path: "stroke", value: { color: "#AC1922", width: 2 } },
      { op: "set", node: "b", path: "stroke.color", value: "#AC1922" },
      { op: "set", node: "rule", path: "stroke.color", value: "#AC1922" },
    ]);
    run(d, ops);
    expect(setFieldOps(d, ["b", "rule"], "stroke.color", null)).toEqual([{ op: "set", node: "b", path: "stroke", value: null }]);
    expect(setFieldOps(d, ["a", "b"], "stroke.width", 4)).toEqual([
      { op: "set", node: "a", path: "stroke", value: { color: "#190F0B", width: 4 } },
      { op: "set", node: "b", path: "stroke.width", value: 4 },
    ]);
  });

  it("refuses an unknown field", () => {
    expect(() => setFieldOps(doc(), ["a"], "colour" as never, 1)).toThrow(/unknown field colour/);
  });
});

describe("select matching", () => {
  it("same type: visible, unlocked layers of the same frame (inside groups too), the given ones first", () => {
    const d = doc();
    expect(matchingIds(d, ["c"], "type")).toEqual(["c", "a", "b", "g1"]);
    expect(matchingIds(d, ["l2"], "type")).toEqual(["l2", "l1"]);
    expect(matchingIds(d, ["c"], "type", { includeHidden: true })).toEqual(["c", "a", "b", "g1", "locked", "ghost"]);
    expect(matchingIds(d, ["other"], "type")).toEqual(["other"]);
  });

  it("same colour: shape fill or text colour", () => {
    const d = doc();
    expect(matchingIds(d, ["a"], "fill")).toEqual(["a", "b", "l1", "g1"]);
    expect(matchingIds(d, ["a"], "fill", { frames: ["square", "li"] })).toEqual(["a", "b", "l1", "g1", "other"]);
    expect(matchingIds(d, ["rule"], "fill")).toEqual(["rule"]);
  });

  it("idsOfType for the CLI's --type", () => {
    const d = doc();
    expect(idsOfType(d, ["text"])).toEqual(["l1", "l2"]);
    expect(idsOfType(d, ["rect"], "li")).toEqual(["other"]);
  });
});
