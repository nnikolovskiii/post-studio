// 2D geometry for the canvas: node boxes, the ancestor transforms the renderer applies
// (group translate + rotate, node rotate about its centre), and the resize / rotate maths.
// Pure: no DOM, no React. Frame coordinates are the frame's own px (0..w, 0..h).
import { NODE_DEFAULTS, findItem, type Document, type Frame, type Node, type TextNode } from "@post-studio/schema";

/** Affine matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (SVG order). */
export type Mat = [number, number, number, number, number, number];
export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m1 ∘ m2: apply m2 first, then m1. */
export function mul(m1: Mat, m2: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}

export function inv(m: Mat): Mat {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-12;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const apply = (m: Mat, p: Pt): Pt => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
/** Apply only the linear part (for deltas). */
export const applyVec = (m: Mat, p: Pt): Pt => ({ x: m[0] * p.x + m[2] * p.y, y: m[1] * p.x + m[3] * p.y });
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];

export function rotateAbout(deg: number, cx: number, cy: number): Mat {
  if (!deg) return IDENTITY;
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
}

export const rotateVec = (p: Pt, deg: number): Pt => applyVec(rotateAbout(deg, 0, 0), p);
/** Rotation (degrees) carried by a matrix's linear part. */
export const matRotation = (m: Mat): number => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
export const isTranslationOnly = (m: Mat) => Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;

/** Text boxes come from the HarfBuzz layout (packages/text), never from browser measurement. */
export type TextBoxFn = (node: TextNode) => { w: number; h: number };

/** A node's own box in its parent's coordinates, before its rotation. */
export function nodeBox(node: Node, textBox: TextBoxFn): Box {
  switch (node.type) {
    case "text": {
      const b = textBox(node);
      return { x: node.x, y: node.y, w: b.w, h: b.h };
    }
    case "line":
      return { x: Math.min(node.x, node.x + node.w), y: Math.min(node.y, node.y + node.h), w: Math.abs(node.w), h: Math.abs(node.h) };
    case "group": {
      if (node.w > 0 || node.h > 0 || !node.children.length) return { x: node.x, y: node.y, w: node.w, h: node.h };
      const u = unionBoxes(node.children.map((c) => aabb(corners(nodeBox(c, textBox), ownMatrix(c, textBox)))));
      return { x: node.x + u.x, y: node.y + u.y, w: u.w, h: u.h };
    }
    default:
      return { x: node.x, y: node.y, w: node.w, h: node.h };
  }
}

/** The node's rotation as the renderer applies it, in parent coordinates. */
export function ownMatrix(node: Node, textBox: TextBoxFn): Mat {
  const rot = node.rotation ?? NODE_DEFAULTS.rotation;
  if (!rot) return IDENTITY;
  if (node.type === "group") return rotateAbout(rot, node.x + node.w / 2, node.y + node.h / 2);
  if (node.type === "text") {
    const b = textBox(node);
    return rotateAbout(rot, node.x + b.w / 2, node.y + b.h / 2);
  }
  // Lines, like every other shape, rotate about the centre of their (x, y, w, h) box.
  return rotateAbout(rot, node.x + node.w / 2, node.y + node.h / 2);
}

/** Group → its children's space: translate(x y) rotate(θ w/2 h/2), as packages/render writes it. */
export function groupChildMatrix(g: Extract<Node, { type: "group" }>): Mat {
  return mul(translate(g.x, g.y), rotateAbout(g.rotation ?? 0, g.w / 2, g.h / 2));
}

/** Parent space of `id` → frame coordinates (the product of every ancestor group). */
export function parentMatrix(doc: Document, id: string): Mat {
  const chain: Array<Extract<Node, { type: "group" }>> = [];
  let loc = findItem(doc, id);
  while (loc && loc.kind === "node") {
    const parent = findItem(doc, loc.parent);
    if (!parent || parent.kind !== "node") break;
    chain.unshift(parent.item as Extract<Node, { type: "group" }>);
    loc = parent;
  }
  return chain.reduce<Mat>((m, g) => mul(m, groupChildMatrix(g)), IDENTITY);
}

/** Node space (unrotated box coordinates) → frame coordinates. */
export function nodeMatrix(doc: Document, node: Node, textBox: TextBoxFn): Mat {
  return mul(parentMatrix(doc, node.id), ownMatrix(node, textBox));
}

export function corners(b: Box, m: Mat = IDENTITY): [Pt, Pt, Pt, Pt] {
  return [
    apply(m, { x: b.x, y: b.y }),
    apply(m, { x: b.x + b.w, y: b.y }),
    apply(m, { x: b.x + b.w, y: b.y + b.h }),
    apply(m, { x: b.x, y: b.y + b.h }),
  ];
}

export function aabb(pts: Pt[]): Box {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function unionBoxes(boxes: Box[]): Box {
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 };
  return aabb(boxes.flatMap((b) => [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]));
}

export const intersects = (a: Box, b: Box) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

/** Frame-space corners of a node (rotation included). */
export function nodeCorners(doc: Document, node: Node, textBox: TextBoxFn): [Pt, Pt, Pt, Pt] {
  return corners(nodeBox(node, textBox), nodeMatrix(doc, node, textBox));
}

export function nodeAabb(doc: Document, node: Node, textBox: TextBoxFn): Box {
  return aabb(nodeCorners(doc, node, textBox));
}

export function frameOf(doc: Document, id: string): Frame | undefined {
  const loc = findItem(doc, id);
  return loc ? doc.frames.find((f) => f.id === loc.frame) : undefined;
}

