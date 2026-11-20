// Hand-drawn shapes (`node.sketch`): wobbly outlines drawn as rough pen strokes, plus a solid,
// hachure or cross-hatch fill. Pure geometry: the result is plain SVG path data, so the editor
// canvas, the PNG / JPEG / MP4 pipeline (resvg), the plain and the Figma SVG all draw the same
// thing, and Figma gets ordinary vector paths. No filters, no patterns, no clip paths.
//
// Deterministic: every random number comes from one seeded generator per node (seed = the
// node's `sketch.seed`, else a hash of its id), consumed in a fixed order, and every coordinate
// is rounded to 2 decimals. Same document → byte-identical markup, in Node and in the browser.
import type { Node, Sketch } from "@post-studio/schema";

export type Pt = [number, number];
export type SketchNode = Extract<Node, { type: "rect" | "ellipse" | "line" | "path" }>;

export const SKETCH_DEFAULTS = { fill: "hachure", roughness: 1, angle: -41, tint: 0.3 } as const;
export const SKETCH_FILLS = ["hachure", "cross-hatch", "solid"] as const;

/** Upper bound of hatch lines per shape; the gap widens past it (a huge shape stays cheap). */
const MAX_HATCH_LINES = 1500;

/** FNV-1a of the id: the default seed, stable for the node's whole life. */
export function sketchSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) & 0x7fffffff;
}

/** mulberry32: small, fast, the same sequence on every JS engine. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (n: number) => {
  const v = Math.round(n * 100) / 100;
  return Object.is(v, -0) ? "0" : String(v);
};
const pt = (p: Pt) => `${r2(p[0])} ${r2(p[1])}`;

/** The resolved options for one node (defaults filled in from the shape's size). */
export interface SketchParams {
  fill: "solid" | "hachure" | "cross-hatch";
  roughness: number;
  weight: number;
  gap: number;
  angle: number;
  tint: number;
  seed: number;
}

export function sketchParams(node: SketchNode): SketchParams {
  const s: Sketch = node.sketch ?? {};
  const minDim = Math.max(1, Math.min(Math.abs(node.w), Math.abs(node.h)) || Math.max(Math.abs(node.w), Math.abs(node.h)));
  const weight = s.weight ?? Math.max(1, Math.min(3, minDim / 10));
  return {
    fill: s.fill ?? SKETCH_DEFAULTS.fill,
    roughness: s.roughness ?? SKETCH_DEFAULTS.roughness,
    weight,
    gap: s.gap ?? Math.max(2, weight * 2.2),
    angle: s.angle ?? SKETCH_DEFAULTS.angle,
    tint: s.tint ?? SKETCH_DEFAULTS.tint,
    seed: s.seed ?? sketchSeed(node.id),
  };
}

// ---------------------------------------------------------------- outlines (polygons)

