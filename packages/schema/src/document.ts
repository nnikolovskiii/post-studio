// post-studio/2: the canonical scene graph. Pure zod, no defaults applied on parse:
// a validated document is byte-for-byte what was stored, which keeps ops invertible.
// Optional fields fall back to NODE_DEFAULTS / MOTION_DEFAULTS when read.
// post-studio/2 = post-studio/1 + optional `motion` on the document and `anim` on nodes
// (PLAN-motion.md §4.1). A document without them is a still post.
import { z } from "zod";
import { AnimSchema, MotionSchema, type Anim, type Motion } from "./motion.ts";

export const SCHEMA_VERSION = "post-studio/2" as const;

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const PROJECT_ID_RE = /^prj_[A-Za-z0-9]{4,40}$/;

export const IdSchema = z.string().regex(ID_RE, "ids use letters, digits, '_' and '-' (1–64 chars)");
const Finite = z.number().finite();
const Size = Finite.min(0);

export const HexSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/, "colors are #RRGGBB or #RRGGBBAA");
export const TokenRefSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/, "token is '<kit>.<name>'") })
  .strict();
export const ColorSchema = z.union([HexSchema, TokenRefSchema]);

export const StrokeSchema = z
  .object({
    color: ColorSchema,
    width: z.number().positive().max(1000),
    dash: z.array(z.number().min(0)).max(16).optional(),
    cap: z.enum(["butt", "round", "square"]).optional(),
  })
  .strict();

/**
 * Hand-drawn look for a shape (rect, ellipse, line, path): wobbly edges drawn as rough pen
 * strokes and an optional hatched fill, like a marker sketch. The renderer turns it into plain
 * paths from a seeded random sequence, so every render and export of the same document is
 * identical, and the paths keep the shape's own fill / stroke colours (palette rules unchanged).
 */
export const SketchSchema = z
  .object({
    /** How the inside is drawn: 'solid' (wobbly flat fill), 'hachure' (parallel pen lines), 'cross-hatch' (two directions). Default 'hachure'. */
    fill: z.enum(["solid", "hachure", "cross-hatch"]).optional(),
    /** How far edges and lines wander, 0 (straight) – 5. Default 1. */
    roughness: z.number().min(0).max(5).optional(),
    /** Pen width in px for the hatch lines and the outline. Default from the shape size (1–3 px). */
    weight: z.number().min(0.25).max(50).optional(),
    /** Distance between hatch lines in px. Default 2.2 × the pen width. */
    gap: z.number().min(1).max(500).optional(),
    /** Hatch angle in degrees. Default -41. */
    angle: z.number().min(-360).max(360).optional(),
    /** Opacity (0–1) of a flat fill under the hatch lines, so the shape reads as one block. Default 0.3; 0 = lines only. */
    tint: z.number().min(0).max(1).optional(),
    /** Random sequence. Absent = derived from the node id (stable across renders). */
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
  })
  .strict();
export type Sketch = z.infer<typeof SketchSchema>;

export const AssetRefSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "asset refs are 'sha256:<64 hex>'");
export const MetaSchema = z.record(z.string(), z.unknown());