// ---------------------------------------------------------------- resize

/** Handle position on the box: 0, 0.5 or 1 on each axis. (0.5, 0.5) is not a handle. */
export interface Handle {
  hx: 0 | 0.5 | 1;
  hy: 0 | 0.5 | 1;
}

export const HANDLES: Array<Handle & { name: string; cursor: string }> = [
  { hx: 0, hy: 0, name: "nw", cursor: "nwse-resize" },
  { hx: 0.5, hy: 0, name: "n", cursor: "ns-resize" },
  { hx: 1, hy: 0, name: "ne", cursor: "nesw-resize" },
  { hx: 1, hy: 0.5, name: "e", cursor: "ew-resize" },
  { hx: 1, hy: 1, name: "se", cursor: "nwse-resize" },
  { hx: 0.5, hy: 1, name: "s", cursor: "ns-resize" },
  { hx: 0, hy: 1, name: "sw", cursor: "nesw-resize" },
  { hx: 0, hy: 0.5, name: "w", cursor: "ew-resize" },
];

export interface ResizeOptions {
  /** Shift: keep the aspect ratio. */
  keepAspect?: boolean;
  /** Alt: resize about the centre. */
  fromCenter?: boolean;
  min?: number;
}

/**
 * New box (parent coordinates, unrotated) when `handle` of a box rotated by `rotation` degrees is
 * dragged to `p` (parent coordinates). The opposite handle stays where it was on screen.
 */
export function resizeBox(box: Box, rotation: number, handle: Handle, p: Pt, opts: ResizeOptions = {}): Box {
  const min = opts.min ?? 1;
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  // Pointer in the box's own frame, origin at the box's top-left (unrotated).
  const d = rotateVec({ x: p.x - c.x, y: p.y - c.y }, -rotation);
  const u = d.x + box.w / 2;
  const v = d.y + box.h / 2;
  const ax = opts.fromCenter ? 0.5 : 1 - handle.hx;
  const ay = opts.fromCenter ? 0.5 : 1 - handle.hy;
  const anchor = { u: ax * box.w, v: ay * box.h };

  let u0 = 0;
  let u1 = box.w;
  let v0 = 0;
  let v1 = box.h;
  if (handle.hx !== 0.5) {
    const span = opts.fromCenter ? Math.abs(u - anchor.u) * 2 : Math.abs(u - anchor.u);
    const w = Math.max(min, span);
    const dir = opts.fromCenter ? 0 : u >= anchor.u ? 1 : -1;
    [u0, u1] = opts.fromCenter ? [anchor.u - w / 2, anchor.u + w / 2] : dir > 0 ? [anchor.u, anchor.u + w] : [anchor.u - w, anchor.u];
  }
  if (handle.hy !== 0.5) {
    const span = opts.fromCenter ? Math.abs(v - anchor.v) * 2 : Math.abs(v - anchor.v);
    const h = Math.max(min, span);
    const dir = opts.fromCenter ? 0 : v >= anchor.v ? 1 : -1;
    [v0, v1] = opts.fromCenter ? [anchor.v - h / 2, anchor.v + h / 2] : dir > 0 ? [anchor.v, anchor.v + h] : [anchor.v - h, anchor.v];
  }

  if (opts.keepAspect && box.w > 0 && box.h > 0) {
    const sx = (u1 - u0) / box.w;
    const sy = (v1 - v0) / box.h;
    // Corners: the larger change wins. Edges: the dragged axis drives the other one.
    const s = handle.hx === 0.5 ? sy : handle.hy === 0.5 ? sx : Math.max(sx, sy);
    const w = Math.max(min, box.w * s);
    const h = Math.max(min, box.h * s);
    const place = (lo: number, hi: number, size: number, hFrac: number, a: number) => {
      if (opts.fromCenter || hFrac === 0.5) {
        const mid = hFrac === 0.5 && !opts.fromCenter ? (lo + hi) / 2 : a;
        return [mid - size / 2, mid + size / 2];
      }
      return lo === a ? [a, a + size] : [a - size, a];
    };
    [u0, u1] = place(u0, u1, w, handle.hx, anchor.u);
    [v0, v1] = place(v0, v1, h, handle.hy, anchor.v);
  }

  const w = u1 - u0;
  const h = v1 - v0;
  // New centre: shift of the box centre in its own frame, rotated back into parent space.
  const shift = rotateVec({ x: u0 + w / 2 - box.w / 2, y: v0 + h / 2 - box.h / 2 }, rotation);
  const nc = { x: c.x + shift.x, y: c.y + shift.y };
  return { x: nc.x - w / 2, y: nc.y - h / 2, w, h };
}

// ---------------------------------------------------------------- rotate

export function angleDeg(center: Pt, p: Pt): number {
  return (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI;
}

/** Normalise to (-180, 180]. */
export function normAngle(a: number): number {
  let r = a % 360;
  if (r <= -180) r += 360;
  if (r > 180) r -= 360;
  return Math.round(r * 1000) / 1000;
}

/** Rotation after dragging the rotate handle from `start` to `p` around `center`. Shift snaps to 15°. */
export function rotateFromDrag(startRotation: number, center: Pt, start: Pt, p: Pt, snap = false): number {
  let r = startRotation + angleDeg(center, p) - angleDeg(center, start);
  if (snap) r = Math.round(r / 15) * 15;
  return normAngle(r);
}

/** Round to 0.01 px: keeps documents readable and diffs stable. */
export const r2 = (n: number) => {
  const v = Math.round(n * 100) / 100;
  return Object.is(v, -0) ? 0 : v;
};
