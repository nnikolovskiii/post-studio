// Document → SVG string (pure: no I/O besides reading registered font files for @font-face).
// One renderer for the export, the PNG pipeline and (Phase 3) the editor canvas.
import { isAccentObject, resolveBrandToken } from "@post-studio/brand";
import { NODE_DEFAULTS, type Document, type Frame, type Node, type TextNode } from "@post-studio/schema";
import { hasKeyframes, originPoint, sampleNode, type NodeSample } from "@post-studio/motion";
import { layoutNode, type FontRegistry, type TextLayout } from "@post-studio/text";
import { fontFaceCss, glyphPath } from "./fonts.ts";
import { imageSize } from "./image-size.ts";
import { inlineSvgAsset } from "./svg-asset.ts";
import { sketchPaths, type SketchNode } from "./sketch.ts";
import type { AssetData, RenderOptions, RenderResult, TextMode } from "./types.ts";
import { attrs, dataUri, escText, num, paint, rotateAttr, utf8Text, type Paint } from "./util.ts";

export class RenderError extends Error {}

interface Ctx {
  doc: Document;
  fonts: FontRegistry;
  mode: TextMode;
  positioning: "glyph" | "line";
  assets: RenderOptions["assets"];
  imageHref: (sha: string, data: AssetData) => string;
  resolve: (token: string) => string | undefined;
  warnings: string[];
  used: Map<string, { family: string; weight: number; file: string }>;
  /** Inside the frame's accent object (its art keeps no accent group of its own). */
  inAccent: boolean;
  /** The moment to draw (ms); undefined = the rest pose (no motion applied). */
  time: number | undefined;
}

const FIT_PAR = { contain: "xMidYMid meet", cover: "xMidYMid slice", fill: "none" } as const;

function fillAttrs(p: Paint, prefix: "fill" | "stroke"): Record<string, string | number | undefined> {
  return { [prefix]: p.color, [`${prefix}-opacity`]: p.opacity };
}

function strokeAttrs(ctx: Ctx, stroke: Extract<Node, { type: "rect" }>["stroke"], widthScale = 1): Record<string, string | number | undefined> {
  if (!stroke) return {};
  const p = paint(stroke.color, ctx.resolve, (m) => ctx.warnings.push(m));
  return {
    ...fillAttrs(p, "stroke"),
    "stroke-width": stroke.width / widthScale,
    "stroke-dasharray": stroke.dash?.length ? stroke.dash.map((d) => num(d / widthScale)).join(" ") : undefined,
    "stroke-linecap": stroke.cap,
  };
}

const colorOf = (ctx: Ctx, c: Parameters<typeof paint>[0]) => paint(c, ctx.resolve, (m) => ctx.warnings.push(`${m}`));

function assetSha(ref: string): string {
  return ref.slice("sha256:".length);
}

function missingAsset(ctx: Ctx, node: Node, ref: string): string {
  ctx.warnings.push(`${node.id}: asset ${ref} is missing; drawn as a placeholder`);
  return `<g id="${node.id}"><rect${attrs({ x: node.x, y: node.y, width: node.w, height: node.h, fill: "#FF00FF", "fill-opacity": 0.15, stroke: "#FF00FF", "stroke-width": 2 })}/></g>`;
}

/** Wrap with rotation / opacity when needed. `inner` must not carry the id already. */
function wrap(node: Node, inner: string, cx: number, cy: number, extra: Record<string, string | undefined> = {}): string {
  const transform = rotateAttr(node.rotation, cx, cy);
  const opacity = node.opacity !== undefined && node.opacity !== NODE_DEFAULTS.opacity ? node.opacity : undefined;
  return `<g${attrs({ id: node.id, transform, opacity, ...extra })}>${inner}</g>`;
}

/** Element with id + rotation + opacity directly on it (no wrapper). */
function common(node: Node, cx: number, cy: number): Record<string, string | number | undefined> {
  return {
    id: node.id,
    transform: rotateAttr(node.rotation, cx, cy),
    opacity: node.opacity !== undefined && node.opacity !== NODE_DEFAULTS.opacity ? node.opacity : undefined,
  };
}

