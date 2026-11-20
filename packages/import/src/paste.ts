// SVG pasted or dropped into the editor (Figma "Copy as SVG", an exported .svg, any SVG file)
// → real post-studio nodes. Pure: runs in the browser (the editor) and in Node (tests). The
// caller parses the markup (DOMParser / xmldom) and uploads what this returns (svg pieces,
// embedded rasters) through POST /v1/assets, so everything still passes the server sanitizer.
//
// What becomes what:
// - rect / circle / ellipse / line / path / polygon / polyline with flat colours → shapes
//   (rotation kept when the transform is a rotation; scale or skew → picture);
// - text → editable text: lines from Figma's positioned <tspan>s, left / centre / right found
//   from where the lines start, fonts mapped to a registered family (others → nearest match);
// - groups → groups (named when the SVG names them, opacity kept);
// - embedded PNG / JPEG / WebP <image> → image layers;
// - anything else (gradients, shadows and blurs, masks, real clips, blend modes, <use>, even-odd
//   shapes with holes, rotated text) → an `svg` layer for just that element, cut to its own box
//   (a Figma shadow's filter region included).
import type { GroupNode, Node, TextNode } from "@post-studio/schema";
import { layout, type FontRegistry } from "@post-studio/text";
import { makeGroup, type Box } from "./boxes.ts";
import { Ids } from "./ids.ts";
import { pathBoundsPure } from "./path-bounds.ts";
import { textNodeFromSpec, type Anchor, type TextSpec } from "./text.ts";
import {
  applyMat,
  fam,
  IDENTITY,
  inherit,
  INHERITED,
  kids,
  letterSpacingPx,
  mul,
  num,
  own,
  parseColor,
  parseTransform,
  rigidAngle,
  shapeStroke,
  withAlpha,
  type Attrs,
  type Mat,
  type SvgElementLike,
} from "./svg-common.ts";

export { makeGroup, shift } from "./boxes.ts";
export type { SvgElementLike } from "./svg-common.ts";

export const PLACEHOLDER_ASSET = `sha256:${"0".repeat(64)}`;

export interface PasteOptions {
  fonts: FontRegistry;
  lang: string;
  /** Ids already used in the document (new ids never clash with them). */
  taken?: Iterable<string>;
  /** Markup of one element (XMLSerializer). */
  serialize: (el: SvgElementLike) => string;
  /** Refuse (throw TooComplex) above this many layers; the caller inserts one picture instead. Default 1500. */
  maxNodes?: number;
}

/** An `svg` layer whose asset (this markup) the caller uploads, then sets `node.asset`. */
export interface PastePiece {
  node: Extract<Node, { type: "svg" }>;
  markup: string;
  why: string[];
}
/** An `image` layer whose embedded data: URI the caller uploads, then sets `node.asset`. */
export interface PasteRaster {
  node: Extract<Node, { type: "image" }>;
  href: string;
}

export interface PasteReport {
  /** Layers made (groups included). */
  layers: number;
  texts: number;
  /** Kinds of things kept as picture ("gradient or pattern fill", "shadow or blur", …), with counts. */
  pictures: Record<string, number>;
  /** "Inter → IBM Plex Sans", "IBM Plex Sans 700 → 600", "italic shown upright". */
  fonts: string[];
  /** Left out on purpose (hidden layers, external images). */
  skipped: string[];
}

export interface PasteResult {
  /** The SVG's viewBox: nodes are in these coordinates. */
  viewBox: [number, number, number, number];
  nodes: Node[];
  pieces: PastePiece[];
  rasters: PasteRaster[];
  report: PasteReport;
}

export class PasteError extends Error {}
export class TooComplex extends PasteError {}

const KEYS = INHERITED;
const DEFS_LIKE = new Set(["defs", "style", "linearGradient", "radialGradient", "clipPath", "mask", "filter", "pattern", "symbol", "marker", "script", "foreignObject"]);
const IGNORED = new Set(["title", "desc", "metadata"]);
const SVG_NS = "http://www.w3.org/2000/svg";

type Item =
  | { kind: "node"; node: Node; base: string }
  | { kind: "group"; label?: string; opacity?: number; items: Item[] }
  | { kind: "piece"; els: SvgElementLike[]; inh: Attrs; m: Mat; why: string[]; label?: string }
  | { kind: "raster"; node: Extract<Node, { type: "image" }>; href: string; base: string };

