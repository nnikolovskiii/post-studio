// Multi-select editing in the editor model: one command per change across N layers (one revision,
// one undo), text boxes that follow a new size or font, weights that exist in each text's font,
// align / space evenly, the same width on several layers, and what the phone may edit.
import { beforeAll, describe, expect, it } from "vitest";
import { apply, invert } from "@post-studio/ops";
import { DocumentSchema, findItem, SCHEMA_VERSION, validateStructure, type Document, type Node } from "@post-studio/schema";
import { FontRegistry } from "@post-studio/text";
import { weightsOf } from "../src/fonts.ts";
import { textBoxFn } from "../src/textlayout.ts";
import { alignNodes, countLabel, distributeNodes, phoneEditable, setShared, setSharedMany, setSharedSize, sizeValues } from "../src/model/shared.ts";
import { nodeAabb, type TextBoxFn } from "../src/model/geometry.ts";
import type { Command } from "../src/model/commands.ts";

let fonts: FontRegistry;
let tb: TextBoxFn;
const wf = (f: string) => weightsOf(fonts, f);

beforeAll(async () => {
  fonts = await FontRegistry.load();
  tb = textBoxFn(fonts, "mk");
});

function doc(): Document {
  const bar = (id: string, x: number, y: number, w: number, fill: string, extra: object = {}): Node => ({ id, type: "rect", x, y, w, h: 24, fill, ...extra }) as Node;
  const label = (id: string, y: number, size: number, text: string, extra: object = {}): Node => ({ id, type: "text", x: 135, y, w: 10, h: 10, box: "auto-width", align: "left", style: { font: "IBM Plex Sans", weight: 500, size, fill: "#655B56" }, spans: [{ text }], ...extra }) as Node;
  const d = DocumentSchema.parse({
    schema: SCHEMA_VERSION,
    id: "prj_multiedit",
    title: "Multi",
    lang: "mk",
    frames: [
      {
        id: "square",
        name: "Square",
        w: 1080,
        h: 1080,
        children: [
          label("l1", 100, 28, "Прва"),
          label("l2", 160, 32, "Втора подолга"),
          label("l3", 220, 28, "Bold", { spans: [{ text: "Bold " }, { text: "word", weight: 600 }] }),
          bar("a", 300, 400, 200, "#305880"),
          bar("b", 360, 450, 120, "#305880"),
          bar("c", 600, 500, 80, "#AC1922"),
          { id: "grp", type: "group", x: 100, y: 700, w: 0, h: 0, locked: true, children: [bar("inner", 0, 0, 50, "#305880")] },
          bar("locked", 0, 900, 40, "#305880", { locked: true }),
        ],
      },
    ],
  }) as Document;
  // Stored boxes as the editor keeps them (auto-width follows the layout).
  for (const id of ["l1", "l2", "l3"]) {
    const n = findItem(d, id)!.item as any;
    const b = tb(n);
    n.w = Math.round(b.w * 100) / 100;
    n.h = Math.round(b.h * 100) / 100;
  }
  return d;
}

const get = (d: Document, id: string) => findItem(d, id)!.item as any;
/** One command → the server's validated apply; one inverse (= one undo) restores everything. */
function run(d: Document, c: Command): Document {
  expect(c.ops.length).toBeGreaterThan(0);
  const r = apply(d, c.ops);
  expect(validateStructure(r.doc).ok).toBe(true);
  expect(apply(r.doc, invert(d, c.ops)).doc).toEqual(d);
  return r.doc;
}

