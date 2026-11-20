// Baseline-anchored SVG text (x, y = baseline, text-anchor) → post-studio text boxes, using the
// same packages/text metrics the renderer uses, so the glyphs land where they were.
import type { TextNode } from "@post-studio/schema";
import { layout, type FontRegistry } from "@post-studio/text";

export type Anchor = "start" | "middle" | "end";

export interface TextSpec {
  id: string;
  name?: string;
  role?: string;
  /** One entry per line; a line is a list of spans. */
  lines: Array<Array<{ text: string; fill?: string; weight?: number }>>;
  font: string;
  weight: number;
  size: number;
  fill: string;
  anchor: Anchor;
  x: number;
  /** Baseline of the first line. */
  baseline: number;
  /** Baseline distance between lines (px), when there are several. */
  leading?: number;
  letterSpacing?: number;
  opacity?: number;
  meta?: Record<string, unknown>;
}

const r3 = (n: number) => {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
};

/** Join consecutive one-line specs of the same role and style into one multi-line box (headline lines). */
export function mergeLines(items: Array<TextSpec | unknown>, isSpec: (x: unknown) => x is TextSpec): Array<TextSpec | unknown> {
  const out: Array<TextSpec | unknown> = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (isSpec(it) && isSpec(prev) && it.role && it.role === prev.role && it.lines.length === 1 && sameStyle(prev, it)) {
      const step = prev.lines.length === 1 ? it.baseline - prev.baseline : prev.leading!;
      const expected = prev.baseline + step * prev.lines.length;
      if (step > 0 && Math.abs(it.baseline - expected) < 0.01) {
        prev.lines.push(it.lines[0]);
        prev.leading = step;
        delete prev.name; // 'headline-1' no longer describes the merged box
        continue;
      }
    }
    out.push(it);
  }
  return out;
}

function sameStyle(a: TextSpec, b: TextSpec): boolean {
  return a.font === b.font && a.weight === b.weight && a.size === b.size && a.fill === b.fill && a.anchor === b.anchor && Math.abs(a.x - b.x) < 0.01 && (a.letterSpacing ?? 0) === (b.letterSpacing ?? 0) && (a.opacity ?? 1) === (b.opacity ?? 1);
}

export interface BoxContext {
  fonts: FontRegistry;
  lang: string;
  frameW: number;
  /** Safe column inset from the frame edges (social-posts templates: 135 px). */
  inset?: number;
}

/**
 * Text box for a baseline-anchored text. start → auto-width, left; end → auto-width, right;
 * middle on the frame's centre line → a centered fixed-width box over the safe column when the
 * text fits, so it stays centered when the wording changes; other middle → auto-width, centered.
 */
export function textNodeFromSpec(ctx: BoxContext, s: TextSpec): TextNode {
  const spans: TextNode["spans"] = [];
  s.lines.forEach((line, i) => {
    line.forEach((sp, k) => {
      const text = (i > 0 && k === 0 ? "\n" : "") + sp.text;
      const span: TextNode["spans"][number] = { text };
      if (sp.fill && sp.fill.toUpperCase() !== s.fill.toUpperCase()) span.fill = sp.fill.toUpperCase();
      if (sp.weight && sp.weight !== s.weight) span.weight = sp.weight;
      const prev = spans[spans.length - 1];
      if (prev && prev.fill === span.fill && prev.weight === span.weight) prev.text += text;
      else spans.push(span);
    });
  });
  const style: TextNode["style"] = { font: s.font, weight: s.weight, size: s.size, fill: s.fill.toUpperCase() };
  if (s.leading && s.lines.length > 1) style.lineHeight = s.leading / s.size;
  if (s.letterSpacing) style.letterSpacing = r3(s.letterSpacing);

  const auto = layout(ctx.fonts, { spans, style, box: "auto-width", align: "left", w: 0, h: 0 }, ctx.lang);
  const width = auto.width;
  const b0 = auto.lines[0].baseline;
  let box: TextNode["box"] = "auto-width";
  let align: TextNode["align"] = s.anchor === "start" ? "left" : s.anchor === "end" ? "right" : "center";
  let x = s.anchor === "start" ? s.x : s.anchor === "end" ? s.x - width : s.x - width / 2;
  let w = width;
  if (s.anchor === "middle" && Math.abs(s.x - ctx.frameW / 2) < 1) {
    const half = Math.min(s.x, ctx.frameW - s.x) - (ctx.inset ?? 135);
    if (half > 0 && 2 * half >= width + 0.5) {
      const fixed = layout(ctx.fonts, { spans, style, box: "fixed-width", align: "center", w: 2 * half, h: 0 }, ctx.lang);
      if (fixed.lines.length === auto.lines.length) {
        box = "fixed-width";
        align = "center";
        x = s.x - half;
        w = 2 * half;
      }
    }
  }
  const node: TextNode = {
    id: s.id,
    type: "text",
    x: r3(x),
    y: r3(s.baseline - b0),
    w: r3(w),
    h: r3(auto.height),
    box,
    align,
    style,
    spans,
  };
  if (s.name) node.name = s.name;
  if (s.role) node.role = s.role;
  if (s.opacity !== undefined && s.opacity < 1) node.opacity = s.opacity;
  if (s.meta && Object.keys(s.meta).length) node.meta = s.meta;
  return node;
}