interface Ctx {
  opts: PasteOptions;
  vb: [number, number, number, number];
  byId: Map<string, SvgElementLike>;
  report: PasteReport;
  families: string[];
}

const r3 = (n: number) => {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
};
const firstNum = (v: string | undefined): number | undefined => {
  if (v === undefined || !v.trim()) return undefined;
  const x = parseFloat(v.trim().split(/[\s,]+/)[0]);
  return Number.isFinite(x) ? x : undefined;
};
const len = (v: string | null | undefined): number | undefined => {
  if (v === null || v === undefined || v.trim() === "") return undefined;
  const m = /^\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*(px)?\s*$/i.exec(v);
  return m ? Number(m[1]) : NaN;
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function viewBoxOf(root: SvgElementLike): [number, number, number, number] {
  const vb = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return vb as [number, number, number, number];
  const w = parseFloat(root.getAttribute("width") ?? "");
  const h = parseFloat(root.getAttribute("height") ?? "");
  if (w > 0 && h > 0) return [0, 0, w, h];
  throw new PasteError("The SVG has no size (no viewBox, width or height)");
}

/** Convert a parsed <svg> root. Throws PasteError when it is not usable at all. */
export function svgToNodes(root: SvgElementLike, opts: PasteOptions): PasteResult {
  if (root.localName !== "svg") throw new PasteError("This is not SVG markup");
  const vb = viewBoxOf(root);
  const byId = new Map<string, SvgElementLike>();
  const index = (el: SvgElementLike) => {
    for (const c of kids(el)) {
      const id = c.getAttribute("id");
      if (id && !byId.has(id)) byId.set(id, c);
      index(c);
    }
  };
  index(root);
  const ctx: Ctx = { opts, vb, byId, report: { layers: 0, texts: 0, pictures: {}, fonts: [], skipped: [] }, families: opts.fonts.families() };
  const items = walkList(root, inherit({}, root, KEYS), IDENTITY, ctx);

  const ids = new Ids(opts.taken ?? []);
  const pieces: PastePiece[] = [];
  const rasters: PasteRaster[] = [];
  let count = 0;
  const max = opts.maxNodes ?? 1500;
  const fin = (list: Item[]): Node[] =>
    list.map((it): Node => {
      if (++count > max) throw new TooComplex(`The SVG has more than ${max} layers`);
      switch (it.kind) {
        case "node":
          it.node.id = ids.take(it.base);
          if (it.node.type === "text") ctx.report.texts++;
          return it.node;
        case "raster":
          it.node.id = ids.take(it.base);
          rasters.push({ node: it.node, href: it.href });
          return it.node;
        case "group": {
          const children = fin(it.items);
          return makeGroup(ids.take(it.label ?? "group"), children, { ...(it.label ? { name: it.label } : {}), ...(it.opacity !== undefined ? { opacity: it.opacity } : {}) }) as GroupNode;
        }
        case "piece": {
          const p = buildPiece(it, ctx);
          p.node.id = ids.take(it.label ?? "svg-art");
          for (const w of new Set(it.why)) ctx.report.pictures[w] = (ctx.report.pictures[w] ?? 0) + 1;
          pieces.push(p);
          return p.node;
        }
      }
    });
  const nodes = fin(items);
  ctx.report.layers = count;
  ctx.report.fonts = [...new Set(ctx.report.fonts)];
  return { viewBox: vb, nodes, pieces, rasters, report: ctx.report };
}

// ---------------------------------------------------------------- walking

function walkList(el: SvgElementLike, inh: Attrs, m: Mat, ctx: Ctx): Item[] {
  const out: Item[] = [];
  // One picture layer per element, so each can still be moved, hidden or deleted on its own.
  const pushPiece = (c: SvgElementLike, why: string[], label?: string) => out.push({ kind: "piece", els: [c], inh, m, why: [...why], label });
  for (const c of kids(el)) {
    const name = c.localName ?? "";
    if (IGNORED.has(name) || DEFS_LIKE.has(name)) continue;
    const o = own(c);
    const a = inherit(inh, c, KEYS);
    const label = c.getAttribute("id") ?? c.getAttribute("data-name") ?? undefined;
    if (o.display === "none" || a.visibility === "hidden" || o.visibility === "hidden") {
      ctx.report.skipped.push(`hidden <${name}>${label ? ` "${label}"` : ""}`);
      continue;
    }
    const t = parseTransform(o.transform);
    if (!t) {
      pushPiece(c, ["unusual transform"], label);
      continue;
    }
    const mc = mul(m, t);
    const why: string[] = [];
    if (o.filter && o.filter !== "none") why.push("shadow or blur effect");
    if (o.mask && o.mask !== "none") why.push("mask");
    const blend = o["mix-blend-mode"];
    if (blend && blend !== "normal") why.push("blend mode");
    if (o["clip-path"] && o["clip-path"] !== "none" && !trivialClip(o["clip-path"], mc, ctx)) why.push("clipped content");
    if (why.length) {
      pushPiece(c, why, label);
      continue;
    }
    const opacity = o.opacity !== undefined && Number(o.opacity) < 1 ? Math.max(0, Number(o.opacity)) : undefined;
    if (name === "g" || name === "a") {
      const items = walkList(c, a, mc, ctx);
      if (!items.length) continue;
      if (opacity !== undefined || (label && items.length > 1)) out.push({ kind: "group", label, opacity, items });
      else if (label && items.length === 1 && items[0].kind !== "group" && items[0].kind !== "piece") {
        // A named group around one shape (Figma's "Group 1 > Vector"): keep the shape, use the name.
        const only = items[0];
        if (only.kind === "node" || only.kind === "raster") {
          only.node.name ??= label;
          only.base = label;
        }
        out.push(only);
      } else out.push(...items);
      continue;
    }
    const conv = convertLeaf(c, name, o, a, mc, opacity, label, ctx);
    if ("why" in conv) pushPiece(c, conv.why, label);
    else out.push(...conv.items);
  }
  return out;
}

/** A clip-path that is one plain rectangle covering the whole SVG (Figma clips every frame so) changes nothing. */
function trivialClip(value: string, m: Mat, ctx: Ctx): boolean {
  const id = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)$/.exec(value.trim())?.[1];
  const cp = id ? ctx.byId.get(id) : undefined;
  if (!cp || cp.localName !== "clipPath" || cp.getAttribute("clipPathUnits") === "objectBoundingBox") return false;
  const cs = kids(cp);
  if (cs.length !== 1 || cs[0].localName !== "rect") return false;
  const o = own(cs[0]);
  if (o.rx || o.ry) return false;
  const t = parseTransform(o.transform);
  if (!t) return false;
  const mm = mul(m, t);
  if (rigidAngle(mm) !== 0) return false;
  const x = len(o.x) ?? 0;
  const y = len(o.y) ?? 0;
  const w = len(o.width);
  const h = len(o.height);
  if (!(w! > 0 && h! > 0)) return false;
  const p = applyMat(mm, { x, y });
  const [vx, vy, vw, vh] = ctx.vb;
  return p.x <= vx + 0.5 && p.y <= vy + 0.5 && p.x + w! >= vx + vw - 0.5 && p.y + h! >= vy + vh - 0.5;
}

