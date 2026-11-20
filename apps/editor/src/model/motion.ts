// Motion in the editor (PLAN-motion.md §6.1): geometry at a time t (the canvas overlay and hit
// testing follow the layer to where it is drawn), Animate-mode op builders, timeline rows, time
// snapping and keyframe pins. Pure: no DOM, no React. Values come from packages/motion only;
// nothing here interpolates on its own.
import { NODE_DEFAULTS, TRACK_NEUTRAL, TRACK_RANGES, TRACKS, findItem, type Document, type Keyframe, type Node, type TrackName } from "@post-studio/schema";
import { activeTracks, hasKeyframes, nextKeyId, originPoint, sampleNode, snapToFrame, timeRange, type MotionOp } from "@post-studio/motion";
import { apply as applyPt, applyVec, corners, groupChildMatrix, IDENTITY, inv, mul, nodeBox, ownMatrix, rotateAbout, translate, type Box, type Mat, type Pt, type TextBoxFn } from "./geometry.ts";

// ---------------------------------------------------------------- geometry at a time

/**
 * The box the renderer anchors `origin` on (packages/render renderNode): the laid-out box for
 * text, the stored (normalized) x / y / w / h for everything else, groups included.
 */
export function animBox(node: Node, tb: TextBoxFn): Box {
  if (node.type === "text") {
    const b = tb(node);
    return { x: node.x, y: node.y, w: b.w, h: b.h };
  }
  return { x: Math.min(node.x, node.x + node.w), y: Math.min(node.y, node.y + node.h), w: Math.abs(node.w), h: Math.abs(node.h) };
}

const scaleMat = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0];

/**
 * The motion wrapper of `node` at time t as a matrix, exactly what packages/render's animAttrs()
 * writes: translate(dx+ox dy+oy) rotate(r) scale(sx sy) translate(−ox −oy). Identity without
 * keyframes, and for a layer that is invisible at t (scaled or faded to 0: the renderer drops
 * the transform there too).
 */
export function animMatrix(node: Node, t: number | undefined, tb: TextBoxFn): Mat {
  if (t === undefined || !hasKeyframes(node)) return IDENTITY;
  const s = sampleNode(node, t);
  const sx = s.scale * s.scaleX;
  const sy = s.scale * s.scaleY;
  if (s.opacity <= 0 || sx <= 0 || sy <= 0) return IDENTITY;
  if (s.rotate === 0 && sx === 1 && sy === 1) return translate(s.dx, s.dy);
  const b = animBox(node, tb);
  const o = originPoint(node.anim?.origin, b.w, b.h);
  const ox = b.x + o.x;
  const oy = b.y + o.y;
  return mul(translate(s.dx + ox, s.dy + oy), mul(rotateAbout(s.rotate, 0, 0), mul(scaleMat(sx, sy), translate(-ox, -oy))));
}

/** True when the layer draws nothing at t (faded or scaled to 0, itself or an ancestor). */
export function hiddenAt(doc: Document, node: Node, t: number | undefined): boolean {
  if (t === undefined) return false;
  const chain = [node, ...ancestors(doc, node.id)];
  return chain.some((n) => {
    if (!hasKeyframes(n)) return false;
    const s = sampleNode(n, t);
    return s.opacity <= 0 || s.scale * s.scaleX <= 0 || s.scale * s.scaleY <= 0;
  });
}

function ancestors(doc: Document, id: string): Array<Extract<Node, { type: "group" }>> {
  const chain: Array<Extract<Node, { type: "group" }>> = [];
  let loc = findItem(doc, id);
  while (loc && loc.kind === "node") {
    const parent = findItem(doc, loc.parent);
    if (!parent || parent.kind !== "node") break;
    chain.unshift(parent.item as Extract<Node, { type: "group" }>);
    loc = parent;
  }
  return chain;
}

/** Parent space of `id` → frame coordinates at time t (ancestor groups with their motion). */
export function parentMatrixAt(doc: Document, id: string, t: number | undefined, tb: TextBoxFn): Mat {
  return ancestors(doc, id).reduce<Mat>((m, g) => mul(m, mul(animMatrix(g, t, tb), groupChildMatrix(g))), IDENTITY);
}

