import { DOC_ID, indexDocument, subtreeIds, type Document, type Location, type Node } from "@post-studio/schema";
import { describeAnimChanges, describeMotionChanges } from "@post-studio/motion";
import type { Op } from "./types.ts";

export interface PropChange {
  path: string;
  from?: unknown;
  to?: unknown;
}

export interface ItemDiff {
  id: string;
  kind: "added" | "deleted" | "changed";
  itemKind: "doc" | "frame" | "node";
  type?: string;
  role?: string;
  name?: string;
  frame?: string;
  parent?: { from?: string; to?: string };
  index?: { from: number; to: number };
  changes: PropChange[];
  /** Filled by attribute(). */
  authors?: string[];
  revs?: [number, number];
}

export interface DocDiff {
  items: ItemDiff[];
  /** Ids with a role that did not change. */
  unchanged: Array<{ id: string; role?: string }>;
}

const SKIP_KEYS = new Set(["children", "id"]);

/** Property-level diff between two versions of a document, by stable id. */
export function diffDocs(a: Document, b: Document): DocDiff {
  const ia = indexDocument(a);
  const ib = indexDocument(b);
  const items: ItemDiff[] = [];

  const docChanges = diffValues(stripDoc(a), stripDoc(b), "");
  if (docChanges.length) items.push({ id: DOC_ID, kind: "changed", itemKind: "doc", changes: docChanges });

  for (const [id, lb] of ib) {
    const la = ia.get(id);
    if (!la) {
      // Report only the root of an added subtree.
      if (lb.parent !== DOC_ID && !ia.has(lb.parent) && ib.has(lb.parent)) continue;
      items.push({ ...head(lb), kind: "added", parent: { to: lb.parent }, changes: [] });
      continue;
    }
    const changes = diffValues(strip(la), strip(lb), "");
    const d: ItemDiff = { ...head(lb), kind: "changed", changes };
    if (la.parent !== lb.parent) d.parent = { from: la.parent, to: lb.parent };
    else if (la.index !== lb.index && reordered(ia, ib, la, lb)) d.index = { from: la.index, to: lb.index };
    if (changes.length || d.parent || d.index) items.push(d);
  }
  for (const [id, la] of ia) {
    if (ib.has(id)) continue;
    // Report only the root of a deleted subtree.
    if (la.parent !== DOC_ID && !ib.has(la.parent) && ia.has(la.parent)) continue;
    items.push({ ...head(la), kind: "deleted", changes: [] });
  }

  const touched = new Set(items.map((i) => i.id));
  const unchanged = [...ib.values()]
    .filter((l) => !touched.has(l.id) && (l.item as Node).role)
    .map((l) => ({ id: l.id, role: (l.item as Node).role }));
  return { items, unchanged };
}

/** True when the relative order of siblings that exist on both sides changed for this node. */
function reordered(ia: Map<string, Location>, ib: Map<string, Location>, la: Location, lb: Location): boolean {
  const sib = (idx: Map<string, Location>, other: Map<string, Location>, parent: string) =>
    [...idx.values()].filter((l) => l.parent === parent && other.has(l.id) && other.get(l.id)!.parent === parent).map((l) => l.id);
  const before = sib(ia, ib, la.parent);
  const after = sib(ib, ia, lb.parent);
  return before.indexOf(la.id) !== after.indexOf(lb.id);
}

function head(l: Location): Omit<ItemDiff, "kind" | "changes"> {
  const n = l.item as Partial<Node> & { name?: string };
  return {
    id: l.id,
    itemKind: l.kind,
    type: l.kind === "frame" ? "frame" : (n.type as string),
    ...(n.role ? { role: n.role } : {}),
    ...(n.name ? { name: n.name } : {}),
    frame: l.frame,
  };
}

function strip(l: Location): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // A frame's `canvas` is where the editor shows it, not part of the design: no diff noise.
  for (const [k, v] of Object.entries(l.item)) if (!SKIP_KEYS.has(k) && !(l.kind === "frame" && k === "canvas")) out[k] = v;
  return out;
}

