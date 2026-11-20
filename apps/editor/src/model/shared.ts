// Editing several selected layers at once (Figma-style shared properties). The field list and the
// plain ops live in packages/ops (shared.ts, also used by `pstudio ops set`); this file adds what
// only the editor knows: text boxes that follow a new size or font, a font's available weights,
// alignment and spacing on the canvas. Every function returns ONE command = one revision = one undo.
import { setFieldOps, sharedFields, sharedValue, typeCounts, type FieldKey, type SharedField } from "@post-studio/ops";
import type { Document, Node, NodeType, TextNode } from "@post-studio/schema";
import { Batch, fitText, getNode, setNodeBox, topmost, type Command } from "./commands.ts";
import { applyVec, inv, nodeAabb, nodeBox, parentMatrix, r2, unionBoxes, type Box, type TextBoxFn } from "./geometry.ts";
import { colorName, type Color } from "./brand.ts";

export { sharedFields, sharedValue, typeCounts, type FieldKey, type SharedField };

/** The node types as the panel names them. */
export const TYPE_LABEL: Record<NodeType, [string, string]> = {
  text: ["text", "texts"],
  rect: ["rectangle", "rectangles"],
  ellipse: ["ellipse", "ellipses"],
  line: ["line", "lines"],
  path: ["shape", "shapes"],
  image: ["image", "images"],
  svg: ["SVG art", "SVG art"],
  group: ["group", "groups"],
};

export function countLabel(n: number, type: NodeType): string {
  return `${n} ${TYPE_LABEL[type][n === 1 ? 0 : 1]}`;
}

const nameOf = (doc: Document, ids: string[]) => {
  if (ids.length !== 1) return `${ids.length} layers`;
  const n = getNode(doc, ids[0]);
  return n?.name && n.name !== n.id ? n.name : ids[0];
};

function valueText(key: FieldKey, v: unknown): string {
  if (v === undefined) return "default";
  if (v === null) return "none";
  if (key === "fill" || key === "stroke.color") return colorName(v as Color);
  if (key === "opacity") return `${Math.round((v as number) * 1000) / 10}%`;
  return String(v);
}

/**
 * One field on every given layer that has it (layers without it are left alone). Text layers keep
 * their box in line with the new layout (auto width grows, fixed width gets its new height).
 * `weightsFor` gives the weights a family has: a new font keeps each text's weight when the
 * family has it, else the nearest; a new weight snaps per text to its own family's nearest weight.
 */
export function setShared(doc: Document, ids: string[], key: FieldKey, value: unknown, tb: TextBoxFn, weightsFor?: (family: string) => number[]): Command {
  const b = new Batch(doc);
  const texts = new Map<string, TextNode>();
  for (const id of ids) {
    const n = getNode(doc, id);
    if (n?.type === "text") texts.set(id, n);
  }
  if (key === "font" && weightsFor) {
    const ws = weightsFor(value as string);
    for (const n of texts.values()) {
      if (n.style.font === value) continue;
      const w = ws.length && !ws.includes(n.style.weight) ? ws.reduce((a, c) => (Math.abs(c - n.style.weight) < Math.abs(a - n.style.weight) ? c : a)) : n.style.weight;
      b.set(n.id, "style", { ...n.style, font: value as string, weight: w });
      // Bold words in a weight the new family does not have fall back to the text's weight.
      const spans = n.spans.map((sp) => (sp.weight !== undefined && ws.length && !ws.includes(sp.weight) ? { ...sp, weight: undefined } : sp)).map((sp) => JSON.parse(JSON.stringify(sp)));
      b.set(n.id, "spans", spans);
    }
  } else if (key === "weight" && weightsFor) {
    const want = value as number;
    for (const n of texts.values()) {
      const ws = weightsFor(n.style.font);
      const w = !ws.length || ws.includes(want) ? want : ws.reduce((a, c) => (Math.abs(c - want) < Math.abs(a - want) ? c : a));
      b.set(n.id, "style.weight", w);
    }
  } else {
    for (const op of setFieldOps(doc, ids, key, value)) b.push(op);
  }
  if (LAYOUT_KEYS.has(key)) for (const [id, before] of texts) fitText(b, id, before, tb);
  return b.done(`${fieldWord(key)} ${valueText(key, value)} on ${nameOf(doc, ids)}`);
}

/** Fields that change how a text is laid out (its box follows). */
const LAYOUT_KEYS = new Set<FieldKey>(["font", "weight", "size", "lineHeight", "letterSpacing", "box", "align"]);

function fieldWord(key: FieldKey): string {
  return { opacity: "opacity", rotation: "rotation", fill: "fill", radius: "radius", "stroke.color": "stroke", "stroke.width": "stroke width", font: "font", weight: "weight", size: "size", lineHeight: "line height", letterSpacing: "letter spacing", align: "align", box: "box", fit: "fit" }[key];
}

/** Several fields at once (the phone sheet's Apply): still one command. */
export function setSharedMany(doc: Document, ids: string[], changes: Array<[FieldKey, unknown]>, tb: TextBoxFn, weightsFor?: (family: string) => number[]): Command {
  let cur = doc;
  const ops: Command["ops"] = [];
  const words: string[] = [];
  for (const [k, v] of changes) {
    const c = setShared(cur, ids, k, v, tb, weightsFor);
    if (!c.ops.length) continue;
    const b = new Batch(cur);
    for (const op of c.ops) b.push(op);
    cur = b.doc;
    ops.push(...c.ops);
    words.push(`${fieldWord(k)} ${valueText(k, v)}`);
  }
  return { ops, label: `${words.join(", ") || "no change"} on ${nameOf(doc, ids)}` };
}

