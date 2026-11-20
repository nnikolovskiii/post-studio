// Editor commands → op batches (packages/ops). Every user action becomes one batch with a short
// label (the revision message). A Batch applies its ops to a working copy as they are written,
// so later ops in the same batch see the earlier ones (z-order, group, ungroup).
import { applyOne, type Op } from "@post-studio/ops";
import { findItem, isContainer, subtreeIds, walk, type Document, type Frame, type Node, type TextNode } from "@post-studio/schema";
import {
  aabb,
  apply as applyPt,
  applyVec,
  corners,
  groupChildMatrix,
  IDENTITY,
  inv,
  mul,
  nodeBox,
  ownMatrix,
  parentMatrix,
  r2,
  unionBoxes,
  type Box,
  type Mat,
  type Pt,
  type TextBoxFn,
} from "./geometry.ts";
import type { Span } from "./richtext.ts";

export interface Command {
  ops: Op[];
  label: string;
}

export class Batch {
  readonly ops: Op[] = [];
  readonly doc: Document;
  constructor(doc: Document) {
    this.doc = structuredClone(doc);
  }
  push(op: Op): this {
    applyOne(this.doc, op);
    this.ops.push(op);
    return this;
  }
  /** set, skipped when the value is already equal. */
  set(node: string, path: string, value: unknown): this {
    const loc = findItem(this.doc, node);
    const cur = loc ? path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), loc.item) : undefined;
    if (JSON.stringify(cur) === JSON.stringify(value)) return this;
    return this.push({ op: "set", node, path, value });
  }
  unset(node: string, path: string): this {
    const loc = findItem(this.doc, node);
    const parts = path.split(".");
    const parent = loc ? parts.slice(0, -1).reduce<any>((o, k) => (o == null ? undefined : o[k]), loc.item) : undefined;
    if (!parent || !(parts[parts.length - 1] in parent)) return this;
    return this.push({ op: "unset", node, path });
  }
  node(id: string): Node | undefined {
    const loc = findItem(this.doc, id);
    return loc?.kind === "node" ? (loc.item as Node) : undefined;
  }
  done(label: string): Command {
    return { ops: this.ops, label };
  }
}

// ---------------------------------------------------------------- ids

const ID_SUFFIX = /_[a-z0-9]{4}$/;

