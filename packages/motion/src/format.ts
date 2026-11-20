// Time wording for agents and the History panel (PLAN-motion.md §4.3): the readable lines that
// packages/ops `describe`, `formatDiff` and `outline` print for motion.
import { MOTION_DEFAULTS, TRACKS, type Anim, type Keyframe, type Motion, type TrackName } from "@post-studio/schema";
import { activeTracks, fpsOf, sortedKeyframes, timeRange } from "./sample.ts";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** 400 → "0.40 s". */
export function fmtTime(ms: number, digits = 2): string {
  return `${(ms / 1000).toFixed(digits)} s`;
}

/** 6000 → "6.0 s" (lengths read better with one decimal). */
export function fmtDuration(ms: number): string {
  return fmtTime(ms, ms % 100 === 0 ? 1 : 2);
}

/** A track value: degrees for rotate, plain numbers (≤ 2 decimals) otherwise. */
export function fmtValue(track: string, v: unknown): string {
  if (typeof v !== "number") return JSON.stringify(v);
  const n = String(round(v, 2));
  return track === "rotate" ? `${n}°` : n;
}

/** "6.0 s @ 30 fps, loop, poster rest". */
export function motionSummary(m: Motion): string {
  const poster = m.poster ?? MOTION_DEFAULTS.poster;
  return `${fmtDuration(m.duration)} @ ${fpsOf(m)} fps${m.loop ? ", loop" : ""}, poster ${poster === "rest" ? "rest" : fmtTime(poster)}`;
}

/** One line for a layer's motion: "dy 40→0, opacity 0→1 · 0.40–1.00 s · out". */
export function animSummary(anim: Anim | undefined): string {
  const node = { anim };
  const names = activeTracks(node);
  const extra: string[] = [];
  if (anim?.origin && anim.origin !== MOTION_DEFAULTS.origin) extra.push(`origin ${anim.origin}`);
  if (names.includes("reveal")) extra.push(`by ${anim?.revealBy ?? MOTION_DEFAULTS.revealBy}`);
  if (!names.length) return ["no keyframes", ...extra].join(" · ");
  const eases = new Set<string>();
  const tracks = names.map((name) => {
    const keys = sortedKeyframes(anim!.tracks![name]);
    keys.slice(0, -1).forEach((k) => eases.add(k.ease ?? MOTION_DEFAULTS.ease));
    const vals = keys.map((k) => fmtValue(name, k.v));
    return `${name} ${vals.length > 4 ? [...vals.slice(0, 3), "…", vals[vals.length - 1]].join("→") : vals.join("→")}`;
  });
  const [lo, hi] = timeRange(node)!;
  const when = lo === hi ? fmtTime(lo) : `${(lo / 1000).toFixed(2)}–${fmtTime(hi)}`;
  return [tracks.join(", "), when, ...(eases.size ? [[...eases].join("/")] : []), ...extra].join(" · ");
}

export interface PathChange {
  path: string;
  from?: unknown;
  to?: unknown;
}

const kfLabel = (track: string, k: Keyframe) => `${fmtTime(k.t)} (${fmtValue(track, k.v)}${k.ease ? `, ${k.ease}` : ""})`;

/**
 * Readable parts for the changes of one node under `anim` (paths relative to the node, starting
 * with "anim"). Returns the parts and the paths it consumed; anything else is left to the caller.
 */