/** Node space (unrotated box) → frame coordinates at time t. */
export function nodeMatrixAt(doc: Document, node: Node, t: number | undefined, tb: TextBoxFn): Mat {
  return mul(parentMatrixAt(doc, node.id, t, tb), mul(animMatrix(node, t, tb), ownMatrix(node, tb)));
}

/** Frame-space corners of a node where it is drawn at time t. */
export function nodeCornersAt(doc: Document, node: Node, t: number | undefined, tb: TextBoxFn): [Pt, Pt, Pt, Pt] {
  return corners(nodeBox(node, tb), nodeMatrixAt(doc, node, t, tb));
}

/** Hit testing at time t (hit.ts): each layer where it is drawn, layers invisible at t skipped. */
export function hitMotionAt(t: number | undefined, tb: TextBoxFn): { matrix: (n: Node) => Mat; hidden: (n: Node) => boolean } | undefined {
  if (t === undefined) return undefined;
  return {
    matrix: (n) => animMatrix(n, t, tb),
    hidden: (n) => {
      if (!hasKeyframes(n)) return false;
      const smp = sampleNode(n, t);
      return smp.opacity <= 0 || smp.scale * smp.scaleX <= 0 || smp.scale * smp.scaleY <= 0;
    },
  };
}

/** Axis-aligned frame-space box of a node where it is drawn at t (the rest pose without t). */
export function nodeBoxAt(doc: Document, node: Node, t: number | undefined, tb: TextBoxFn): Box {
  const c = nodeCornersAt(doc, node, t, tb);
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** True when the layer (or an ancestor) is drawn away from its rest pose at t. */
export function movedAt(doc: Document, node: Node, t: number | undefined, tb: TextBoxFn): boolean {
  if (t === undefined) return false;
  const a = nodeCornersAt(doc, node, t, tb);
  const b = nodeCornersAt(doc, node, undefined, tb);
  return a.some((p, i) => Math.abs(p.x - b[i].x) > 0.25 || Math.abs(p.y - b[i].y) > 0.25);
}

/** True when the node or anything inside it has keyframes. */
export function subtreeAnimated(node: Node): boolean {
  if (hasKeyframes(node)) return true;
  return node.type === "group" && node.children.some(subtreeAnimated);
}

// ---------------------------------------------------------------- writing keyframes at the playhead

const ROUND: Record<TrackName, number> = { dx: 100, dy: 100, scale: 10000, scaleX: 10000, scaleY: 10000, rotate: 100, opacity: 1000, reveal: 1000 };

/** Clamp to the track's range and round to a sensible number of decimals. */
export function cleanValue(track: TrackName, v: number): number {
  const [lo, hi] = TRACK_RANGES[track];
  const c = Math.min(hi, Math.max(lo, v));
  return Math.round(c * ROUND[track]) / ROUND[track];
}

/** The latest keyframe time of the node (any track) strictly before t, else 0. */
export function previousKeyTime(node: Node, t: number): number {
  let best = 0;
  for (const k of TRACKS) for (const kf of Object.values(node.anim?.tracks?.[k] ?? {})) if (kf.t < t && kf.t > best) best = kf.t;
  return best;
}

/**
 * Ops that make `track` of `nodeId` read `v` at time t (Animate mode, PLAN-motion.md §6.1):
 * the keyframe at exactly t gets the value, else a new one is added. When the track was empty
 * the first edit also writes a neutral keyframe at the layer's previous keyframe time on any
 * track (or 0), so the layer animates *to* the new value instead of jumping.
 */
export function keyAtTime(doc: Document, nodeId: string, track: TrackName, v: number, t: number): MotionOp[] {
  const loc = findItem(doc, nodeId);
  if (!loc || loc.kind !== "node") return [];
  const node = loc.item as Node;
  const value = cleanValue(track, v);
  const existing = node.anim?.tracks?.[track] ?? {};
  const same = Object.entries(existing).find(([, k]) => k.t === t);
  if (same) return same[1].v === value ? [] : [{ op: "set", node: nodeId, path: `anim.tracks.${track}.${same[0]}.v`, value }];
  const ops: MotionOp[] = [];
  const taken: string[] = [];
  if (!Object.keys(existing).length) {
    const prev = previousKeyTime(node, t);
    if (prev < t && value !== TRACK_NEUTRAL[track]) {
      const key = nextKeyId(node, track, "k");
      taken.push(key);
      ops.push({ op: "set", node: nodeId, path: `anim.tracks.${track}.${key}`, value: { t: prev, v: TRACK_NEUTRAL[track] } satisfies Keyframe });
    }
  }
  const key = nextKeyId(node, track, "k", taken);
  ops.push({ op: "set", node: nodeId, path: `anim.tracks.${track}.${key}`, value: { t, v: value } satisfies Keyframe });
  return ops;
}

/**
 * Animate-mode move: the layers are drawn `delta` (frame px) further at time t. Writes dx / dy
 * keyframes at t (in each layer's parent space, so a layer inside a rotated group moves with
 * the pointer). The layout (x / y) is not touched.
 */
export function animateMoveOps(doc: Document, ids: string[], delta: Pt, t: number, tb: TextBoxFn): MotionOp[] {
  const ops: MotionOp[] = [];
  for (const id of ids) {
    const loc = findItem(doc, id);
    if (!loc || loc.kind !== "node") continue;
    const node = loc.item as Node;
    const v = applyVec(inv(parentMatrixAt(doc, id, t, tb)), delta);
    const s = sampleNode(node, t);
    if (Math.abs(v.x) > 1e-6) ops.push(...keyAtTime(doc, id, "dx", s.dx + v.x, t));
    if (Math.abs(v.y) > 1e-6) ops.push(...keyAtTime(doc, id, "dy", s.dy + v.y, t));
  }
  return ops;
}

/** Animate-mode rotate: add `delta` degrees to the rotate track at t. */
export function animateRotateOps(doc: Document, ids: string[], delta: number, t: number): MotionOp[] {
  return ids.flatMap((id) => {
    const n = findItem(doc, id)?.item as Node | undefined;
    return n ? keyAtTime(doc, id, "rotate", sampleNode(n, t).rotate + delta, t) : [];
  });
}

/** Which scale track a resize handle drives in Animate mode: corners → scale, sides → scaleX / scaleY. */
export function scaleTrackFor(hx: number, hy: number): TrackName {
  if (hx !== 0.5 && hy !== 0.5) return "scale";
  return hx !== 0.5 ? "scaleX" : "scaleY";
}

/**
 * The relative scale factor of an Animate-mode resize: `q` is the pointer in the layer's rest
 * (pre-motion) parent space, `handle` the handle's rest position there, `origin` the scale
 * anchor. 1 when the handle sits on the anchor (that axis cannot scale from there).
 */
export function scaleFactor(track: TrackName, q: Pt, handle: Pt, origin: Pt): number {
  const f = (a: number, b: number) => (Math.abs(b) < 1e-6 ? 1 : a / b);
  const fx = f(q.x - origin.x, handle.x - origin.x);
  const fy = f(q.y - origin.y, handle.y - origin.y);
  const v = track === "scaleX" ? fx : track === "scaleY" ? fy : Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy;
  return Math.max(0.01, v);
}

/** Rest-pose geometry an Animate-mode resize needs for one layer. */
export function scaleSetup(doc: Document, node: Node, t: number, tb: TextBoxFn, hx: number, hy: number) {
  const pre = mul(parentMatrixAt(doc, node.id, t, tb), animMatrix(node, t, tb)); // rest parent space → frame
  const b = nodeBox(node, tb);
  const handle = applyPt(ownMatrix(node, tb), { x: b.x + b.w * hx, y: b.y + b.h * hy });
  const ab = animBox(node, tb);
  const o = originPoint(node.anim?.origin, ab.w, ab.h);
  return { toRest: inv(pre), handle, origin: { x: ab.x + o.x, y: ab.y + o.y }, sample: sampleNode(node, t) };
}

// ---------------------------------------------------------------- timeline rows

export interface TimelineRow {
  id: string;
  name: string;
  depth: number;
  frame: string;
  tracks: TrackName[];
  range?: [number, number];
}

/**
 * One row per animated layer, plus the selected layers even without motion, in Layers-panel
 * order (frame by frame, front to back, groups before their children).
 */
export function timelineRows(doc: Document, selection: readonly string[]): TimelineRow[] {
  const sel = new Set(selection);
  const rows: TimelineRow[] = [];
  const visit = (nodes: Node[], frame: string, depth: number) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (hasKeyframes(n) || sel.has(n.id)) rows.push({ id: n.id, name: n.name ?? n.id, depth, frame, tracks: activeTracks(n), range: timeRange(n) });
      if (n.type === "group") visit(n.children, frame, depth + 1);
    }
  };
  for (const f of doc.frames) visit(f.children, f.id, 0);
  return rows;
}

