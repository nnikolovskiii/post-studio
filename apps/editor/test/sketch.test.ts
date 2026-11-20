// Hand-drawn shapes (node.sketch) in the document model, the ops path agents use, and the editor
// commands behind the desktop "Hand-drawn" section and the phone sheet.
import { describe, expect, it } from "vitest";
import { apply, checkPins, diffDocs, describe as describeItem, invert, outline, softPinsFromRevisions } from "@post-studio/ops";
import { DocumentSchema, findItem, SCHEMA_VERSION, validateStructure, type Document, type Node } from "@post-studio/schema";
import { isSketchable, reseedSketch, resetSketch, setSketchOn, setSketchOption, sketchCandidates, sketchLook } from "../src/model/sketch.ts";
import type { Command } from "../src/model/commands.ts";

function chart(): Document {
  const bar = (id: string, y: number, w: number, fill: string): Node => ({ id, type: "rect", x: 210, y, w, h: 24, fill: { token: fill } }) as Node;
  return DocumentSchema.parse({
    schema: SCHEMA_VERSION,
    id: "prj_sketchtest",
    title: "Bars",
    lang: "mk",
    brandKit: "lux",
    frames: [
      {
        id: "square",
        name: "Square",
        w: 1080,
        h: 1080,
        background: { color: { token: "lux.paper" } },
        children: [
          { id: "bg", type: "rect", x: 0, y: 0, w: 1080, h: 1080, fill: { token: "lux.paper" } },
          { id: "headline", type: "text", x: 135, y: 100, w: 10, h: 10, box: "auto-width", align: "left", style: { font: "IBM Plex Sans", weight: 600, size: 50, fill: { token: "lux.ink" } }, spans: [{ text: "Бар" }] },
          { id: "gen", type: "group", x: 135, y: 229, w: 810, h: 276, children: [bar("gen-sol-bar", 54, 467.4, "lux.chart-green"), bar("gen-opus-bar", 92, 285, "lux.chart-blue"), { id: "gen-rule", type: "line", x: 0, y: 140, w: 810, h: 0, stroke: { color: { token: "lux.ink" }, width: 1 } }] },
          { id: "locked-bar", type: "rect", x: 135, y: 600, w: 100, h: 24, fill: { token: "lux.chart-blue" }, locked: true },
          { id: "hidden-group", type: "group", x: 0, y: 0, w: 10, h: 10, visible: false, children: [{ id: "ghost", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#000000" }] },
        ],
      },
    ],
  }) as Document;
}

const node = (d: Document, id: string) => findItem(d, id)!.item as any;
/** Apply a command like the server does (validated), and check undo restores the document. */
function run(d: Document, c: Command): Document {
  const r = apply(d, c.ops);
  expect(validateStructure(r.doc).ok).toBe(true);
  expect(apply(r.doc, invert(d, c.ops)).doc).toEqual(d);
  return r.doc;
}

describe("sketch in the document model and the ops path", () => {
  it("validates on shapes only, with bounded options", () => {
    const d = chart();
    const ok = (path: string, value: unknown, id = "gen-sol-bar") => {
      try {
        apply(d, [{ op: "set", node: id, path, value }]);
        return true;
      } catch {
        return false;
      }
    };
    expect(ok("sketch", { fill: "hachure", roughness: 1.5, tint: 0.3, weight: 2, gap: 5, angle: -41, seed: 12 })).toBe(true);
    expect(ok("sketch", {})).toBe(true);
    expect(ok("sketch", { fill: "zigzag" })).toBe(false);
    expect(ok("sketch", { roughness: 9 })).toBe(false);
    expect(ok("sketch", { tint: 2 })).toBe(false);
    expect(ok("sketch", { seed: 1.5 })).toBe(false);
    expect(ok("sketch", { wobble: 1 })).toBe(false);
    expect(ok("sketch", { fill: "solid" }, "headline")).toBe(false);
    expect(ok("sketch", { fill: "solid" }, "gen-rule")).toBe(true);
    // An agent's plain op path: set one option on a layer that has none yet creates the object.
    const r = apply(d, [{ op: "set", node: "gen-sol-bar", path: "sketch.roughness", value: 2 }]);
    expect(node(r.doc, "gen-sol-bar").sketch).toEqual({ roughness: 2 });
    expect(apply(r.doc, r.inverse).doc).toEqual(d);
  });

  it("diff, outline and soft pins talk about it", () => {
    const d = chart();
    const on = apply(d, [{ op: "set", node: "gen-sol-bar", path: "sketch", value: { fill: "hachure", roughness: 1.5 } }]).doc;
    const item = diffDocs(d, on).items.find((i) => i.id === "gen-sol-bar")!;
    expect(describeItem(item)).toBe("hand-drawn on (hachure, roughness 1.5)");
    const more = apply(on, [{ op: "set", node: "gen-sol-bar", path: "sketch.roughness", value: 2.5 }]).doc;
    expect(describeItem(diffDocs(on, more).items[0])).toBe("hand-drawn roughness 1.5 → 2.5");
    const off = apply(on, [{ op: "unset", node: "gen-sol-bar", path: "sketch" }]).doc;
    expect(describeItem(diffDocs(on, off).items[0])).toBe("hand-drawn off");
    expect(outline(on)).toMatch(/gen-sol-bar rect .*fill @lux\.chart-green · hand-drawn hachure, roughness 1\.5/);
    // His change soft-pins it: an agent cannot undo it on its next turn.
    const pins = softPinsFromRevisions([{ rev: 1, author: "human", ops: [{ op: "set", node: "gen-sol-bar", path: "sketch.roughness", value: 2.5 }] }]);
    expect(checkPins(more, [{ op: "set", node: "gen-sol-bar", path: "sketch.roughness", value: 1 }], pins).blocked.length).toBe(1);
    expect(checkPins(more, [{ op: "set", node: "gen-opus-bar", path: "sketch", value: {} }], pins).blocked.length).toBe(0);
  });
});

describe("editor commands", () => {
  it("Hand-drawn on / off for several layers is one invertible batch; non-shapes are ignored", () => {
    const d = chart();
    const on = run(d, setSketchOn(d, ["gen-sol-bar", "gen-opus-bar", "headline"], true));
    expect(node(on, "gen-sol-bar").sketch).toEqual({ fill: "hachure" });
    expect(node(on, "gen-opus-bar").sketch).toEqual({ fill: "hachure" });
    expect(node(on, "headline").sketch).toBeUndefined();
    // Turning it on again keeps a layer's own settings.
    const tuned = run(on, setSketchOption(on, ["gen-sol-bar"], "roughness", 2));
    expect(setSketchOn(tuned, ["gen-sol-bar"], true).ops).toEqual([]);
    const off = run(tuned, setSketchOn(tuned, ["gen-sol-bar", "gen-opus-bar"], false));
    expect(node(off, "gen-sol-bar").sketch).toBeUndefined();
    expect(off).toEqual(d);
  });

  it("options: set, back to default, on a layer that is not hand-drawn yet", () => {
    const d = chart();
    const a = run(d, setSketchOption(d, ["gen-sol-bar"], "fill", "cross-hatch"));
    expect(node(a, "gen-sol-bar").sketch).toEqual({ fill: "cross-hatch" });
    const b = run(a, setSketchOption(a, ["gen-sol-bar"], "tint", 0.5));
    expect(node(b, "gen-sol-bar").sketch).toEqual({ fill: "cross-hatch", tint: 0.5 });
    const c = run(b, setSketchOption(b, ["gen-sol-bar"], "tint", undefined));
    expect(node(c, "gen-sol-bar").sketch).toEqual({ fill: "cross-hatch" });
    // Setting an option to its current value writes nothing.
    expect(setSketchOption(c, ["gen-sol-bar"], "fill", "cross-hatch").ops).toEqual([]);
    const seeded = run(c, reseedSketch(c, ["gen-sol-bar", "gen-opus-bar"], () => 0.25));
    expect(node(seeded, "gen-sol-bar").sketch.seed).toBe(Math.floor(0.25 * 2_147_483_647));
    expect(node(seeded, "gen-opus-bar").sketch).toBeUndefined(); // not hand-drawn: no seed
    const tuned = run(seeded, setSketchOption(seeded, ["gen-sol-bar"], "weight", 4));
    const reset = run(tuned, resetSketch(tuned, ["gen-sol-bar"]));
    expect(node(reset, "gen-sol-bar").sketch).toEqual({ fill: "cross-hatch", seed: Math.floor(0.25 * 2_147_483_647) });
  });

  it("phone: candidates are the visible, unlocked shapes that are not a background; one look in one batch", () => {
    const d = chart();
    const cands = sketchCandidates(d.frames[0]).map((n) => n.id);
    expect(cands).toEqual(["gen-sol-bar", "gen-opus-bar", "gen-rule"]);
    expect(isSketchable(node(d, "bg"))).toBe(true); // a shape, but a background: not offered
    const c = sketchLook(d, ["gen-sol-bar", "gen-opus-bar"], { fill: "solid", roughness: 2 });
    expect(c.ops.length).toBe(2);
    const after = run(d, c);
    expect(node(after, "gen-opus-bar").sketch).toEqual({ fill: "solid", roughness: 2 });
    const again = run(after, sketchLook(after, ["gen-opus-bar"], { fill: "hachure", roughness: 1 }));
    expect(node(again, "gen-opus-bar").sketch).toEqual({ fill: "hachure", roughness: 1 });
  });
});