export function describeAnimChanges(changes: PathChange[]): { parts: string[]; used: Set<string> } {
  const used = new Set<string>();
  const added = new Map<TrackName, Array<{ key: string; k: Keyframe }>>();
  const removed = new Map<TrackName, Array<{ key: string; k: Keyframe }>>();
  const fields = new Map<string, { track: TrackName; key: string; t?: PathChange; v?: PathChange; ease?: PathChange }>();
  const props: string[] = [];
  let whole: string | undefined;

  const collect = (into: typeof added, value: unknown, track?: TrackName, key?: string) => {
    if (!isObj(value)) return;
    if (track && key) {
      into.set(track, [...(into.get(track) ?? []), { key, k: value as unknown as Keyframe }]);
      return;
    }
    if (track) {
      for (const [k, kf] of Object.entries(value)) collect(into, kf, track, k);
      return;
    }
    for (const t of TRACKS) if (isObj(value[t])) collect(into, value[t], t);
  };

  for (const c of changes) {
    const segs = c.path.split(".");
    if (segs[0] !== "anim") continue;
    const rest = segs.slice(1);
    if (rest.length === 0) {
      used.add(c.path);
      if (c.from === undefined && isObj(c.to)) whole = `new motion: ${animSummary(c.to as Anim)}`;
      else if (c.to === undefined && isObj(c.from)) whole = `motion cleared (was ${animSummary(c.from as Anim)})`;
      else whole = `anim ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`;
      continue;
    }
    if (rest[0] === "origin" && rest.length === 1) {
      used.add(c.path);
      props.push(`origin ${String(c.from ?? MOTION_DEFAULTS.origin)} → ${String(c.to ?? MOTION_DEFAULTS.origin)}`);
      continue;
    }
    if (rest[0] === "revealBy" && rest.length === 1) {
      used.add(c.path);
      props.push(`reveal by ${String(c.from ?? MOTION_DEFAULTS.revealBy)} → ${String(c.to ?? MOTION_DEFAULTS.revealBy)}`);
      continue;
    }
    if (rest[0] !== "tracks") continue;
    const track = rest[1] as TrackName | undefined;
    if (track !== undefined && !TRACKS.includes(track)) continue;
    if (rest.length <= 3) {
      // Whole tracks object, one track or one keyframe appeared or went away.
      used.add(c.path);
      collect(removed, c.from, track, rest[2]);
      collect(added, c.to, track, rest[2]);
      continue;
    }
    if (rest.length === 4 && (rest[3] === "t" || rest[3] === "v" || rest[3] === "ease")) {
      used.add(c.path);
      const id = `${track}.${rest[2]}`;
      const f = fields.get(id) ?? { track: track!, key: rest[2] };
      f[rest[3] as "t" | "v" | "ease"] = c;
      fields.set(id, f);
    }
  }

  const parts: string[] = [];
  if (whole) parts.push(whole);
  const byTrack = (a: { track: TrackName }, b: { track: TrackName }) => TRACKS.indexOf(a.track) - TRACKS.indexOf(b.track);
  for (const f of [...fields.values()].sort(byTrack)) {
    const bits: string[] = [];
    if (f.t) bits.push(`${typeof f.t.from === "number" ? fmtTime(f.t.from) : "?"} → ${typeof f.t.to === "number" ? fmtTime(f.t.to) : "?"}`);
    if (f.v) bits.push(`${fmtValue(f.track, f.v.from)} → ${fmtValue(f.track, f.v.to)}`);
    if (f.ease) bits.push(`ease ${String(f.ease.from ?? MOTION_DEFAULTS.ease)} → ${String(f.ease.to ?? MOTION_DEFAULTS.ease)}`);
    parts.push(`${f.track} ${f.key} ${bits.join(", ")}`);
  }
  const list = (m: typeof added, word: string, withKey: boolean) => {
    for (const track of TRACKS) {
      const ks = (m.get(track) ?? []).sort((a, b) => a.k.t - b.k.t);
      if (!ks.length) continue;
      const items = ks.map(({ key, k }) => (withKey ? `${key} ${kfLabel(track, k)}` : kfLabel(track, k)));
      parts.push(`${word} ${track} keyframe${ks.length > 1 ? "s" : ""} ${items.join(", ")}`);
    }
  };
  list(added, "new", false);
  list(removed, "removed", true);
  parts.push(...props);
  return { parts, used };
}

/** Readable parts for document-level `motion` changes. */
export function describeMotionChanges(changes: PathChange[]): { parts: string[]; used: Set<string> } {
  const used = new Set<string>();
  const parts: string[] = [];
  for (const c of changes) {
    if (c.path === "motion") {
      used.add(c.path);
      if (c.from === undefined && isObj(c.to)) parts.push(`motion added: ${motionSummary(c.to as Motion)}`);
      else if (c.to === undefined) parts.push("motion removed (now a still post)");
      else parts.push(`motion ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
      continue;
    }
    if (!c.path.startsWith("motion.")) continue;
    const field = c.path.slice(7);
    used.add(c.path);
    switch (field) {
      case "duration":
        parts.push(`duration ${typeof c.from === "number" ? fmtDuration(c.from) : "?"} → ${typeof c.to === "number" ? fmtDuration(c.to) : "?"}`);
        break;
      case "fps":
        parts.push(`fps ${String(c.from ?? MOTION_DEFAULTS.fps)} → ${String(c.to ?? MOTION_DEFAULTS.fps)}`);
        break;
      case "loop":
        parts.push(c.to ? "loop on" : "loop off");
        break;
      case "poster": {
        const p = (v: unknown) => (typeof v === "number" ? fmtTime(v) : String(v ?? MOTION_DEFAULTS.poster));
        parts.push(`poster ${p(c.from)} → ${p(c.to)}`);
        break;
      }
      default:
        parts.push(`${c.path} ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
    }
  }
  return { parts, used };
}