describe("setShared: one field on several layers = one command", () => {
  it("text size on three texts: one batch, each auto-width box follows its own text", () => {
    const d = doc();
    const c = setShared(d, ["l1", "l2", "l3"], "size", 40, tb, wf);
    expect(c.label).toBe("size 40 on 3 layers");
    const after = run(d, c);
    for (const id of ["l1", "l2", "l3"]) {
      expect(get(after, id).style.size).toBe(40);
      expect(get(after, id).w).toBeCloseTo(tb(get(after, id)).w, 1);
      expect(get(after, id).w).toBeGreaterThan(get(d, id).w);
    }
  });

  it("fill on bars and a text in one go (text colour), other layers untouched", () => {
    const d = doc();
    const after = run(d, setShared(d, ["a", "c", "l1"], "fill", { token: "lux.ink" }, tb));
    expect([get(after, "a").fill, get(after, "c").fill, get(after, "l1").style.fill]).toEqual([{ token: "lux.ink" }, { token: "lux.ink" }, { token: "lux.ink" }]);
    expect(get(after, "b").fill).toBe("#305880");
    // A colour change does not touch text boxes.
    expect(setShared(d, ["l1"], "fill", "#190F0B", tb).ops).toEqual([{ op: "set", node: "l1", path: "style.fill", value: "#190F0B" }]);
  });

  it("font: each text keeps its weight when the family has it, bold words the family lacks fall back", () => {
    const d = doc();
    const fams = fonts.families();
    const target = fams.find((f) => f !== "IBM Plex Sans" && !wf(f).includes(600) && wf(f).length) ?? fams.find((f) => f !== "IBM Plex Sans")!;
    const after = run(d, setShared(d, ["l1", "l3"], "font", target, tb, wf));
    for (const id of ["l1", "l3"]) {
      expect(get(after, id).style.font).toBe(target);
      expect(wf(target)).toContain(get(after, id).style.weight);
    }
    if (!wf(target).includes(600)) expect(get(after, "l3").spans[1].weight).toBeUndefined();
    else expect(get(after, "l3").spans[1].weight).toBe(600);
  });

  it("weight snaps per text to its own family's nearest weight", () => {
    const d = doc();
    const ws = wf("IBM Plex Sans");
    const want = ws.reduce((a, c) => (Math.abs(c - 700) < Math.abs(a - 700) ? c : a));
    const after = run(d, setShared(d, ["l1", "l2"], "weight", 700, tb, wf));
    expect([get(after, "l1").style.weight, get(after, "l2").style.weight]).toEqual([want, want]);
    expect(ws).toContain(want);
  });

  it("several fields at once (the phone's Apply) are still one command", () => {
    const d = doc();
    const c = setSharedMany(d, ["l1", "l2", "a"], [["size", 36], ["fill", "#190F0B"], ["opacity", 0.5], ["align", "center"]], tb, wf);
    expect(c.label).toMatch(/^size 36, fill #190F0B, opacity 50%, align center on 3 layers$/);
    const after = run(d, c);
    expect([get(after, "l1").style.size, get(after, "l2").style.fill, get(after, "a").fill, get(after, "a").opacity, get(after, "l2").align]).toEqual([36, "#190F0B", "#190F0B", 0.5, "center"]);
    expect(setSharedMany(after, ["l1"], [["size", 36]], tb, wf).ops).toEqual([]);
  });
});

describe("size, align and spacing for several layers", () => {
  it("the same width on bars keeps each one's left edge", () => {
    const d = doc();
    expect(sizeValues([get(d, "a"), get(d, "b")], tb, "w")).toEqual([200, 120]);
    const after = run(d, setSharedSize(d, ["a", "b", "c"], "w", 150, tb));
    expect(["a", "b", "c"].map((id) => [get(after, id).x, get(after, id).w])).toEqual([[300, 150], [360, 150], [600, 150]]);
  });

  it("align left / right / middle on the box around them; one layer aligns with its frame", () => {
    const d = doc();
    const left = run(d, alignNodes(d, ["a", "b", "c"], "left", tb));
    expect(["a", "b", "c"].map((id) => get(left, id).x)).toEqual([300, 300, 300]);
    const right = run(d, alignNodes(d, ["a", "b", "c"], "right", tb));
    expect(["a", "b", "c"].map((id) => get(right, id).x + get(right, id).w)).toEqual([680, 680, 680]);
    const mid = run(d, alignNodes(d, ["a", "c"], "vcenter", tb));
    expect(get(mid, "a").y).toBe(get(mid, "c").y);
    const one = run(d, alignNodes(d, ["c"], "hcenter", tb, { x: 0, y: 0, w: 1080, h: 1080 }));
    expect(get(one, "c").x).toBe(500);
  });

  it("space evenly: equal gaps, the outer layers stay", () => {
    const d = doc();
    get(d, "b").y = 420; // gaps 0 and 56 before
    const after = run(d, distributeNodes(d, ["a", "b", "c"], "v", tb));
    const box = (id: string) => nodeAabb(after, get(after, id), tb);
    expect(get(after, "a").y).toBe(400);
    expect(get(after, "c").y).toBe(500);
    const g1 = box("b").y - (box("a").y + box("a").h);
    const g2 = box("c").y - (box("b").y + box("b").h);
    expect(g1).toBeCloseTo(g2, 2);
    expect(distributeNodes(d, ["a", "b"], "h", tb).ops).toEqual([]);
  });
});

describe("phone: what Edit together may change", () => {
  it("leaves out locked and hidden layers and layers inside a locked group", () => {
    const d = doc();
    expect(phoneEditable(d, ["a", "locked", "inner", "l1", "a", "gone"])).toEqual({
      ok: ["a", "l1"],
      blocked: [
        { id: "locked", reason: "locked" },
        { id: "inner", reason: "inside the locked group grp" },
      ],
    });
    expect(countLabel(2, "text")).toBe("2 texts");
    expect(countLabel(1, "rect")).toBe("1 rectangle");
  });
});