/** The text layout, or undefined (with a warning) when the text cannot be laid out. */
function layoutText(ctx: Ctx, node: TextNode): TextLayout | undefined {
  try {
    return layoutNode(ctx.fonts, node, ctx.doc.lang);
  } catch (e) {
    ctx.warnings.push(`${node.id}: ${(e as Error).message}; text skipped`);
    return undefined;
  }
}

/**
 * `reveal` (0–1) → the first hidden UTF-16 index of the text: every character at or after it is
 * not drawn. Units come from the layout already computed: 'char' = glyph clusters that are not
 * white space, 'word' = runs of non-space characters, 'line' = laid-out lines with ink. N of the
 * units are shown, N = floor(reveal × units). Infinity = all of it (reveal 1 changes nothing).
 */
export function revealCut(L: TextLayout, full: string, by: "char" | "word" | "line", reveal: number): number {
  if (!(reveal < 1)) return Infinity;
  const ws = (k: number) => /\s/.test(full[k] ?? " ");
  const starts: number[] = [];
  for (const line of L.lines) {
    if (line.end <= line.start) continue;
    if (by === "line") {
      if (full.slice(line.start, line.end).trim()) starts.push(line.start);
      continue;
    }
    if (by === "word") {
      for (let k = line.start; k < line.end; k++) if (!ws(k) && (k === line.start || ws(k - 1))) starts.push(k);
      continue;
    }
    const clusters = [...new Set(line.glyphs.map((g) => g.cluster))].filter((c) => c >= line.start && c < line.end && !ws(c)).sort((a, b) => a - b);
    starts.push(...clusters);
  }
  const shown = Math.floor(Math.max(0, reveal) * starts.length + 1e-9);
  return shown >= starts.length ? Infinity : starts[shown];
}

function renderText(ctx: Ctx, node: TextNode, layout?: TextLayout, reveal = 1): string {
  const L = layout ?? layoutText(ctx, node);
  if (!L) return "";
  if (L.missingGlyphs.length) ctx.warnings.push(`${node.id}: no glyph for ${L.missingGlyphs.join(" ")}`);
  if (L.overflowX > 0.5 || L.overflowY > 0.5) ctx.warnings.push(`${node.id}: text overflows its box by ${num(L.overflowX)} × ${num(L.overflowY)} px`);
  const { style } = node;
  const full = node.spans.map((s) => s.text).join("");
  const spanOf: number[] = [];
  node.spans.forEach((s, i) => {
    for (let k = 0; k < s.text.length; k++) spanOf.push(i);
  });
  const baseFill = colorOf(ctx, style.fill);
  const cx = node.x + L.boxW / 2;
  const cy = node.y + L.boxH / 2;
  const cut = revealCut(L, full, node.anim?.revealBy ?? "char", reveal);

  for (const line of L.lines) for (const g of line.glyphs) ctx.used.set(`${style.font}|${g.weight}|${g.file}`, { family: style.font, weight: g.weight, file: g.file });

  if (ctx.mode === "outlined") {
    // One path per fill color; glyph outlines from the same HarfBuzz fonts the layout used.
    const byFill = new Map<string, { p: Paint; d: string[] }>();
    for (const line of L.lines) {
      for (const g of line.glyphs) {
        if (g.cluster >= cut) continue;
        const span = node.spans[g.span];
        const p = span?.fill !== undefined ? colorOf(ctx, span.fill) : baseFill;
        const key = `${p.color}|${p.opacity ?? 1}`;
        let entry = byFill.get(key);
        if (!entry) byFill.set(key, (entry = { p, d: [] }));
        const font = ctx.fonts.font(style.font, g.weight, g.file);
        const upem = ctx.fonts.filesFor(style.font, g.weight).find((f) => f.file === g.file)!.upem;
        const d = glyphPath(font, g.gid, node.x + line.x + g.x, Math.round(node.y + line.baseline) + g.y, style.size / upem);
        if (d) entry.d.push(d);
      }
    }
    const paths = [...byFill.values()].filter((e) => e.d.length);
    if (!paths.length) return "";
    const label = full.replace(/\s+/g, " ").trim().slice(0, 120);
    if (paths.length === 1) {
      const e = paths[0];
      return `<path${attrs({ ...common(node, cx, cy), "aria-label": label, d: e.d.join(""), ...fillAttrs(e.p, "fill") })}/>`;
    }
    return wrap(node, paths.map((e) => `<path${attrs({ d: e.d.join(""), ...fillAttrs(e.p, "fill") })}/>`).join(""), cx, cy, { "aria-label": label });
  }

  // Live text: one <text>, one <tspan> per line and span run, each placed at the layout's x / baseline.
  const tspans: string[] = [];
  for (const line of L.lines) {
    const end = Math.min(line.end, cut);
    if (end <= line.start) continue;
    let a = line.start;
    while (a < end) {
      let b = a + 1;
      while (b < end && spanOf[b] === spanOf[a]) b++;
      const span = node.spans[spanOf[a]];
      const first = line.glyphs.find((g) => g.cluster >= a);
      const rx = a === line.start ? 0 : first ? first.x : line.width;
      const fill = span.fill !== undefined ? colorOf(ctx, span.fill) : undefined;
      const xs = ctx.positioning === "glyph" ? charXs(line, full, a, b) : undefined;
      tspans.push(
        `<tspan${attrs({
          x: xs ? xs.map((v) => num(node.x + line.x + v)).join(" ") : node.x + line.x + rx,
          y: Math.round(node.y + line.baseline),
          "font-weight": span.weight !== undefined && span.weight !== style.weight ? String(span.weight) : undefined,
          ...(fill ? fillAttrs(fill, "fill") : {}),
        })}>${escText(full.slice(a, b))}</tspan>`,
      );
      a = b;
    }
  }
  if (!tspans.length) return "";
  const spacing = style.letterSpacing ?? NODE_DEFAULTS.letterSpacing;
  return `<text${attrs({
    ...common(node, cx, cy),
    "font-family": `'${style.font}'`,
    "font-weight": String(style.weight),
    "font-size": style.size,
    "letter-spacing": spacing ? spacing : undefined,
    ...fillAttrs(baseFill, "fill"),
    "xml:space": "preserve",
  })}>${tspans.join("")}</text>`;
}

