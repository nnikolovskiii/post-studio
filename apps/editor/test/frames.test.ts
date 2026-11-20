// "+ Frame" and "Duplicate frame" (Layers panel): the op batches are valid, invertible (undo
// removes the frame), number and name the new frame like the others, and give every copied
// layer a fresh id.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apply, diffDocs, invert, softPinsFromRevisions } from "@post-studio/ops";
import { validateStructure, walk, type Document, type Frame, type GroupNode, type Node } from "@post-studio/schema";
import { addFrame, duplicateFrame, FRAME_GAP, frameOffsets, MAX_FRAMES, moveFrame, nextFrameId, nextFrameName, snapFramePosition } from "../src/model/frames.ts";
import { FRAME_PRESETS } from "../src/model/guides.ts";
import type { Command } from "../src/model/commands.ts";

const lux6 = (): Document => {
  const d = JSON.parse(readFileSync(new URL("../../../fixtures/lux-6-square.hand.json", import.meta.url), "utf8")) as Document;
  d.id = "prj_test1234";
  return d;
};

/** A carousel like his: "1 · Насловна", "2 · Разликата", "3 · Грешки" (s1 … s3), LinkedIn size. */
function carousel(): Document {
  const d = lux6();
  const content = d.frames[0];
  const li = { w: 1080, h: 1350, background: { color: "#84A493" }, guides: "lane/li-1350" };
  d.frames = [
    { id: "s1", name: "1 · Насловна", ...li, children: content.children },
    { id: "s2", name: "2 · Разликата", ...li, children: [] },
    { id: "s3", name: "3 · Грешки", ...li, background: { color: "#FCFAF6" }, children: [] },
  ];
  return d;
}

/** Apply: the result validates and its inverse (what undo applies) gives the input back exactly. */
function run(d: Document, c: (Command & { frame: string }) | { error: string }): { doc: Document; frame: Frame } {
  if ("error" in c) throw new Error(c.error);
  const r = apply(d, c.ops);
  expect(validateStructure(r.doc).ok).toBe(true);
  expect(apply(r.doc, r.inverse).doc).toEqual(d);
  expect(invert(d, c.ops)).toEqual(r.inverse);
  expect(c.ops).toHaveLength(1);
  return { doc: r.doc, frame: r.doc.frames.find((f) => f.id === c.frame)! };
}

const ids = (d: Document) => [...walk(d)].map((l) => l.id);
const nodes = (f: Frame | GroupNode): Node[] => f.children.flatMap((n) => [n, ...(n.type === "group" ? nodes(n) : [])]);

