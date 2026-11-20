// Pure editor model: geometry, resize / rotate maths, snapping, guides, rich text, caret
// mapping and the command → op builders (checked against packages/ops apply + validate).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, invert } from "@post-studio/ops";
import { validateStructure, type Document, type GroupNode, type TextNode } from "@post-studio/schema";
import { FontRegistry, layoutNode } from "@post-studio/text";
import {
  apply as applyPt,
  inv,
  mul,
  nodeAabb,
  nodeCorners,
  parentMatrix,
  resizeBox,
  rotateAbout,
  rotateFromDrag,
  type TextBoxFn,
} from "../src/model/geometry.ts";
import { buildTargets, snapBox } from "../src/model/snap.ts";
import { pinLabel, pinSummary, softPinsByNode } from "../src/model/pins.ts";
import { FRAME_PRESETS, guideSnapLines, guidesFor } from "../src/model/guides.ts";
import { fullText, normalize, replaceRange, setRangeAttr, textDiff, toggleBold, attrsAt } from "../src/model/richtext.ts";
import { caretRect, indexAtPoint, lineEnd, lineStart, selectionRects, verticalMove, wordAt } from "../src/model/caret.ts";
import {
  commitText,
  copyNodes,
  deleteNodes,
  duplicateNodes,
  groupNodes,
  moveNodes,
  newId,
  pasteNodes,
  reorder,
  resizeNode,
  rotateMany,
  setTextProps,
  ungroup,
  zOrder,
  type Command,
} from "../src/model/commands.ts";

let fonts: FontRegistry;
let tb: TextBoxFn;
let doc: Document;
beforeAll(async () => {
  fonts = await FontRegistry.load();
  tb = (n: TextNode) => {
    const L = layoutNode(fonts, n, "mk");
    return { w: L.boxW, h: L.boxH };
  };
  doc = JSON.parse(readFileSync(new URL("../../../fixtures/lux-6-square.hand.json", import.meta.url), "utf8"));
  doc.id = "prj_test1234";
});

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

/** Apply a command: the result validates and the inverse gives back the input exactly. */
function run(d: Document, c: Command | { error: string }): Document {
  if ("error" in c) throw new Error(c.error);
  const r = apply(d, c.ops);
  expect(validateStructure(r.doc).ok).toBe(true);
  expect(apply(r.doc, r.inverse).doc).toEqual(d);
  expect(invert(d, c.ops)).toEqual(r.inverse);
  return r.doc;
}

const node = (d: Document, id: string) => {
  for (const f of d.frames) {
    const stack = [...f.children];
    while (stack.length) {
      const n = stack.shift()!;
      if (n.id === id) return n;
      if (n.type === "group") stack.push(...n.children);
    }
  }
  throw new Error(`no ${id}`);
};

