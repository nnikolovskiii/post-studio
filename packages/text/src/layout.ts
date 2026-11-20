import * as hb from "harfbuzzjs";
import { NODE_DEFAULTS, type TextNode } from "@post-studio/schema";
import type { FontRegistry, LoadedFile } from "./registry-core.ts";

export interface PositionedGlyph {
  file: string;
  weight: number;
  gid: number;
  /** px from the line's left edge (after alignment is NOT applied; add line.x). */
  x: number;
  /** px offset from the baseline (positive = down). */
  y: number;
  /** UTF-16 index in the node's full text. */
  cluster: number;
  span: number;
}

export interface LayoutLine {
  text: string;
  /** UTF-16 range in the full text (end excludes trailing spaces). */
  start: number;
  end: number;
  width: number;
  /** Left offset inside the box from alignment. */
  x: number;
  /** Baseline, px from the box top. */
  baseline: number;
  glyphs: PositionedGlyph[];
}

export interface TextLayout {
  lines: LayoutLine[];
  /** Widest line. */
  width: number;
  /** lines × line height. */
  height: number;
  /** Box size after the box mode is applied. */
  boxW: number;
  boxH: number;
  overflowX: number;
  overflowY: number;
  lineHeight: number;
  ascent: number;
  descent: number;
  missingGlyphs: string[];
}

export interface TextStyleInput {
  font: string;
  weight: number;
  size: number;
  lineHeight?: number;
  letterSpacing?: number;
}

export interface LayoutInput {
  spans: Array<{ text: string; weight?: number }>;
  style: TextStyleInput;
  box: TextNode["box"];
  align: TextNode["align"];
  w: number;
  h: number;
}

const isMark = (cp: number) => /\p{M}/u.test(String.fromCodePoint(cp));
const isSpace = (c: string) => c === " " || c === " " || c === "\t";

/** Text, per-UTF-16-unit advances (px) and glyphs for one paragraph. */
interface Shaped {
  advances: Float64Array;
  glyphs: Array<PositionedGlyph & { absX: number }>;
}

function shapeParagraph(
  reg: FontRegistry,
  text: string,
  offset: number,
  weights: number[],
  spanOf: number[],
  style: TextStyleInput,
  lang: string,
  missing: Set<string>,
): Shaped {
  const advances = new Float64Array(text.length);
  const glyphs: Shaped["glyphs"] = [];
  // Itemize into runs of (weight, file).
  type Run = { start: number; end: number; weight: number; file: LoadedFile };
  const runs: Run[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const weight = weights[offset + i];
    const files = reg.filesFor(style.font, weight);
    const prev = runs[runs.length - 1];
    let file = prev && prev.weight === weight && isMark(cp) && prev.file.unicodes.has(cp) ? prev.file : files.find((f) => f.unicodes.has(cp));
    if (!file) {
      if (!isSpace(text[i]) && cp >= 0x20) missing.add(String.fromCodePoint(cp));
      file = files[0];
    }
    if (prev && prev.weight === weight && prev.file === file) prev.end = i + len;
    else runs.push({ start: i, end: i + len, weight, file });
    i += len;
  }

  let pen = 0;
  const spacing = style.letterSpacing ?? NODE_DEFAULTS.letterSpacing;
  for (const run of runs) {
    const font = reg.font(style.font, run.weight, run.file.file);
    const scale = style.size / run.file.upem;
    const buf = new hb.Buffer();
    buf.addText(text, run.start, run.end - run.start);
    buf.setLanguage(lang);
    buf.guessSegmentProperties();
    hb.shape(font, buf);
    const infos = buf.getGlyphInfos();
    const pos = buf.getGlyphPositions();
    for (let g = 0; g < infos.length; g++) {
      const cluster = infos[g].cluster;
      const ax = pos[g].xAdvance * scale;
      const lastOfCluster = g === infos.length - 1 || infos[g + 1].cluster !== cluster;
      glyphs.push({
        file: run.file.file,
        weight: run.weight,
        gid: infos[g].codepoint,
        x: 0,
        absX: pen + pos[g].xOffset * scale,
        y: -pos[g].yOffset * scale,
        cluster: offset + cluster,
        span: spanOf[offset + cluster],
      });
      const extra = lastOfCluster ? spacing : 0;
      advances[cluster] += ax + extra;
      pen += ax + extra;
    }
  }
  return { advances, glyphs };
}

