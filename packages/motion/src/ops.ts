// Helpers that WRITE ops for keyframe edits (PLAN-motion.md §5.1, §7). They never apply
// anything: the result goes through the normal apply path (--base, pins, conflicts), so a
// helper can never sneak past one of Nikola's pins. Keyframe edits are plain set / unset ops on
// `anim.tracks.<track>.<key>` and `$doc.motion`.
import {
  DOC_ID,
  findItem,
  KEYFRAME_ID_RE,
  MOTION_DEFAULTS,
  MOTION_LIMITS,
  TRACKS,
  type Document,
  type EaseName,
  type Keyframe,
  type Motion,
  type Node,
  type OriginName,
  type TrackName,
  walk,
} from "@post-studio/schema";

/** Structurally the same as the set / unset ops of @post-studio/ops (no dependency on it). */
export type MotionOp = { op: "set"; node: string; path: string; value: unknown } | { op: "unset"; node: string; path: string };

export class MotionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const trackPath = (track: TrackName) => `anim.tracks.${track}`;
export const keyPath = (track: TrackName, key: string) => `anim.tracks.${track}.${key}`;

function nodeOf(doc: Document, id: string): Node {
  const loc = findItem(doc, id);
  if (!loc || loc.kind !== "node") throw new MotionError("not-found", `node '${id}' not found`);
  return loc.item as Node;
}

function checkTrack(track: string): asserts track is TrackName {
  if (!TRACKS.includes(track as TrackName)) throw new MotionError("bad-track", `unknown track '${track}' (tracks: ${TRACKS.join(", ")})`);
}

function checkTime(t: number) {
  if (!Number.isInteger(t) || t < 0 || t > MOTION_LIMITS.maxTime) throw new MotionError("bad-time", `keyframe times are whole ms 0–${MOTION_LIMITS.maxTime} (got ${t})`);
}

/**
 * A keyframe id not used in this track: `<prefix><n>` with n one above the highest number in
 * use. Ids in `avoid` (e.g. ones deleted earlier in this session) are skipped too.
 */
