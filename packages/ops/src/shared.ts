// Shared properties of several layers (multi-select editing, Figma style). Pure: the editor's
// Properties panel and phone "Edit together" sheet, and the CLI's `pstudio ops set`, use the same
// field list. A field is one user-facing property ("Fill", "Size") that maps to a document path per
// node type: "fill" is `fill` on a rect / ellipse / path and `style.fill` on a text.
// One change across N layers is one op batch = one revision = one undo.
import { findItem, walk, NODE_DEFAULTS, type Document, type Node, type NodeType } from "@post-studio/schema";
import type { Op } from "./types.ts";

export type FieldKey =
  | "opacity"
  | "rotation"
  | "fill"
  | "radius"
  | "stroke.color"
  | "stroke.width"
  | "font"
  | "weight"
  | "size"
  | "lineHeight"
  | "letterSpacing"
  | "align"
  | "box"
  | "fit";

export interface FieldDef {
  key: FieldKey;
  label: string;
  /** Node types that have this property. */
  types: readonly NodeType[];
  /** Document path on that node. */
  path: (n: Node) => string;
  /** The value as shown (defaults filled in; null = none). */
  get: (n: Node) => unknown;
  /** The value that is stored as "absent" (opacity 1 → unset). */
  unsetWhen?: (v: unknown) => boolean;
}

const SHAPES = ["rect", "ellipse", "path"] as const;
const STROKED = ["rect", "ellipse", "path", "line"] as const;
const ALL: readonly NodeType[] = ["text", "rect", "ellipse", "line", "path", "image", "svg", "group"];
const TEXT = ["text"] as const;
const any = (n: Node) => n as any;

export const FIELDS: readonly FieldDef[] = [
  { key: "opacity", label: "Opacity", types: ALL, path: () => "opacity", get: (n) => n.opacity ?? NODE_DEFAULTS.opacity, unsetWhen: (v) => v === 1 },
  { key: "rotation", label: "Rotation", types: ALL, path: () => "rotation", get: (n) => n.rotation ?? NODE_DEFAULTS.rotation, unsetWhen: (v) => v === 0 },
  { key: "fill", label: "Fill", types: [...SHAPES, "text"], path: (n) => (n.type === "text" ? "style.fill" : "fill"), get: (n) => (n.type === "text" ? n.style.fill : (any(n).fill ?? null)) },
  { key: "radius", label: "Radius", types: ["rect"], path: () => "radius", get: (n) => any(n).radius ?? 0, unsetWhen: (v) => v === 0 },
  { key: "stroke.color", label: "Stroke", types: STROKED, path: () => "stroke.color", get: (n) => any(n).stroke?.color ?? null },
  { key: "stroke.width", label: "Stroke width", types: STROKED, path: () => "stroke.width", get: (n) => any(n).stroke?.width ?? null },
  { key: "font", label: "Font", types: TEXT, path: () => "style.font", get: (n) => any(n).style.font },
  { key: "weight", label: "Weight", types: TEXT, path: () => "style.weight", get: (n) => any(n).style.weight },
  { key: "size", label: "Size", types: TEXT, path: () => "style.size", get: (n) => any(n).style.size },
  { key: "lineHeight", label: "Line height", types: TEXT, path: () => "style.lineHeight", get: (n) => any(n).style.lineHeight ?? NODE_DEFAULTS.lineHeight },
  { key: "letterSpacing", label: "Letter spacing", types: TEXT, path: () => "style.letterSpacing", get: (n) => any(n).style.letterSpacing ?? NODE_DEFAULTS.letterSpacing, unsetWhen: (v) => v === 0 },
  { key: "align", label: "Align", types: TEXT, path: () => "align", get: (n) => any(n).align },
  { key: "box", label: "Box", types: TEXT, path: () => "box", get: (n) => any(n).box },
  { key: "fit", label: "Fit", types: ["image"], path: () => "fit", get: (n) => any(n).fit },
];

export const FIELD_KEYS: readonly FieldKey[] = FIELDS.map((f) => f.key);

export function fieldDef(key: string): FieldDef | undefined {
  return FIELDS.find((f) => f.key === key);
}

export const fieldApplies = (f: FieldDef, n: Node) => f.types.includes(n.type);

/** What a field shows for several layers: one value, or "mixed" when they differ. */
export type SharedValue = { mixed: false; value: unknown } | { mixed: true; values: unknown[] };

