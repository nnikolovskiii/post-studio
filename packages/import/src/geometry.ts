import { Resvg } from "@resvg/resvg-js";
import type { Box } from "./boxes.ts";

export { boxOf, union, shift, makeGroup, type Box } from "./boxes.ts";

/** Geometric bounds of path data (no stroke), measured by resvg. */
export function pathBounds(d: string): Box | undefined {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="${d.replace(/"/g, "")}"/></svg>`;
  const b = new Resvg(svg).getBBox();
  if (!b || !Number.isFinite(b.x)) return undefined;
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}
