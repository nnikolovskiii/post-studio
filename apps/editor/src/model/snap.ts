// Snapping (PLAN §3.7): frame edges and centre, other nodes' edges and centres, and the
// template guides. Works on frame-space axis-aligned boxes; returns the correction to apply
// and the lines to draw.
import type { Box } from "./geometry.ts";

export interface SnapTarget {
  /** Frame-space coordinate of the line. */
  value: number;
  kind: "frame" | "node" | "guide";
  label?: string;
}

export interface SnapTargets {
  x: SnapTarget[];
  y: SnapTarget[];
}

export interface SnapLine {
  axis: "x" | "y";
  value: number;
  kind: SnapTarget["kind"];
  /** Frame the line belongs to (set by the canvas). */
  frame?: string;
}

export interface SnapResult {
  dx: number;
  dy: number;
  lines: SnapLine[];
}

/** Edges and centre of a frame plus every other node's box. */
export function buildTargets(frame: { w: number; h: number }, others: Box[], guides: { x: number[]; y: number[] } = { x: [], y: [] }): SnapTargets {
  const x: SnapTarget[] = [
    { value: 0, kind: "frame" },
    { value: frame.w / 2, kind: "frame" },
    { value: frame.w, kind: "frame" },
  ];
  const y: SnapTarget[] = [
    { value: 0, kind: "frame" },
    { value: frame.h / 2, kind: "frame" },
    { value: frame.h, kind: "frame" },
  ];
  for (const b of others) {
    x.push({ value: b.x, kind: "node" }, { value: b.x + b.w / 2, kind: "node" }, { value: b.x + b.w, kind: "node" });
    y.push({ value: b.y, kind: "node" }, { value: b.y + b.h / 2, kind: "node" }, { value: b.y + b.h, kind: "node" });
  }
  for (const g of guides.x) x.push({ value: g, kind: "guide" });
  for (const g of guides.y) y.push({ value: g, kind: "guide" });
  return { x, y };
}

function best(candidates: number[], targets: SnapTarget[], threshold: number): { delta: number; target?: SnapTarget } {
  let delta = 0;
  let target: SnapTarget | undefined;
  let dist = threshold + 1e-9;
  for (const c of candidates) {
    for (const t of targets) {
      const d = t.value - c;
      // Guides win ties: they encode the layout rules.
      const ad = Math.abs(d) - (t.kind === "guide" ? 1e-6 : 0);
      if (ad < dist) {
        dist = ad;
        delta = d;
        target = t;
      }
    }
  }
  return { delta: target ? delta : 0, target };
}

/**
 * Snap a moving box. `edges` chooses which of the box's lines may snap: all three for a move,
 * only the dragged edge for a resize. `threshold` is in frame px (screen px / zoom).
 */
export function snapBox(
  box: Box,
  targets: SnapTargets,
  threshold: number,
  edges: { x: Array<0 | 0.5 | 1>; y: Array<0 | 0.5 | 1> } = { x: [0, 0.5, 1], y: [0, 0.5, 1] },
): SnapResult {
  const bx = best(edges.x.map((f) => box.x + box.w * f), targets.x, threshold);
  const by = best(edges.y.map((f) => box.y + box.h * f), targets.y, threshold);
  const lines: SnapLine[] = [];
  const moved = { x: box.x + bx.delta, y: box.y + by.delta, w: box.w, h: box.h };
  // Draw every target line the snapped box now touches on that axis (centre and edges).
  if (bx.target) {
    for (const f of edges.x) {
      const v = moved.x + moved.w * f;
      for (const t of targets.x) if (Math.abs(t.value - v) < 0.01 && !lines.some((l) => l.axis === "x" && Math.abs(l.value - t.value) < 0.01)) lines.push({ axis: "x", value: t.value, kind: t.kind });
    }
  }
  if (by.target) {
    for (const f of edges.y) {
      const v = moved.y + moved.h * f;
      for (const t of targets.y) if (Math.abs(t.value - v) < 0.01 && !lines.some((l) => l.axis === "y" && Math.abs(l.value - t.value) < 0.01)) lines.push({ axis: "y", value: t.value, kind: t.kind });
    }
  }
  return { dx: bx.delta, dy: by.delta, lines };
}

/** Snap a single point (line endpoints, resize corners). */
export function snapPoint(p: { x: number; y: number }, targets: SnapTargets, threshold: number): SnapResult {
  return snapBox({ x: p.x, y: p.y, w: 0, h: 0 }, targets, threshold, { x: [0], y: [0] });
}