type Conv = { items: Item[] } | { why: string[] };

/** Box (x, y, w, h) drawn through `m`: the post-studio box and rotation, or a reason. */
function place(m: Mat, b: Box, why: string[]): { x: number; y: number; rotation?: number } | undefined {
  const ang = rigidAngle(m);
  if (ang === undefined) {
    why.push("scaled or skewed shape");
    return undefined;
  }
  const c = applyMat(m, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
  return { x: r3(c.x - b.w / 2), y: r3(c.y - b.h / 2), ...(ang ? { rotation: ang } : {}) };
}

function colour(v: string | undefined, why: string[]): string | null | undefined {
  const tmp: string[] = [];
  const c = parseColor(v, tmp, "");
  if (tmp.length) why.push(/url\(/.test(v ?? "") ? "gradient or pattern fill" : `colour ${String(v).slice(0, 30)}`);
  return c;
}

function convertLeaf(c: SvgElementLike, name: string, o: Attrs, a: Attrs, m: Mat, opacity: number | undefined, label: string | undefined, ctx: Ctx): Conv {
  const why: string[] = [];
  const base = label ?? name;
  const common = (n: Node): Node => {
    if (label) n.name = label;
    if (opacity !== undefined) n.opacity = opacity;
    return n;
  };
  const fillOf = () => withAlpha(colour(a.fill ?? "#000000", why), a["fill-opacity"]);
  const strokeOf = () => {
    const tmp: string[] = [];
    const s = shapeStroke(a, tmp, "");
    if (tmp.length) why.push(/url\(/.test(a.stroke ?? "") ? "gradient or pattern fill" : "stroke colour");
    if (s && (!Number.isFinite(s.width) || s.width <= 0)) return undefined;
    return s;
  };
  switch (name) {
    case "rect": {
      const x = len(o.x) ?? 0;
      const y = len(o.y) ?? 0;
      const w = len(o.width);
      const h = len(o.height);
      if (![x, y, w, h].every((v) => v !== undefined && Number.isFinite(v))) return { why: ["sizes in % or other units"] };
      if (!(w! > 0 && h! > 0)) return { items: [] };
      const fill = fillOf();
      const stroke = strokeOf();
      const rx = len(o.rx);
      const ry = len(o.ry);
      if (rx !== undefined && ry !== undefined && Math.abs(rx - ry) > 0.01) why.push("elliptical corners");
      const p = place(m, { x, y, w: w!, h: h! }, why);
      if (why.length || !p) return { why };
      const node: Node = { id: base, type: "rect", ...p, w: r3(w!), h: r3(h!), fill: fill ?? null };
      if (stroke) node.stroke = stroke;
      const r = rx ?? ry;
      if (r && Number.isFinite(r) && r > 0) node.radius = r3(Math.min(r, w! / 2, h! / 2));
      return { items: [{ kind: "node", node: common(node), base }] };
    }
    case "circle":
    case "ellipse": {
      const rx = name === "circle" ? len(o.r) : len(o.rx);
      const ry = name === "circle" ? len(o.r) : len(o.ry);
      const cx = len(o.cx) ?? 0;
      const cy = len(o.cy) ?? 0;
      if (![rx, ry, cx, cy].every((v) => v !== undefined && Number.isFinite(v))) return { why: ["sizes in % or other units"] };
      if (!(rx! > 0 && ry! > 0)) return { items: [] };
      const fill = fillOf();
      const stroke = strokeOf();
      const p = place(m, { x: cx - rx!, y: cy - ry!, w: 2 * rx!, h: 2 * ry! }, why);
      if (why.length || !p) return { why };
      const node: Node = { id: base, type: "ellipse", ...p, w: r3(2 * rx!), h: r3(2 * ry!), fill: fill ?? null };
      if (stroke) node.stroke = stroke;
      return { items: [{ kind: "node", node: common(node), base }] };
    }
    case "line": {
      const stroke = strokeOf();
      if (why.length) return { why };
      if (!stroke) return { items: [] };
      const p1 = applyMat(m, { x: num(o.x1), y: num(o.y1) });
      const p2 = applyMat(m, { x: num(o.x2), y: num(o.y2) });
      if (![p1.x, p1.y, p2.x, p2.y].every(Number.isFinite)) return { why: ["sizes in % or other units"] };
      if (rigidAngle(m) === undefined) stroke.width = r3(stroke.width * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])));
      const node: Node = { id: base, type: "line", x: r3(p1.x), y: r3(p1.y), w: r3(p2.x - p1.x), h: r3(p2.y - p1.y), stroke };
      return { items: [{ kind: "node", node: common(node), base }] };
    }
    case "path":
    case "polygon":
    case "polyline": {
      let d = o.d ?? "";
      if (name !== "path") {
        const pts = (o.points ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
        if (pts.length < 4 || pts.some((v) => !Number.isFinite(v))) return { items: [] };
        d = pts.reduce((s, v, i) => (i % 2 ? s : `${s}${i ? "L" : "M"}${v} ${pts[i + 1]}`), "") + (name === "polygon" ? "Z" : "");
      }
      const local = pathBoundsPure(d);
      if (!local) return { items: [] };
      if (a["fill-rule"] === "evenodd" && (d.match(/[Mm]/g) ?? []).length > 1 && a.fill !== "none") why.push("shape with holes (even-odd)");
      const stroke = strokeOf();
      if (stroke && a["stroke-linejoin"] && a["stroke-linejoin"] !== "miter") why.push("rounded line joins");
      const implicit = a.fill === undefined && (local.w === 0 || local.h === 0);
      const fill = implicit ? null : (fillOf() ?? null);
      const vw = Math.max(local.w, 0.001);
      const vh = Math.max(local.h, 0.001);
      const p = place(m, { x: local.x, y: local.y, w: vw, h: vh }, why);
      if (why.length || !p) return { why };
      if (!fill && !stroke) return { items: [] };
      const node: Node = { id: base, type: "path", ...p, w: r3(vw), h: r3(vh), d, viewBox: [local.x, local.y, vw, vh], fill };
      if (stroke) node.stroke = stroke;
      return { items: [{ kind: "node", node: common(node), base }] };
    }
    case "image": {
      const href = (c.getAttribute("href") ?? c.getAttribute("xlink:href") ?? "").trim();
      const x = len(o.x) ?? 0;
      const y = len(o.y) ?? 0;
      const w = len(o.width);
      const h = len(o.height);
      if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(href)) {
        if (/^data:image\/svg/i.test(href)) return { why: ["embedded SVG image"] };
        ctx.report.skipped.push(`image linked from outside the SVG${href ? ` (${href.slice(0, 60)})` : ""}`);
        return { items: [] };
      }
      if (!(w! > 0 && h! > 0)) return { why: ["image without a size"] };
      const p = place(m, { x, y, w: w!, h: h! }, why);
      if (why.length || !p) return { why };
      const par = o.preserveAspectRatio ?? "xMidYMid meet";
      const node = common({ id: base, type: "image", asset: PLACEHOLDER_ASSET, ...p, w: r3(w!), h: r3(h!), fit: par === "none" ? "fill" : par.includes("slice") ? "cover" : "contain" }) as Extract<Node, { type: "image" }>;
      return { items: [{ kind: "raster", node, href, base }] };
    }
    case "text": {
      const r = convertText(c, o, a, m, opacity, label, ctx);
      return r;
    }
    default:
      return { why: [name === "use" ? "reused symbol (<use>)" : `<${name}>`] };
  }
}

