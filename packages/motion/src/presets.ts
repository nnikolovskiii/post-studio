// Animation presets (PLAN-motion.md §6.1, §7): a preset only WRITES ordinary keyframes (two per
// track) at a start time; afterwards they are plain keyframes anyone can drag. There are no
// hidden "preset objects". Several layers can be staggered.
import { findItem, MOTION_LIMITS, type Document, type EaseName, type Node, type OriginName, type TrackName } from "@post-studio/schema";
import { addMotion, DEFAULT_MOTION, MotionError, nextKeyId, keyPath, type MotionOp } from "./ops.ts";

export interface PresetTrack {
  track: TrackName;
  from: number;
  to: number;
  /** Offset presets scale with `distance`. */
  distance?: boolean;
}

export interface Preset {
  id: string;
  label: string;
  /** 'in' presets end at the rest pose, 'out' presets start from it. Keyframe ids use it as prefix. */
  kind: "in" | "out";
  tracks: PresetTrack[];
  ease: EaseName;
  origin?: OriginName;
  textOnly?: boolean;
}

/** Default length of a preset (ms) and the slide distance (px). */
export const PRESET_DEFAULTS = { dur: 600, distance: 40, slideX: 80 } as const;

export const PRESETS: readonly Preset[] = [
  { id: "fade-in", label: "Fade in", kind: "in", ease: "out", tracks: [{ track: "opacity", from: 0, to: 1 }] },
  {
    id: "slide-up-in",
    label: "Slide up in",
    kind: "in",
    ease: "out",
    tracks: [
      { track: "dy", from: PRESET_DEFAULTS.distance, to: 0, distance: true },
      { track: "opacity", from: 0, to: 1 },
    ],
  },
  {
    id: "slide-in-left",
    label: "Slide in from left",
    kind: "in",
    ease: "out",
    tracks: [
      { track: "dx", from: -PRESET_DEFAULTS.slideX, to: 0, distance: true },
      { track: "opacity", from: 0, to: 1 },
    ],
  },
  {
    id: "slide-in-right",
    label: "Slide in from right",
    kind: "in",
    ease: "out",
    tracks: [
      { track: "dx", from: PRESET_DEFAULTS.slideX, to: 0, distance: true },
      { track: "opacity", from: 0, to: 1 },
    ],
  },
  {
    id: "pop",
    label: "Pop",
    kind: "in",
    ease: "back-out",
    origin: "center",
    tracks: [
      { track: "scale", from: 0.8, to: 1 },
      { track: "opacity", from: 0, to: 1 },
    ],
  },
  { id: "grow-left", label: "Grow from left", kind: "in", ease: "out", origin: "left", tracks: [{ track: "scaleX", from: 0, to: 1 }] },
  { id: "grow-bottom", label: "Grow from bottom", kind: "in", ease: "out", origin: "bottom", tracks: [{ track: "scaleY", from: 0, to: 1 }] },
  { id: "typewriter", label: "Typewriter", kind: "in", ease: "linear", textOnly: true, tracks: [{ track: "reveal", from: 0, to: 1 }] },
  { id: "fade-out", label: "Fade out", kind: "out", ease: "in", tracks: [{ track: "opacity", from: 1, to: 0 }] },
  {
    id: "slide-down-out",
    label: "Slide down out",
    kind: "out",
    ease: "in",
    tracks: [
      { track: "dy", from: 0, to: PRESET_DEFAULTS.distance, distance: true },
      { track: "opacity", from: 1, to: 0 },
    ],
  },
];

/** Other names agents may use. */
export const PRESET_ALIASES: Readonly<Record<string, string>> = { "fade-up": "slide-up-in", "slide-up": "slide-up-in", "slide-left": "slide-in-left", "slide-right": "slide-in-right" };

export function getPreset(id: string): Preset | undefined {
  const real = PRESET_ALIASES[id] ?? id;
  return PRESETS.find((p) => p.id === real);
}

export interface PresetOptions {
  /** Start of the first layer's animation, ms. */
  at: number;
  /** Length, ms. Default 600. */
  dur?: number;
  /** Override the preset's ease (the curve from its first keyframe to its second). */
  ease?: EaseName;
  /** Each further layer starts this many ms after the previous one. Default 0. */
  stagger?: number;
  /** Slide distance in px for offset presets (sign is the preset's). */
  distance?: number;
  /** Add `$doc.motion` (6 s or longer, 30 fps, loop) when the document has none. Default true. */
  ensureMotion?: boolean;
}

