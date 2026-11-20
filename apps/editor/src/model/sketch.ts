// Hand-drawn shapes (node.sketch) in the editor: the ops behind the desktop "Hand-drawn" section
// and the phone sheet. Rendering is packages/render/src/sketch.ts (same code as the export).
import { findItem, type Document, type Frame, type Node, type Sketch } from "@post-studio/schema";
import { Batch, type Command } from "./commands.ts";

export type SketchableNode = Extract<Node, { type: "rect" | "ellipse" | "line" | "path" }>;

export const isSketchable = (n: Node | undefined): n is SketchableNode => !!n && (n.type === "rect" || n.type === "ellipse" || n.type === "line" || n.type === "path");

/** What "Hand-drawn" on writes: the hachure look; every other option keeps its default. */
export const SKETCH_ON: Sketch = { fill: "hachure" };

export type SketchKey = keyof Sketch;

function nodesOf(doc: Document, ids: string[]): SketchableNode[] {
  return ids.map((id) => findItem(doc, id)?.item as Node | undefined).filter(isSketchable);
}

/** Switch the hand-drawn look on (keeping a node's own settings) or off for these layers. */
export function setSketchOn(doc: Document, ids: string[], on: boolean, preset: Sketch = SKETCH_ON): Command {
  const b = new Batch(doc);
  const ns = nodesOf(doc, ids);
  for (const n of ns) {
    if (on && !n.sketch) b.set(n.id, "sketch", { ...preset });
    else if (!on && n.sketch) b.unset(n.id, "sketch");
  }
  return b.done(on ? `hand-drawn ${label(ns)}` : `not hand-drawn: ${label(ns)}`);
}

/**
 * One option on every layer (undefined = back to the default). A layer that is not hand-drawn
 * yet becomes hand-drawn with that option.
 */
export function setSketchOption<K extends SketchKey>(doc: Document, ids: string[], key: K, value: Sketch[K] | undefined): Command {
  const b = new Batch(doc);
  const ns = nodesOf(doc, ids);
  for (const n of ns) {
    if (!n.sketch) {
      if (value !== undefined) b.set(n.id, "sketch", { ...SKETCH_ON, [key]: value });
    } else if (value === undefined) {
      if (n.sketch[key] !== undefined) b.unset(n.id, `sketch.${key}`);
    } else if (n.sketch[key] !== value) b.set(n.id, `sketch.${key}`, value);
  }
  return b.done(`hand-drawn ${key} ${value ?? "default"} on ${label(ns)}`);
}

/**
 * The phone's one-tap look: these layers become hand-drawn with `look` (fill kind, roughness)
 * on top of their own settings; one revision.
 */
export function sketchLook(doc: Document, ids: string[], look: Sketch): Command {
  const b = new Batch(doc);
  const ns = nodesOf(doc, ids);
  for (const n of ns) {
    const next: Sketch = { ...(n.sketch ?? SKETCH_ON), ...look };
    if (next.fill === undefined) next.fill = "hachure";
    b.set(n.id, "sketch", next);
  }
  return b.done(`hand-drawn ${look.fill ?? "hachure"} on ${label(ns)}`);
}

/** A new random look: a fresh seed per layer (from `rnd`, so tests can pin it). */
export function reseedSketch(doc: Document, ids: string[], rnd: () => number = Math.random): Command {
  const b = new Batch(doc);
  const ns = nodesOf(doc, ids).filter((n) => n.sketch);
  for (const n of ns) b.set(n.id, "sketch.seed", Math.floor(rnd() * 2_147_483_647));
  return b.done(`new hand-drawn look on ${label(ns)}`);
}

/** Every option back to its default; the fill kind and the seed (the drawn look) stay. */
export function resetSketch(doc: Document, ids: string[]): Command {
  const b = new Batch(doc);
  const ns = nodesOf(doc, ids).filter((n) => n.sketch);
  for (const n of ns) {
    const keep: Sketch = { fill: n.sketch!.fill ?? "hachure" };
    if (n.sketch!.seed !== undefined) keep.seed = n.sketch!.seed;
    b.set(n.id, "sketch", keep);
  }
  return b.done(`hand-drawn defaults on ${label(ns)}`);
}

function label(ns: Node[]): string {
  return ns.length === 1 ? ns[0].id : `${ns.length} layers`;
}

/**
 * Shapes of a frame the phone offers for the hand-drawn look: rect / ellipse / line / path,
 * visible, not locked (nor inside a locked or hidden group), and not a background (a layer that
 * covers 90 % or more of the frame).
 */
export function sketchCandidates(frame: Frame): SketchableNode[] {
  const out: SketchableNode[] = [];
  const area = frame.w * frame.h;
  const walk = (ns: Node[], ox: number, oy: number) => {
    for (const n of ns) {
      if (n.visible === false || n.locked) continue;
      if (n.type === "group") walk(n.children, ox + n.x, oy + n.y);
      else if (isSketchable(n)) {
        const x0 = Math.max(0, ox + Math.min(n.x, n.x + n.w)), x1 = Math.min(frame.w, ox + Math.max(n.x, n.x + n.w));
        const y0 = Math.max(0, oy + Math.min(n.y, n.y + n.h)), y1 = Math.min(frame.h, oy + Math.max(n.y, n.y + n.h));
        const cover = (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / area;
        if (cover < 0.9) out.push(n);
      }
    }
  };
  walk(frame.children, 0, 0);
  return out;
}