export interface SharedField {
  key: FieldKey;
  label: string;
  /** Layers that have this property. */
  ids: string[];
  /** true when every given layer has it (the Figma intersection). */
  all: boolean;
  value: SharedValue;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The shared value of one field over the layers that have it (undefined when none has it). */
export function sharedValue(nodes: Node[], key: FieldKey): SharedValue | undefined {
  const f = fieldDef(key)!;
  const vals = nodes.filter((n) => fieldApplies(f, n)).map((n) => f.get(n));
  if (!vals.length) return undefined;
  if (vals.every((v) => same(v, vals[0]))) return { mixed: false, value: vals[0] };
  const distinct: unknown[] = [];
  for (const v of vals) if (!distinct.some((d) => same(d, v))) distinct.push(v);
  return { mixed: true, values: distinct };
}

/** Every field at least one of the layers has, with its shared value or "mixed". */
export function sharedFields(nodes: Node[]): SharedField[] {
  const out: SharedField[] = [];
  for (const f of FIELDS) {
    const has = nodes.filter((n) => fieldApplies(f, n));
    if (!has.length) continue;
    out.push({ key: f.key, label: f.label, ids: has.map((n) => n.id), all: has.length === nodes.length, value: sharedValue(has, f.key)! });
  }
  return out;
}

/** Layer types in a selection with their counts, e.g. { text: 2, rect: 3 }. */
export function typeCounts(nodes: Node[]): Partial<Record<NodeType, number>> {
  const c: Partial<Record<NodeType, number>> = {};
  for (const n of nodes) c[n.type] = (c[n.type] ?? 0) + 1;
  return c;
}

const DEFAULT_STROKE = { color: "#190F0B", width: 2 };

/**
 * Ops that set one field on every given layer that has it, in one batch. Layers that already have
 * the value get no op; layers without the property are skipped. `undefined` (or the field's default,
 * e.g. opacity 1) unsets it; `null` fill / stroke colour means none. A stroke colour or width on a
 * shape without a stroke adds one (the other part from DEFAULT_STROKE).
 */
export function setFieldOps(doc: Document, ids: string[], key: FieldKey, value: unknown): Op[] {
  const f = fieldDef(key);
  if (!f) throw new Error(`unknown field ${key} (fields: ${FIELD_KEYS.join(", ")})`);
  if (key === "fill" && value === undefined) value = null;
  const ops: Op[] = [];
  for (const id of ids) {
    const loc = findItem(doc, id);
    if (!loc || loc.kind !== "node") continue;
    const n = loc.item as Node;
    if (!fieldApplies(f, n)) continue;
    // A text always has a colour: "no fill" leaves texts alone.
    if (key === "fill" && value === null && n.type === "text") continue;
    if (key === "stroke.color" || key === "stroke.width") {
      const st = (n as any).stroke as { color: unknown; width: number } | null | undefined;
      if (value === null || value === undefined) {
        // No stroke: lines must keep one; shapes drop it.
        if (key === "stroke.color" && st && n.type !== "line") ops.push({ op: "set", node: id, path: "stroke", value: null });
        continue;
      }
      if (!st) {
        ops.push({ op: "set", node: id, path: "stroke", value: { ...DEFAULT_STROKE, [key === "stroke.color" ? "color" : "width"]: value } });
        continue;
      }
    }
    const cur = f.get(n);
    const unset = value === undefined || (f.unsetWhen?.(value) ?? false);
    if (unset) {
      if (hasPath(n, f.path(n))) ops.push({ op: "unset", node: id, path: f.path(n) });
      continue;
    }
    if (same(cur, value)) continue;
    ops.push({ op: "set", node: id, path: f.path(n), value });
  }
  return ops;
}

function hasPath(n: Node, path: string): boolean {
  const parts = path.split(".");
  let o: any = n;
  for (const p of parts.slice(0, -1)) {
    o = o?.[p];
    if (o == null) return false;
  }
  return o != null && Object.prototype.hasOwnProperty.call(o, parts[parts.length - 1]);
}

// ---------------------------------------------------------------- select matching

export interface MatchOptions {
  /** Only these frames (default: the frames of the given layers). */
  frames?: string[];
  /** Also hidden and locked layers (and layers inside hidden or locked groups). Default false. */
  includeHidden?: boolean;
}

export type MatchBy = "type" | "fill";

/**
 * "Select all matching": every visible, unlocked layer in the same frame(s) as `ids` with the same
 * type (by "type") or the same fill colour (by "fill": shape fill or text colour) as one of them.
 * The given layers come first, in their order.
 */
export function matchingIds(doc: Document, ids: string[], by: MatchBy, opts: MatchOptions = {}): string[] {
  const seeds = ids.map((id) => findItem(doc, id)).filter((l) => l?.kind === "node") as Array<{ item: Node; frame: string }>;
  if (!seeds.length) return [];
  const frames = new Set(opts.frames ?? seeds.map((l) => l.frame));
  const fill = fieldDef("fill")!;
  const types = new Set(seeds.map((l) => l.item.type));
  const fills = seeds.filter((l) => fieldApplies(fill, l.item)).map((l) => JSON.stringify(fill.get(l.item)));
  const want = (n: Node) => (by === "type" ? types.has(n.type) : fieldApplies(fill, n) && fill.get(n) !== null && fills.includes(JSON.stringify(fill.get(n))));
  const out = seeds.map((l) => l.item.id);
  for (const f of doc.frames) {
    if (!frames.has(f.id)) continue;
    const visit = (ns: Node[]) => {
      for (const n of ns) {
        if (!opts.includeHidden && (n.visible === false || n.locked)) continue;
        if (want(n) && !out.includes(n.id)) out.push(n.id);
        if (n.type === "group") visit(n.children);
      }
    };
    visit(f.children);
  }
  return out;
}

/** Every layer id of a frame (or all frames) with one of these types: the CLI's `--type`. */
export function idsOfType(doc: Document, types: string[], frame?: string): string[] {
  const out: string[] = [];
  for (const l of walk(doc)) {
    if (l.kind !== "node") continue;
    if (frame && l.frame !== frame) continue;
    if (types.includes((l.item as Node).type)) out.push(l.id);
  }
  return out;
}
