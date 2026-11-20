// Boxes and groups for imported nodes. Pure (no Node APIs): used by the CLI importer and by the
// editor's SVG paste.
import type { GroupNode, Node } from "@post-studio/schema";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boxOf(n: Node): Box {
  if (n.type === "line") return { x: Math.min(n.x, n.x + n.w), y: Math.min(n.y, n.y + n.h), w: Math.abs(n.w), h: Math.abs(n.h) };
  return { x: n.x, y: n.y, w: n.w, h: n.h };
}

export function union(boxes: Box[]): Box {
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function shift<T extends Node>(n: T, dx: number, dy: number): T {
  return { ...n, x: r3(n.x + dx), y: r3(n.y + dy) };
}

/** A group whose box is the union of its children; children become relative to it. */
export function makeGroup(id: string, children: Node[], extra: Partial<GroupNode> = {}): GroupNode {
  const b = union(children.map(boxOf));
  const gx = r3(b.x);
  const gy = r3(b.y);
  return { id, type: "group", ...extra, x: gx, y: gy, w: r3(b.w), h: r3(b.h), children: children.map((c) => shift(c, -gx, -gy)) } as GroupNode;
}
