// Bounds of SVG path data without a renderer (the editor has no resvg): exact for lines and
// Bézier curves (extrema from the derivative's roots), arcs sampled finely. Optionally through a
// transform, so a rotated or translated path gets the box it is drawn in.
import type { Box } from "./boxes.ts";
import { applyMat, IDENTITY, type Mat } from "./svg-common.ts";

type Pt = { x: number; y: number };

const ARG_COUNT: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Path data → absolute commands. undefined when it does not parse. */
export function parsePath(d: string): Array<{ cmd: string; args: number[] }> | undefined {
  const out: Array<{ cmd: string; args: number[] }> = [];
  let i = 0;
  const len = d.length;
  const skip = () => {
    while (i < len && /[\s,]/.test(d[i])) i++;
  };
  const number = (): number | undefined => {
    skip();
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(d.slice(i, i + 64));
    if (!m) return undefined;
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = (): number | undefined => {
    skip();
    if (d[i] === "0" || d[i] === "1") return Number(d[i++]);
    return undefined;
  };
  let cmd = "";
  for (;;) {
    skip();
    if (i >= len) break;
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(d[i])) cmd = d[i++];
    else if (!cmd || cmd === "z" || cmd === "Z") return undefined;
    const lower = cmd.toLowerCase();
    const n = ARG_COUNT[lower];
    if (n === 0) {
      out.push({ cmd, args: [] });
      cmd = "";
      continue;
    }
    const args: number[] = [];
    for (let k = 0; k < n; k++) {
      const v = lower === "a" && (k === 3 || k === 4) ? flag() : number();
      if (v === undefined) return args.length === 0 && k === 0 ? (out.length ? out : undefined) : undefined;
      args.push(v);
    }
    out.push({ cmd, args });
    // Extra pairs after M are implicit L.
    if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
  }
  return out;
}

function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // Derivative: 3[(p1-p0)(1-t)^2 + 2(p2-p1)t(1-t) + (p3-p2)t^2] = a t^2 + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      ts.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/** Points on an elliptical arc (endpoint parameterization, SVG F.6.5), sampled. */
function arcPoints(p0: Pt, rx: number, ry: number, phiDeg: number, large: number, sweep: number, p1: Pt): Pt[] {
  if (!rx || !ry) return [p1];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (co * rx * y1) / ry;
  const cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0.x + p1.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0.y + p1.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const out: Pt[] = [];
  const steps = 64;
  for (let k = 1; k <= steps; k++) {
    const t = t1 + (dt * k) / steps;
    out.push({ x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos });
  }
  return out;
}

/**
 * Geometric bounds (no stroke) of path data, in the coordinates `m` maps to (default: the
 * path's own). Bézier curves are transformed as control points, which is exact for affine maps.
 */
export function pathBoundsPure(d: string, m: Mat = IDENTITY): Box | undefined {
  const cmds = parsePath(d);
  if (!cmds || !cmds.length) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (p: Pt) => {
    const q = applyMat(m, p);
    x0 = Math.min(x0, q.x);
    y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x);
    y1 = Math.max(y1, q.y);
  };
  const cubic = (a: Pt, b: Pt, c: Pt, e: Pt) => {
    // Extrema of the transformed curve: transform the control points first.
    const [A, B, C, E] = [a, b, c, e].map((p) => applyMat(m, p));
    const ts = [...cubicExtrema(A.x, B.x, C.x, E.x), ...cubicExtrema(A.y, B.y, C.y, E.y)];
    const push = (q: Pt) => {
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x);
      y1 = Math.max(y1, q.y);
    };
    push(E);
    for (const t of ts) push({ x: cubicAt(A.x, B.x, C.x, E.x, t), y: cubicAt(A.y, B.y, C.y, E.y, t) });
  };
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let lastCtrl: Pt | undefined;
  let lastQuad: Pt | undefined;
  for (const { cmd, args } of cmds) {
    const rel = cmd === cmd.toLowerCase();
    const P = (x: number, y: number): Pt => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });
    const lower = cmd.toLowerCase();
    let ctrl: Pt | undefined;
    let quad: Pt | undefined;
    switch (lower) {
      case "m":
        cur = P(args[0], args[1]);
        start = cur;
        add(cur);
        break;
      case "l":
        cur = P(args[0], args[1]);
        add(cur);
        break;
      case "h":
        cur = { x: rel ? cur.x + args[0] : args[0], y: cur.y };
        add(cur);
        break;
      case "v":
        cur = { x: cur.x, y: rel ? cur.y + args[0] : args[0] };
        add(cur);
        break;
      case "c": {
        const c1 = P(args[0], args[1]);
        const c2 = P(args[2], args[3]);
        const e = P(args[4], args[5]);
        cubic(cur, c1, c2, e);
        ctrl = c2;
        cur = e;
        break;
      }
      case "s": {
        const c1 = lastCtrl ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y } : cur;
        const c2 = P(args[0], args[1]);
        const e = P(args[2], args[3]);
        cubic(cur, c1, c2, e);
        ctrl = c2;
        cur = e;
        break;
      }
      case "q":
      case "t": {
        const q = lower === "q" ? P(args[0], args[1]) : lastQuad ? { x: 2 * cur.x - lastQuad.x, y: 2 * cur.y - lastQuad.y } : cur;
        const e = lower === "q" ? P(args[2], args[3]) : P(args[0], args[1]);
        // Quadratic → cubic (exact).
        cubic(cur, { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) }, { x: e.x + (2 / 3) * (q.x - e.x), y: e.y + (2 / 3) * (q.y - e.y) }, e);
        quad = q;
        cur = e;
        break;
      }
      case "a": {
        const e = P(args[5], args[6]);
        for (const p of arcPoints(cur, args[0], args[1], args[2], args[3], args[4], e)) add(p);
        cur = e;
        break;
      }
      case "z":
        cur = start;
        break;
    }
    lastCtrl = ctrl;
    lastQuad = quad;
  }
  if (!Number.isFinite(x0)) return undefined;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
