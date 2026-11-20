// Motion Part 3, pure editor model (apps/editor/src/model/motion.ts): geometry at a time matches
// the renderer's wrapper exactly, Animate-mode op builders, time snapping, keyframe pins,
// timeline rows and hit testing at the playhead.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { apply, validateDocument, type Op } from "@post-studio/ops";
import { walk, type Document, type Node, type TextNode } from "@post-studio/schema";
import { hasKeyframes, sampleNode } from "@post-studio/motion";
import { animAttrs, nodeBox as renderBox } from "@post-studio/render";
import { FontRegistry, layoutNode } from "@post-studio/text";
import { apply as applyPt, mul, rotateAbout, translate, IDENTITY, type Mat, type TextBoxFn } from "../src/model/geometry.ts";
import { hitTest } from "../src/model/hit.ts";
import {
  animMatrix,
  animateMoveOps,
  animateRotateOps,
  cleanValue,
  hiddenAt,
  keyAtTime,
  keyframeChanged,
  keyframePin,
  movedAt,
  nodeCornersAt,
  previousKeyTime,
  scaleFactor,
  scaleTrackFor,
  snapTime,
  subtreeAnimated,
  timelineRows,
} from "../src/model/motion.ts";

const ROOT = new URL("../../../", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("fixtures/lux-6-motion.json", ROOT), "utf8")) as Document;
let fonts: FontRegistry;
let tb: TextBoxFn;
beforeAll(async () => {
  fonts = await FontRegistry.load();
  tb = (n: TextNode) => {
    const L = layoutNode(fonts, n, "mk");
    return { w: L.boxW, h: L.boxH };
  };
});

/** SVG transform list → matrix (translate / rotate / scale, as animAttrs writes them). */
function parseTransform(s: string | undefined): Mat {
  let m: Mat = IDENTITY;
  for (const [, fn, args] of (s ?? "").matchAll(/(\w+)\(([^)]*)\)/g)) {
    const a = args.trim().split(/[\s,]+/).map(Number);
    if (fn === "translate") m = mul(m, translate(a[0], a[1] ?? 0));
    else if (fn === "rotate") m = mul(m, rotateAbout(a[0], 0, 0));
    else if (fn === "scale") m = mul(m, [a[0], 0, 0, a[1] ?? a[0], 0, 0]);
  }
  return m;
}

const rect = (id: string, extra: Partial<Node> = {}): Node => ({ id, type: "rect", x: 100, y: 100, w: 200, h: 100, fill: "#000000", ...extra }) as Node;
const docWith = (children: Node[], motion = true): Document => ({
  schema: "post-studio/2",
  id: "prj_test",
  title: "t",
  lang: "mk",
  ...(motion ? { motion: { duration: 6000, fps: 30 } } : {}),
  frames: [{ id: "square", name: "Square", w: 1080, h: 1080, children }],
});
const run = (d: Document, ops: unknown[]) => apply(d, ops as Op[]).doc;