/**
 * Ops that put a preset on one or more layers, in the given order (stagger follows it; see
 * readingOrder()). Keyframe ids are `in<n>` / `out<n>`, the next free ones per track. A
 * keyframe at exactly the same time as an existing one on the same track updates that one.
 */
export function presetOps(doc: Document, nodeIds: readonly string[], presetId: string, opts: PresetOptions): MotionOp[] {
  const preset = getPreset(presetId);
  if (!preset) throw new MotionError("bad-preset", `unknown preset '${presetId}' (presets: ${PRESETS.map((p) => p.id).join(", ")})`);
  const ids = [...new Set(nodeIds)];
  if (!ids.length) throw new MotionError("bad-request", "name at least one layer");
  const dur = Math.round(opts.dur ?? PRESET_DEFAULTS.dur);
  const stagger = Math.round(opts.stagger ?? 0);
  const at = Math.round(opts.at);
  if (!(dur > 0)) throw new MotionError("bad-time", `length must be > 0 ms (got ${dur})`);
  if (stagger < 0) throw new MotionError("bad-time", `stagger must be ≥ 0 ms (got ${stagger})`);
  if (at < 0) throw new MotionError("bad-time", `start must be ≥ 0 ms (got ${at})`);
  const end = at + (ids.length - 1) * stagger + dur;
  if (end > MOTION_LIMITS.maxTime) throw new MotionError("bad-time", `the preset would end at ${end} ms (max ${MOTION_LIMITS.maxTime})`);

  const ops: MotionOp[] = [];
  if (opts.ensureMotion !== false && !doc.motion) {
    const duration = Math.min(MOTION_LIMITS.maxDuration, Math.max(DEFAULT_MOTION.duration, Math.ceil(end / 1000) * 1000));
    ops.push(...addMotion(doc, { ...DEFAULT_MOTION, duration }));
  }
  ids.forEach((id, i) => {
    const loc = findItem(doc, id);
    if (!loc || loc.kind !== "node") throw new MotionError("not-found", `node '${id}' not found`);
    const node = loc.item as Node;
    if (preset.textOnly && node.type !== "text") throw new MotionError("text-only", `'${preset.id}' works on text layers only; '${id}' is a ${node.type}`);
    const start = at + i * stagger;
    if (preset.origin && (node.anim?.origin ?? "center") !== preset.origin) ops.push({ op: "set", node: id, path: "anim.origin", value: preset.origin });
    for (const pt of preset.tracks) {
      const scale = pt.distance && opts.distance !== undefined ? Math.abs(opts.distance) / Math.abs(pt.from || pt.to || 1) : 1;
      const from = pt.from * scale;
      const to = pt.to * scale;
      const existing = node.anim?.tracks?.[pt.track] ?? {};
      const at0 = Object.entries(existing).find(([, k]) => k.t === start);
      const at1 = Object.entries(existing).find(([, k]) => k.t === start + dur);
      const fresh: string[] = [];
      const write = (t: number, v: number, ease: EaseName | undefined, same: [string, { v: number; ease?: EaseName }] | undefined) => {
        if (same) {
          const [key, k] = same;
          if (k.v !== v) ops.push({ op: "set", node: id, path: `${keyPath(pt.track, key)}.v`, value: v });
          if (ease && k.ease !== ease) ops.push({ op: "set", node: id, path: `${keyPath(pt.track, key)}.ease`, value: ease });
          return;
        }
        const key = nextKeyId(node, pt.track, preset.kind, fresh);
        fresh.push(key);
        ops.push({ op: "set", node: id, path: keyPath(pt.track, key), value: { t, v, ...(ease ? { ease } : {}) } });
      };
      write(start, from, opts.ease ?? preset.ease, at0);
      write(start + dur, to, undefined, at1);
    }
  });
  return ops;
}

/** Layer ids sorted top-to-bottom, then left-to-right, by their absolute position. */
export function readingOrder(doc: Document, nodeIds: readonly string[]): string[] {
  const pos = new Map<string, [number, number]>();
  for (const id of nodeIds) {
    const loc = findItem(doc, id);
    if (!loc || loc.kind !== "node") throw new MotionError("not-found", `node '${id}' not found`);
    const n = loc.item as Node;
    pos.set(id, [loc.offset.y + Math.min(n.y, n.y + n.h), loc.offset.x + Math.min(n.x, n.x + n.w)]);
  }
  return [...nodeIds].sort((a, b) => pos.get(a)![0] - pos.get(b)![0] || pos.get(a)![1] - pos.get(b)![1]);
}
