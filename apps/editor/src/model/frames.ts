// Frames (slides of a carousel): add the next one, duplicate one. Pure: document in, one op
// batch out, so the store commits it like every other edit (one revision, one undo step).
import { walk, type Document, type Frame, type Node } from "@post-studio/schema";
import type { Op } from "@post-studio/ops";
import { allIds, cloneWithNewIds, type Command } from "./commands.ts";
import type { FramePreset } from "./guides.ts";

/** The schema's limit on frames per document. */
export const MAX_FRAMES = 50;

/** First free id among `<stem><n>`, `<stem><n+1>`, … (frames share the id space with layers). */
function freeId(taken: Set<string>, stem: string, start: number): string {
  for (let i = start; ; i++) {
    const id = `${stem}${i}`.slice(0, 64);
    if (!taken.has(id)) return id;
  }
}

/** Id for the next frame: `s5` when the frames are `s1 … s4` (agent carousels), else `frame-5`. */
export function nextFrameId(doc: Document, taken: Set<string> = allIds(doc)): string {
  const n = doc.frames.length + 1;
  return freeId(taken, doc.frames.some((f) => /^s\d+$/.test(f.id)) ? "s" : "frame-", n);
}

/** "5 · Frame 5" (or "5 · Story" for a preset): numbered like his carousel frames ("1 · Насловна", …). */
export function nextFrameName(doc: Document, label?: string): string {
  const n = doc.frames.length + 1;
  return `${n} · ${label ?? `Frame ${n}`}`;
}

/**
 * A new empty frame at the end, the same size, background and guides as `like` (the active
 * frame, else the last one). A preset (Frames section: Instagram square, LinkedIn, Story) sets
 * its own size and guides instead.
 */
export function addFrame(doc: Document, like?: string, preset?: FramePreset): (Command & { frame: string }) | { error: string } {
  if (doc.frames.length >= MAX_FRAMES) return { error: `A post can have at most ${MAX_FRAMES} frames` };
  const ref = doc.frames.find((f) => f.id === like) ?? doc.frames[doc.frames.length - 1];
  const id = nextFrameId(doc);
  const name = nextFrameName(doc, preset?.name);
  const guides = preset ? preset.guides : ref.guides;
  const frame: Frame = {
    id,
    name,
    w: preset?.w ?? ref.w,
    h: preset?.h ?? ref.h,
    ...(ref.background !== undefined ? { background: structuredClone(ref.background) } : {}),
    ...(guides !== undefined ? { guides } : {}),
    children: [],
  };
  return { ops: [{ op: "frame", action: "add", frame }], label: `add frame ${name}`, frame: id };
}

/** Accent group by id (`<g id="accent">`) loses that id in a copy: keep it the accent object. */
function keepAccent(orig: Node, copy: Node) {
  if (orig.type === "group" && orig.id === "accent" && copy.accent === undefined) copy.accent = true;
  if (orig.type === "group" && copy.type === "group") orig.children.forEach((c, i) => keepAccent(c, copy.children[i]));
}

/**
 * A copy of a frame with all its layers right after it. Every layer gets a fresh id; names,
 * roles, styles and keyframes are kept, pins are not (they are his decisions on the original).
 */
export function duplicateFrame(doc: Document, frameId: string): (Command & { frame: string }) | { error: string } {
  const index = doc.frames.findIndex((f) => f.id === frameId);
  if (index < 0) return { error: `Frame '${frameId}' not found` };
  if (doc.frames.length >= MAX_FRAMES) return { error: `A post can have at most ${MAX_FRAMES} frames` };
  const src = doc.frames[index];
  const taken = new Set([...walk(doc)].map((l) => l.id));
  const stem = `${src.id.slice(0, 52)}-copy`;
  const id = taken.has(stem) ? freeId(taken, `${stem}-`, 2) : stem;
  taken.add(id);
  const children = src.children.map((c) => {
    const copy = cloneWithNewIds(c, taken);
    keepAccent(c, copy);
    return copy;
  });
  const name = `${src.name.length > 190 ? src.name.slice(0, 190) : src.name} (copy)`;
  const frame: Frame = {
    id,
    name,
    w: src.w,
    h: src.h,
    ...(src.background !== undefined ? { background: structuredClone(src.background) } : {}),
    ...(src.guides !== undefined ? { guides: src.guides } : {}),
    children,
  };
  return { ops: [{ op: "frame", action: "add", frame, index: index + 1 }], label: `duplicate frame ${src.name}`, frame: id };
}