function ellipsePoints(cx: number, cy: number, rx: number, ry: number, from = 0, to = Math.PI * 2, closed = true): Pt[] {
  const per = Math.abs(to - from) * Math.sqrt((rx * rx + ry * ry) / 2);
  const n = Math.max(closed ? 16 : 3, Math.min(720, Math.ceil(per / 6)));
  const out: Pt[] = [];
  const last = closed ? n - 1 : n;
  for (let i = 0; i <= last; i++) {
    const t = from + ((to - from) * i) / n;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

function rectPoints(x: number, y: number, w: number, h: number, radius = 0): Pt[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r < 0.5) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const q = Math.PI / 2;
  return [
    ...ellipsePoints(x + w - r, y + r, r, r, -q, 0, false),
    ...ellipsePoints(x + w - r, y + h - r, r, r, 0, q, false),
    ...ellipsePoints(x + r, y + h - r, r, r, q, 2 * q, false),
    ...ellipsePoints(x + r, y + r, r, r, 2 * q, 3 * q, false),
  ];
}

const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Path data → flattened sub-paths (curves sampled), in path coordinates. [] when it does not parse. */
export function flattenPath(d: string): Array<{ pts: Pt[]; closed: boolean }> {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
  const subs: Array<{ pts: Pt[]; closed: boolean }> = [];
  let cur: Pt[] = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastCtrl: Pt | undefined;
  let lastCmd = "";
  let i = 0;
  let cmd = "";
  const end = (closed: boolean) => {
    if (cur.length > 1) subs.push({ pts: cur, closed });
    cur = [];
  };
  const curve = (pts: Pt[], steps: number, f: (t: number) => Pt) => {
    for (let k = 1; k <= steps; k++) pts.push(f(k / steps));
  };
  const steps = (len: number) => Math.max(4, Math.min(64, Math.ceil(len / 6)));
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) return subs;
    const lower = cmd.toLowerCase();
    const rel = cmd !== cmd.toUpperCase();
    const n = ARGS[lower];
    if (n === 0) {
      x = sx;
      y = sy;
      end(true);
      lastCmd = "z";
      cmd = "";
      continue;
    }
    if (i + n > toks.length) break;
    const a = toks.slice(i, i + n).map(Number);
    if (a.some((v) => !Number.isFinite(v))) break;
    i += n;
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (!cur.length) cur = [[x, y]];
    switch (lower) {
      case "m":
        end(false);
        x = a[0] + ox;
        y = a[1] + oy;
        sx = x;
        sy = y;
        cur = [[x, y]];
        cmd = rel ? "l" : "L";
        break;
      case "l":
        x = a[0] + ox;
        y = a[1] + oy;
        cur.push([x, y]);
        break;
      case "h":
        x = a[0] + ox;
        cur.push([x, y]);
        break;
      case "v":
        y = a[0] + oy;
        cur.push([x, y]);
        break;
      case "c":
      case "s":
      case "q":
      case "t": {
        let c1: Pt, c2: Pt, p: Pt;
        const p0: Pt = [x, y];
        const refl = (): Pt => (lastCtrl ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y]);
        if (lower === "c") {
          c1 = [a[0] + ox, a[1] + oy];
          c2 = [a[2] + ox, a[3] + oy];
          p = [a[4] + ox, a[5] + oy];
        } else if (lower === "s") {
          c1 = /[cs]/.test(lastCmd) ? refl() : [x, y];
          c2 = [a[0] + ox, a[1] + oy];
          p = [a[2] + ox, a[3] + oy];
        } else {
          const q: Pt = lower === "q" ? [a[0] + ox, a[1] + oy] : /[qt]/.test(lastCmd) ? refl() : [x, y];
          p = lower === "q" ? [a[2] + ox, a[3] + oy] : [a[0] + ox, a[1] + oy];
          c1 = [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])];
          c2 = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])];
          lastCtrl = q;
        }
        const len = Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(p[0] - c2[0], p[1] - c2[1]);
        curve(cur, steps(len), (t) => {
          const u = 1 - t;
          return [u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p[0], u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p[1]];
        });
        if (lower === "c" || lower === "s") lastCtrl = c2;
        x = p[0];
        y = p[1];
        break;
      }
      case "a": {
        const p: Pt = [a[5] + ox, a[6] + oy];
        cur.push(...arcPoints([x, y], p, a[0], a[1], a[2], a[3] !== 0, a[4] !== 0));
        x = p[0];
        y = p[1];
        break;
      }
    }
    if (!/[csqt]/.test(lower)) lastCtrl = undefined;
    lastCmd = lower;
  }
  end(false);
  return subs;
}

/** SVG elliptical arc (endpoint form) → points after p0, ending at p1. */
function arcPoints(p0: Pt, p1: Pt, rxIn: number, ryIn: number, rotDeg: number, large: boolean, sweep: boolean): Pt[] {
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
  if (rx < 1e-9 || ry < 1e-9 || (p0[0] === p1[0] && p0[1] === p1[1])) return [p1];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (p0[0] + p1[0]) / 2;
  const cy = sin * cxp + cos * cyp + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.min(96, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / 6)));
  const out: Pt[] = [];
  for (let k = 1; k <= n; k++) {
    const t = t1 + (dt * k) / n;
    out.push(k === n ? p1 : [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
  }
  return out;
}

/** The shape's outline in its parent's coordinates (before the node's rotation). */
export function sketchOutline(node: SketchNode): Array<{ pts: Pt[]; closed: boolean }> {
  switch (node.type) {
    case "rect":
      return [{ pts: rectPoints(node.x, node.y, node.w, node.h, node.radius), closed: true }];
    case "ellipse":
      return [{ pts: ellipsePoints(node.x + node.w / 2, node.y + node.h / 2, node.w / 2, node.h / 2), closed: true }];
    case "line":
      return [{ pts: [[node.x, node.y], [node.x + node.w, node.y + node.h]], closed: false }];
    case "path": {
      const [vx, vy, vw, vh] = node.viewBox;
      const sx = node.w / vw, sy = node.h / vh;
      return flattenPath(node.d).map((s) => ({ closed: s.closed, pts: s.pts.map(([px, py]) => [node.x + (px - vx) * sx, node.y + (py - vy) * sy] as Pt) }));
    }
  }
}

// ---------------------------------------------------------------- rough strokes

/**
 * One rough pen line from a to b (a slightly bowed cubic with jittered ends), after rough.js's
 * line model: the jitter shrinks on short lines, so small shapes stay recognisable.
 */
function roughLine(rnd: () => number, a: Pt, b: Pt, rough: number, maxOffset: number, overshoot = 0): string {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1e-6) return "";
  let off = maxOffset;
  if (off * off * 100 > len * len) off = len / 10;
  const gain = len < 200 ? 1 : len > 500 ? 0.4 : -0.0016668 * len + 1.233334;
  const o = (v: number) => rough * gain * (rnd() * 2 * v - v);
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
  // Pen lines start a little early and stop a little late (or short), like a hand does.
  const e0 = overshoot ? o(overshoot) : 0, e1 = overshoot ? o(overshoot) : 0;
  const x1 = a[0] - ux * e0, y1 = a[1] - uy * e0, x2 = b[0] + ux * e1, y2 = b[1] + uy * e1;
  const div = 0.2 + rnd() * 0.2;
  const bow = 1;
  const mdx = o((bow * maxOffset * (y2 - y1)) / 200);
  const mdy = o((bow * maxOffset * (x1 - x2)) / 200);
  return (
    `M${pt([x1 + o(off), y1 + o(off)])}C${pt([mdx + x1 + (x2 - x1) * div + o(off), mdy + y1 + (y2 - y1) * div + o(off)])} ` +
    `${pt([mdx + x1 + 2 * (x2 - x1) * div + o(off), mdy + y1 + 2 * (y2 - y1) * div + o(off)])} ${pt([x2 + o(off), y2 + o(off)])}`
  );
}