/** A readable id that is not in the document: `<base>_<4 random>`. */
export function newId(doc: Document | Set<string>, base: string, rand: () => number = Math.random): string {
  const taken = doc instanceof Set ? doc : new Set([...walk(doc)].map((l) => l.id));
  const stem = (base.replace(ID_SUFFIX, "").replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "node").slice(0, 50);
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  for (;;) {
    let s = "";
    for (let i = 0; i < 4; i++) s += abc[Math.floor(rand() * abc.length)];
    const id = `${stem}_${s}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/** Deep copy of a subtree with fresh ids (names, roles and meta kept). */
export function cloneWithNewIds(node: Node, taken: Set<string>): Node {
  const copy = structuredClone(node) as Node;
  const re = (n: Node) => {
    n.id = newId(taken, n.id);
    delete n.pins;
    if (n.type === "group") n.children.forEach(re);
  };
  re(copy);
  return copy;
}

export function allIds(doc: Document): Set<string> {
  return new Set([...walk(doc)].map((l) => l.id));
}

// ---------------------------------------------------------------- helpers

export function getNode(doc: Document, id: string): Node | undefined {
  const loc = findItem(doc, id);
  return loc?.kind === "node" ? (loc.item as Node) : undefined;
}

/** Drop ids whose ancestor is also selected (moving a group moves its children). */
export function topmost(doc: Document, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let loc = findItem(doc, id);
    while (loc && loc.kind === "node") {
      const parent = findItem(doc, loc.parent);
      if (!parent || parent.kind !== "node") break;
      if (set.has(parent.id)) return false;
      loc = parent;
    }
    return !!findItem(doc, id);
  });
}

const label1 = (doc: Document, ids: string[], verb: string) => {
  const n = ids.length === 1 ? getNode(doc, ids[0]) : undefined;
  return n ? `${verb} ${n.name && n.name !== n.id ? n.name : n.id}` : `${verb} ${ids.length} layers`;
};

// ---------------------------------------------------------------- move / nudge

/** Move by a frame-space delta. Each node's parent may be translated or rotated. */
export function moveNodes(doc: Document, ids: string[], dx: number, dy: number, verb = "move"): Command {
  const b = new Batch(doc);
  const top = topmost(doc, ids);
  for (const id of top) {
    const n = b.node(id);
    if (!n) continue;
    const d = applyVec(inv(parentMatrix(doc, id)), { x: dx, y: dy });
    b.set(id, "x", r2(n.x + d.x));
    b.set(id, "y", r2(n.y + d.y));
  }
  return b.done(label1(doc, top, verb));
}

// ---------------------------------------------------------------- resize

/** Text box rules when the user resizes: width change → fixed-width; height change → fixed. */
function textResize(b: Batch, n: TextNode, box: Box, textBox: TextBoxFn) {
  const cur = textBox(n);
  const wChanged = Math.abs(box.w - cur.w) > 0.01;
  const hChanged = Math.abs(box.h - cur.h) > 0.01;
  b.set(n.id, "x", r2(box.x));
  b.set(n.id, "y", r2(box.y));
  if (hChanged) {
    b.set(n.id, "box", "fixed");
    b.set(n.id, "w", r2(box.w));
    b.set(n.id, "h", r2(box.h));
  } else if (wChanged) {
    if (n.box === "auto-width") b.set(n.id, "box", "fixed-width");
    b.set(n.id, "w", r2(box.w));
    const after = b.node(n.id) as TextNode;
    b.set(n.id, "h", r2(textBox(after).h));
  }
}

/** Scale a subtree's geometry (group resize). Text sizes follow the smaller factor. */
function scaleChildren(b: Batch, children: Node[], sx: number, sy: number, origin: Pt) {
  const fs = Math.min(sx, sy);
  for (const c of children) {
    b.set(c.id, "x", r2(origin.x + (c.x - origin.x) * sx));
    b.set(c.id, "y", r2(origin.y + (c.y - origin.y) * sy));
    if (c.type === "text") {
      if (c.box !== "auto-width") b.set(c.id, "w", r2(c.w * sx));
      if (c.box === "fixed") b.set(c.id, "h", r2(c.h * sy));
      if (Math.abs(fs - 1) > 1e-6) b.set(c.id, "style.size", r2(c.style.size * fs));
    } else if (c.type === "group") {
      b.set(c.id, "w", r2(c.w * sx));
      b.set(c.id, "h", r2(c.h * sy));
      scaleChildren(b, c.children, sx, sy, { x: 0, y: 0 });
    } else {
      b.set(c.id, "w", r2(c.w * sx));
      b.set(c.id, "h", r2(c.h * sy));
    }
  }
}

/** Give one node a new box (parent coordinates, unrotated). */
export function setNodeBox(b: Batch, id: string, box: Box, textBox: TextBoxFn) {
  const n = b.node(id);
  if (!n) return;
  if (n.type === "text") return textResize(b, n, box, textBox);
  if (n.type === "line") {
    // Keep the direction of the line: map its endpoints into the new box.
    const old = nodeBox(n, textBox);
    const fx = (v: number) => (old.w ? (v - old.x) / old.w : 0.5);
    const fy = (v: number) => (old.h ? (v - old.y) / old.h : 0.5);
    const x1 = box.x + fx(n.x) * box.w;
    const y1 = box.y + fy(n.y) * box.h;
    const x2 = box.x + fx(n.x + n.w) * box.w;
    const y2 = box.y + fy(n.y + n.h) * box.h;
    b.set(id, "x", r2(x1)).set(id, "y", r2(y1)).set(id, "w", r2(x2 - x1)).set(id, "h", r2(y2 - y1));
    return;
  }
  if (n.type === "group") {
    const old = nodeBox(n, textBox);
    const sx = old.w ? box.w / old.w : 1;
    const sy = old.h ? box.h / old.h : 1;
    // Children live in the group's space, relative to (x, y); the box offset (if w/h are 0) is kept.
    const offX = old.x - n.x;
    const offY = old.y - n.y;
    b.set(id, "x", r2(box.x - offX * sx));
    b.set(id, "y", r2(box.y - offY * sy));
    if (n.w > 0 || n.h > 0) {
      b.set(id, "w", r2(box.w));
      b.set(id, "h", r2(box.h));
    }
    scaleChildren(b, n.children, sx, sy, { x: 0, y: 0 });
    return;
  }
  b.set(id, "x", r2(box.x)).set(id, "y", r2(box.y)).set(id, "w", r2(Math.max(0, box.w))).set(id, "h", r2(Math.max(0, box.h)));
}

export function resizeNode(doc: Document, id: string, box: Box, textBox: TextBoxFn): Command {
  const b = new Batch(doc);
  setNodeBox(b, id, box, textBox);
  return b.done(label1(doc, [id], "resize"));
}

/** Several nodes: scale positions and sizes from `from` (frame-space selection box) to `to`. */
export function resizeMany(doc: Document, ids: string[], from: Box, to: Box, textBox: TextBoxFn): Command {
  const b = new Batch(doc);
  const sx = from.w ? to.w / from.w : 1;
  const sy = from.h ? to.h / from.h : 1;
  const top = topmost(doc, ids);
  for (const id of top) {
    const n = b.node(id);
    if (!n) continue;
    const pm = parentMatrix(doc, id);
    const box = nodeBox(n, textBox);
    // Box centre in frame space → scaled → back into parent space.
    const c = applyPt(pm, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
    const nc = applyPt(inv(pm), { x: to.x + (c.x - from.x) * sx, y: to.y + (c.y - from.y) * sy });
    const w = box.w * sx;
    const h = box.h * sy;
    setNodeBox(b, id, { x: nc.x - w / 2, y: nc.y - h / 2, w, h }, textBox);
  }
  return b.done(label1(doc, top, "resize"));
}

/** Line endpoints in parent coordinates. */
export function setLineEnds(doc: Document, id: string, p1: Pt, p2: Pt): Command {
  const b = new Batch(doc);
  b.set(id, "x", r2(p1.x)).set(id, "y", r2(p1.y)).set(id, "w", r2(p2.x - p1.x)).set(id, "h", r2(p2.y - p1.y));
  return b.done(label1(doc, [id], "reshape"));
}

// ---------------------------------------------------------------- rotate

export function rotateNode(doc: Document, id: string, rotation: number): Command {
  const b = new Batch(doc);
  if (Math.abs(rotation) < 1e-6) b.unset(id, "rotation");
  else b.set(id, "rotation", rotation);
  return b.done(label1(doc, [id], "rotate"));
}

/** Rotate several nodes by `delta` degrees about a frame-space centre. */
export function rotateMany(doc: Document, ids: string[], delta: number, center: Pt, textBox: TextBoxFn): Command {
  const b = new Batch(doc);
  const top = topmost(doc, ids);
  const rad = (delta * Math.PI) / 180;
  for (const id of top) {
    const n = b.node(id);
    if (!n) continue;
    const pm = parentMatrix(doc, id);
    const box = nodeBox(n, textBox);
    const c = applyPt(pm, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
    const rc = { x: center.x + (c.x - center.x) * Math.cos(rad) - (c.y - center.y) * Math.sin(rad), y: center.y + (c.x - center.x) * Math.sin(rad) + (c.y - center.y) * Math.cos(rad) };
    const local = applyPt(inv(pm), rc);
    const dx = local.x - (box.x + box.w / 2);
    const dy = local.y - (box.y + box.h / 2);
    b.set(id, "x", r2(n.x + dx)).set(id, "y", r2(n.y + dy));
    const rot = Math.round(((n.rotation ?? 0) + delta) * 1000) / 1000;
    if (Math.abs(rot % 360) < 1e-6) b.unset(id, "rotation");
    else b.set(id, "rotation", ((((rot + 180) % 360) + 360) % 360) - 180);
  }
  return b.done(label1(doc, top, "rotate"));
}

// ---------------------------------------------------------------- delete / duplicate / paste

export function deleteNodes(doc: Document, ids: string[]): Command {
  const b = new Batch(doc);
  const top = topmost(doc, ids);
  for (const id of top) if (b.node(id)) b.push({ op: "delete", node: id });
  return b.done(label1(doc, top, "delete"));
}

export function duplicateNodes(doc: Document, ids: string[], offset = 20): Command & { created: string[] } {
  const b = new Batch(doc);
  const taken = allIds(doc);
  const created: string[] = [];
  for (const id of topmost(doc, ids)) {
    const loc = findItem(b.doc, id);
    if (!loc || loc.kind !== "node") continue;
    const copy = cloneWithNewIds(loc.item as Node, taken);
    copy.x = r2(copy.x + offset);
    copy.y = r2(copy.y + offset);
    b.push({ op: "insert", parent: loc.parent, index: loc.index + 1, node: copy });
    created.push(copy.id);
  }
  return { ...b.done(label1(doc, ids, "duplicate")), created };
}

/** Clipboard entry: a subtree with its frame-space translation (for pasting into another place). */
export interface ClipItem {
  node: Node;
  /** Frame-space offset of the node's parent space (translation only). */
  parentOffset: Pt;
  frame: string;
}

export function copyNodes(doc: Document, ids: string[]): ClipItem[] {
  return topmost(doc, ids).flatMap((id) => {
    const loc = findItem(doc, id);
    if (!loc || loc.kind !== "node") return [];
    const pm = parentMatrix(doc, id);
    return [{ node: structuredClone(loc.item as Node), parentOffset: { x: pm[4], y: pm[5] }, frame: loc.frame }];
  });
}

/** Paste at the top of `frame`. Copies onto the same frame land 20 px down-right, like duplicate. */
export function pasteNodes(doc: Document, items: ClipItem[], frame: string): Command & { created: string[] } {
  const b = new Batch(doc);
  const taken = allIds(doc);
  const created: string[] = [];
  for (const it of items) {
    const copy = cloneWithNewIds(it.node, taken);
    const shift = it.frame === frame ? 20 : 0;
    copy.x = r2(copy.x + it.parentOffset.x + shift);
    copy.y = r2(copy.y + it.parentOffset.y + shift);
    b.push({ op: "insert", parent: frame, node: copy });
    created.push(copy.id);
  }
  return { ...b.done(items.length === 1 ? `paste ${items[0].node.name ?? items[0].node.id}` : `paste ${items.length} layers`), created };
}

export function insertNode(doc: Document, parent: string, node: Node, index?: number): Command {
  const b = new Batch(doc);
  b.push({ op: "insert", parent, node, ...(index === undefined ? {} : { index }) });
  return b.done(`add ${node.type} ${node.name ?? node.id}`);
}

// ---------------------------------------------------------------- group / ungroup

export function commonParent(doc: Document, ids: string[]): string | undefined {
  const parents = new Set(ids.map((id) => findItem(doc, id)?.parent));
  return parents.size === 1 ? [...parents][0] : undefined;
}

export function groupNodes(doc: Document, ids: string[], textBox: TextBoxFn, groupId?: string): (Command & { group: string }) | { error: string } {
  const top = topmost(doc, ids);
  if (!top.length) return { error: "nothing selected" };
  const parent = commonParent(doc, top);
  if (!parent) return { error: "select layers that share a parent to group them" };
  const container = findItem(doc, parent)!.item as Frame | Extract<Node, { type: "group" }>;
  const ordered = container.children.filter((c) => top.includes(c.id));
  const maxIndex = Math.max(...ordered.map((c) => container.children.indexOf(c)));
  const u = unionBoxes(ordered.map((c) => aabb(corners(nodeBox(c, textBox), ownMatrix(c, textBox)))));
  const id = groupId ?? newId(doc, "group");
  const b = new Batch(doc);
  b.push({ op: "insert", parent, index: maxIndex + 1, node: { id, type: "group", name: "Group", x: r2(u.x), y: r2(u.y), w: r2(u.w), h: r2(u.h), children: [] } });
  ordered.forEach((c, i) => {
    b.push({ op: "move", node: c.id, parent: id, index: i });
    b.set(c.id, "x", r2(c.x - u.x)).set(c.id, "y", r2(c.y - u.y));
  });
  return { ...b.done(`group ${ordered.length} layers`), group: id };
}

export function ungroup(doc: Document, groupId: string, textBox: TextBoxFn): (Command & { children: string[] }) | { error: string } {
  const loc = findItem(doc, groupId);
  if (!loc || loc.kind !== "node" || (loc.item as Node).type !== "group") return { error: "select a group to ungroup" };
  const g = loc.item as Extract<Node, { type: "group" }>;
  const m = groupChildMatrix(g);
  const rot = g.rotation ?? 0;
  const b = new Batch(doc);
  const kids = [...g.children];
  kids.forEach((c, i) => {
    b.push({ op: "move", node: c.id, parent: loc.parent, index: loc.index + 1 + i });
    const box = nodeBox(c, textBox);
    const center = applyPt(m, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
    b.set(c.id, "x", r2(c.x + center.x - (box.x + box.w / 2))).set(c.id, "y", r2(c.y + center.y - (box.y + box.h / 2)));
    if (rot) {
      const r = Math.round(((c.rotation ?? 0) + rot) * 1000) / 1000;
      if (Math.abs(r % 360) < 1e-6) b.unset(c.id, "rotation");
      else b.set(c.id, "rotation", ((((r + 180) % 360) + 360) % 360) - 180);
    }
  });
  if (g.opacity !== undefined && g.opacity !== 1) {
    for (const c of kids) b.set(c.id, "opacity", Math.round((c.opacity ?? 1) * g.opacity * 1000) / 1000);
  }
  b.push({ op: "delete", node: groupId });
  return { ...b.done(`ungroup ${g.name && g.name !== g.id ? g.name : g.id}`), children: kids.map((k) => k.id) };
}

// ---------------------------------------------------------------- z-order

export type ZMove = "forward" | "backward" | "front" | "back";

export function zOrder(doc: Document, ids: string[], how: ZMove): Command {
  const b = new Batch(doc);
  const top = topmost(doc, ids);
  const byParent = new Map<string, string[]>();
  for (const id of top) {
    const p = findItem(doc, id)!.parent;
    byParent.set(p, [...(byParent.get(p) ?? []), id]);
  }
  for (const [parent, list] of byParent) {
    const kids = () => (findItem(b.doc, parent)!.item as Frame).children;
    const idx = (id: string) => kids().findIndex((c) => c.id === id);
    const sorted = [...list].sort((a, z) => idx(a) - idx(z));
    if (how === "front") for (const id of sorted) b.push({ op: "move", node: id, index: kids().length - 1 });
    else if (how === "back") for (const id of [...sorted].reverse()) b.push({ op: "move", node: id, index: 0 });
    else if (how === "forward") {
      for (const id of [...sorted].reverse()) {
        const i = idx(id);
        const next = kids()[i + 1];
        if (next && !list.includes(next.id)) b.push({ op: "move", node: id, index: i + 1 });
      }
    } else {
      for (const id of sorted) {
        const i = idx(id);
        const prev = kids()[i - 1];
        if (prev && !list.includes(prev.id)) b.push({ op: "move", node: id, index: i - 1 });
      }
    }
  }
  const verb = { forward: "bring forward", backward: "send backward", front: "bring to front", back: "send to back" }[how];
  return b.done(label1(doc, top, verb));
}

/** Layers panel drag: put `id` into `parent` at `index` (index in the parent's list after removal). */
export function reorder(doc: Document, id: string, parent: string, index: number, textBox: TextBoxFn): Command | { error: string } {
  const loc = findItem(doc, id);
  const target = findItem(doc, parent);
  if (!loc || loc.kind !== "node" || !target || !isContainer(target.item)) return { error: "cannot move there" };
  if (subtreeIds(loc.item as Node).includes(parent)) return { error: "cannot move a group into itself" };
  const b = new Batch(doc);
  if (loc.parent !== parent) {
    // Keep the node where it is on screen: re-express its position in the new parent's space.
    const n = loc.item as Node;
    const box = nodeBox(n, textBox);
    const center = applyPt(parentMatrix(doc, id), { x: box.x + box.w / 2, y: box.y + box.h / 2 });
    const targetSpace = target.kind === "frame" ? IDENTITY : groupSpace(doc, parent);
    const local = applyPt(inv(targetSpace), center);
    b.push({ op: "move", node: id, parent, index });
    b.set(id, "x", r2(n.x + local.x - (box.x + box.w / 2))).set(id, "y", r2(n.y + local.y - (box.y + box.h / 2)));
  } else {
    if (loc.index === index) return { ops: [], label: "" };
    b.push({ op: "move", node: id, index });
  }
  return b.done(label1(doc, [id], "reorder"));
}

/** Frame-space matrix of a group's child space. */
function groupSpace(doc: Document, groupId: string): Mat {
  const g = getNode(doc, groupId) as Extract<Node, { type: "group" }>;
  return mul(parentMatrix(doc, groupId), groupChildMatrix(g));
}

// ---------------------------------------------------------------- properties and text

/** A set (or unset when value is undefined) on one or more nodes. */
export function setProps(doc: Document, ids: string[], path: string, value: unknown, labelText?: string): Command {
  const b = new Batch(doc);
  for (const id of ids) {
    if (!findItem(doc, id)) continue;
    if (value === undefined) b.unset(id, path);
    else b.set(id, path, value);
  }
  return b.done(labelText ?? label1(doc, ids, `set ${path} on`));
}

/**
 * After a text change (spans, font, size …) keep the stored box in line with the layout:
 * auto-width → w and h follow (anchored by alignment), fixed-width → h follows.
 */
export function fitText(b: Batch, id: string, before: TextNode, textBox: TextBoxFn) {
  const n = b.node(id);
  if (!n || n.type !== "text") return;
  const nb = textBox(n);
  if (n.box === "auto-width") {
    const ob = textBox(before);
    const dx = n.align === "center" ? (ob.w - nb.w) / 2 : n.align === "right" ? ob.w - nb.w : 0;
    if (Math.abs(dx) > 0.004) b.set(id, "x", r2(n.x + dx));
    b.set(id, "w", r2(nb.w));
    b.set(id, "h", r2(nb.h));
  } else if (n.box === "fixed-width") {
    b.set(id, "h", r2(nb.h));
  }
}

export function setTextProps(doc: Document, ids: string[], path: string, value: unknown, textBox: TextBoxFn, labelText?: string): Command {
  const b = new Batch(doc);
  for (const id of ids) {
    const before = getNode(doc, id);
    if (!before) continue;
    if (value === undefined) b.unset(id, path);
    else b.set(id, path, value);
    if (before.type === "text") fitText(b, id, before, textBox);
  }
  return b.done(labelText ?? label1(doc, ids, `set ${path} on`));
}

export function commitText(doc: Document, id: string, spans: Span[], textBox: TextBoxFn): Command {
  const before = getNode(doc, id) as TextNode;
  const b = new Batch(doc);
  b.set(id, "spans", spans);
  fitText(b, id, before, textBox);
  return b.done(label1(doc, [id], "edit text"));
}