// ---------------------------------------------------------------- text

const normFamily = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A registered family for an SVG font-family (exact, same name spelled differently, else the nearest kind). */
function mapFamily(ctx: Ctx, family: string): string {
  const list = ctx.families;
  if (list.includes(family)) return family;
  const n = normFamily(family);
  const same = list.find((f) => normFamily(f) === n) ?? list.find((f) => n && n.startsWith(normFamily(f)) && /^(regular|medium|semibold|bold|light|book|text|variable)/.test(n.slice(normFamily(f).length)));
  if (same) return same;
  const pick = (...names: string[]) => names.find((x) => list.includes(x));
  let out: string | undefined;
  if (/mono|code|courier|consol/.test(n)) out = pick("IBM Plex Mono");
  else if ((/serif/.test(n) && !/sans/.test(n)) || /georgia|times|garamond|merriweather|playfair|lora|bitter|alegreya$|crimson|baskerville/.test(n)) out = pick("Bitter", "Alegreya");
  else if (/rubik|rounded|nunito|quicksand/.test(n)) out = pick("Rubik");
  out ??= pick("IBM Plex Sans") ?? list[0];
  ctx.report.fonts.push(`${family || "(no font)"} → ${out}`);
  return out;
}

function weightOf(v: string | undefined): number {
  if (!v) return 400;
  if (v === "bold" || v === "bolder") return 700;
  if (v === "normal" || v === "lighter") return 400;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 400;
}

