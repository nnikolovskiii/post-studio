// Sampling: the one place that turns keyframes into values at a time t (PLAN-motion.md §5.1).
// The editor preview, the renderer, the video export and the tests all call these functions.
import {
  MOTION_DEFAULTS,
  TRACK_NEUTRAL,
  TRACKS,
  type Anim,
  type Fps,
  type Keyframe,
  type Motion,
  type Node,
  type OriginName,
  type Track,
  type TrackName,
} from "@post-studio/schema";
import { ease } from "./ease.ts";

/** A keyframe with its id, as returned by sortedKeyframes(). */
export interface KeyframeEntry extends Keyframe {
  key: string;
}

/** Keyframes of a track in time order. Equal times are ordered by id, so the order is stable. */
export function sortedKeyframes(track: Track | undefined): KeyframeEntry[] {
  if (!track) return [];
  return Object.entries(track)
    .map(([key, k]) => ({ key, ...k }))
    .sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The value of one track at time t (ms). Before the first keyframe it holds the first value,
 * after the last it holds the last. Between two keyframes the first one's ease applies. When two
 * keyframes share a time the later one (by id) wins from that moment on, which makes a jump.
 * An empty or missing track gives `neutral`.
 */
export function sampleTrack(track: Track | undefined, t: number, neutral = 0): number {
  const keys = sortedKeyframes(track);
  if (keys.length === 0) return neutral;
  if (t < keys[0].t) return keys[0].v;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  if (!b) return a.v;
  const p = (t - a.t) / (b.t - a.t);
  return a.v + (b.v - a.v) * ease(a.ease, p);
}

/** Every track of a node at one moment. Missing tracks are neutral. */
export interface NodeSample {
  dx: number;
  dy: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  rotate: number;
  /** Multiplied with the node's own opacity. */
  opacity: number;
  /** Share of the text shown (text nodes). */
  reveal: number;
}

export const NEUTRAL_SAMPLE: Readonly<NodeSample> = Object.freeze({ ...TRACK_NEUTRAL });

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Sample a node (or a bare `anim`) at time t. Opacity and reveal are clamped to 0–1 and scales
 * to ≥ 0, because a `back-out` overshoot may carry them past their range for a moment.
 */
export function sampleNode(node: Pick<Node, "anim"> | { anim?: Anim } | undefined, t: number): NodeSample {
  const tracks = node?.anim?.tracks;
  if (!tracks) return { ...NEUTRAL_SAMPLE };
  const out = {} as NodeSample;
  for (const name of TRACKS) out[name] = sampleTrack(tracks[name], t, TRACK_NEUTRAL[name]);
  out.opacity = clamp(out.opacity, 0, 1);
  out.reveal = clamp(out.reveal, 0, 1);
  out.scale = Math.max(0, out.scale);
  out.scaleX = Math.max(0, out.scaleX);
  out.scaleY = Math.max(0, out.scaleY);
  return out;
}

/** True when the sample changes nothing (the node draws exactly as at rest). */
export function isNeutral(s: NodeSample): boolean {
  return TRACKS.every((k) => s[k] === TRACK_NEUTRAL[k]);
}

/** True when the node has at least one keyframe. */
export function hasKeyframes(node: { anim?: Anim } | undefined): boolean {
  const tracks = node?.anim?.tracks;
  if (!tracks) return false;
  return TRACKS.some((k) => Object.keys(tracks[k] ?? {}).length > 0);
}

/** Tracks of a node that have keyframes, in the fixed track order. */
export function activeTracks(node: { anim?: Anim } | undefined): TrackName[] {
  const tracks = node?.anim?.tracks;
  if (!tracks) return [];
  return TRACKS.filter((k) => Object.keys(tracks[k] ?? {}).length > 0);
}

/** First and last keyframe time of a node, or undefined without keyframes. */
export function timeRange(node: { anim?: Anim } | undefined): [number, number] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of TRACKS) {
    for (const kf of Object.values(node?.anim?.tracks?.[k] ?? {})) {
      lo = Math.min(lo, kf.t);
      hi = Math.max(hi, kf.t);
    }
  }
  return lo === Infinity ? undefined : [lo, hi];
}

/** The anchor point of `origin` inside a w × h box, relative to the box's top-left corner. */
export function originPoint(origin: OriginName | undefined, w: number, h: number): { x: number; y: number } {
  const o = origin ?? MOTION_DEFAULTS.origin;
  const fx = o.endsWith("left") ? 0 : o.endsWith("right") ? 1 : 0.5;
  const fy = o.startsWith("top") ? 0 : o.startsWith("bottom") ? 1 : 0.5;
  return { x: w * fx, y: h * fy };
}

export function fpsOf(motion: Pick<Motion, "fps"> | undefined): Fps {
  return motion?.fps ?? MOTION_DEFAULTS.fps;
}

/** Number of frames in one pass: round(duration × fps / 1000). */
export function frameCount(motion: Pick<Motion, "duration" | "fps">): number {
  return Math.round((motion.duration * fpsOf(motion)) / 1000);
}

/** Time in ms of frame i: round(i × 1000 / fps). */
export function frameTime(i: number, fps: number): number {
  return Math.round((i * 1000) / fps);
}

/** The moment of every frame of one pass, in ms. */
export function frameTimes(motion: Pick<Motion, "duration" | "fps">): number[] {
  const fps = fpsOf(motion);
  return Array.from({ length: frameCount(motion) }, (_, i) => frameTime(i, fps));
}

/** Snap a time to the nearest frame time. */
export function snapToFrame(t: number, fps: number): number {
  return frameTime(Math.round((t * fps) / 1000), fps);
}

/** The still moment: undefined for 'rest' (no animation applied), else a time in ms. */
export function posterTime(motion: Pick<Motion, "poster"> | undefined): number | undefined {
  const p = motion?.poster ?? MOTION_DEFAULTS.poster;
  return p === "rest" ? undefined : p;
}