// ---------------------------------------------------------------- time snapping

/**
 * Snap a time: to the nearest candidate (other keyframes, the playhead, 0.1 s steps) within
 * `threshold` ms, else to the nearest frame. `free` (Ctrl / ⌘) = whole ms, no snapping.
 */
export function snapTime(t: number, opts: { fps: number; candidates?: number[]; threshold: number; free?: boolean; max?: number }): number {
  const max = opts.max ?? Infinity;
  const clamp = (x: number) => Math.min(max, Math.max(0, x));
  if (opts.free) return clamp(Math.round(t));
  let best: number | undefined;
  let bestD = opts.threshold;
  const consider = (c: number) => {
    const d = Math.abs(c - t);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  };
  for (const c of opts.candidates ?? []) consider(c);
  consider(Math.round(t / 100) * 100);
  return clamp(best ?? snapToFrame(t, opts.fps));
}

// ---------------------------------------------------------------- pins on keyframes

export type KeyPin = "explicit" | "soft" | undefined;

const covers = (a: string, b: string) => a === b || b.startsWith(a + ".") || a.startsWith(b + ".");

/**
 * How a keyframe is protected from the agent: an explicit pin on it, its track, the layer's
 * motion or the whole layer; or a soft pin (he changed it, or part of it, since the agent's
 * last turn).
 */