/**
 * Line-relative x of every UTF-16 unit in [a, b), from the glyph that starts each cluster.
 * Undefined (→ one x for the run) when a character has no glyph of its own (ligatures, marks,
 * surrogate pairs): SVG x lists address characters, and guessing would misplace them.
 */
function charXs(line: TextLayout["lines"][number], full: string, a: number, b: number): number[] | undefined {
  const at = new Map<number, number>();
  for (const g of line.glyphs) if (!at.has(g.cluster)) at.set(g.cluster, g.x);
  const xs: number[] = [];
  for (let k = a; k < b; k++) {
    const c = full.charCodeAt(k);
    if (c >= 0xd800 && c <= 0xdfff) return undefined;
    const x = at.get(k);
    if (x === undefined) return undefined;
    xs.push(x);
  }
  return xs;
}

function renderNode(ctx: Ctx, node: Node): string {
  if (node.visible === false) return "";
  // Motion (PLAN-motion.md §5.2): the node's own markup is unchanged; one wrapper <g> carries the
  // sampled offset / rotate / scale around the origin and the opacity multiplier.
  const sample = ctx.time !== undefined && hasKeyframes(node) ? sampleNode(node, ctx.time) : undefined;
  let layout: TextLayout | undefined;
  if (sample && node.type === "text") {
    layout = layoutText(ctx, node);
    if (!layout) return "";
  }
  let inner: string;
  if (!isAccentObject(node)) inner = renderInner(ctx, node, layout, sample?.reveal);
  else {
    // The accent object becomes post.svg's <g id="accent"> (DESIGN §1.4, check_palette.py).
    const was = ctx.inAccent;
    ctx.inAccent = true;
    const body = renderInner(ctx, node, layout, sample?.reveal);
    ctx.inAccent = was;
    inner = node.type === "group" && node.id === "accent" ? body : `<g id="accent">${body}</g>`;
  }
  if (!sample) return inner;
  const box = layout ? { x: node.x, y: node.y, w: layout.boxW, h: layout.boxH } : nodeBox(node);
  return `<g${attrs(animAttrs(sample, box, node.anim?.origin))}>${inner}</g>`;
}

/** The node's box in its parent's coordinates, normalized (lines may have a negative w / h). */
export function nodeBox(node: Pick<Node, "x" | "y" | "w" | "h">): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(node.x, node.x + node.w), y: Math.min(node.y, node.y + node.h), w: Math.abs(node.w), h: Math.abs(node.h) };
}

