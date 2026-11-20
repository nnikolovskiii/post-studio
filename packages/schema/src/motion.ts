// post-studio/2 time axis (PLAN-motion.md §4.1). A document with `motion` is a motion project;
// any node may carry `anim` keyframes. Tracks are offsets / multipliers on top of the node's own
// layout (its rest pose), so moving a layer and retiming its motion are different paths.
// Keyframes live in maps keyed by a stable id, so pins, conflicts, diff and revert stay exact.
import { z } from "zod";

export const TRACKS = ["dx", "dy", "scale", "scaleX", "scaleY", "rotate", "opacity", "reveal"] as const;
export type TrackName = (typeof TRACKS)[number];

export const EASES = ["linear", "in", "out", "in-out", "back-out", "hold"] as const;
export type EaseName = (typeof EASES)[number];

export const ORIGINS = ["center", "top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right"] as const;
export type OriginName = (typeof ORIGINS)[number];

export const REVEAL_BY = ["char", "word", "line"] as const;
export type RevealBy = (typeof REVEAL_BY)[number];

export const FPS_VALUES = [24, 25, 30, 60] as const;
export type Fps = (typeof FPS_VALUES)[number];

export const MOTION_LIMITS = {
  minDuration: 500,
  maxDuration: 60_000,
  /** A keyframe time may lie after `duration` (a warning: it never plays), but not beyond this. */
  maxTime: 600_000,
  keyframesPerTrack: 100,
  keyframesPerDocument: 5_000,
  maxScale: 20,
  maxOffset: 100_000,
  maxRotate: 36_000,
} as const;

/** Values used when an optional motion field is absent. */
export const MOTION_DEFAULTS = {
  fps: 30 as Fps,
  loop: false,
  poster: "rest" as const,
  ease: "out" as EaseName,
  origin: "center" as OriginName,
  revealBy: "char" as RevealBy,
} as const;

/** What a missing track means: no offset, no scale, full opacity, the whole text shown. */
export const TRACK_NEUTRAL: Record<TrackName, number> = { dx: 0, dy: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1, reveal: 1 };

export const KEYFRAME_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;

const ranges: Record<TrackName, [number, number]> = {
  dx: [-MOTION_LIMITS.maxOffset, MOTION_LIMITS.maxOffset],
  dy: [-MOTION_LIMITS.maxOffset, MOTION_LIMITS.maxOffset],
  scale: [0, MOTION_LIMITS.maxScale],
  scaleX: [0, MOTION_LIMITS.maxScale],
  scaleY: [0, MOTION_LIMITS.maxScale],
  rotate: [-MOTION_LIMITS.maxRotate, MOTION_LIMITS.maxRotate],
  opacity: [0, 1],
  reveal: [0, 1],
};
export const TRACK_RANGES: Readonly<Record<TrackName, readonly [number, number]>> = ranges;

export const EaseSchema = z.enum(EASES);

const keyframeSchema = (track: TrackName) =>
  z
    .object({
      /** Time in ms from the start. */
      t: z.number().int("keyframe times are whole milliseconds").min(0).max(MOTION_LIMITS.maxTime),
      v: z
        .number()
        .finite()
        .min(ranges[track][0], `${track} values are ${ranges[track][0]}–${ranges[track][1]}`)
        .max(ranges[track][1], `${track} values are ${ranges[track][0]}–${ranges[track][1]}`),
      /** Curve from this keyframe to the next one. Default 'out'. */
      ease: EaseSchema.optional(),
    })
    .strict();

const trackSchema = (track: TrackName) =>
  z
    .record(z.string().regex(KEYFRAME_ID_RE), keyframeSchema(track), {
      error: (iss) => (iss.code === "invalid_key" ? "keyframe ids use letters, digits, '_' and '-' (1–16 chars)" : undefined),
    })
    .refine((m) => Object.keys(m).length <= MOTION_LIMITS.keyframesPerTrack, `at most ${MOTION_LIMITS.keyframesPerTrack} keyframes per track`);

export const KeyframeSchema = keyframeSchema("dx");

export const TracksSchema = z.strictObject(
  Object.fromEntries(TRACKS.map((t) => [t, trackSchema(t).optional()])) as Record<TrackName, z.ZodOptional<ReturnType<typeof trackSchema>>>,
  {
    error: (iss) =>
      iss.code === "unrecognized_keys" ? `unknown track ${(iss.keys as string[]).map((k) => `'${k}'`).join(", ")} (tracks: ${TRACKS.join(", ")})` : undefined,
  },
);

export const AnimSchema = z
  .object({
    /** Anchor for scale and rotate, relative to the node's box. Default 'center'. */
    origin: z.enum(ORIGINS).optional(),
    /** How `reveal` counts text (text nodes only). Default 'char'. */
    revealBy: z.enum(REVEAL_BY).optional(),
    tracks: TracksSchema.optional(),
  })
  .strict();

export const MotionSchema = z
  .object({
    /** Length in ms. */
    duration: z.number().int().min(MOTION_LIMITS.minDuration).max(MOTION_LIMITS.maxDuration),
    fps: z.union(FPS_VALUES.map((f) => z.literal(f)) as [z.ZodLiteral<24>, z.ZodLiteral<25>, z.ZodLiteral<30>, z.ZodLiteral<60>], { error: "fps is 24, 25, 30 or 60" }).optional(),
    /** Preview loops. Export is always one pass of `duration`. */
    loop: z.boolean().optional(),
    /** The still moment: 'rest' (the layout as designed, no animation) or a time in ms. */
    poster: z.union([z.literal("rest"), z.number().int().min(0).max(MOTION_LIMITS.maxDuration)]).optional(),
  })
  .strict();

export interface Keyframe {
  t: number;
  v: number;
  ease?: EaseName;
}
export type Track = Record<string, Keyframe>;
export type Tracks = Partial<Record<TrackName, Track>>;
export interface Anim {
  origin?: OriginName;
  revealBy?: RevealBy;
  tracks?: Tracks;
}
export type Motion = z.infer<typeof MotionSchema>;
