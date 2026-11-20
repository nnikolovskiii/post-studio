// Rich text spans (bold / colour emphasis inside one text node), edited by UTF-16 ranges of
// the node's full text. Pure functions; the in-place editor keeps a <textarea> mirror of the
// plain text and replays its changes here.
import type { TextNode } from "@post-studio/schema";

export type Span = TextNode["spans"][number];
export type SpanColor = NonNullable<Span["fill"]>;

export const fullText = (spans: Span[]) => spans.map((s) => s.text).join("");

const sameColor = (a: Span["fill"], b: Span["fill"]) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameAttrs = (a: Span, b: Span) => a.weight === b.weight && sameColor(a.fill, b.fill);

function attrsOf(s: Span): Omit<Span, "text"> {
  const out: Omit<Span, "text"> = {};
  if (s.fill !== undefined) out.fill = s.fill;
  if (s.weight !== undefined) out.weight = s.weight;
  return out;
}

/** Merge neighbours with the same attributes, drop empty spans (keeping one), drop attributes equal to the base style. */
export function normalize(spans: Span[], base?: { weight: number }): Span[] {
  const out: Span[] = [];
  for (const s0 of spans) {
    const s: Span = { text: s0.text, ...attrsOf(s0) };
    if (base && s.weight === base.weight) delete s.weight;
    if (!s.text) continue;
    const prev = out[out.length - 1];
    if (prev && sameAttrs(prev, s)) prev.text += s.text;
    else out.push(s);
  }
  if (!out.length) {
    const first = spans[0] ? attrsOf(spans[0]) : {};
    if (base && first.weight === base.weight) delete first.weight;
    out.push({ text: "", ...first });
  }
  return out;
}

/** Split so that `at` falls on a span boundary. Returns the index of the span starting at `at`. */
function splitAt(spans: Span[], at: number): number {
  let pos = 0;
  for (let i = 0; i < spans.length; i++) {
    const len = spans[i].text.length;
    if (at === pos) return i;
    if (at < pos + len) {
      const s = spans[i];
      spans.splice(i, 1, { ...attrsOf(s), text: s.text.slice(0, at - pos) }, { ...attrsOf(s), text: s.text.slice(at - pos) });
      return i + 1;
    }
    pos += len;
  }
  return spans.length;
}

/** Attributes in effect at a caret position (those of the character before it, else after). */
export function attrsAt(spans: Span[], index: number): Omit<Span, "text"> {
  let pos = 0;
  for (let i = 0; i < spans.length; i++) {
    const len = spans[i].text.length;
    if (index > pos && index <= pos + len) return attrsOf(spans[i]);
    if (index === 0 && len > 0) return attrsOf(spans[i]);
    pos += len;
  }
  return spans.length ? attrsOf(spans[spans.length - 1]) : {};
}

/** Replace [start, end) with `insert`. Inserted text takes the attributes of the first replaced character, or those at the caret. */
export function replaceRange(spans: Span[], start: number, end: number, insert: string, base?: { weight: number }): Span[] {
  const total = fullText(spans).length;
  const a = Math.max(0, Math.min(start, total));
  const b = Math.max(a, Math.min(end, total));
  const attrs = attrsAt(spans, b > a ? a + 1 : a);
  const work = spans.map((s) => ({ ...s }));
  const i = splitAt(work, a);
  const j = splitAt(work, b);
  work.splice(i, j - i, ...(insert ? [{ ...attrs, text: insert }] : []));
  return normalize(work, base);
}

/** Set (value) or clear (null) one attribute over [start, end). */
export function setRangeAttr<K extends "weight" | "fill">(spans: Span[], start: number, end: number, key: K, value: Span[K] | null, base?: { weight: number }): Span[] {
  if (end <= start) return spans;
  const work = spans.map((s) => ({ ...s }));
  const i = splitAt(work, start);
  const j = splitAt(work, end);
  for (let k = i; k < j; k++) {
    if (value === null || value === undefined) delete work[k][key];
    else work[k][key] = value as Span[K];
  }
  return normalize(work, base);
}

/** Every character in [start, end) has this predicate true. */
export function rangeAll(spans: Span[], start: number, end: number, pred: (s: Span) => boolean): boolean {
  let pos = 0;
  let any = false;
  for (const s of spans) {
    const a = Math.max(start, pos);
    const b = Math.min(end, pos + s.text.length);
    if (b > a) {
      any = true;
      if (!pred(s)) return false;
    }
    pos += s.text.length;
  }
  return any;
}

/** Bold toggle: everything in range heavier than the base → back to base; else → `boldWeight`. */
export function toggleBold(spans: Span[], start: number, end: number, baseWeight: number, boldWeight: number): Span[] {
  const isBold = rangeAll(spans, start, end, (s) => (s.weight ?? baseWeight) > baseWeight);
  return setRangeAttr(spans, start, end, "weight", isBold ? null : boldWeight, { weight: baseWeight });
}

/** The edit that turns `before` into `after`: common prefix and suffix removed. */
export function textDiff(before: string, after: string): { start: number; end: number; insert: string } {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  return { start: p, end: before.length - s, insert: after.slice(p, after.length - s) };
}

export const spansEqual = (a: Span[], b: Span[]) => JSON.stringify(a) === JSON.stringify(b);