/** Scales need more than num()'s 3 decimals near 0 (a bar growing from nothing). */
const num5 = (n: number) => String(Math.round(n * 100000) / 100000);

/**
 * The motion wrapper's attributes for one sample: translate(dx dy), then rotate and scale around
 * the origin anchor of `box`, then the opacity multiplier. A node scaled to 0 or faded to 0 gets
 * opacity 0 and no transform (a singular matrix is not drawn the same way everywhere).
 */
export function animAttrs(s: NodeSample, box: { x: number; y: number; w: number; h: number }, origin?: Parameters<typeof originPoint>[0]): { transform?: string; opacity?: string } {
  const sx = s.scale * s.scaleX;
  const sy = s.scale * s.scaleY;
  if (s.opacity <= 0 || sx <= 0 || sy <= 0) return { opacity: "0" };
  const parts: string[] = [];
  if (s.rotate !== 0 || sx !== 1 || sy !== 1) {
    const o = originPoint(origin, box.w, box.h);
    const ox = box.x + o.x;
    const oy = box.y + o.y;
    parts.push(`translate(${num(s.dx + ox)} ${num(s.dy + oy)})`);
    if (s.rotate !== 0) parts.push(`rotate(${num(s.rotate)})`);
    if (sx !== 1 || sy !== 1) parts.push(`scale(${num5(sx)} ${num5(sy)})`);
    parts.push(`translate(${num(-ox)} ${num(-oy)})`);
  } else if (s.dx !== 0 || s.dy !== 0) parts.push(`translate(${num(s.dx)} ${num(s.dy)})`);
  return { transform: parts.length ? parts.join(" ") : undefined, opacity: s.opacity < 1 ? num5(s.opacity) : undefined };
}

/**
 * A shape with `sketch` (hand-drawn): plain paths from packages/render/src/sketch.ts, in the
 * shape's own colours, inside one <g> that carries the id, rotation and opacity.
 */
function renderSketch(ctx: Ctx, node: SketchNode, cx: number, cy: number): string {
  const fill = node.type === "line" ? { color: "none" } : colorOf(ctx, node.fill);
  const hasFill = fill.color !== "none";
  const st = node.stroke ?? undefined;
  const sp = sketchPaths(node, hasFill, !!st);
  const w = sp.params.weight;
  const parts: string[] = [];
  const pen = (d: string, p: Paint, width: number, extra: Record<string, string | number | undefined> = {}) =>
    `<path${attrs({ d, fill: "none", ...fillAttrs(p, "stroke"), "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round", ...extra })}/>`;
  if (sp.fill) parts.push(`<path${attrs({ d: sp.fill, ...fillAttrs(fill, "fill") })}/>`);
  if (sp.tint) parts.push(`<path${attrs({ d: sp.tint, fill: fill.color, "fill-opacity": num(sp.params.tint * (fill.opacity ?? 1)) })}/>`);
  if (sp.hatch) parts.push(pen(sp.hatch, fill, w));
  if (sp.edge) parts.push(pen(sp.edge, fill, sp.params.fill === "solid" ? Math.max(0.5, w * 0.5) : w));
  if (sp.stroke && st) {
    const p = colorOf(ctx, st.color);
    parts.push(pen(sp.stroke, p, st.width, { "stroke-dasharray": st.dash?.length ? st.dash.map(num).join(" ") : undefined, "stroke-linecap": st.cap ?? "round" }));
  }
  return wrap(node, parts.join(""), cx, cy);
}