describe("geometry", () => {
  it("matrices: rotation about a point, inverse, composition", () => {
    const m = rotateAbout(90, 10, 10);
    const p = applyPt(m, { x: 20, y: 10 });
    near(p.x, 10);
    near(p.y, 20);
    const back = applyPt(inv(m), p);
    near(back.x, 20);
    near(back.y, 10);
    const both = mul(m, inv(m));
    near(both[0], 1);
    near(both[4], 0);
  });

  it("group children are placed by translate + rotate, like packages/render", () => {
    const d = structuredClone(doc);
    const chart = node(d, "chart") as GroupNode;
    chart.rotation = 90;
    const child = chart.children[0];
    const pm = parentMatrix(d, child.id);
    // The child's top-left in frame space = group origin + child offset rotated about the group centre.
    const p = applyPt(pm, { x: child.x, y: child.y });
    const c = { x: chart.w / 2, y: chart.h / 2 };
    const rel = { x: child.x - c.x, y: child.y - c.y };
    near(p.x, chart.x + c.x - rel.y, 1e-6);
    near(p.y, chart.y + c.y + rel.x, 1e-6);
  });

  it("text boxes come from the HarfBuzz layout", () => {
    const head = node(doc, "headline") as TextNode;
    const b = nodeAabb(doc, head, tb);
    const L = layoutNode(fonts, head, "mk");
    near(b.w, L.boxW);
    near(b.h, L.boxH);
  });

  it("resize keeps the opposite corner fixed, also when rotated", () => {
    const box = { x: 100, y: 100, w: 200, h: 100 };
    for (const rot of [0, 30, -75, 180]) {
      const m = rotateAbout(rot, 200, 150);
      const anchorBefore = applyPt(m, { x: 100, y: 100 }); // nw stays when se is dragged
      const target = applyPt(m, { x: 360, y: 240 });
      const nb = resizeBox(box, rot, { hx: 1, hy: 1 }, target);
      near(nb.w, 260, 1e-6);
      near(nb.h, 140, 1e-6);
      const anchorAfter = applyPt(rotateAbout(rot, nb.x + nb.w / 2, nb.y + nb.h / 2), { x: nb.x, y: nb.y });
      near(anchorAfter.x, anchorBefore.x, 1e-6);
      near(anchorAfter.y, anchorBefore.y, 1e-6);
    }
  });

  it("resize: shift keeps the aspect, edges change one axis, dragging past the anchor flips", () => {
    const box = { x: 0, y: 0, w: 200, h: 100 };
    const a = resizeBox(box, 0, { hx: 1, hy: 1 }, { x: 400, y: 120 }, { keepAspect: true });
    expect(a).toEqual({ x: 0, y: 0, w: 400, h: 200 });
    const e = resizeBox(box, 0, { hx: 1, hy: 0.5 }, { x: 300, y: 999 });
    expect(e).toEqual({ x: 0, y: 0, w: 300, h: 100 });
    const ea = resizeBox(box, 0, { hx: 1, hy: 0.5 }, { x: 300, y: 0 }, { keepAspect: true });
    expect(ea).toEqual({ x: 0, y: -25, w: 300, h: 150 });
    const flip = resizeBox(box, 0, { hx: 1, hy: 0.5 }, { x: -50, y: 0 });
    expect(flip).toEqual({ x: -50, y: 0, w: 50, h: 100 });
    const c = resizeBox(box, 0, { hx: 1, hy: 1 }, { x: 150, y: 75 }, { fromCenter: true });
    expect(c).toEqual({ x: 50, y: 25, w: 100, h: 50 });
  });

  it("rotation from a drag, with 15° snapping", () => {
    const c = { x: 0, y: 0 };
    expect(rotateFromDrag(0, c, { x: 10, y: 0 }, { x: 0, y: 10 })).toBe(90);
    expect(rotateFromDrag(10, c, { x: 10, y: 0 }, { x: 10, y: 1.2 }, true)).toBe(15);
    expect(rotateFromDrag(170, c, { x: 10, y: 0 }, { x: 0, y: 10 })).toBe(-100);
  });
});

describe("snapping and guides", () => {
  it("snaps a moved box to frame centre, other nodes and guides", () => {
    const targets = buildTargets({ w: 1080, h: 1080 }, [{ x: 300, y: 300, w: 100, h: 50 }], guideSnapLines(guidesFor({ w: 1080, h: 1080 })));
    const r = snapBox({ x: 488, y: 600, w: 100, h: 40 }, targets, 6);
    expect(r.dx).toBe(2); // centre 538 → 540
    expect(r.lines.some((l) => l.axis === "x" && l.value === 540)).toBe(true);
    const g = snapBox({ x: 139, y: 700, w: 50, h: 50 }, targets, 6);
    expect(g.dx).toBe(-4); // left edge → safe column 135
    expect(g.lines[0]).toMatchObject({ axis: "x", value: 135, kind: "guide" });
    const n = snapBox({ x: 600, y: 352, w: 50, h: 50 }, targets, 6);
    expect(n.dy).toBe(-2); // top 352 → node bottom 350
    expect(snapBox({ x: 600, y: 700, w: 7, h: 7 }, targets, 3)).toMatchObject({ dx: 0, dy: 0, lines: [] });
  });

  it("guide sets for the three presets (lane templates for square and LinkedIn)", () => {
    expect(FRAME_PRESETS.map((p) => `${p.w}x${p.h}`)).toEqual(["1080x1080", "1080x1350", "1080x1920"]);
    const sq = guidesFor({ w: 1080, h: 1080 })!;
    expect(sq.lines.filter((l) => l.axis === "x").map((l) => l.value)).toEqual([135, 945]);
    expect(sq.lines.find((l) => l.axis === "y")!.value).toBe(1008);
    expect(sq.zones.find((z) => z.kind === "keep-out")).toMatchObject({ x: 920, y: 960, w: 160, h: 120 });
    expect(sq.zones.filter((z) => z.kind === "column").map((z) => z.x)).toEqual([72, 232, 392, 552, 712, 872]);
    const li = guidesFor({ w: 1080, h: 1350, guides: "lux/li-1350" })!;
    expect(li.lines.find((l) => l.axis === "y")!.value).toBe(1270);
    expect(li.zones.filter((z) => z.kind === "column").map((z) => z.x)).toEqual([80, 237.333, 394.667, 552, 709.333, 866.667]);
    expect(guidesFor({ w: 1080, h: 1920 })!.id).toBe("lane/story-1920");
    expect(guidesFor({ w: 500, h: 500 })).toBeUndefined();
    expect(guidesFor({ w: 1080, h: 1080, guides: "none" })).toBeUndefined();
  });
});

