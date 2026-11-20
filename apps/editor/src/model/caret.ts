// Caret and selection geometry for in-place text editing, from the packages/text layout.
// The canvas text is drawn from that layout, so the caret is placed with it too (never from
// browser text metrics). Coordinates are inside the text box: (0, 0) is the box's top-left.
import type { TextLayout } from "@post-studio/text";

export interface CaretRect {
  x: number;
  top: number;
  bottom: number;
  line: number;
}

interface LineSpan {
  /** First caret index on the line. */
  first: number;
  /** Last caret index on the line (inclusive). */
  last: number;
}

/** Caret index ranges per line. Soft-wrapped lines end before the next line's start; paragraphs end at their '\n'. */
function lineSpans(L: TextLayout, text: string): LineSpan[] {
  return L.lines.map((line, i) => {
    const next = L.lines[i + 1];
    if (!next) return { first: line.start, last: text.length };
    const hard = text[next.start - 1] === "\n";
    return { first: line.start, last: hard ? next.start - 1 : Math.max(line.start, next.start - 1) };
  });
}

export function lineOf(L: TextLayout, text: string, index: number): number {
  const spans = lineSpans(L, text);
  for (let i = 0; i < spans.length; i++) if (index <= spans[i].last) return i;
  return Math.max(0, spans.length - 1);
}

/** x (box coordinates) of the caret before character `index` on line `li`. */
function caretX(L: TextLayout, li: number, index: number, spaceAdvance: number): number {
  const line = L.lines[li];
  if (!line) return 0;
  if (index <= line.start) return line.x;
  if (index >= line.end) return line.x + line.width + Math.max(0, index - line.end) * spaceAdvance;
  for (const g of line.glyphs) if (g.cluster >= index) return line.x + g.x;
  return line.x + line.width;
}

export function caretRect(L: TextLayout, text: string, index: number, spaceAdvance: number): CaretRect {
  const li = lineOf(L, text, index);
  const line = L.lines[li];
  if (!line) return { x: 0, top: 0, bottom: L.lineHeight || 10, line: 0 };
  return { x: caretX(L, li, index, spaceAdvance), top: line.baseline - L.ascent, bottom: line.baseline + L.descent, line: li };
}

/** Nearest caret index to a point in box coordinates. */
export function indexAtPoint(L: TextLayout, text: string, p: { x: number; y: number }, spaceAdvance: number): number {
  if (!L.lines.length) return 0;
  const li = Math.max(0, Math.min(L.lines.length - 1, Math.floor(p.y / (L.lineHeight || 1))));
  return indexOnLine(L, text, li, p.x, spaceAdvance);
}

export function indexOnLine(L: TextLayout, text: string, li: number, x: number, spaceAdvance: number): number {
  const span = lineSpans(L, text)[li];
  if (!span) return text.length;
  let best = span.first;
  let dist = Infinity;
  for (let k = span.first; k <= span.last; k++) {
    // Skip positions inside a surrogate pair.
    const c = text.charCodeAt(k);
    if (k > span.first && c >= 0xdc00 && c <= 0xdfff) continue;
    const d = Math.abs(caretX(L, li, k, spaceAdvance) - x);
    if (d < dist) {
      dist = d;
      best = k;
    }
  }
  return best;
}

export function lineStart(L: TextLayout, text: string, index: number): number {
  return lineSpans(L, text)[lineOf(L, text, index)]?.first ?? 0;
}

export function lineEnd(L: TextLayout, text: string, index: number): number {
  return lineSpans(L, text)[lineOf(L, text, index)]?.last ?? text.length;
}

/** Index one line up (-1) or down (+1), keeping the x position. Undefined at the first / last line. */
export function verticalMove(L: TextLayout, text: string, index: number, dir: -1 | 1, preferredX: number | undefined, spaceAdvance: number): { index: number; x: number } {
  const li = lineOf(L, text, index);
  const x = preferredX ?? caretX(L, li, index, spaceAdvance);
  const target = li + dir;
  if (target < 0) return { index: 0, x };
  if (target >= L.lines.length) return { index: text.length, x };
  return { index: indexOnLine(L, text, target, x, spaceAdvance), x };
}

/** Selection highlight rectangles for [a, b) in box coordinates. */
export function selectionRects(L: TextLayout, text: string, a: number, b: number, spaceAdvance: number): Array<{ x: number; y: number; w: number; h: number }> {
  if (b <= a) return [];
  const spans = lineSpans(L, text);
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  spans.forEach((s, li) => {
    const lo = Math.max(a, s.first);
    const hi = Math.min(b, s.last);
    if (hi < lo || (hi === lo && !(b > s.last && a <= s.last))) return;
    const line = L.lines[li];
    const x0 = caretX(L, li, lo, spaceAdvance);
    let x1 = caretX(L, li, hi, spaceAdvance);
    // Selection runs past the end of this line (into the newline / wrap): show a small tail.
    if (b > s.last) x1 += spaceAdvance * 0.6;
    out.push({ x: x0, y: line.baseline - L.ascent, w: Math.max(1, x1 - x0), h: L.ascent + L.descent });
  });
  return out;
}

/** Word around an index (double-click). */
export function wordAt(text: string, index: number): [number, number] {
  const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_'’-]/u.test(c);
  let a = index;
  let b = index;
  if (!isWord(text[a]) && isWord(text[a - 1])) a = b = index - 1;
  if (!isWord(text[a])) return [index, Math.min(text.length, index + 1)];
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  return [a, b];
}