function renderInner(ctx: Ctx, node: Node, layout?: TextLayout, reveal?: number): string {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  if ((node.type === "rect" || node.type === "ellipse" || node.type === "line" || node.type === "path") && node.sketch) return renderSketch(ctx, node, cx, cy);
  switch (node.type) {
    case "text":
      return renderText(ctx, node, layout, reveal);
    case "rect": {
      const r = node.radius ? Math.min(node.radius, node.w / 2, node.h / 2) : undefined;
      return `<rect${attrs({ ...common(node, cx, cy), x: node.x, y: node.y, width: node.w, height: node.h, rx: r, ...fillAttrs(colorOf(ctx, node.fill), "fill"), ...strokeAttrs(ctx, node.stroke) })}/>`;
    }
    case "ellipse":
      return `<ellipse${attrs({ ...common(node, cx, cy), cx, cy, rx: node.w / 2, ry: node.h / 2, ...fillAttrs(colorOf(ctx, node.fill), "fill"), ...strokeAttrs(ctx, node.stroke) })}/>`;
    case "line":
      return `<line${attrs({ ...common(node, cx, cy), x1: node.x, y1: node.y, x2: node.x + node.w, y2: node.y + node.h, fill: "none", ...strokeAttrs(ctx, node.stroke) })}/>`;
    case "path": {
      const [vx, vy, vw, vh] = node.viewBox;
      const sx = node.w / vw;
      const sy = node.h / vh;
      const unit = Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9;
      const t = unit ? `translate(${num(node.x - vx)} ${num(node.y - vy)})` : `translate(${num(node.x)} ${num(node.y)}) scale(${num(sx)} ${num(sy)}) translate(${num(-vx)} ${num(-vy)})`;
      const path = `<path${attrs({ transform: t, d: node.d, ...fillAttrs(colorOf(ctx, node.fill), "fill"), ...strokeAttrs(ctx, node.stroke, unit ? 1 : (sx + sy) / 2) })}/>`;
      return wrap(node, path, cx, cy);
    }
    case "image": {
      const sha = assetSha(node.asset);
      const data = ctx.assets(sha);
      if (!data) return missingAsset(ctx, node, node.asset);
      const href = ctx.imageHref(sha, data);
      const par = FIT_PAR[node.fit];
      if (node.crop) {
        const nat = imageSize(data.bytes);
        if (nat) {
          const inner = `<svg${attrs({ x: node.x, y: node.y, width: node.w, height: node.h, viewBox: node.crop.map(num).join(" "), preserveAspectRatio: par })}><image${attrs({ x: 0, y: 0, width: nat.w, height: nat.h, preserveAspectRatio: "none", href })}/></svg>`;
          return wrap(node, inner, cx, cy);
        }
        ctx.warnings.push(`${node.id}: crop ignored (image size unknown)`);
      }
      return `<image${attrs({ ...common(node, cx, cy), x: node.x, y: node.y, width: node.w, height: node.h, preserveAspectRatio: par, href })}/>`;
    }
    case "svg": {
      const sha = assetSha(node.asset);
      const data = ctx.assets(sha);
      if (!data) return missingAsset(ctx, node, node.asset);
      if (data.mime !== "image/svg+xml") {
        ctx.warnings.push(`${node.id}: asset is ${data.mime}, not SVG; drawn as an image`);
        return `<image${attrs({ ...common(node, cx, cy), x: node.x, y: node.y, width: node.w, height: node.h, href: ctx.imageHref(sha, data) })}/>`;
      }
      const r = inlineSvgCached(data, { prefix: `${node.id}--`, x: node.x, y: node.y, w: node.w, h: node.h, recolor: node.recolor, keepAccentId: !ctx.inAccent });
      for (const w of r.warnings) ctx.warnings.push(`${node.id}: ${w}`);
      return wrap(node, r.markup, cx, cy);
    }
    case "group": {
      const transform = `translate(${num(node.x)} ${num(node.y)})${node.rotation ? ` rotate(${num(node.rotation)} ${num(node.w / 2)} ${num(node.h / 2)})` : ""}`;
      const opacity = node.opacity !== undefined && node.opacity !== NODE_DEFAULTS.opacity ? node.opacity : undefined;
      return `<g${attrs({ id: node.id, transform, opacity })}>${node.children.map((c) => renderNode(ctx, c)).join("")}</g>`;
    }
  }
}

// Inlining parses the asset (xmldom); the editor re-renders nodes on every drag frame, so results
// are memoised per asset bytes + placement. Pure inputs → pure output, so a cache is safe.
const svgTextCache = new WeakMap<Uint8Array, string>();
const svgInlineCache = new Map<string, ReturnType<typeof inlineSvgAsset>>();
function inlineSvgCached(data: AssetData, place: Omit<Parameters<typeof inlineSvgAsset>[0], "svg">) {
  let text = svgTextCache.get(data.bytes);
  if (text === undefined) svgTextCache.set(data.bytes, (text = utf8Text(data.bytes)));
  const key = `${text.length}:${hashString(text)}|${JSON.stringify(place)}`;
  let out = svgInlineCache.get(key);
  if (!out) {
    out = inlineSvgAsset({ svg: text, ...place });
    if (svgInlineCache.size > 500) svgInlineCache.delete(svgInlineCache.keys().next().value!);
    svgInlineCache.set(key, out);
  }
  return out;
}