/** Explicit pins on a node: '*' (whole node), '#parent' (z-order / parent), or a property path. */
export const PinSchema = z.string().regex(/^(\*|#parent|#exists|[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9#_-]+)*)$/);

const base = {
  id: IdSchema,
  name: z.string().max(200).optional(),
  role: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/, "roles are lower-case words like 'headline'")
    .optional(),
  x: Finite,
  y: Finite,
  w: Size,
  h: Size,
  rotation: Finite.optional(),
  opacity: z.number().min(0).max(1).optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  pins: z.array(PinSchema).max(64).optional(),
  /** This node is the frame's one accent object (DESIGN §1.4): the brand accent colour may only be used inside it. Role 'accent' means the same. */
  accent: z.boolean().optional(),
  /** Keyframes (post-studio/2). Offsets / multipliers on top of the layout above. */
  anim: AnimSchema.optional(),
  meta: MetaSchema.optional(),
};

export const TextStyleSchema = z
  .object({
    font: z.string().min(1).max(100),
    weight: z.number().int().min(1).max(1000),
    size: z.number().positive().max(2000),
    /** Multiplier of size. Default 1.2. */
    lineHeight: z.number().positive().max(10).optional(),
    /** Extra px after every character cluster. Default 0. */
    letterSpacing: Finite.optional(),
    fill: ColorSchema,
  })
  .strict();

export const SpanSchema = z
  .object({
    text: z.string().max(20_000),
    fill: ColorSchema.optional(),
    weight: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export const TextNodeSchema = z
  .object({
    ...base,
    type: z.literal("text"),
    /** auto-width: w/h follow the text. fixed-width: wraps at w, h follows. fixed: both fixed, overflow reported. */
    box: z.enum(["auto-width", "fixed-width", "fixed"]),
    align: z.enum(["left", "center", "right"]),
    style: TextStyleSchema,
    spans: z.array(SpanSchema).min(1).max(200),
  })
  .strict();

export const RectNodeSchema = z
  .object({
    ...base,
    type: z.literal("rect"),
    fill: ColorSchema.nullable().optional(),
    stroke: StrokeSchema.nullable().optional(),
    radius: Size.optional(),
    sketch: SketchSchema.optional(),
  })
  .strict();

export const EllipseNodeSchema = z
  .object({
    ...base,
    type: z.literal("ellipse"),
    fill: ColorSchema.nullable().optional(),
    stroke: StrokeSchema.nullable().optional(),
    sketch: SketchSchema.optional(),
  })
  .strict();

/** A line runs from (x, y) to (x + w, y + h). w and h may be negative or zero. */
export const LineNodeSchema = z
  .object({
    ...base,
    type: z.literal("line"),
    w: Finite,
    h: Finite,
    stroke: StrokeSchema,
    sketch: SketchSchema.optional(),
  })
  .strict();

/** Path data `d` is in viewBox space and is scaled into x/y/w/h. No point editing. */
export const PathNodeSchema = z
  .object({
    ...base,
    type: z.literal("path"),
    d: z.string().min(1).max(500_000),
    viewBox: z.tuple([Finite, Finite, z.number().positive(), z.number().positive()]),
    fill: ColorSchema.nullable().optional(),
    stroke: StrokeSchema.nullable().optional(),
    sketch: SketchSchema.optional(),
  })
  .strict();

export const ImageNodeSchema = z
  .object({
    ...base,
    type: z.literal("image"),
    asset: AssetRefSchema,
    fit: z.enum(["contain", "cover", "fill"]),
    /** Optional source crop in image pixels: [x, y, w, h]. */
    crop: z.tuple([Size, Size, z.number().positive(), z.number().positive()]).optional(),
  })
  .strict();

export const SvgNodeSchema = z
  .object({
    ...base,
    type: z.literal("svg"),
    asset: AssetRefSchema,
    /** Hex → hex color swap map applied to the art. */
    recolor: z.record(HexSchema, HexSchema).optional(),
  })
  .strict();

export interface BaseNode {
  id: string;
  name?: string;
  role?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  pins?: string[];
  accent?: boolean;
  anim?: Anim;
  meta?: Record<string, unknown>;
}
export type TextNode = z.infer<typeof TextNodeSchema>;
export type RectNode = z.infer<typeof RectNodeSchema>;
export type EllipseNode = z.infer<typeof EllipseNodeSchema>;
export type LineNode = z.infer<typeof LineNodeSchema>;
export type PathNode = z.infer<typeof PathNodeSchema>;
export type ImageNode = z.infer<typeof ImageNodeSchema>;
export type SvgNode = z.infer<typeof SvgNodeSchema>;
export interface GroupNode extends BaseNode {
  type: "group";
  children: Node[];
}
export type Node = TextNode | RectNode | EllipseNode | LineNode | PathNode | ImageNode | SvgNode | GroupNode;
export type NodeType = Node["type"];

/** Children of a group are positioned relative to the group's x/y. */
export const GroupNodeSchema: z.ZodType<GroupNode> = z
  .object({
    ...base,
    type: z.literal("group"),
    get children() {
      return z.array(NodeSchema).max(2000);
    },
  })
  .strict() as unknown as z.ZodType<GroupNode>;

export const NodeSchema: z.ZodType<Node> = z.discriminatedUnion("type", [
  TextNodeSchema,
  RectNodeSchema,
  EllipseNodeSchema,
  LineNodeSchema,
  PathNodeSchema,
  ImageNodeSchema,
  SvgNodeSchema,
  GroupNodeSchema as any,
]) as unknown as z.ZodType<Node>;

export const FrameSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(200),
    w: z.number().int().positive().max(20_000),
    h: z.number().int().positive().max(20_000),
    background: z.object({ color: ColorSchema }).strict().nullable().optional(),
    /** Guide set name, e.g. 'lux/ig-1080'. Resolved by the editor (Phase 3). */
    guides: z.string().max(100).optional(),
    /**
     * Where the editor shows this frame on its canvas (world px, top-left). Editor layout only:
     * not rendered, not exported, left out of diffs and soft pins. Absent = the automatic row
     * (to the right of every other frame).
     */
    canvas: z.object({ x: Finite.min(-1_000_000).max(1_000_000), y: Finite.min(-1_000_000).max(1_000_000) }).strict().optional(),
    pins: z.array(PinSchema).max(64).optional(),
    meta: MetaSchema.optional(),
    children: z.array(NodeSchema).max(5000),
  })
  .strict();
export type Frame = z.infer<typeof FrameSchema>;

export const DocumentSchema = z
  .object({
    schema: z.literal(SCHEMA_VERSION),
    id: z.string().regex(PROJECT_ID_RE, "project ids look like 'prj_…'"),
    title: z.string().min(1).max(200),
    lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/, "BCP 47 language, e.g. 'mk'"),
    /** Brand kit id (brand-kits/<id>.json): tokens resolve to its colours and the palette rules apply. */
    brandKit: z.string().max(100).nullable().optional(),
    /** Strict palette: new off-palette colours / accent problems are errors that block the write (human-only switch). */
    strictPalette: z.boolean().optional(),
    /** Present = a motion project (post-studio/2): length, fps, loop, poster moment. */
    motion: MotionSchema.optional(),
    frames: z.array(FrameSchema).min(1).max(50),
    meta: MetaSchema.optional(),
  })
  .strict();
export type Document = z.infer<typeof DocumentSchema>;
export type { Motion };

/** Values used when an optional field is absent. */
export const NODE_DEFAULTS = {
  rotation: 0,
  opacity: 1,
  visible: true,
  locked: false,
  lineHeight: 1.2,
  letterSpacing: 0,
} as const;

export const NODE_TYPES: readonly NodeType[] = ["text", "rect", "ellipse", "line", "path", "image", "svg", "group"];