// ---------------------------------------------------------------- where frames sit on the canvas

/** Space between frames in the automatic row. */
export const FRAME_GAP = 160;

/**
 * Top-left of every frame on the editor canvas (world px). A frame with `canvas` (he dragged it)
 * sits there. The others keep the automatic row: in document order, each one to the right of
 * everything placed so far, top at 0. A document where no frame was ever moved therefore gets
 * exactly the old side-by-side row, and a new frame (+ Frame, an agent's `frame add`) lands to
 * the right of everything.
 */
export function frameOffsets(doc: Document): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  let right = -Infinity;
  for (const f of doc.frames) {
    if (!f.canvas) continue;
    out.set(f.id, { x: f.canvas.x, y: f.canvas.y });
    right = Math.max(right, f.canvas.x + f.w);
  }
  for (const f of doc.frames) {
    if (f.canvas) continue;
    const x = right === -Infinity ? 0 : right + FRAME_GAP;
    out.set(f.id, { x, y: 0 });
    right = x + f.w;
  }
  return out;
}

/**
 * Drag a frame to (x, y) on the canvas. The positions of all frames are written down at once
 * (frames still in the automatic row get their current spot), so nothing else jumps when one
 * frame leaves the row. One batch = one revision = one undo step; undo puts the old layout back.
 */
export function moveFrame(doc: Document, frameId: string, x: number, y: number): Command | { error: string } {
  const f = doc.frames.find((fr) => fr.id === frameId);
  if (!f) return { error: `Frame '${frameId}' not found` };
  const offs = frameOffsets(doc);
  const ops: Op[] = [];
  for (const fr of doc.frames) {
    const o = fr.id === frameId ? { x: Math.round(x), y: Math.round(y) } : offs.get(fr.id)!;
    if (fr.canvas && fr.canvas.x === o.x && fr.canvas.y === o.y) continue;
    ops.push({ op: "set", node: fr.id, path: "canvas", value: { x: o.x, y: o.y } });
  }
  return { ops, label: `move frame ${f.name} on the canvas` };
}

/**
 * Snap a dragged frame's top-left to the other frames: left / right edges and the row gap
 * horizontally, top / bottom edges vertically. `thr` is in world px.
 */
export function snapFramePosition(doc: Document, frameId: string, p: { x: number; y: number }, thr: number): { x: number; y: number } {
  const f = doc.frames.find((fr) => fr.id === frameId);
  if (!f) return p;
  const offs = frameOffsets(doc);
  let bx: { d: number; v: number } | undefined;
  let by: { d: number; v: number } | undefined;
  const tryX = (target: number, mine: number) => {
    const d = Math.abs(target - (p.x + mine));
    if (d <= thr && (!bx || d < bx.d)) bx = { d, v: target - mine };
  };
  const tryY = (target: number, mine: number) => {
    const d = Math.abs(target - (p.y + mine));
    if (d <= thr && (!by || d < by.d)) by = { d, v: target - mine };
  };
  for (const o of doc.frames) {
    if (o.id === frameId) continue;
    const q = offs.get(o.id)!;
    for (const mine of [0, f.w]) for (const t of [q.x, q.x + o.w]) tryX(t, mine);
    tryX(q.x + o.w + FRAME_GAP, 0);
    tryX(q.x - FRAME_GAP, f.w);
    for (const mine of [0, f.h]) for (const t of [q.y, q.y + o.h]) tryY(t, mine);
    tryY(q.y + o.h + FRAME_GAP, 0);
    tryY(q.y - FRAME_GAP, f.h);
  }
  return { x: bx ? bx.v : p.x, y: by ? by.v : p.y };
}