const hashCache = new Map<string, number>();
function hashString(s: string): number {
  let h = hashCache.get(s);
  if (h !== undefined) return h;
  h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  if (hashCache.size > 200) hashCache.delete(hashCache.keys().next().value!);
  hashCache.set(s, h >>> 0);
  return h >>> 0;
}

export function pickFrame(doc: Document, frameId?: string): Frame {
  const frame = frameId ? doc.frames.find((f) => f.id === frameId) : doc.frames[0];
  if (!frame) throw new RenderError(`frame '${frameId}' not found (frames: ${doc.frames.map((f) => f.id).join(", ")})`);
  return frame;
}

function makeCtx(doc: Document, opts: RenderOptions): Ctx {
  return {
    doc,
    fonts: opts.fonts,
    mode: opts.text ?? "live",
    positioning: opts.positioning ?? "glyph",
    assets: opts.assets,
    imageHref: opts.imageHref ?? ((_sha, d) => dataUri(d.mime, d.bytes)),
    resolve: opts.resolveToken ?? resolveBrandToken,
    warnings: [],
    used: new Map(),
    inAccent: false,
    // Time applies to motion projects only: a still document renders exactly as before.
    time: opts.time !== undefined && doc.motion ? opts.time : undefined,
  };
}

/**
 * Node-by-node rendering for the editor canvas: exactly the markup renderSvg puts in the frame,
 * one top-level node at a time, so the canvas can re-render only what changed.
 */
export interface NodeRenderer {
  /** Markup of one node (and its subtree), as it appears inside the frame's <svg>. */
  node(node: Node): string;
  /** The frame background rect ('' when none). */
  background(frame: Frame): string;
  /** Warnings collected so far (deduplicated). */
  warnings(): string[];
}

export function createNodeRenderer(doc: Document, opts: Omit<RenderOptions, "frame">): NodeRenderer {
  const ctx = makeCtx(doc, opts);
  return {
    node: (n) => renderNode(ctx, n),
    background: (frame) => backgroundRect(ctx, frame),
    warnings: () => [...new Set(ctx.warnings)],
  };
}

function backgroundRect(ctx: Ctx, frame: Frame): string {
  const bg = frame.background ? colorOf(ctx, frame.background.color) : undefined;
  return bg && bg.color !== "none" ? `<rect${attrs({ width: frame.w, height: frame.h, ...fillAttrs(bg, "fill") })}/>` : "";
}

/** Render one frame to an SVG string. */
export function renderSvg(doc: Document, opts: RenderOptions): RenderResult {
  const frame = pickFrame(doc, opts.frame);
  const mode = opts.text ?? "live";
  const ctx: Ctx = makeCtx(doc, opts);
  const body = frame.children.map((n) => renderNode(ctx, n)).join("\n");
  const used = [...ctx.used.values()];
  const defs: string[] = [];
  if (mode === "live" && (opts.embedFonts ?? true) && used.length) defs.push(`<style>${fontFaceCss(opts.fonts, used)}</style>`);
  const bgRect = backgroundRect(ctx, frame);
  const parts = [
    `<svg${attrs({ xmlns: "http://www.w3.org/2000/svg", "xmlns:xlink": "http://www.w3.org/1999/xlink", width: frame.w, height: frame.h, viewBox: `0 0 ${frame.w} ${frame.h}`, "xml:lang": doc.lang, lang: doc.lang })}>`,
    opts.title === false ? "" : `<title>${escText(doc.title)}</title>`,
    defs.length ? `<defs>${defs.join("")}</defs>` : "",
    bgRect,
    body,
    "</svg>",
  ];
  return {
    svg: parts.filter(Boolean).join("\n") + "\n",
    frame: { id: frame.id, name: frame.name, w: frame.w, h: frame.h },
    warnings: [...new Set(ctx.warnings)],
    fontsUsed: used,
  };
}