// ---------------------------------------------------------------- size

/** The same width (or height) on every layer; each keeps its own top-left corner. Lines are skipped. */
export function setSharedSize(doc: Document, ids: string[], dim: "w" | "h", value: number, tb: TextBoxFn): Command {
  const b = new Batch(doc);
  const top = topmost(doc, ids);
  for (const id of top) {
    const n = b.node(id);
    if (!n || n.type === "line") continue;
    const box = nodeBox(n, tb);
    if (Math.abs(box[dim] - value) < 0.005) continue;
    setNodeBox(b, id, { ...box, [dim]: Math.max(0, value) }, tb);
  }
  return b.done(`${dim === "w" ? "width" : "height"} ${r2(value)} on ${nameOf(doc, top)}`);
}

/** Width / height of each layer (lines left out) as the panel shows it. */
export function sizeValues(nodes: Node[], tb: TextBoxFn, dim: "w" | "h"): number[] {
  return nodes.filter((n) => n.type !== "line").map((n) => r2(nodeBox(n, tb)[dim]));
}

// ---------------------------------------------------------------- align / distribute

export type AlignHow = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/**
 * Line the layers up on the box around all of them (Figma's align), or with one layer, on its frame.
 * Moves happen in frame space, so layers inside rotated or moved groups line up where they are drawn.
 */
export function alignNodes(doc: Document, ids: string[], how: AlignHow, tb: TextBoxFn, frameBox?: Box): Command {
  const b = new Batch(doc);
  const top = topmost(doc, ids);
  const boxes = top.map((id) => [id, nodeAabb(doc, getNode(doc, id)!, tb)] as const);
  if (!boxes.length) return b.done("align");
  const ref = top.length === 1 && frameBox ? frameBox : unionBoxes(boxes.map(([, x]) => x));
  for (const [id, box] of boxes) {
    let dx = 0, dy = 0;
    if (how === "left") dx = ref.x - box.x;
    else if (how === "right") dx = ref.x + ref.w - (box.x + box.w);
    else if (how === "hcenter") dx = ref.x + ref.w / 2 - (box.x + box.w / 2);
    else if (how === "top") dy = ref.y - box.y;
    else if (how === "bottom") dy = ref.y + ref.h - (box.y + box.h);
    else dy = ref.y + ref.h / 2 - (box.y + box.h / 2);
    moveBy(b, doc, id, dx, dy);
  }
  return b.done(`align ${how === "hcenter" ? "centre" : how === "vcenter" ? "middle" : how} ${nameOf(doc, top)}`);
}

/** Equal gaps between three or more layers, left to right (h) or top to bottom (v); the outer two stay. */
export function distributeNodes(doc: Document, ids: string[], axis: "h" | "v", tb: TextBoxFn): Command {
  const b = new Batch(doc);
  const top = topmost(doc, ids);
  const boxes = top.map((id) => ({ id, box: nodeAabb(doc, getNode(doc, id)!, tb) }));
  if (boxes.length < 3) return b.done("distribute");
  const lo = (x: Box) => (axis === "h" ? x.x : x.y);
  const len = (x: Box) => (axis === "h" ? x.w : x.h);
  boxes.sort((p, q) => lo(p.box) - lo(q.box));
  const first = boxes[0].box, last = boxes[boxes.length - 1].box;
  const span = lo(last) + len(last) - lo(first);
  const total = boxes.reduce((s, x) => s + len(x.box), 0);
  const gap = (span - total) / (boxes.length - 1);
  let at = lo(first) + len(first) + gap;
  for (const x of boxes.slice(1, -1)) {
    const d = at - lo(x.box);
    moveBy(b, doc, x.id, axis === "h" ? d : 0, axis === "v" ? d : 0);
    at += len(x.box) + gap;
  }
  return b.done(`space ${nameOf(doc, top)} evenly ${axis === "h" ? "across" : "down"}`);
}

function moveBy(b: Batch, doc: Document, id: string, dx: number, dy: number) {
  if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) return;
  const n = b.node(id);
  if (!n) return;
  const d = applyVec(inv(parentMatrix(doc, id)), { x: dx, y: dy });
  b.set(id, "x", r2(n.x + d.x));
  b.set(id, "y", r2(n.y + d.y));
}

// ---------------------------------------------------------------- phone

/**
 * The phone's "Edit together" refuses layers he cannot change there: locked or hidden ones, and
 * layers inside a locked or hidden group (the same rule as its text edits).
 */
export function phoneEditable(doc: Document, ids: string[]): { ok: string[]; blocked: Array<{ id: string; reason: string }> } {
  const ok: string[] = [];
  const blocked: Array<{ id: string; reason: string }> = [];
  for (const id of [...new Set(ids)]) {
    const n = getNode(doc, id);
    if (!n) continue;
    const why = n.locked ? "locked" : n.visible === false ? "hidden" : ancestorBlock(doc, id);
    if (why) blocked.push({ id, reason: why });
    else ok.push(id);
  }
  return { ok, blocked };
}

function ancestorBlock(doc: Document, id: string): string | undefined {
  for (const f of doc.frames) {
    const path: Node[] = [];
    const find = (ns: Node[]): boolean => {
      for (const n of ns) {
        if (n.id === id) return true;
        if (n.type === "group") {
          path.push(n);
          if (find(n.children)) return true;
          path.pop();
        }
      }
      return false;
    };
    if (find(f.children)) {
      const g = path.find((p) => p.locked || p.visible === false);
      return g ? `inside the ${g.locked ? "locked" : "hidden"} group ${g.name ?? g.id}` : undefined;
    }
  }
  return undefined;
}
