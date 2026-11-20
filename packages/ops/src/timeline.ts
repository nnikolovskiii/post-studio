// `pstudio timeline` (PLAN-motion.md §7): a text timeline an agent can read. One row per animated
// layer with a bar over the length of the post, then one line per track with every keyframe (id,
// time, value, ease). Pins are marked 📌 (whole keyframe) or 📌t / 📌v / 📌ease (one field).
import { fmtDuration, fmtTime, fmtValue, frameCount, hasKeyframes, sortedKeyframes, timeRange } from "@post-studio/motion";
import { MOTION_DEFAULTS, TRACKS, walk, type Document, type Motion, type Node, type TrackName } from "@post-studio/schema";

export interface TimelineKey {
  key: string;
  t: number;
  v: number;
  ease?: string;
  /** Never plays (after the end of the post). */
  late?: boolean;
  /** 'all' = the whole keyframe is pinned; otherwise the pinned fields ('t', 'v', 'ease'). */
  pinned?: "all" | string[];
}

export interface TimelineLayer {
  id: string;
  frame: string;
  type: Node["type"];
  name?: string;
  role?: string;
  depth: number;
  /** First and last keyframe time, ms. */
  range: [number, number];
  origin: string;
  revealBy?: string;
  tracks: Array<{ track: TrackName; keys: TimelineKey[] }>;
}

export interface Timeline {
  motion?: Motion;
  frames?: number;
  /** Pinned $doc.motion fields ('duration', 'fps', … or '*' for the whole object). */
  motionPins: string[];
  layers: TimelineLayer[];
}

type PinLike = { node: string; path: string };

function keyPins(pins: PinLike[], node: string, kp: string): TimelineKey["pinned"] {
  const fields: string[] = [];
  for (const p of pins) {
    if (p.node !== node) continue;
    if (p.path === "*" || p.path === kp || kp.startsWith(p.path + ".")) return "all";
    if (p.path.startsWith(kp + ".")) fields.push(p.path.slice(kp.length + 1));
  }
  return fields.length ? fields : undefined;
}

export function timeline(doc: Document, opts: { pins?: PinLike[] } = {}): Timeline {
  const pins = opts.pins ?? [];
  const layers: TimelineLayer[] = [];
  const end = doc.motion?.duration ?? Infinity;
  for (const loc of walk(doc)) {
    if (loc.kind !== "node") continue;
    const n = loc.item as Node;
    if (!hasKeyframes(n)) continue;
    const tracks = TRACKS.filter((tr) => Object.keys(n.anim?.tracks?.[tr] ?? {}).length).map((track) => ({
      track,
      keys: sortedKeyframes(n.anim!.tracks![track]).map((k) => {
        const pinned = keyPins(pins, n.id, `anim.tracks.${track}.${k.key}`);
        return { key: k.key, t: k.t, v: k.v, ...(k.ease ? { ease: k.ease } : {}), ...(k.t > end ? { late: true } : {}), ...(pinned ? { pinned } : {}) };
      }),
    }));
    layers.push({
      id: n.id,
      frame: loc.frame,
      type: n.type,
      ...(n.name ? { name: n.name } : {}),
      ...(n.role ? { role: n.role } : {}),
      depth: loc.depth - 1,
      range: timeRange(n)!,
      origin: n.anim?.origin ?? MOTION_DEFAULTS.origin,
      ...(n.type === "text" && n.anim?.tracks?.reveal ? { revealBy: n.anim.revealBy ?? MOTION_DEFAULTS.revealBy } : {}),
      tracks,
    });
  }
  const motionPins = pins.filter((p) => p.node === "$doc" && (p.path === "motion" || p.path.startsWith("motion."))).map((p) => (p.path === "motion" ? "*" : p.path.slice(7)));
  return { ...(doc.motion ? { motion: doc.motion, frames: frameCount(doc.motion) } : {}), motionPins, layers };
}

const pinMark = (p: TimelineKey["pinned"]) => (!p ? "" : p === "all" ? " 📌" : ` 📌${p.join(",")}`);

/** The text view: a ruler, a bar per layer, a line per track. `width` = bar columns. */
export function formatTimeline(doc: Document, tl: Timeline = timeline(doc), width = 60): string {
  const lines: string[] = [];
  if (!tl.motion) {
    lines.push(`${doc.title}: a still post (no motion).`);
    if (tl.layers.length) lines.push(`  ${tl.layers.length} layer(s) have keyframes, but they only play once the document has motion ($doc.motion).`);
    else return lines.join("\n");
  } else {
    const m = tl.motion;
    const pinned = tl.motionPins.length ? `  📌${tl.motionPins.join(",")}` : "";
    lines.push(`motion: ${fmtDuration(m.duration)} @ ${m.fps ?? MOTION_DEFAULTS.fps} fps${m.loop ? ", loop" : ""}, poster ${(m.poster ?? "rest") === "rest" ? "rest" : fmtTime(m.poster as number)} · ${tl.frames} frames · ${tl.layers.length} animated layer${tl.layers.length === 1 ? "" : "s"}${pinned}`);
  }
  const dur = tl.motion?.duration ?? Math.max(1000, ...tl.layers.map((l) => l.range[1]));
  const multiFrame = doc.frames.length > 1;
  const label = (l: TimelineLayer) => `${"  ".repeat(l.depth)}${multiFrame ? `${l.frame}/` : ""}${l.id}`;
  const nameW = Math.min(28, Math.max(12, ...tl.layers.map((l) => label(l).length + 2), ...TRACKS.map((t) => t.length + 4)));
  const col = (t: number) => Math.max(0, Math.min(width - 1, Math.floor((t / dur) * width)));
  // Ruler: a label at every whole second (every 5 s for long posts).
  const step = dur > 20_000 ? 5000 : dur > 8000 ? 2000 : 1000;
  const ruler = Array.from({ length: width + 6 }, () => " ");
  for (let t = 0; t <= dur; t += step) {
    const s = `${t / 1000}s`;
    const c = t === dur ? width - 1 : col(t);
    for (let i = 0; i < s.length && c + i < ruler.length; i++) ruler[c + i] = s[i];
  }
  lines.push(`${"".padEnd(nameW)}${ruler.join("").trimEnd()}`);
  for (const l of tl.layers) {
    const bar = Array.from({ length: width }, () => "·");
    const [lo, hi] = l.range;
    if (lo < dur) for (let c = col(lo); c <= col(Math.min(hi, dur)); c++) bar[c] = "█";
    const extra = [l.origin !== MOTION_DEFAULTS.origin ? `origin ${l.origin}` : "", l.revealBy ? `reveal by ${l.revealBy}` : ""].filter(Boolean).join(", ");
    const when = lo === hi ? fmtTime(lo) : `${(lo / 1000).toFixed(2)}–${fmtTime(hi)}`;
    lines.push(`${label(l).padEnd(nameW)}${bar.join("")}  ${when}${extra ? ` · ${extra}` : ""}`);
    for (const tr of l.tracks) {
      const keys = tr.keys.map((k, i) => `${k.key} ${fmtTime(k.t)} ${fmtValue(tr.track, k.v)}${i < tr.keys.length - 1 ? ` (${k.ease ?? MOTION_DEFAULTS.ease})` : ""}${k.late ? " [after the end]" : ""}${pinMark(k.pinned)}`);
      lines.push(`${`${"  ".repeat(l.depth)}  ${tr.track}`.padEnd(nameW)}${keys.join(" → ")}`);
    }
  }
  if (tl.motion && !tl.layers.length) lines.push("  (no keyframes yet: write them with ops, or pstudio anim preset … --out ops.json)");
  return lines.join("\n");
}