describe("rich text spans", () => {
  const spans = [{ text: "Исти " }, { text: "модели", weight: 700 }, { text: "." }];
  it("replaces ranges; inserted text takes the attributes at the caret", () => {
    expect(fullText(replaceRange(spans, 5, 11, "оценки"))).toBe("Исти оценки.");
    expect(replaceRange(spans, 5, 11, "оценки")[1]).toEqual({ text: "оценки", weight: 700 });
    expect(replaceRange(spans, 8, 8, "XX")).toEqual([{ text: "Исти " }, { text: "модXXели", weight: 700 }, { text: "." }]);
    expect(replaceRange(spans, 0, 12, "")).toEqual([{ text: "" }]);
    expect(attrsAt(spans, 5)).toEqual({});
    expect(attrsAt(spans, 6)).toEqual({ weight: 700 });
  });
  it("bold toggle and colour emphasis split and merge spans", () => {
    const one = [{ text: "Исти модели." }];
    const b = toggleBold(one, 5, 11, 600, 700);
    expect(b).toEqual([{ text: "Исти " }, { text: "модели", weight: 700 }, { text: "." }]);
    expect(toggleBold(b, 5, 11, 600, 700)).toEqual(one);
    const c = setRangeAttr(one, 0, 4, "fill", "#AC1922");
    expect(c).toEqual([{ text: "Исти", fill: "#AC1922" }, { text: " модели." }]);
    expect(normalize([{ text: "a", weight: 600 }, { text: "b" }], { weight: 600 })).toEqual([{ text: "ab" }]);
  });
  it("text diff finds the changed range", () => {
    expect(textDiff("Исти модели", "Исти нови модели")).toEqual({ start: 5, end: 5, insert: "нови " });
    expect(textDiff("abc", "ac")).toEqual({ start: 1, end: 2, insert: "" });
  });
});

describe("caret geometry from the layout", () => {
  it("maps indices to carets and points back to indices on wrapped Macedonian text", () => {
    const n: TextNode = { id: "t", type: "text", x: 0, y: 0, w: 300, h: 0, box: "fixed-width", align: "left", style: { font: "IBM Plex Sans", weight: 600, size: 40, fill: "#000000" }, spans: [{ text: "Исти модели различни оценки\nѓ ќ" }] };
    const L = layoutNode(fonts, n, "mk");
    const text = fullText(n.spans);
    expect(L.lines.length).toBeGreaterThanOrEqual(3);
    const space = 10;
    for (let i = 0; i <= text.length; i++) {
      const c = caretRect(L, text, i, space);
      const back = indexAtPoint(L, text, { x: c.x, y: (c.top + c.bottom) / 2 }, space);
      // Soft-wrap ends map to the same spot as the next line start; everything else round-trips.
      if (back !== i) expect(caretRect(L, text, back, space).x).toBeCloseTo(c.x, 3);
    }
    const second = L.lines[1].start;
    expect(lineStart(L, text, second + 2)).toBe(second);
    expect(lineEnd(L, text, 0)).toBeLessThan(second);
    const down = verticalMove(L, text, 2, 1, undefined, space);
    expect(caretRect(L, text, down.index, space).line).toBe(1);
    expect(selectionRects(L, text, 0, text.length, space).length).toBe(L.lines.length);
    expect(wordAt(text, 7)).toEqual([5, 11]);
  });
});