/** A polygon's outline as rough strokes, each edge drawn twice (the second pass tighter). */
function roughOutline(rnd: () => number, pts: Pt[], closed: boolean, rough: number, maxOffset: number): string {
  if (rough <= 0) return polyPath(pts, closed);
  const runs = mergeEdges(pts, closed);
  let d = "";
  for (const pass of [maxOffset, maxOffset / 2]) for (const [a, b] of runs) d += roughLine(rnd, a, b, rough, pass, pass);
  return d;
}

/**
 * Edges to stroke: straight runs of a polygon become one rough line each, and the many short
 * edges of a curve are merged into strokes of about 40 px (a hand draws a circle in a few arcs).
 */
function mergeEdges(pts: Pt[], closed: boolean): Array<[Pt, Pt]> {
  const n = pts.length;
  const edges: Array<[Pt, Pt]> = [];
  const m = closed ? n : n - 1;
  let start = pts[0];
  let acc = 0;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
    const next = pts[(i + 2) % n];
    const turn = i + 1 < m || closed ? angleBetween(a, b, next) : Math.PI;
    if (acc >= 40 || turn > 0.5 || i === m - 1) {
      edges.push([start, b]);
      start = b;
      acc = 0;
    }
  }
  return edges;
}

function angleBetween(a: Pt, b: Pt, c: Pt): number {
  const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = Math.abs(t2 - t1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

function polyPath(pts: Pt[], closed: boolean): string {
  return pts.length ? `M${pts.map(pt).join("L")}${closed ? "Z" : ""}` : "";
}

/**
 * A closed polygon with a hand-drawn edge: points every ~8 px along it, each pushed along the
 * normal by smooth seeded noise plus a little grain, joined with quadratic curves through the
 * midpoints (no corners sharper than a pen makes).
 */
function wobblyPolygon(rnd: () => number, pts: Pt[], amp: number): string {
  const dense: Pt[] = [];
  const normals: Pt[] = [];
  const n = pts.length;
  const area = signedArea(pts);
  const side = area >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    const k = Math.max(1, Math.ceil(len / 8));
    const nx = (side * -(b[1] - a[1])) / len, ny = (side * (b[0] - a[0])) / len;
    for (let j = 0; j < k; j++) {
      dense.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
      normals.push([nx, ny]);
    }
  }
  if (dense.length < 3) return polyPath(pts, true);
  // Smooth noise: random values every ~5 points, cosine-interpolated, plus per-point grain.
  const knots = Math.max(3, Math.ceil(dense.length / 5));
  const kv = Array.from({ length: knots }, () => rnd() * 2 - 1);
  const out: Pt[] = dense.map((p, i) => {
    const f = (i / dense.length) * knots;
    const i0 = Math.floor(f) % knots, i1 = (i0 + 1) % knots;
    const t = (1 - Math.cos((f - Math.floor(f)) * Math.PI)) / 2;
    const smooth = kv[i0] * (1 - t) + kv[i1] * t;
    const grain = rnd() * 2 - 1;
    const d = amp * (0.75 * smooth + 0.35 * grain);
    return [p[0] + normals[i][0] * d, p[1] + normals[i][1] * d];
  });
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let d = `M${pt(mid(out[out.length - 1], out[0]))}`;
  for (let i = 0; i < out.length; i++) d += `Q${pt(out[i])} ${pt(mid(out[i], out[(i + 1) % out.length]))}`;
  return d + "Z";
}

function signedArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

// ---------------------------------------------------------------- hatching

/**
 * Parallel lines `gap` apart at `angleDeg` across the polygons (even-odd inside). With `rnd`,
 * each line is shifted by up to `jitter` × gap and tilted a little, so the hatch looks drawn by
 * hand rather than ruled.
 */
export function hatchSegments(polys: Pt[][], gap: number, angleDeg: number, rnd?: () => number, jitter = 0): Array<[Pt, Pt]> {
  const all = polys.flat();
  if (!all.length) return [];
  const th = (angleDeg * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  // Rotate by -angle so hatch lines are horizontal, scan, rotate back.
  const rot = (p: Pt): Pt => [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];
  const back = (p: Pt): Pt => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
  const rp = polys.map((p) => p.map(rot));
  let minY = Infinity, maxY = -Infinity;
  for (const p of rp) for (const q of p) {
    minY = Math.min(minY, q[1]);
    maxY = Math.max(maxY, q[1]);
  }
  let step = gap;
  if ((maxY - minY) / step > MAX_HATCH_LINES) step = (maxY - minY) / MAX_HATCH_LINES;
  const out: Array<[Pt, Pt]> = [];
  for (let y0 = minY + step / 2; y0 < maxY; y0 += step) {
    // A hand's line: shifted off the ruled position, and its two ends at slightly different heights.
    const shift = rnd && jitter ? (rnd() * 2 - 1) * jitter * step : 0;
    const tilt = rnd && jitter ? (rnd() * 2 - 1) * jitter * step * 0.6 : 0;
    const y = y0 + shift;
    const xs: number[] = [];
    for (const p of rp) for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > 0.5) out.push([back([xs[k], y - tilt]), back([xs[k + 1], y + tilt])]);
  }
  return out;
}

// ---------------------------------------------------------------- the whole shape

export interface SketchPaths {
  /** Solid fill (wobbly polygon), filled with the shape's fill colour. */
  fill?: string;
  /** Tint under the hatch lines (same polygon as `fill`), drawn at `tint` opacity. */
  tint?: string;
  /** Hatch lines, stroked with the fill colour at `weight`. */
  hatch?: string;
  /** The rough outline in the fill colour (no stroke on the shape) at `weight`. */
  edge?: string;
  /** The rough outline for the shape's own stroke (its colour and width). */
  stroke?: string;
  params: SketchParams;
}

/**
 * Path data for a sketched shape. `hasFill` / `hasStroke` say which paints the shape has; the
 * random sequence is consumed in a fixed order whatever they are, so toggling the stroke does not
 * reshuffle the fill.
 */
export function sketchPaths(node: SketchNode, hasFill: boolean, hasStroke: boolean): SketchPaths {
  const P = sketchParams(node);
  const subs = sketchOutline(node).filter((s) => s.pts.length > 1);
  const closed = subs.filter((s) => s.closed || node.type === "path").map((s) => s.pts).filter((p) => p.length > 2);
  const minDim = Math.max(1, Math.min(Math.abs(node.w), Math.abs(node.h)) || Math.max(Math.abs(node.w), Math.abs(node.h)));
  const rough = P.roughness;
  const maxOffset = Math.min(2, minDim / 8);
  const out: SketchPaths = { params: P };
  const fillRnd = seededRandom(P.seed);
  const edgeRnd = seededRandom((P.seed ^ 0x5bd1e995) >>> 0);
  const strokeRnd = seededRandom((P.seed ^ 0x27d4eb2f) >>> 0);

  if (hasFill && closed.length && node.type !== "line") {
    const amp = rough * Math.min(1.6, minDim / 14);
    const wobbly = () => (rough > 0 ? closed.map((p) => wobblyPolygon(fillRnd, p, amp)).join("") : closed.map((p) => polyPath(p, true)).join(""));
    if (P.fill === "solid") out.fill = wobbly();
    else {
      if (P.tint > 0) out.tint = wobbly();
      const jitter = Math.min(0.35, rough * 0.18);
      const lines = hatchSegments(closed, P.gap, P.angle, fillRnd, jitter);
      if (P.fill === "cross-hatch") lines.push(...hatchSegments(closed, P.gap * 1.25, P.angle + 90, fillRnd, jitter));
      // Hatch lines overshoot the edge by up to ~a pen width: the fuzzy rim of a marker fill.
      out.hatch = lines.map(([a, b]) => roughLine(fillRnd, a, b, rough, Math.min(1.2, maxOffset), rough ? P.weight * 0.6 : 0)).join("");
    }
    if (!hasStroke) out.edge = closed.map((p) => roughOutline(edgeRnd, p, true, rough, maxOffset)).join("");
  }
  if (hasStroke) out.stroke = subs.map((s) => roughOutline(strokeRnd, s.pts, s.closed, rough, maxOffset)).join("");
  return out;
}