/** Nearest weight the family has (a variable face covers its range). */
function nearestWeight(ctx: Ctx, family: string, w: number): number {
  let best = w;
  let d = Infinity;
  for (const f of ctx.opts.fonts.faceSpecs()) {
    if (f.family !== family) continue;
    const c = Math.min(Math.max(w, f.weights[0]), f.weights[1]);
    if (Math.abs(c - w) < d || (Math.abs(c - w) === d && c > best)) {
      d = Math.abs(c - w);
      best = c;
    }
  }
  if (best !== w) ctx.report.fonts.push(`${family} ${w} → ${best}`);
  return best;
}

interface Run {
  text: string;
  x?: number;
  y?: number;
  a: Attrs;
}

function convertText(el: SvgElementLike, o: Attrs, a: Attrs, m: Mat, opacity: number | undefined, label: string | undefined, ctx: Ctx): Conv {
  const why: string[] = [];
  if (rigidAngle(m) !== 0) return { why: ["rotated or scaled text"] };
  const tx = m[4];
  const ty = m[5];
  for (const k of ["rotate", "textLength", "dx", "dy"]) if (o[k]) return { why: ["text with per-letter positions"] };
  const preserve = el.getAttribute("xml:space") === "preserve" || /^pre/.test(a["white-space"] ?? "");
  const runs: Run[] = [];
  for (const ch of Array.from(el.childNodes)) {
    if (ch.nodeType === 3 || ch.nodeType === 4) {
      const v = ch.nodeValue ?? "";
      if (/\n/.test(v) && !v.trim()) continue; // indentation between <tspan>s
      runs.push({ text: v, a });
    } else if (ch.nodeType === 1) {
      const t = ch as unknown as SvgElementLike;
      if (t.localName !== "tspan" || kids(t).length) return { why: ["text with nested styles"] };
      const ta = own(t);
      if (["rotate", "textLength", "dx", "dy", "transform"].some((k) => ta[k])) return { why: ["text with per-letter positions"] };
      runs.push({ text: t.textContent ?? "", x: firstNum(ta.x), y: firstNum(ta.y), a: inherit(a, t, KEYS) });
    }
  }
  if (!runs.length) return { items: [] };
  if (runs[0].x === undefined) runs[0].x = firstNum(o.x) ?? 0;
  if (runs[0].y === undefined) runs[0].y = firstNum(o.y) ?? 0;

  const familyRaw = fam(a["font-family"]);
  const family = mapFamily(ctx, familyRaw);
  const size = len(a["font-size"]) ?? 16;
  if (!Number.isFinite(size) || size <= 0) return { why: ["font size in other units"] };
  const weight = nearestWeight(ctx, family, weightOf(a["font-weight"]));
  const fill = withAlpha(colour(a.fill ?? "#000000", why), a["fill-opacity"]);
  if (why.length) return { why };
  if (!fill) return { items: [] };
  if (a["font-style"] === "italic" || a["font-style"] === "oblique") ctx.report.fonts.push("italic shown upright");
  const ls = letterSpacingPx(a["letter-spacing"], size);

  // Lines: a run with a new y starts a line (Figma writes one <tspan x y> per line and per style run).
  const mixed = runs.some((r) => fam(r.a["font-family"]) !== familyRaw || (len(r.a["font-size"]) ?? 16) !== size);
  type Line = { x: number; y: number; spans: TextSpec["lines"][number] };
  const lines: Line[] = [];
  for (const r of runs) {
    let line = lines[lines.length - 1];
    if (!line || (r.y !== undefined && Math.abs(r.y - line.y) > 0.01)) {
      line = { x: r.x ?? line?.x ?? 0, y: r.y ?? line?.y ?? 0, spans: [] };
      lines.push(line);
    }
    const spanFill = withAlpha(colour(r.a.fill ?? "#000000", why), r.a["fill-opacity"]);
    if (why.length) return { why };
    const span: { text: string; fill?: string; weight?: number } = { text: preserve ? r.text.replace(/\n/g, "") : r.text.replace(/\s+/g, " ") };
    if (spanFill && spanFill !== fill) span.fill = spanFill;
    const w = nearestWeight(ctx, family, weightOf(r.a["font-weight"]));
    if (w !== weight) span.weight = w;
    line.spans.push(span);
  }
  for (const l of lines) {
    // Trailing spaces at a line end (Figma keeps the space before a soft wrap) only move nothing.
    const last = l.spans[l.spans.length - 1];
    if (last) last.text = last.text.replace(/\s+$/, "");
    if (!preserve && l.spans[0]) l.spans[0].text = l.spans[0].text.replace(/^\s+/, "");
    l.spans = l.spans.filter((s, i) => s.text.length || i === 0);
    if (!l.spans.length) l.spans = [{ text: "" }];
  }
  while (lines.length && !lines[lines.length - 1].spans.some((s) => s.text)) lines.pop();
  if (!lines.length) return { items: [] };

  const style = { font: family, weight, size, fill };
  const spec = (ls_: Line[], anchor: Anchor, x: number): TextSpec => {
    const s: TextSpec = { id: label ?? "text", lines: ls_.map((l) => l.spans), font: family, weight, size, fill, anchor, x: x + tx, baseline: ls_[0].y + ty };
    if (ls_.length > 1) s.leading = ls_[1].y - ls_[0].y;
    if (ls) s.letterSpacing = ls;
    if (opacity !== undefined) s.opacity = opacity;
    if (label) s.name = label;
    return s;
  };
  const widthOf = (l: Line) =>
    layout(ctx.opts.fonts, { spans: l.spans.map((s) => ({ text: s.text, ...(s.weight ? { weight: s.weight } : {}) })), style: { ...style, ...(ls ? { letterSpacing: ls } : {}) }, box: "auto-width", align: "left", w: 0, h: 0 }, ctx.opts.lang).width;
  const attrAnchor = (["start", "middle", "end"].includes(a["text-anchor"] ?? "") ? a["text-anchor"] : "start") as Anchor;

  let specs: TextSpec[];
  if (mixed) {
    // Different fonts or sizes inside one text: one text layer per line (sizes cannot mix in a layer).
    specs = lines.map((l) => spec([l], attrAnchor, l.x));
  } else if (lines.length === 1) {
    specs = [spec(lines, attrAnchor, lines[0].x)];
  } else {
    const step = lines[1].y - lines[0].y;
    const even = step > 0 && lines.every((l, i) => i === 0 || Math.abs(l.y - lines[i - 1].y - step) < 0.05);
    const full = lines.filter((l) => l.spans.some((s) => s.text));
    const same = (vs: number[], tol: number) => vs.every((v) => Math.abs(v - vs[0]) <= tol);
    let one: TextSpec | undefined;
    if (even) {
      const xs = full.map((l) => l.x);
      if (same(xs, 0.5)) one = spec(lines, attrAnchor, xs[0]);
      else if (attrAnchor === "start") {
        const ws = full.map(widthOf);
        const centres = full.map((l, i) => l.x + ws[i] / 2);
        const rights = full.map((l, i) => l.x + ws[i]);
        if (same(centres, 1.5)) one = spec(lines, "middle", centres.reduce((s, v) => s + v, 0) / centres.length);
        else if (same(rights, 1.5)) one = spec(lines, "end", rights.reduce((s, v) => s + v, 0) / rights.length);
      }
    }
    specs = one ? [one] : lines.filter((l) => l.spans.some((s) => s.text)).map((l) => spec([l], attrAnchor, l.x));
  }
  const frameW = ctx.vb[0] === 0 ? ctx.vb[2] : NaN;
  const items: Item[] = specs.map((s) => {
    const node: TextNode = textNodeFromSpec({ fonts: ctx.opts.fonts, lang: ctx.opts.lang, frameW }, s);
    return { kind: "node", node, base: label ?? firstWords(node) };
  });
  return { items };
}