describe("commands → ops", () => {
  it("move, resize, rotate, nudge keep the document valid and invertible", () => {
    let d = run(doc, moveNodes(doc, ["headline"], 10, -24));
    expect(node(d, "headline")).toMatchObject({ x: 145, y: 76 });
    d = run(d, resizeNode(d, "logo", { x: 135, y: 10, w: 100, h: 100 }, tb));
    expect(node(d, "logo")).toMatchObject({ w: 100, h: 100 });
    d = run(d, rotateMany(d, ["logo"], 30, { x: 185, y: 60 }, tb));
    expect(node(d, "logo").rotation).toBe(30);
  });

  it("moves a child of a rotated group in the group's own space", () => {
    const d0 = structuredClone(doc);
    (node(d0, "chart") as GroupNode).rotation = 90;
    const child = (node(d0, "chart") as GroupNode).children[0];
    const before = nodeCorners(d0, child, tb)[0];
    const d = run(d0, moveNodes(d0, [child.id], 10, 0));
    const after = nodeCorners(d, node(d, child.id), tb)[0];
    near(after.x - before.x, 10, 1e-2);
    near(after.y - before.y, 0, 1e-2);
  });

  it("text resize: width change → fixed-width, height change → fixed", () => {
    const sub = node(doc, "sub") as TextNode;
    const box = nodeAabb(doc, sub, tb);
    const d = run(doc, resizeNode(doc, "sub", { ...box, w: box.w - 100 }, tb));
    expect(node(d, "sub")).toMatchObject({ box: sub.box === "fixed" ? "fixed" : "fixed-width", w: Math.round((box.w - 100) * 100) / 100 });
    const d2 = run(doc, resizeNode(doc, "sub", { ...box, h: box.h + 40 }, tb));
    expect(node(d2, "sub")).toMatchObject({ box: "fixed" });
  });

  it("group resize scales the children", () => {
    const chart = node(doc, "chart") as GroupNode;
    const d = run(doc, resizeNode(doc, "chart", { x: chart.x, y: chart.y, w: chart.w * 0.5, h: chart.h * 0.5 }, tb));
    const c0 = (node(d, "chart") as GroupNode).children[0];
    const o0 = chart.children[0];
    near(c0.x, Math.round(o0.x * 0.5 * 100) / 100, 0.01);
    expect(node(d, "chart").w).toBeCloseTo(chart.w * 0.5, 1);
  });

  it("delete, duplicate, copy / paste use fresh ids", () => {
    const dup = duplicateNodes(doc, ["headline", "logo"]);
    const d = run(doc, dup);
    expect(dup.created).toHaveLength(2);
    expect(dup.created.every((id) => /_[a-z0-9]{4}$/.test(id))).toBe(true);
    expect(node(d, dup.created[0]).x).toBe(node(doc, "headline").x + 20);
    const clip = copyNodes(doc, ["chart"]);
    const p = pasteNodes(doc, clip, "square");
    const d2 = run(doc, p);
    const pasted = node(d2, p.created[0]) as GroupNode;
    expect(pasted.children.map((c) => c.id).every((id) => !id.startsWith("row-") || id.includes("_"))).toBe(true);
    run(d2, deleteNodes(d2, [p.created[0], (pasted.children[0] as any).id]));
    expect(newId(new Set(["a_bbbb"]), "a_aaaa", () => 0)).toBe("a_aaaa".replace("aaaa", "aaaa"));
  });

  it("group then ungroup puts everything back where it was on screen", () => {
    const ids = ["headline", "sub", "logo"];
    const before = ids.map((id) => nodeAabb(doc, node(doc, id), tb));
    const g = groupNodes(doc, ids, tb, "grp");
    const d = run(doc, g);
    expect((node(d, "grp") as GroupNode).children.map((c) => c.id)).toEqual(["logo", "headline", "sub"].filter((x) => ids.includes(x)).sort((a, b) => doc.frames[0].children.findIndex((c) => c.id === a) - doc.frames[0].children.findIndex((c) => c.id === b)));
    ids.forEach((id, i) => {
      const a = nodeAabb(d, node(d, id), tb);
      near(a.x, before[i].x, 0.011);
      near(a.y, before[i].y, 0.011);
    });
    // Rotate the group, ungroup: children keep their on-screen centres and take the rotation.
    const d2 = structuredClone(d);
    (node(d2, "grp") as GroupNode).rotation = 20;
    const centres = ids.map((id) => {
      const cs = nodeCorners(d2, node(d2, id), tb);
      return { x: (cs[0].x + cs[2].x) / 2, y: (cs[0].y + cs[2].y) / 2 };
    });
    const d3 = run(d2, ungroup(d2, "grp", tb));
    ids.forEach((id, i) => {
      const cs = nodeCorners(d3, node(d3, id), tb);
      near((cs[0].x + cs[2].x) / 2, centres[i].x, 0.02);
      near((cs[0].y + cs[2].y) / 2, centres[i].y, 0.02);
      expect(node(d3, id).rotation).toBe(20);
    });
    expect(groupNodes(doc, ["headline", (node(doc, "chart") as GroupNode).children[0].id], tb)).toHaveProperty("error");
  });

  it("z-order and layer reorder", () => {
    const kids = () => doc.frames[0].children.map((c) => c.id);
    const first = kids()[0];
    const d = run(doc, zOrder(doc, [first], "front"));
    expect(d.frames[0].children.at(-1)!.id).toBe(first);
    const d2 = run(d, zOrder(d, [first], "backward"));
    expect(d2.frames[0].children.at(-2)!.id).toBe(first);
    const d3 = run(d2, zOrder(d2, [first], "back"));
    expect(d3.frames[0].children[0].id).toBe(first);
    const d4 = run(d3, zOrder(d3, [first], "forward"));
    expect(d4.frames[0].children[1].id).toBe(first);
    // Drag the headline into the chart group: it stays where it is on screen.
    const before = nodeAabb(doc, node(doc, "headline"), tb);
    const d5 = run(doc, reorder(doc, "headline", "chart", 0, tb));
    const after = nodeAabb(d5, node(d5, "headline"), tb);
    near(after.x, before.x, 0.011);
    near(after.y, before.y, 0.011);
  });

  it("text edits keep auto-width boxes anchored by alignment and refit fixed-width heights", () => {
    const d0 = structuredClone(doc);
    const t = node(d0, "headline") as TextNode;
    t.box = "auto-width";
    t.align = "right";
    const fitted = tb(t);
    t.w = fitted.w;
    t.h = fitted.h;
    const right = t.x + t.w;
    const d = run(d0, commitText(d0, "headline", [{ text: "Кратко." }], tb));
    const n = node(d, "headline") as TextNode;
    near(n.x + n.w, right, 0.011);
    expect(n.w).toBeCloseTo(tb(n).w, 1);
    const big = run(doc, setTextProps(doc, ["headline"], "style.size", 80, tb));
    expect(node(big, "headline").h).toBeCloseTo(tb(node(big, "headline") as TextNode).h, 1);
  });
});