/** Lay out text with the registered fonts: shaping, line breaks, alignment, overflow. */
export function layout(reg: FontRegistry, input: LayoutInput, lang: string): TextLayout {
  const { style } = input;
  const full = input.spans.map((s) => s.text).join("");
  const weights: number[] = [];
  const spanOf: number[] = [];
  input.spans.forEach((s, si) => {
    for (let i = 0; i < s.text.length; i++) {
      weights.push(s.weight ?? style.weight);
      spanOf.push(si);
    }
  });

  const ext = reg.extents(style.font, style.weight);
  const scale = style.size / ext.upem;
  const ascent = ext.ascender * scale;
  const descent = -ext.descender * scale;
  const lh = style.size * (style.lineHeight ?? NODE_DEFAULTS.lineHeight);
  const halfLeading = (lh - (ascent + descent)) / 2;
  const maxW = input.box === "auto-width" ? Infinity : input.w;

  const missing = new Set<string>();
  const lines: LayoutLine[] = [];
  let offset = 0;
  for (const para of full.split("\n")) {
    const shaped = shapeParagraph(reg, para, offset, weights, spanOf, style, lang, missing);
    const prefix = new Float64Array(para.length + 1);
    for (let i = 0; i < para.length; i++) prefix[i + 1] = prefix[i] + shaped.advances[i];
    const widthOf = (a: number, b: number) => prefix[b] - prefix[a];
    const trimEnd = (a: number, b: number) => {
      while (b > a && isSpace(para[b - 1])) b--;
      return b;
    };

    // Segments end after a run of spaces, after a zero-width space, or after a hyphen between letters.
    const segs: Array<[number, number]> = [];
    let s = 0;
    for (let i = 0; i < para.length; i++) {
      const c = para[i];
      const next = para[i + 1];
      const brk =
        (isSpace(c) && c !== " " && (next === undefined || !isSpace(next))) ||
        c === "​" ||
        ((c === "-" || c === "‐") && i > 0 && /\p{L}/u.test(para[i - 1]) && next !== undefined && /\p{L}/u.test(next));
      if (brk) {
        segs.push([s, i + 1]);
        s = i + 1;
      }
    }
    if (s < para.length || segs.length === 0) segs.push([s, para.length]);

    const ranges: Array<[number, number]> = [];
    let ls = 0;
    for (const [a, b] of segs) {
      const hasContent = trimEnd(ls, a) > ls;
      if (hasContent && widthOf(ls, trimEnd(a, b)) > maxW + 0.01) {
        ranges.push([ls, a]);
        ls = a;
      }
    }
    ranges.push([ls, para.length]);

    for (const [a, b0] of ranges) {
      const b = trimEnd(a, b0);
      const origin = prefix[a];
      lines.push({
        text: para.slice(a, b),
        start: offset + a,
        end: offset + b,
        width: widthOf(a, b),
        x: 0,
        baseline: 0,
        glyphs: shaped.glyphs
          .filter((g) => g.cluster >= offset + a && g.cluster < offset + b)
          .map(({ absX, ...g }) => ({ ...g, x: absX - origin })),
      });
    }
    offset += para.length + 1;
  }

  const width = Math.max(0, ...lines.map((l) => l.width));
  const height = lines.length * lh;
  const boxW = input.box === "auto-width" ? width : input.w;
  const boxH = input.box === "fixed" ? input.h : height;
  lines.forEach((l, i) => {
    l.baseline = halfLeading + ascent + i * lh;
    l.x = input.align === "left" ? 0 : input.align === "center" ? (boxW - l.width) / 2 : boxW - l.width;
  });
  return {
    lines,
    width,
    height,
    boxW,
    boxH,
    overflowX: input.box === "auto-width" ? 0 : Math.max(0, width - input.w),
    overflowY: input.box === "fixed" ? Math.max(0, height - input.h) : 0,
    lineHeight: lh,
    ascent,
    descent,
    missingGlyphs: [...missing],
  };
}

export function layoutNode(reg: FontRegistry, node: TextNode, lang: string): TextLayout {
  return layout(reg, node, lang);
}

/** Single-line advance width in px (what Chrome reports as getComputedTextLength). */
export function measureAdvance(reg: FontRegistry, text: string, style: TextStyleInput, lang: string): number {
  return layout(reg, { spans: [{ text }], style, box: "auto-width", align: "left", w: 0, h: 0 }, lang).width;
}

/** Adapter for @post-studio/ops validateDocument({ measureText }). */
export function measureTextFor(reg: FontRegistry) {
  return (node: TextNode, lang: string) => {
    const l = layoutNode(reg, node, lang);
    return { width: l.width, height: l.height, lines: l.lines.length, overflowX: l.overflowX, overflowY: l.overflowY, missingGlyphs: l.missingGlyphs };
  };
}