export function keyframePin(node: Pick<Node, "pins">, softPaths: readonly string[], track: TrackName, key: string): KeyPin {
  const kp = `anim.tracks.${track}.${key}`;
  const ex = node.pins ?? [];
  if (ex.includes("*") || ex.some((p) => p === "anim" || p === `anim.tracks.${track}` || covers(kp, p))) return "explicit";
  return softPaths.some((p) => covers(kp, p) || p === "anim" || p === "anim.tracks" || p === `anim.tracks.${track}`) ? "soft" : undefined;
}

/** True when an agent change touched this keyframe (a diff path under it, or the whole track / motion). */
export function keyframeChanged(paths: readonly string[], track: TrackName, key: string): boolean {
  const kp = `anim.tracks.${track}.${key}`;
  return paths.some((p) => covers(kp, p) || p === "anim" || p === "anim.tracks" || p === `anim.tracks.${track}`);
}

// ---------------------------------------------------------------- wording

/** "1.20 s" */
export const fmtTime = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/** Value of a track for display / editing: px, ×, °, %. */
export function trackUnit(track: TrackName): string {
  return track === "dx" || track === "dy" ? "px" : track === "rotate" ? "°" : track === "opacity" || track === "reveal" ? "0–1" : "×";
}

export const TRACK_LABELS: Record<TrackName, string> = { dx: "move x", dy: "move y", scale: "scale", scaleX: "scale x", scaleY: "scale y", rotate: "rotate", opacity: "opacity", reveal: "reveal" };

/** Node opacity as the renderer applies it (for the Animate-mode opacity field). */
export const ownOpacity = (n: Node) => n.opacity ?? NODE_DEFAULTS.opacity;