function firstWords(n: TextNode): string {
  const t = n.spans.map((s) => s.text).join("").trim().split(/\s+/).slice(0, 3).join("-");
  return /[A-Za-z0-9]/.test(t) ? `text-${t}` : "text";
}

// ---------------------------------------------------------------- pictures

function buildPiece(it: Extract<Item, { kind: "piece" }>, ctx: Ctx): PastePiece {
  const ser = (e: SvgElementLike) => ctx.opts.serialize(e).replace(/ xmlns(:xlink)?="[^"]*"/g, "");
  const inner = it.els.map(ser).join("");
  const style = Object.entries(it.inh)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  const isId = it.m.every((v, i) => v === IDENTITY[i]);
  const body = `<g${isId ? "" : ` transform="matrix(${it.m.map(r3).join(" ")})"`}${style ? ` style="${esc(style)}"` : ""}>${inner}</g>`;
  // Definitions the piece refers to (gradients, filters, clips, patterns and their images), transitively.
  const defs: string[] = [];
  const seen = new Set<string>();
  const scan = (markup: string) => {
    for (const mm of markup.matchAll(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)|href="#([^"]+)"/g)) {
      const id = mm[1] ?? mm[2];
      if (seen.has(id) || inner.includes(`id="${id}"`)) continue;
      seen.add(id);
      const el = ctx.byId.get(id);
      if (!el) continue;
      const s = ser(el);
      defs.push(s);
      scan(s);
    }
  };
  scan(body);
  const box = piecesBox(it.els, it.inh, it.m, ctx) ?? { x: ctx.vb[0], y: ctx.vb[1], w: ctx.vb[2], h: ctx.vb[3] };
  const markup = `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${r3(box.w)}" height="${r3(box.h)}" viewBox="${r3(box.x)} ${r3(box.y)} ${r3(box.w)} ${r3(box.h)}">${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${body}</svg>`;
  const node: Extract<Node, { type: "svg" }> = { id: it.label ?? "svg-art", type: "svg", name: it.label ?? `Picture (${[...new Set(it.why)].join(", ")})`.slice(0, 200), x: r3(box.x), y: r3(box.y), w: r3(box.w), h: r3(box.h), asset: PLACEHOLDER_ASSET };
  return { node, markup, why: it.why };
}