describe("soft pins (what the agent keeps from his last changes)", () => {
  const soft = (node: string, path: string, rev = 1) => ({ node, path, source: "soft" as const, rev });
  it("groups per node, drops always-human paths and paths an explicit pin already covers", () => {
    const m = softPinsByNode(
      [soft("headline", "y"), soft("headline", "x"), soft("headline", "style.size", 2), soft("headline", "y", 3), soft("logo", "pins"), soft("logo", "locked"), soft("sub", "spans"), soft("sticker", "#exists"), soft("chart", "fill")],
      (id) => (id === "sub" ? ["spans"] : id === "chart" ? ["*"] : undefined),
    );
    expect([...m.entries()]).toEqual([
      ["headline", ["x", "y", "style.size"]],
      ["sticker", ["#exists"]],
    ]);
  });
  it("labels paths for people", () => {
    expect(pinLabel("style.size")).toBe("font size");
    expect(pinLabel("#exists")).toBe("the layer (you added it)");
    expect(pinLabel("spans")).toBe("text");
    expect(pinLabel("recolor.#AC1922")).toBe("recolour (#AC1922)");
    expect(pinLabel("meta.scores")).toBe("meta.scores");
    expect(pinSummary(["x", "y", "style.size"])).toBe("position, font size");
    expect(pinSummary(["y"])).toBe("y");
  });
});