export function nextKeyId(node: Pick<Node, "anim">, track: TrackName, prefix = "k", avoid: Iterable<string> = []): string {
  const taken = new Set([...Object.keys(node.anim?.tracks?.[track] ?? {}), ...avoid]);
  let n = 0;
  const re = new RegExp(`^${prefix.replace(/[^A-Za-z0-9_-]/g, "")}(\\d+)$`);
  for (const id of taken) {
    const m = re.exec(id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  let id = `${prefix}${n + 1}`;
  while (taken.has(id)) id = `${prefix}${++n + 1}`;
  if (!KEYFRAME_ID_RE.test(id)) throw new MotionError("bad-key", `keyframe id '${id}' is not valid`);
  return id;
}

export interface AddKeyframeOptions {
  /** Keyframe id. Default: the next free `k<n>` (or `<prefix><n>`). */
  key?: string;
  prefix?: string;
  avoid?: Iterable<string>;
  /**
   * When the track already has a keyframe at exactly this time, change that one's value (and
   * ease, when given) instead of adding a second keyframe at the same moment. Default true.
   */
  replaceAtSameTime?: boolean;
}

/** Add a keyframe (or update the one at the same time). */
export function addKeyframe(doc: Document, nodeId: string, track: string, kf: Keyframe, opts: AddKeyframeOptions = {}): MotionOp[] {
  checkTrack(track);
  checkTime(kf.t);
  const node = nodeOf(doc, nodeId);
  const existing = node.anim?.tracks?.[track] ?? {};
  if (opts.replaceAtSameTime !== false && !opts.key) {
    const same = Object.entries(existing).find(([, k]) => k.t === kf.t);
    if (same) {
      const [key, k] = same;
      const ops: MotionOp[] = [];
      if (k.v !== kf.v) ops.push({ op: "set", node: nodeId, path: `${keyPath(track, key)}.v`, value: kf.v });
      if (kf.ease !== undefined && k.ease !== kf.ease) ops.push({ op: "set", node: nodeId, path: `${keyPath(track, key)}.ease`, value: kf.ease });
      return ops;
    }
  }
  const key = opts.key ?? nextKeyId(node, track, opts.prefix, opts.avoid);
  if (!KEYFRAME_ID_RE.test(key)) throw new MotionError("bad-key", `keyframe ids use letters, digits, '_' and '-' (1–16 chars); got '${key}'`);
  if (opts.key && existing[key]) throw new MotionError("duplicate-key", `'${nodeId}' already has ${track} keyframe '${key}'`);
  const value: Keyframe = { t: kf.t, v: kf.v, ...(kf.ease ? { ease: kf.ease } : {}) };
  return [{ op: "set", node: nodeId, path: keyPath(track, key), value }];
}

function keyframeOf(doc: Document, nodeId: string, track: string, key: string): Keyframe {
  checkTrack(track);
  const k = nodeOf(doc, nodeId).anim?.tracks?.[track]?.[key];
  if (!k) throw new MotionError("not-found", `'${nodeId}' has no ${track} keyframe '${key}'`);
  return k;
}

/** Retime one keyframe: writes only its `t`, so a pin on its value or ease is not touched. */
export function moveKeyframe(doc: Document, nodeId: string, track: string, key: string, t: number): MotionOp[] {
  checkTime(t);
  const k = keyframeOf(doc, nodeId, track, key);
  return k.t === t ? [] : [{ op: "set", node: nodeId, path: `${keyPath(track as TrackName, key)}.t`, value: t }];
}

/** Change a keyframe's value and / or ease (not its time). */
export function editKeyframe(doc: Document, nodeId: string, track: string, key: string, patch: { v?: number; ease?: EaseName | null }): MotionOp[] {
  const k = keyframeOf(doc, nodeId, track, key);
  const p = keyPath(track as TrackName, key);
  const ops: MotionOp[] = [];
  if (patch.v !== undefined && patch.v !== k.v) ops.push({ op: "set", node: nodeId, path: `${p}.v`, value: patch.v });
  if (patch.ease === null && k.ease !== undefined) ops.push({ op: "unset", node: nodeId, path: `${p}.ease` });
  else if (patch.ease && patch.ease !== k.ease) ops.push({ op: "set", node: nodeId, path: `${p}.ease`, value: patch.ease });
  return ops;
}

/** Delete one keyframe. */
export function deleteKeyframe(doc: Document, nodeId: string, track: string, key: string): MotionOp[] {
  keyframeOf(doc, nodeId, track, key);
  return [{ op: "unset", node: nodeId, path: keyPath(track as TrackName, key) }];
}

/** Every keyframe of a node (optionally only some tracks). */
function keyframesOf(node: Node, tracks?: readonly TrackName[]): Array<{ track: TrackName; key: string; k: Keyframe }> {
  const out: Array<{ track: TrackName; key: string; k: Keyframe }> = [];
  for (const track of tracks ?? TRACKS) {
    for (const [key, k] of Object.entries(node.anim?.tracks?.[track] ?? {})) out.push({ track, key, k });
  }
  return out;
}

/**
 * Shift a layer's keyframes by `deltaMs` (drag the whole bar). Writes one `t` per keyframe.
 * Refuses a shift that would put a keyframe before 0.
 */
export function shiftKeyframes(doc: Document, nodeId: string, deltaMs: number, opts: { tracks?: readonly TrackName[] } = {}): MotionOp[] {
  if (!Number.isInteger(deltaMs)) throw new MotionError("bad-time", `shift is whole ms (got ${deltaMs})`);
  const all = keyframesOf(nodeOf(doc, nodeId), opts.tracks);
  if (!deltaMs) return [];
  const early = all.find(({ k }) => k.t + deltaMs < 0);
  if (early) throw new MotionError("bad-time", `shifting '${nodeId}' by ${deltaMs} ms would put ${early.track} ${early.key} before 0`);
  for (const { k } of all) checkTime(k.t + deltaMs);
  return all.map(({ track, key, k }) => ({ op: "set" as const, node: nodeId, path: `${keyPath(track, key)}.t`, value: k.t + deltaMs }));
}

/**
 * Stretch a layer's keyframe times around `anchor` (Alt-drag the bar's end): t' = anchor +
 * (t − anchor) × factor, rounded to whole ms.
 */
export function stretchKeyframes(doc: Document, nodeId: string, factor: number, anchor: number, opts: { tracks?: readonly TrackName[] } = {}): MotionOp[] {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new MotionError("bad-factor", `stretch factor must be > 0 (got ${factor})`);
  const ops: MotionOp[] = [];
  for (const { track, key, k } of keyframesOf(nodeOf(doc, nodeId), opts.tracks)) {
    const t = Math.round(anchor + (k.t - anchor) * factor);
    checkTime(t);
    if (t !== k.t) ops.push({ op: "set", node: nodeId, path: `${keyPath(track, key)}.t`, value: t });
  }
  return ops;
}

/** Remove all of a layer's motion. */
export function clearNodeMotion(doc: Document, nodeId: string): MotionOp[] {
  return nodeOf(doc, nodeId).anim ? [{ op: "unset", node: nodeId, path: "anim" }] : [];
}

export const DEFAULT_MOTION: Motion = { duration: 6000, fps: 30, loop: true };

/** Turn a still post into a motion project ("Add motion"). No ops when it already is one. */
export function addMotion(doc: Document, motion: Motion = DEFAULT_MOTION): MotionOp[] {
  return doc.motion ? [] : [{ op: "set", node: DOC_ID, path: "motion", value: { ...motion } }];
}

/** "Remove motion": the document's `motion` and every layer's `anim`, in one batch. */
export function removeMotion(doc: Document): MotionOp[] {
  const ops: MotionOp[] = [];
  for (const loc of walk(doc)) if (loc.kind === "node" && (loc.item as Node).anim) ops.push({ op: "unset", node: loc.id, path: "anim" });
  if (doc.motion) ops.push({ op: "unset", node: DOC_ID, path: "motion" });
  return ops;
}

/** Set a layer's scale / rotate anchor. */
export function setOrigin(doc: Document, nodeId: string, origin: OriginName): MotionOp[] {
  const node = nodeOf(doc, nodeId);
  if ((node.anim?.origin ?? MOTION_DEFAULTS.origin) === origin) return [];
  return [{ op: "set", node: nodeId, path: "anim.origin", value: origin }];
}