describe("+ Frame", () => {
  it("adds '4 · Frame 4' (s4) at the end, like the active frame: size, background, guides", () => {
    const d = carousel();
    const { doc, frame } = run(d, addFrame(d, "s3"));
    expect(doc.frames.map((f) => f.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(frame).toEqual({ id: "s4", name: "4 · Frame 4", w: 1080, h: 1350, background: { color: "#FCFAF6" }, guides: "lane/li-1350", children: [] });
    // Like the active frame, not always the last one.
    expect(run(d, addFrame(d, "s1")).frame.background).toEqual({ color: "#84A493" });
    // No active frame → like the last one.
    expect(run(d, addFrame(d)).frame.background).toEqual({ color: "#FCFAF6" });
  });

  it("numbers on: the next one after a new frame is '5 · Frame 5'", () => {
    const d = carousel();
    const a = run(d, addFrame(d, "s3")).doc;
    const b = run(a, addFrame(a, "s4"));
    expect(b.frame).toMatchObject({ id: "s5", name: "5 · Frame 5" });
  });

  it("frames without the s<n> pattern get frame-<n>; a taken id is skipped", () => {
    const d = lux6(); // one frame, 'square'
    expect(nextFrameId(d)).toBe("frame-2");
    expect(nextFrameName(d)).toBe("2 · Frame 2");
    const withTaken = structuredClone(d);
    withTaken.frames[0].children.push({ id: "frame-2", type: "rect", x: 0, y: 0, w: 1, h: 1, fill: "#000000" } as Node);
    expect(run(withTaken, addFrame(withTaken)).frame.id).toBe("frame-3");
  });

  it("a preset (Frames section) sets its own size and guides, keeps the numbering", () => {
    const d = carousel();
    const story = FRAME_PRESETS.find((p) => p.id === "story")!;
    const { frame } = run(d, addFrame(d, "s1", story));
    expect(frame).toMatchObject({ id: "s4", name: "4 · Story", w: 1080, h: 1920, guides: "lane/story-1920", background: { color: "#84A493" } });
  });

  it("refuses past the schema's frame limit", () => {
    const d = carousel();
    for (let i = d.frames.length; i < MAX_FRAMES; i++) d.frames.push({ id: `x${i}`, name: `x${i}`, w: 10, h: 10, children: [] });
    expect(addFrame(d)).toEqual({ error: `A post can have at most ${MAX_FRAMES} frames` });
    expect(duplicateFrame(d, "s1")).toEqual({ error: `A post can have at most ${MAX_FRAMES} frames` });
  });

  it("a motion project stays valid; the new frame has no animation", () => {
    const d = carousel();
    d.motion = { duration: 3000, fps: 30 };
    const { doc, frame } = run(d, addFrame(d, "s1"));
    expect(doc.motion).toEqual({ duration: 3000, fps: 30 });
    expect(frame.children).toEqual([]);
  });
});

describe("Duplicate frame", () => {
  it("copies every layer right after the frame, with fresh unique ids; names, roles and styles kept", () => {
    const d = carousel();
    const src = d.frames[0];
    const { doc, frame } = run(d, duplicateFrame(d, "s1"));
    expect(doc.frames.map((f) => f.id)).toEqual(["s1", "s1-copy", "s2", "s3"]);
    expect(frame).toMatchObject({ name: "1 · Насловна (copy)", w: 1080, h: 1350, background: { color: "#84A493" }, guides: "lane/li-1350" });
    const all = ids(doc);
    expect(new Set(all).size).toBe(all.length);
    const before = nodes(src);
    const after = nodes(frame);
    expect(after.length).toBe(before.length);
    const old = new Set(ids(d));
    after.forEach((n, i) => {
      expect(old.has(n.id)).toBe(false);
      expect(n.id.startsWith(before[i].id.replace(/_[a-z0-9]{4}$/, ""))).toBe(true);
      const { id: _a, pins: _p, ...rest } = before[i] as Node & { children?: Node[] };
      const { id: _b, ...copy } = n as Node & { children?: Node[] };
      if (rest.children) {
        delete rest.children;
        delete copy.children;
      }
      if ((rest as Node).accent === undefined && (copy as Node).accent === true) delete (copy as Node).accent;
      expect(copy).toEqual(rest);
    });
    // The original is untouched.
    expect(doc.frames[0]).toEqual(src);
  });

  it("pins stay on the original; the accent group stays the copy's accent object; keyframes come along", () => {
    const d = carousel();
    const kids = d.frames[0].children;
    kids[0].pins = ["*"];
    kids.push({ id: "accent", type: "group", x: 0, y: 0, w: 10, h: 10, children: [{ id: "dot", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#AC1922" }] } as unknown as Node);
    d.motion = { duration: 2000, fps: 30 };
    kids[1].anim = { tracks: { opacity: { in1: { t: 0, v: 0 }, in2: { t: 400, v: 1, ease: "out" } } } };
    const { frame } = run(d, duplicateFrame(d, "s1"));
    expect(frame.children[0].pins).toBeUndefined();
    expect(d.frames[0].children[0].pins).toEqual(["*"]);
    const acc = frame.children[frame.children.length - 1] as GroupNode;
    expect(acc.id).not.toBe("accent");
    expect(acc.accent).toBe(true);
    expect(frame.children[1].anim).toEqual(kids[1].anim);
  });

  it("a second copy of the same frame gets '-copy-2'; an unknown frame is an error", () => {
    const d = carousel();
    const a = run(d, duplicateFrame(d, "s2")).doc;
    expect(run(a, duplicateFrame(a, "s2")).frame.id).toBe("s2-copy-2");
    expect(duplicateFrame(d, "nope")).toEqual({ error: "Frame 'nope' not found" });
  });
});

describe("moving frames on the canvas (frame.canvas)", () => {
  it("without any moved frame the row is exactly the old side-by-side layout", () => {
    const d = carousel();
    expect([...frameOffsets(d)]).toEqual([
      ["s1", { x: 0, y: 0 }],
      ["s2", { x: 1080 + FRAME_GAP, y: 0 }],
      ["s3", { x: 2 * (1080 + FRAME_GAP), y: 0 }],
    ]);
  });

  it("a drag writes every frame's spot in one batch, so the others stay put; undo restores the row", () => {
    const d = carousel();
    const before = frameOffsets(d);
    const c = moveFrame(d, "s2", 300.4, 1600.6);
    if ("error" in c) throw new Error(c.error);
    expect(c.ops).toHaveLength(3);
    const r = apply(d, c.ops);
    expect(validateStructure(r.doc).ok).toBe(true);
    const after = frameOffsets(r.doc);
    expect(after.get("s2")).toEqual({ x: 300, y: 1601 });
    expect(after.get("s1")).toEqual(before.get("s1"));
    expect(after.get("s3")).toEqual(before.get("s3"));
    expect(apply(r.doc, r.inverse).doc).toEqual(d);
    // A second drag only writes the frame that moved.
    const c2 = moveFrame(r.doc, "s3", 0, -2000);
    if ("error" in c2) throw new Error(c2.error);
    expect(c2.ops).toEqual([{ op: "set", node: "s3", path: "canvas", value: { x: 0, y: -2000 } }]);
    expect(moveFrame(d, "nope", 0, 0)).toEqual({ error: "Frame 'nope' not found" });
  });

  it("frames without a spot (+ Frame, an agent's frame add) land to the right of everything", () => {
    const d = carousel();
    d.frames[0].canvas = { x: 5000, y: 3000 };
    const o = frameOffsets(d);
    expect(o.get("s1")).toEqual({ x: 5000, y: 3000 });
    expect(o.get("s2")).toEqual({ x: 6080 + FRAME_GAP, y: 0 });
    expect(o.get("s3")).toEqual({ x: 6080 + FRAME_GAP + 1080 + FRAME_GAP, y: 0 });
    const added = run(d, addFrame(d, "s1"));
    expect(added.frame.canvas).toBeUndefined();
    const dup = run(d, duplicateFrame(d, "s1"));
    expect(dup.frame.canvas).toBeUndefined();
  });

  it("snaps to the other frames' edges and to the row gap", () => {
    const d = carousel();
    // Near the right edge of s1 plus the gap, and near s1's top.
    expect(snapFramePosition(d, "s3", { x: 1080 + FRAME_GAP + 4, y: -3 }, 6)).toEqual({ x: 1080 + FRAME_GAP, y: 0 });
    // Below s1: its bottom + gap.
    expect(snapFramePosition(d, "s3", { x: 2, y: 1350 + FRAME_GAP - 5 }, 6)).toEqual({ x: 0, y: 1350 + FRAME_GAP });
    // Far from everything: unchanged.
    expect(snapFramePosition(d, "s3", { x: 777, y: 4444 }, 6)).toEqual({ x: 777, y: 4444 });
  });

  it("is not a design change: no diff line, no soft pin", () => {
    const d = carousel();
    const c = moveFrame(d, "s2", 100, 2000);
    if ("error" in c) throw new Error(c.error);
    const moved = apply(d, c.ops).doc;
    expect(diffDocs(d, moved).items).toEqual([]);
    expect(softPinsFromRevisions([{ rev: 2, author: "human", ops: c.ops }])).toEqual([]);
    // A real change next to it still is one.
    const renamed = apply(moved, [{ op: "set", node: "s2", path: "name", value: "2 · Нов" }]).doc;
    expect(diffDocs(d, renamed).items.map((i) => i.changes.map((x) => x.path))).toEqual([["name"]]);
  });
});