/** Where a piece draws (geometry + stroke), so its layer is no bigger than it; undefined = use the whole SVG (effects, text). */
function piecesBox(els: SvgElementLike[], inh: Attrs, m: Mat, ctx: Ctx): Box | undefined {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (b: Box) => {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  };
  const corners = (mm: Mat, b: Box): Box => {
    const ps = [applyMat(mm, { x: b.x, y: b.y }), applyMat(mm, { x: b.x + b.w, y: b.y }), applyMat(mm, { x: b.x + b.w, y: b.y + b.h }), applyMat(mm, { x: b.x, y: b.y + b.h })];
    const xs = ps.map((p) => p.x);
    const ys = ps.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };
  const visit = (el: SvgElementLike, parentAttrs: Attrs, pm: Mat): boolean => {
    const name = el.localName ?? "";
    if (IGNORED.has(name) || DEFS_LIKE.has(name)) return true;
    const o = own(el);
    const t = parseTransform(o.transform);
    if (!t) return false;
    const mm = mul(pm, t);
    if (o.filter && o.filter !== "none") {
      // Figma writes each effect's region in user space: the effect draws nothing outside it.
      const fid = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)$/.exec(o.filter.trim())?.[1];
      const f = fid ? ctx.byId.get(fid) : undefined;
      const fo = f ? own(f) : undefined;
      const fx = len(fo?.x);
      const fy = len(fo?.y);
      const fw = len(fo?.width);
      const fh = len(fo?.height);
      if (!fo || fo.filterUnits !== "userSpaceOnUse" || ![fx, fy, fw, fh].every((v) => v !== undefined && Number.isFinite(v)) || !(fw! > 0 && fh! > 0)) return false;
      const b = corners(mm, { x: fx!, y: fy!, w: fw!, h: fh! });
      add({ x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 });
      return true;
    }
    const a = inherit(parentAttrs, el, KEYS);
    const sw = a.stroke && a.stroke !== "none" ? (len(a["stroke-width"]) ?? 1) : 0;
    const pad = (Number.isFinite(sw) ? sw : 4) * Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2])) + 1;
    const padded = (b: Box | undefined) => (b ? add({ x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }) : undefined);
    switch (name) {
      case "g":
      case "a":
        return kids(el).every((k) => visit(k, a, mm));
      case "rect":
      case "image": {
        const w = len(o.width);
        const h = len(o.height);
        if (!(w! > 0 && h! > 0)) return w === 0 || h === 0;
        padded(corners(mm, { x: len(o.x) ?? 0, y: len(o.y) ?? 0, w: w!, h: h! }));
        return true;
      }
      case "circle":
      case "ellipse": {
        const rx = name === "circle" ? len(o.r) : len(o.rx);
        const ry = name === "circle" ? len(o.r) : len(o.ry);
        const cx = len(o.cx) ?? 0;
        const cy = len(o.cy) ?? 0;
        if (!(rx! >= 0 && ry! >= 0)) return false;
        const c = applyMat(mm, { x: cx, y: cy });
        const hw = Math.hypot(mm[0] * rx!, mm[2] * ry!);
        const hh = Math.hypot(mm[1] * rx!, mm[3] * ry!);
        padded({ x: c.x - hw, y: c.y - hh, w: 2 * hw, h: 2 * hh });
        return true;
      }
      case "line": {
        const p1 = applyMat(mm, { x: num(o.x1), y: num(o.y1) });
        const p2 = applyMat(mm, { x: num(o.x2), y: num(o.y2) });
        padded({ x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) });
        return true;
      }
      case "path":
      case "polygon":
      case "polyline": {
        let d = o.d ?? "";
        if (name !== "path") {
          const pts = (o.points ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
          d = pts.reduce((s, v, i) => (i % 2 ? s : `${s}${i ? "L" : "M"}${v} ${pts[i + 1]}`), "");
        }
        const b = pathBoundsPure(d, mm);
        if (!b) return !d.trim();
        padded(b);
        return true;
      }
      default:
        return false; // text, use, nested svg …: measure nothing, take the whole SVG
    }
  };
  for (const el of els) if (!visit(el, inh, m)) return undefined;
  if (!Number.isFinite(x0)) return undefined;
  const fl = (v: number) => Math.floor(v * 100) / 100;
  const ce = (v: number) => Math.ceil(v * 100) / 100;
  return { x: fl(x0), y: fl(y0), w: ce(x1) - fl(x0), h: ce(y1) - fl(y0) };
}
