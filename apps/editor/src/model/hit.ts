// Geometric hit testing on the model (not the DOM): a click lands on a text box even between
// glyphs, on thin lines within a tolerance, and never on hidden or locked layers.
import type { Frame, Node } from "@post-studio/schema";
import { apply, groupChildMatrix, IDENTITY, inv, mul, nodeBox, ownMatrix, type Mat, type Pt, type TextBoxFn } from "./geometry.ts";

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hitLeaf(n: Node, pm: Mat, p: Pt, tb: TextBoxFn, tol: number): boolean {
  const m = mul(pm, ownMatrix(n, tb));
  const q = apply(inv(m), p);
  if (n.type === "line") {
    const half = Math.max(tol, n.stroke.width / 2);
    return distToSegment(q, { x: n.x, y: n.y }, { x: n.x + n.w, y: n.y + n.h }) <= half;
  }
  const b = nodeBox(n, tb);
  const ex = b.w < tol * 2 ? tol : 0;
  const ey = b.h < tol * 2 ? tol : 0;
  return q.x >= b.x - ex && q.x <= b.x + b.w + ex && q.y >= b.y - ey && q.y <= b.y + b.h + ey;
}

/**
 * Motion at the playhead: `matrix` is a layer's motion wrapper (identity when it has none);
 * `hidden` says it draws nothing at that moment (then it cannot be clicked on the canvas).
 */
export interface HitMotion {
  matrix: (n: Node) => Mat;
  hidden: (n: Node) => boolean;
}

function hitList(children: Node[], pm: Mat, p: Pt, tb: TextBoxFn, tol: number, motion?: HitMotion): string[] | undefined {
  for (let i = children.length - 1; i >= 0; i--) {
    const n = children[i];
    if (n.visible === false || n.locked) continue;
    if (motion?.hidden(n)) continue;
    const m = motion ? mul(pm, motion.matrix(n)) : pm;
    if (n.type === "group") {
      const chain = hitList(n.children, mul(m, groupChildMatrix(n)), p, tb, tol, motion);
      if (chain) return [n.id, ...chain];
      continue;
    }
    if (hitLeaf(n, m, p, tb, tol)) return [n.id];
  }
  return undefined;
}

/** Ids from the top-level node down to the deepest leaf under `p` (frame coordinates), or []. */
export function hitTest(frame: Frame, p: Pt, tb: TextBoxFn, tol = 3, motion?: HitMotion): string[] {
  return hitList(frame.children, IDENTITY, p, tb, tol, motion) ?? [];
}

/** Which id of a hit chain a click selects: the top level, the child of the entered group, or the deepest (Ctrl/⌘). */
export function pickFromChain(chain: string[], scope: string | null, deep: boolean): string | undefined {
  if (!chain.length) return undefined;
  if (deep) return chain[chain.length - 1];
  if (scope) {
    const i = chain.indexOf(scope);
    if (i >= 0 && chain[i + 1]) return chain[i + 1];
  }
  return chain[0];
}