function stripDoc(d: Document): Record<string, unknown> {
  const { frames: _f, schema: _s, id: _i, ...rest } = d;
  return rest;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function diffValues(a: unknown, b: unknown, path: string): PropChange[] {
  if (isObj(a) && isObj(b)) {
    const out: PropChange[] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out.push(...diffValues(a[k], b[k], path ? `${path}.${k}` : k));
    }
    return out;
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const c: PropChange = { path };
  if (a !== undefined) c.from = a;
  if (b !== undefined) c.to = b;
  return [c];
}

/** Ids an op touches, for attribution. */
function opIds(op: Op): string[] {
  switch (op.op) {
    case "set":
    case "unset":
    case "delete":
    case "move":
      return [op.node];
    case "insert":
      return subtreeIds(op.node);
    case "frame":
      return op.action === "add" ? subtreeIds(op.frame) : [op.frame];
  }
}

/** Fill authors and revision ranges on each item from the revisions between the two versions. */
export function attribute(diff: DocDiff, revisions: Array<{ rev: number; author: string; ops: Op[] }>): DocDiff {
  const by = new Map<string, { authors: Set<string>; min: number; max: number }>();
  for (const r of revisions) {
    for (const op of r.ops) {
      for (const id of opIds(op)) {
        const e = by.get(id) ?? { authors: new Set<string>(), min: r.rev, max: r.rev };
        e.authors.add(r.author);
        e.min = Math.min(e.min, r.rev);
        e.max = Math.max(e.max, r.rev);
        by.set(id, e);
      }
    }
  }
  for (const item of diff.items) {
    const e = by.get(item.id);
    if (e) {
      item.authors = [...e.authors];
      item.revs = [e.min, e.max];
    }
  }
  return diff;
}

/** `{ fill: "hachure", roughness: 1.5, tint: 0.3 }` → "hachure, roughness 1.5, tint 0.3". */
export function sketchWords(v: unknown): string {
  if (!isObj(v)) return String(v);
  const parts = [String(v.fill ?? "hachure")];
  for (const k of ["roughness", "weight", "gap", "angle", "tint", "seed"]) if (v[k] !== undefined) parts.push(`${k} ${num(v[k])}`);
  return parts.join(", ");
}

const num = (v: unknown) => (typeof v === "number" ? String(Math.round(v * 100) / 100) : JSON.stringify(v));
const short = (s: string, n = 40) => {
  const one = s.replace(/\n/g, "\\n");
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};
const color = (v: unknown) => (v === undefined ? "none" : v === null ? "none" : typeof v === "string" ? v : isObj(v) && "token" in v ? `token ${v.token}` : JSON.stringify(v));
const spanText = (v: unknown) => (Array.isArray(v) ? v.map((s: any) => s?.text ?? "").join("") : "");

/** One readable line per changed item, e.g. `headline: moved 0,-24 · size 50 → 56   (human, rev 14–19)`. */
export function formatDiff(diff: DocDiff): string {
  if (!diff.items.length) return "no changes";
  const label = (i: ItemDiff) => (i.id === DOC_ID ? "document" : i.role && i.role !== i.id ? `${i.id} (${i.role})` : i.id);
  const rows = diff.items.map((i) => [label(i), describe(i), who(i)] as const);
  const width = Math.min(28, Math.max(8, ...rows.map((r) => r[0].length + 1)));
  const lines = rows.map(([l, d, w]) => `${(l + ":").padEnd(width)} ${d}${w ? `   (${w})` : ""}`);
  if (diff.unchanged.length) {
    // Name the main roles; the many repeated ones (chart rows, labels, scores) only as a count, so
    // an imported post does not flood an agent's context. The JSON keeps the full list.
    const MAX = 12;
    const counts = new Map<string, number>();
    for (const u of diff.unchanged) counts.set(u.role ?? u.id, (counts.get(u.role ?? u.id) ?? 0) + 1);
    const named = diff.unchanged.filter((u) => (counts.get(u.role ?? u.id) ?? 0) < 5);
    const shown = named.slice(0, MAX).map((u) => u.id);
    const rest = diff.unchanged.length - shown.length;
    const folded = [...counts].filter(([, n]) => n >= 5).map(([r, n]) => `${n} ${r}`);
    lines.push(`${"unchanged:".padEnd(width)} ${shown.join(", ")}${rest ? `${shown.length ? " " : ""}(+${rest} more${folded.length ? `, incl. ${folded.join(", ")}` : ""})` : ""}`);
  }
  return lines.length ? lines.join("\n") : "no changes";
}

function who(i: ItemDiff): string {
  if (!i.authors?.length || !i.revs) return "";
  const [a, b] = i.revs;
  return `${i.authors.join(", ")}, rev ${a === b ? a : `${a}–${b}`}`;
}

export function describe(i: ItemDiff): string {
  if (i.kind === "added") return `added ${i.type}${i.parent?.to ? ` in ${i.parent.to}` : ""}`;
  if (i.kind === "deleted") return "deleted";
  const parts: string[] = [];
  const ch = new Map(i.changes.map((c) => [c.path, c]));
  const take = (p: string) => {
    const c = ch.get(p);
    ch.delete(p);
    return c;
  };
  // Time (post-studio/2): keyframes and the document's motion, in words, after the layout parts.
  const timeParts: string[] = [];
  for (const t of [describeMotionChanges(i.changes), describeAnimChanges(i.changes)]) {
    timeParts.push(...t.parts);
    for (const p of t.used) ch.delete(p);
  }
  const x = take("x"),
    y = take("y");
  if (x || y) {
    const dx = x ? (x.to as number) - (x.from as number) : 0;
    const dy = y ? (y.to as number) - (y.from as number) : 0;
    parts.push(`moved ${num(dx)},${num(dy)}`);
  }
  const w = take("w"),
    h = take("h");
  if (w || h) parts.push(`resized ${w ? `w ${num(w.from)} → ${num(w.to)}` : ""}${w && h ? ", " : ""}${h ? `h ${num(h.from)} → ${num(h.to)}` : ""}`);
  const font = take("style.font"),
    weight = take("style.weight");
  if (font || weight) {
    const f0 = font?.from ?? "",
      f1 = font?.to ?? "";
    parts.push(font ? `font ${f0}${weight ? " " + weight.from : ""} → ${f1}${weight ? " " + weight.to : ""}` : `weight ${weight!.from} → ${weight!.to}`);
  }
  const size = take("style.size");
  if (size) parts.push(`size ${num(size.from)} → ${num(size.to)}`);
  const spans = take("spans");
  if (spans) parts.push(`text "${short(spanText(spans.from))}" → "${short(spanText(spans.to))}"`);
  for (const p of [...ch.keys()].filter((k) => k.startsWith("spans."))) {
    const c = take(p)!;
    parts.push(p.endsWith(".text") ? `text "${short(String(c.from ?? ""))}" → "${short(String(c.to ?? ""))}"` : `${p} ${num(c.from)} → ${num(c.to)}`);
  }
  for (const p of ["fill", "style.fill", "background.color", "stroke.color"]) {
    const c = take(p);
    if (c) parts.push(`${p === "style.fill" ? "color" : p.replace(".color", "")} ${color(c.from)} → ${color(c.to)}`);
  }
  // Hand-drawn look (node.sketch), in words.
  for (const p of [...ch.keys()].filter((k) => k === "sketch" || k.startsWith("sketch."))) {
    const c = take(p)!;
    if (p === "sketch") parts.push(c.to === undefined ? "hand-drawn off" : c.from === undefined ? `hand-drawn on (${sketchWords(c.to)})` : `hand-drawn ${sketchWords(c.from)} → ${sketchWords(c.to)}`);
    else parts.push(`hand-drawn ${p.slice(7)} ${c.from === undefined ? "default" : num(c.from)} → ${c.to === undefined ? "default" : num(c.to)}`);
  }
  const rot = take("rotation");
  if (rot) parts.push(`rotation ${num(rot.from ?? 0)}° → ${num(rot.to ?? 0)}°`);
  const vis = take("visible");
  if (vis) parts.push(vis.to === false ? "hidden" : "shown");
  parts.push(...timeParts);
  for (const c of ch.values()) {
    parts.push(c.to === undefined ? `${c.path} removed` : c.from === undefined ? `${c.path} = ${short(num(c.to))}` : `${c.path} ${short(num(c.from), 30)} → ${short(num(c.to), 30)}`);
  }
  if (i.parent) parts.push(`moved from ${i.parent.from} into ${i.parent.to}`);
  if (i.index) parts.push(`z-order ${i.index.from} → ${i.index.to}`);
  return parts.join(" · ");
}