describe("geometry at a time = the renderer's wrapper", () => {
  it("animMatrix equals animAttrs' transform for every animated layer of the fixture at many moments", () => {
    let checked = 0;
    for (const t of [0, 100, 250, 400, 650, 900, 1100, 1350, 1567, 2000, 5300, 5600]) {
      for (const loc of walk(fixture)) {
        if (loc.kind !== "node") continue;
        const n = loc.item as Node;
        if (!hasKeyframes(n)) continue;
        const s = sampleNode(n, t);
        const box = n.type === "text" ? { x: n.x, y: n.y, ...((b) => ({ w: b.w, h: b.h }))(tb(n)) } : renderBox(n);
        const a = animAttrs(s, box, n.anim?.origin);
        const expected = a.opacity === "0" ? IDENTITY : parseTransform(a.transform);
        const got = animMatrix(n, t, tb);
        for (const p of [{ x: 0, y: 0 }, { x: 500, y: 300 }, { x: 1080, y: 1080 }]) {
          const e = applyPt(expected, p);
          const g = applyPt(got, p);
          expect(Math.abs(e.x - g.x) + Math.abs(e.y - g.y), `${n.id} at ${t}`).toBeLessThan(0.05); // the SVG rounds angles to 3 decimals
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("nested motion composes: group offset + child offset; ghost / hidden checks", () => {
    let d = docWith([{ id: "g", type: "group", x: 0, y: 0, w: 0, h: 0, children: [rect("r")] } as Node]);
    d = run(d, [
      { op: "set", node: "g", path: "anim.tracks.dy.k1", value: { t: 0, v: 10 } },
      { op: "set", node: "r", path: "anim.tracks.dx.k1", value: { t: 0, v: 5 } },
      { op: "set", node: "r", path: "anim.tracks.opacity.k1", value: { t: 0, v: 1 } },
      { op: "set", node: "r", path: "anim.tracks.opacity.k2", value: { t: 1000, v: 0 } },
    ]);
    const r = (d.frames[0].children[0] as Extract<Node, { type: "group" }>).children[0];
    expect(nodeCornersAt(d, r, 0, tb)[0]).toEqual({ x: 105, y: 110 });
    expect(nodeCornersAt(d, r, undefined, tb)[0]).toEqual({ x: 100, y: 100 });
    expect(movedAt(d, r, 0, tb)).toBe(true);
    expect(movedAt(d, r, undefined, tb)).toBe(false);
    expect(hiddenAt(d, r, 500)).toBe(false);
    expect(hiddenAt(d, r, 1000)).toBe(true);
    expect(subtreeAnimated(d.frames[0].children[0])).toBe(true);
  });

  it("hit testing follows the layer to where it is drawn and skips layers invisible at t", () => {
    let d = docWith([rect("r")]);
    d = run(d, [
      { op: "set", node: "r", path: "anim.tracks.dx.k1", value: { t: 0, v: 400 } },
      { op: "set", node: "r", path: "anim.tracks.opacity.k1", value: { t: 0, v: 1 } },
      { op: "set", node: "r", path: "anim.tracks.opacity.k2", value: { t: 2000, v: 0 } },
    ]);
    const motion = (t: number) => ({ matrix: (n: Node) => animMatrix(n, t, tb), hidden: (n: Node) => hiddenAt(d, n, t) });
    const f = d.frames[0];
    expect(hitTest(f, { x: 150, y: 150 }, tb)).toEqual(["r"]); // rest pose without motion
    expect(hitTest(f, { x: 150, y: 150 }, tb, 3, motion(0))).toEqual([]);
    expect(hitTest(f, { x: 550, y: 150 }, tb, 3, motion(0))).toEqual(["r"]);
    expect(hitTest(f, { x: 550, y: 150 }, tb, 3, motion(2000))).toEqual([]); // faded out
  });
});

describe("Animate mode writes keyframes at the playhead", () => {
  it("an empty track gets a neutral keyframe at the layer's previous keyframe time (or 0) first", () => {
    let d = docWith([rect("r")]);
    expect(keyAtTime(d, "r", "dx", 30, 1500)).toEqual([
      { op: "set", node: "r", path: "anim.tracks.dx.k1", value: { t: 0, v: 0 } },
      { op: "set", node: "r", path: "anim.tracks.dx.k2", value: { t: 1500, v: 30 } },
    ]);
    d = run(d, [{ op: "set", node: "r", path: "anim.tracks.opacity.in1", value: { t: 400, v: 0 } }, { op: "set", node: "r", path: "anim.tracks.opacity.in2", value: { t: 1000, v: 1 } }]);
    expect(previousKeyTime(d.frames[0].children[0], 1500)).toBe(1000);
    expect(keyAtTime(d, "r", "dx", 30, 1500)[0]).toEqual({ op: "set", node: "r", path: "anim.tracks.dx.k1", value: { t: 1000, v: 0 } });
    // At 0 there is nothing before: one keyframe only. A neutral value needs no neutral keyframe.
    expect(keyAtTime(d, "r", "dx", 30, 0)).toEqual([{ op: "set", node: "r", path: "anim.tracks.dx.k1", value: { t: 0, v: 30 } }]);
    expect(keyAtTime(d, "r", "scale", 1, 1500)).toEqual([{ op: "set", node: "r", path: "anim.tracks.scale.k1", value: { t: 1500, v: 1 } }]);
  });

  it("a keyframe already at that time gets the new value; a track with keyframes gets just one more", () => {
    let d = docWith([rect("r")]);
    d = run(d, [{ op: "set", node: "r", path: "anim.tracks.opacity.in1", value: { t: 400, v: 0 } }, { op: "set", node: "r", path: "anim.tracks.opacity.in2", value: { t: 1000, v: 1 } }]);
    expect(keyAtTime(d, "r", "opacity", 0.5, 1000)).toEqual([{ op: "set", node: "r", path: "anim.tracks.opacity.in2.v", value: 0.5 }]);
    expect(keyAtTime(d, "r", "opacity", 1, 1000)).toEqual([]);
    expect(keyAtTime(d, "r", "opacity", 1.7, 2000)).toEqual([{ op: "set", node: "r", path: "anim.tracks.opacity.k1", value: { t: 2000, v: 1 } }]); // clamped
    expect(cleanValue("scale", 0.123456)).toBe(0.1235);
    expect(cleanValue("dx", 10.004)).toBe(10);
    // Every op batch is a valid post-studio/2 document.
    const after = run(d, keyAtTime(d, "r", "rotate", 45, 1500));
    expect(validateDocument(after).ok).toBe(true);
  });

  it("move writes dx / dy in the parent's space (a rotated group), only the axes that moved", () => {
    let d = docWith([{ id: "g", type: "group", x: 0, y: 0, w: 100, h: 100, rotation: 90, children: [rect("r")] } as Node]);
    const ops = animateMoveOps(d, ["r"], { x: 10, y: 0 }, 500, tb);
    // In a group turned 90° clockwise, moving right on screen is moving "up" (−y) inside it.
    expect(ops.map((o) => (o as { path: string }).path)).toEqual(["anim.tracks.dy.k1", "anim.tracks.dy.k2"]);
    expect((ops[1] as { value: { v: number } }).value.v).toBeCloseTo(-10, 6);
    d = docWith([rect("r")]);
    expect(animateMoveOps(d, ["r"], { x: 0, y: 12.345 }, 0, tb)).toEqual([{ op: "set", node: "r", path: "anim.tracks.dy.k1", value: { t: 0, v: 12.35 } }]);
    expect(animateRotateOps(d, ["r"], 30, 0)).toEqual([{ op: "set", node: "r", path: "anim.tracks.rotate.k1", value: { t: 0, v: 30 } }]);
  });

  it("resize handles drive scale (corners) or scaleX / scaleY (sides) around the origin", () => {
    expect(scaleTrackFor(0, 0)).toBe("scale");
    expect(scaleTrackFor(1, 0.5)).toBe("scaleX");
    expect(scaleTrackFor(0.5, 1)).toBe("scaleY");
    const origin = { x: 100, y: 100 };
    expect(scaleFactor("scaleX", { x: 400, y: 0 }, { x: 300, y: 150 }, origin)).toBe(1.5);
    expect(scaleFactor("scaleY", { x: 0, y: 125 }, { x: 0, y: 150 }, origin)).toBe(0.5);
    expect(scaleFactor("scale", { x: 300, y: 250 }, { x: 300, y: 200 }, origin)).toBe(1.5); // the axis that moved more
    expect(scaleFactor("scaleX", { x: 400, y: 0 }, { x: 100, y: 0 }, origin)).toBe(1); // handle on the anchor
    expect(scaleFactor("scaleX", { x: 0, y: 0 }, { x: 300, y: 0 }, origin)).toBe(0.01); // never below 1 %
  });
});

describe("timeline", () => {
  it("snaps a time to keyframes / the playhead, then 0.1 s, then frames; Ctrl gives whole ms", () => {
    const o = { fps: 30, candidates: [733, 1250], threshold: 40 };
    expect(snapTime(1230, o)).toBe(1250);
    expect(snapTime(1290, o)).toBe(1300); // 0.1 s step
    expect(snapTime(1355, { ...o, threshold: 10 })).toBe(1367); // nearest frame
    expect(snapTime(1355.4, { ...o, free: true })).toBe(1355);
    expect(snapTime(-50, o)).toBe(0);
    expect(snapTime(700, { ...o, max: 600 })).toBe(600);
  });

  it("keyframe pins: explicit on the keyframe, its track, the layer's motion or the layer; soft on his changes", () => {
    const n = { pins: undefined } as Pick<Node, "pins">;
    expect(keyframePin(n, [], "dy", "k2")).toBeUndefined();
    expect(keyframePin(n, ["anim.tracks.dy.k2.t"], "dy", "k2")).toBe("soft");
    expect(keyframePin(n, ["anim.tracks.dy.k2"], "dy", "k2")).toBe("soft");
    expect(keyframePin(n, ["anim"], "dy", "k2")).toBe("soft");
    expect(keyframePin(n, ["anim.tracks.dy.k1.t", "anim.tracks.opacity.k2"], "dy", "k2")).toBeUndefined();
    for (const p of ["anim.tracks.dy.k2", "anim.tracks.dy", "anim", "*", "anim.tracks.dy.k2.v"]) expect(keyframePin({ pins: [p] }, [], "dy", "k2"), p).toBe("explicit");
    expect(keyframePin({ pins: ["anim.tracks.dx"] }, [], "dy", "k2")).toBeUndefined();
    expect(keyframeChanged(["anim.tracks.dy.k2.ease"], "dy", "k2")).toBe(true);
    expect(keyframeChanged(["anim.tracks.dy.k3"], "dy", "k2")).toBe(false);
    expect(keyframeChanged(["anim"], "dy", "k2")).toBe(true);
  });

  it("rows: animated layers in Layers-panel order (front first, groups before children), plus the selected", () => {
    const rows = timelineRows(fixture, ["masthead"]);
    const ids = rows.map((r) => r.id);
    expect(ids[0]).toBe("status"); // the front-most layer
    expect(ids).toContain("masthead"); // selected, no motion
    expect(ids.indexOf("chart")).toBeLessThan(ids.indexOf("row-1-track"));
    expect(rows.find((r) => r.id === "row-1-track")).toMatchObject({ depth: 1, tracks: ["scaleX"] });
    expect(rows.find((r) => r.id === "masthead")).toMatchObject({ tracks: [], range: undefined });
    expect(rows.find((r) => r.id === "headline")!.range).toEqual([200, 800]);
    expect(ids).not.toContain("kicker");
  });
});
