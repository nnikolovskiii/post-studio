// (b) template-style post.svg (+ copy.json): simple SVG (rect, path, text, line, circle, image,
// groups with translate) becomes real post-studio nodes; the template group ids give the roles:
// `art` (chart / illustration group), `type` (copy, roles from copy.json), `accent`, `footer`.
// (c) fallback: anything else stays as whole-SVG layers (svg nodes, nothing dropped), raster
// images become image nodes and copy.json text becomes editable text nodes on top.
import { DOMParser, XMLSerializer, type Element as XElement, type Node as XNode } from "@xmldom/xmldom";
import type { Frame, Node, TextNode } from "@post-studio/schema";
import { bakeMultiply, readDataUri, readFile, resolveHref, sniffRaster } from "./assets.ts";
import { RoleMatcher, copyLines, norm } from "./copy.ts";
import { boxOf, makeGroup, pathBounds } from "./geometry.ts";
import { Ids } from "./ids.ts";
import { mergeLines, textNodeFromSpec, type Anchor, type TextSpec } from "./text.ts";
import { ImportError, type ImportOptions, type ImportedAsset } from "./types.ts";
import { fam, inherit as inheritKeys, kids, letterSpacingPx, num, own, parseColor, shapeStroke, withAlpha, type Attrs } from "./svg-common.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
// The CLI importer's inherited properties (unchanged since Phase 2; the paste converter uses more).
const INHERITED = ["font-feature-settings", "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "font-family", "font-size", "font-weight", "letter-spacing", "text-anchor", "visibility"];
const inherit = (parent: Attrs, el: XElement) => inheritKeys(parent, el, INHERITED);

export interface SvgFrameCtx {
  opts: ImportOptions;
  dir: string;
  lang: string;
  copy?: Record<string, unknown>;
  ids: Ids;
  assets: ImportedAsset[];
  cache: Map<string, string>;
  warnings: string[];
  skipped: string[];
  frameId: string;
  frameName: string;
  suffix: string;
  file: string;
}

function parse(svg: string): XElement {
  const doc = new DOMParser({ onError: () => undefined }).parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement as unknown as XElement | null;
  if (!root || root.localName !== "svg") throw new ImportError("post.svg does not parse as SVG");
  return root;
}

function frameSize(root: XElement): { w: number; h: number } {
  const vb = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const w = Number(root.getAttribute("width")) || vb[2];
  const h = Number(root.getAttribute("height")) || vb[3];
  if (!(w > 0 && h > 0)) throw new ImportError("post.svg has no width/height or viewBox");
  return { w: Math.round(w), h: Math.round(h) };
}

function translateOf(t: string | null, reasons: string[], what: string): [number, number] {
  if (!t || !t.trim()) return [0, 0];
  const m = /^\s*translate\(\s*(-?[\d.eE+-]+)(?:[\s,]+(-?[\d.eE+-]+))?\s*\)\s*$/.exec(t);
  if (!m) {
    reasons.push(`${what}: transform '${t}' (only translate converts to nodes)`);
    return [0, 0];
  }
  return [Number(m[1]), Number(m[2] ?? 0)];
}

const n = num;
const isSpec = (x: unknown): x is TextSpec => !!x && typeof x === "object" && "lines" in (x as any) && "anchor" in (x as any);

function textSpans(el: XElement, inh: Attrs, reasons: string[], what: string): Array<{ text: string; fill?: string; weight?: number }> | undefined {
  const spans: Array<{ text: string; fill?: string; weight?: number }> = [];
  for (const c of Array.from(el.childNodes) as XNode[]) {
    if (c.nodeType === 3 || c.nodeType === 4) spans.push({ text: c.nodeValue ?? "" });
    else if (c.nodeType === 1) {
      const t = c as unknown as XElement;
      if (t.localName !== "tspan" || ["x", "y", "dx", "dy", "rotate", "transform", "textLength"].some((a) => t.hasAttribute(a))) {
        reasons.push(`${what}: positioned <${t.localName}> inside text`);
        return undefined;
      }
      const a = inherit(inh, t);
      const sp: { text: string; fill?: string; weight?: number } = { text: t.textContent ?? "" };
      const f = parseColor(a.fill, reasons, what);
      if (f) sp.fill = f;
      if (a["font-weight"]) sp.weight = Number(a["font-weight"]) || 400;
      spans.push(sp);
    }
  }
  // xml:space default: collapse runs of whitespace, trim the ends.
  const out = spans.map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ") })).filter((s) => s.text.length);
  if (out.length) {
    out[0].text = out[0].text.replace(/^ /, "");
    out[out.length - 1].text = out[out.length - 1].text.replace(/ $/, "");
  }
  return out.filter((s) => s.text.length);
}

/** <text> → TextSpec (baseline-anchored). Returns undefined with reasons when it is not simple text. */
function textSpec(ctx: SvgFrameCtx, el: XElement, inh: Attrs, tx: number, ty: number, reasons: string[], roles: RoleMatcher, take: boolean): TextSpec | undefined {
  const what = `${ctx.file} <text${el.getAttribute("id") ? ` id=${el.getAttribute("id")}` : ""}>`;
  const before = reasons.length;
  const o = own(el);
  const a = inherit(inh, el);
  if (o.transform) reasons.push(`${what}: transform on text`);
  for (const k of ["dx", "dy", "rotate", "textLength", "filter", "clip-path", "mask"]) if (o[k]) reasons.push(`${what}: ${k}`);
  if ((o.x ?? "").trim().includes(" ") || (o.y ?? "").trim().includes(" ")) reasons.push(`${what}: per-glyph x/y lists`);
  const spans = textSpans(el, a, reasons, what);
  const font = fam(a["font-family"]);
  if (font && !ctx.opts.fonts.families().includes(font)) reasons.push(`${what}: font '${font}' is not registered`);
  const fill = parseColor(a.fill ?? "#000000", reasons, what);
  if (reasons.length > before || !spans) return undefined;
  if (!spans.length) return undefined;
  const size = n(a["font-size"], 16);
  const text = spans.map((s) => s.text).join("");
  const role = take ? roles.take(text) : roles.peek(text);
  const spec: TextSpec = {
    id: el.getAttribute("id") ?? "text",
    lines: [spans],
    font: font || "IBM Plex Sans",
    weight: Number(a["font-weight"]) || (a["font-weight"] === "bold" ? 700 : 400),
    size,
    fill: withAlpha(fill ?? "#000000", a["fill-opacity"])!,
    anchor: (a["text-anchor"] ?? "start") as Anchor,
    x: n(o.x) + tx,
    baseline: n(o.y) + ty,
  };
  const ls = letterSpacingPx(a["letter-spacing"], size);
  if (ls) spec.letterSpacing = ls;
  if (o.opacity !== undefined && Number(o.opacity) < 1) spec.opacity = Number(o.opacity);
  if (role) spec.role = role.role;
  const sourceId = el.getAttribute("id");
  if (sourceId && sourceId !== spec.role) spec.name = sourceId;
  return spec;
}

const COPY_GROUPS = new Set(["type", "footer", "copy"]);
const ROLE_GROUPS: Record<string, string> = { art: "art", accent: "accent", chart: "chart" };

/** (b) Convert a template post.svg. Throws ImportError with every reason it cannot be converted exactly. */
export async function importTemplateFrame(ctx: SvgFrameCtx, svg: string): Promise<Frame> {
  const root = parse(svg);
  const { w: W, h: H } = frameSize(root);
  const ids = kids(root).map((k) => k.getAttribute("id"));
  if (!ids.some((id) => id === "art" || id === "type")) throw new ImportError(`${ctx.file} is not template-style`, [`${ctx.file}: no top-level <g id="art"> or <g id="type">`]);
  const reasons: string[] = [];
  const roles = new RoleMatcher(copyLines(ctx.copy));
  let background: string | null = null;
  let drawn = 0;
  const pending: Array<() => Promise<void>> = [];

  type Item = Node | TextSpec | { group: string; role?: string; name?: string; items: Item[]; opacity?: number };
  const walk = (el: XElement, inh: Attrs, tx: number, ty: number, inside: string | undefined): Item[] => {
    const out: Item[] = [];
    for (const c of kids(el)) {
      const name = c.localName;
      const o = own(c);
      const a = inherit(inh, c);
      const id = c.getAttribute("id") ?? undefined;
      const what = `${ctx.file} <${name}${id ? ` id=${id}` : ""}>`;
      if (o.display === "none") {
        ctx.skipped.push(`${what} (display:none${id === "guides" ? ", template guide overlay" : ""})`);
        continue;
      }
      for (const k of ["filter", "clip-path", "mask"]) if (o[k] && o[k] !== "none") reasons.push(`${what}: ${k}`);
      const blend = o["mix-blend-mode"];
      if (blend && blend !== "normal" && !(name === "image" && blend === "multiply")) reasons.push(`${what}: mix-blend-mode ${blend}`);
      if (o.visibility === "hidden") reasons.push(`${what}: visibility hidden`);
      const opacity = o.opacity !== undefined && Number(o.opacity) < 1 ? Number(o.opacity) : undefined;
      switch (name) {
        case "title":
        case "desc":
        case "metadata":
          continue;
        case "defs":
        case "style":
        case "use":
        case "symbol":
        case "pattern":
        case "linearGradient":
        case "radialGradient":
        case "clipPath":
        case "mask":
        case "filter":
          if (name === "defs" && !kids(c).length) continue;
          reasons.push(`${what}: <${name}> has no post-studio/1 equivalent`);
          continue;
        case "g": {
          const [gx, gy] = translateOf(c.getAttribute("transform"), reasons, what);
          const title = kids(c).find((k) => k.localName === "title")?.textContent?.trim();
          const items = walk(c, a, tx + gx, ty + gy, id ?? inside);
          if (!id && opacity === undefined) out.push(...items);
          else if (id && COPY_GROUPS.has(id) && opacity === undefined) out.push(...items);
          else out.push({ group: id ?? "group", role: id ? ROLE_GROUPS[id] : undefined, name: title, items, opacity });
          continue;
        }
        case "rect": {
          const x = n(o.x) + tx;
          const y = n(o.y) + ty;
          const w = n(o.width);
          const h = n(o.height);
          const fill = withAlpha(parseColor(a.fill ?? "#000000", reasons, what), a["fill-opacity"]);
          const stroke = shapeStroke(a, reasons, what);
          if (drawn === 0 && x === 0 && y === 0 && w === W && h === H && fill && fill.length === 7 && !stroke && opacity === undefined && !inside) {
            background = fill;
            drawn++;
            continue;
          }
          drawn++;
          const r = o.rx ?? o.ry;
          const node: Node = { id: id ?? "rect", type: "rect", x, y, w, h, fill: fill ?? null };
          if (stroke) node.stroke = stroke;
          if (r && (!o.rx || !o.ry || o.rx === o.ry)) node.radius = n(r);
          else if (r) reasons.push(`${what}: elliptical corner radii`);
          if (opacity !== undefined) node.opacity = opacity;
          out.push(node);
          continue;
        }
        case "circle":
        case "ellipse": {
          drawn++;
          const rx = name === "circle" ? n(o.r) : n(o.rx);
          const ry = name === "circle" ? n(o.r) : n(o.ry);
          const node: Node = { id: id ?? name, type: "ellipse", x: n(o.cx) + tx - rx, y: n(o.cy) + ty - ry, w: 2 * rx, h: 2 * ry, fill: withAlpha(parseColor(a.fill ?? "#000000", reasons, what), a["fill-opacity"]) ?? null };
          const stroke = shapeStroke(a, reasons, what);
          if (stroke) node.stroke = stroke;
          if (opacity !== undefined) node.opacity = opacity;
          out.push(node);
          continue;
        }
        case "line": {
          drawn++;
          const stroke = shapeStroke(a, reasons, what);
          if (!stroke) continue; // invisible
          const x1 = n(o.x1) + tx;
          const y1 = n(o.y1) + ty;
          const node: Node = { id: id ?? "line", type: "line", x: x1, y: y1, w: n(o.x2) + tx - x1, h: n(o.y2) + ty - y1, stroke };
          if (opacity !== undefined) node.opacity = opacity;
          out.push(node);
          continue;
        }
        case "path":
        case "polygon":
        case "polyline": {
          drawn++;
          let d = o.d ?? "";
          if (name !== "path") {
            const pts = (o.points ?? "").trim().split(/[\s,]+/).map(Number);
            d = pts.reduce((s, v, i) => (i % 2 ? s : `${s}${i ? "L" : "M"}${v} ${pts[i + 1]}`), "") + (name === "polygon" ? "Z" : "");
          }
          if (o.transform) {
            reasons.push(`${what}: transform on a path`);
            continue;
          }
          const b = pathBounds(d);
          if (!b) {
            ctx.warnings.push(`${what}: empty path skipped`);
            continue;
          }
          const vw = Math.max(b.w, 0.001);
          const vh = Math.max(b.h, 0.001);
          // No fill on a zero-area path (a hairline drawn by its stroke) paints nothing: keep it 'none'
          // instead of SVG's default black, so the export does not gain a colour the source never had.
          const implicit = a.fill === undefined && (b.w === 0 || b.h === 0);
          const node: Node = { id: id ?? "path", type: "path", x: b.x + tx, y: b.y + ty, w: vw, h: vh, d, viewBox: [b.x, b.y, vw, vh], fill: implicit ? null : (withAlpha(parseColor(a.fill ?? "#000000", reasons, what), a["fill-opacity"]) ?? null) };
          const stroke = shapeStroke(a, reasons, what);
          if (stroke) node.stroke = stroke;
          if (a["fill-rule"] === "evenodd") reasons.push(`${what}: fill-rule evenodd`);
          if (opacity !== undefined) node.opacity = opacity;
          out.push(node);
          continue;
        }
        case "text": {
          drawn++;
          const spec = textSpec(ctx, c, a, tx, ty, reasons, roles, true);
          if (spec) {
            if (!spec.role && inside === "art" && id) {
              const m = /^row-(label|value)-\d+$/.exec(id) ?? /^(note|label|value|axis)$/.exec(id);
              if (m) spec.role = m[1];
            }
            out.push(spec);
          }
          continue;
        }
        case "image": {
          drawn++;
          if (o.transform) reasons.push(`${what}: transform on an image`);
          const href = c.getAttribute("href") ?? c.getAttribute("xlink:href") ?? "";
          const par = o.preserveAspectRatio ?? "xMidYMid meet";
          const node: Node = {
            id: id ?? "image",
            type: "image",
            asset: "sha256:" + "0".repeat(64),
            x: n(o.x) + tx,
            y: n(o.y) + ty,
            w: n(o.width),
            h: n(o.height),
            fit: par === "none" ? "fill" : par.includes("slice") ? "cover" : "contain",
          };
          if (id === "logo") node.role = "logo";
          if (opacity !== undefined) node.opacity = opacity;
          out.push(node);
          pending.push(async () => {
            const src = await rasterSource(ctx, href);
            if (!src) {
              reasons.push(`${what}: image '${href.slice(0, 120)}' not found`);
              return;
            }
            let bytes = src.bytes;
            let note: string | undefined;
            if (blend === "multiply") {
              if (!background) {
                reasons.push(`${what}: multiply blend without a solid paper background`);
                return;
              }
              bytes = await bakeMultiply(bytes, background);
              note = `mix-blend-mode multiply onto ${background} baked into the pixels`;
            }
            node.asset = await upload(ctx, bytes, src.name, src.from, note);
            node.meta = { source: src.from, ...(note ? { note } : {}) };
          });
          continue;
        }
        default:
          reasons.push(`${what}: <${name}> is not converted`);
      }
    }
    return out;
  };

  const items = walk(root, inherit({}, root), 0, 0, undefined);
  if (reasons.length) throw new ImportError(`${ctx.file} is not plain template SVG`, reasons);
  for (const p of pending) await p();
  if (reasons.length) throw new ImportError(`${ctx.file}: assets`, reasons);

  const toNodes = (list: Item[]): Node[] => {
    const merged = mergeLines(list, isSpec) as Item[];
    return merged.map((it) => {
      if (isSpec(it)) return textNodeFromSpec({ fonts: ctx.opts.fonts, lang: ctx.lang, frameW: W }, it);
      if ("group" in it) {
        const children = toNodes(it.items);
        const g = makeGroup(it.group, children, { ...(it.role ? { role: it.role } : {}), ...(it.name ? { name: it.name } : {}), ...(it.opacity !== undefined ? { opacity: it.opacity } : {}) });
        const rows = chartRows(children);
        if (rows.length) g.meta = { rows };
        return g;
      }
      return it;
    });
  };
  const children = finalIds(toNodes(items), ctx.ids, ctx.suffix);
  const frame: Frame = { id: ctx.frameId, name: ctx.frameName, w: W, h: H, children, meta: { source: ctx.file, mode: "template" } };
  if (background) frame.background = { color: background };
  return frame;
}

/** Template chart numbers: row-label-N + row-value-N text pairs → [{label, value}]. */
function chartRows(children: Node[]): Array<{ label: string; value: string; number?: number }> {
  const byN = new Map<string, { label?: string; value?: string }>();
  for (const c of children) {
    if (c.type !== "text" || !c.name) continue;
    const m = /^row-(label|value)-(\d+)$/.exec(c.name);
    if (!m) continue;
    const e = byN.get(m[2]) ?? {};
    e[m[1] as "label" | "value"] = c.spans.map((s) => s.text).join("");
    byN.set(m[2], e);
  }
  return [...byN.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .filter(([, e]) => e.label !== undefined && e.value !== undefined)
    .map(([, e]) => {
      const num = Number(/-?[\d.]+/.exec(e.value!)?.[0]);
      return { label: e.label!, value: e.value!, ...(Number.isFinite(num) ? { number: num } : {}) };
    });
}

const COPY_ROLES = new Set(["kicker", "headline", "sub", "chip", "emphasis", "source", "footer", "status", "cta", "logo"]);

function finalIds(nodes: Node[], ids: Ids, suffix: string): Node[] {
  return nodes.map((nd) => {
    const preferred = nd.role && COPY_ROLES.has(nd.role) ? nd.role : nd.type === "text" && nd.name ? nd.name : nd.id;
    const out = { ...nd, id: ids.take(preferred, suffix) } as Node;
    if (out.type === "text" && out.name === out.id) delete out.name;
    if (out.type === "group") out.children = finalIds(out.children, ids, suffix);
    return out;
  });
}

async function rasterSource(ctx: SvgFrameCtx, href: string): Promise<{ bytes: Buffer; name: string; from: string } | undefined> {
  if (href.startsWith("data:")) {
    const d = readDataUri(href);
    if (!d || !sniffRaster(d.bytes)) return undefined;
    return { bytes: d.bytes, name: "embedded", from: "data: URI in post.svg" };
  }
  const p = resolveHref(href, ctx.dir);
  if (!p) return undefined;
  const bytes = readFile(p);
  if (!sniffRaster(bytes)) return undefined;
  const rel = p.startsWith(ctx.dir + "/") ? p.slice(ctx.dir.length + 1) : p;
  const literal = href.startsWith("file:") ? href.slice(href.startsWith("file://") ? 7 : 5) : href;
  return { bytes, name: rel.split("/").pop()!, from: rel !== p ? rel : decodeURIComponent(literal) === p ? p : `${href} → ${p}` };
}

async function upload(ctx: SvgFrameCtx, bytes: Uint8Array, name: string, from: string, note?: string): Promise<string> {
  const key = `${from}|${note ?? ""}`;
  const hit = ctx.cache.get(key);
  if (hit) return hit;
  const up = await ctx.opts.upload(bytes, name);
  ctx.assets.push({ ref: up.ref, mime: up.mime, from, ...(note ? { note } : {}) });
  ctx.cache.set(key, up.ref);
  return up.ref;
}

// ------------------------------------------------------------------ (c) fallback

const SPLIT_BLOCKERS = ["transform", "filter", "clip-path", "mask", "opacity", "mix-blend-mode", "isolation", "display", "visibility"];
const TEXT_ONLY_PROPS = new Set(["font-family", "font-size", "font-weight", "fill", "text-anchor", "letter-spacing", "font-feature-settings", "font-style"]);

/**
 * (c) Whole post.svg kept as SVG layers (everything the template converter can't express:
 * filters, gradients, blend modes …). Raster <image>s that sit in plain groups become image
 * nodes between the layers; copy.json text becomes editable text nodes. Nothing is dropped:
 * every other element is in a layer, defs are copied into each layer.
 */
export async function importFallbackFrame(ctx: SvgFrameCtx, svg: string): Promise<Frame> {
  const root = parse(svg);
  const { w: W, h: H } = frameSize(root);
  const roles = new RoleMatcher(copyLines(ctx.copy));
  const ser = new XMLSerializer();
  const defs: string[] = [];
  type Seg = { kind: "svg"; markup: string } | { kind: "node"; node: Node | TextSpec; group?: string };
  const segs: Seg[] = [];
  const reasons: string[] = []; // only used by textSpec probing
  const imageJobs: Array<() => Promise<void>> = [];
  let comments = 0;

  const wrapOpen = (attrs: Attrs) => {
    const s = Object.entries(attrs).filter(([k]) => k !== "id");
    return s.length ? `<g ${s.map(([k, v]) => `${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`).join(" ")}>` : "";
  };
  const pushSvg = (el: XElement, wrap: Attrs[]) => {
    let markup = ser.serializeToString(el as any).replace(/ xmlns(:xlink)?="[^"]*"/g, "");
    markup = embedImages(ctx, markup);
    for (const w of [...wrap].reverse()) {
      const open = wrapOpen(w);
      if (open) markup = `${open}${markup}</g>`;
    }
    segs.push({ kind: "svg", markup });
  };

  const extractableText = (el: XElement, inh: Attrs): TextSpec | undefined => {
    const probe: string[] = [];
    const spec = textSpec(ctx, el, inh, 0, 0, probe, roles, false);
    if (!spec || probe.length || !spec.role) return undefined;
    const feats = inh["font-feature-settings"] ?? own(el)["font-feature-settings"];
    const text = spec.lines.flat().map((s) => s.text).join("");
    if (feats && /\d/.test(text)) return undefined; // figures would change without the OpenType feature
    roles.take(text);
    if (feats) {
      spec.meta = { ...(spec.meta ?? {}), fontFeatureSettings: feats };
      ctx.warnings.push(`${spec.role}: font-feature-settings ${feats} is not part of post-studio/1 text; kept in meta (no figures in this text, so nothing changes)`);
    }
    return spec;
  };

  const splittableImage = (el: XElement): boolean => {
    const o = own(el);
    if (SPLIT_BLOCKERS.some((k) => o[k] !== undefined && !(k === "opacity" && Number(o[k]) >= 0))) return false;
    if (Object.keys(o).some((k) => !["x", "y", "width", "height", "href", "xlink:href", "preserveAspectRatio", "id", "opacity"].includes(k))) return false;
    const href = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
    return href.startsWith("data:") ? !!readDataUri(href) && !!sniffRaster(readDataUri(href)!.bytes) : !!resolveHref(href, ctx.dir);
  };

  const plainGroup = (g: XElement): boolean => {
    const o = own(g);
    return !SPLIT_BLOCKERS.some((k) => o[k] !== undefined) && Object.keys(o).every((k) => k === "id" || k === "class" || TEXT_ONLY_PROPS.has(k) || k.startsWith("data-"));
  };

  const visit = (el: XElement, inh: Attrs, wrap: Attrs[], group: string | undefined) => {
    for (const c of Array.from(el.childNodes) as XNode[]) {
      if (c.nodeType === 8) {
        comments++;
        continue;
      }
      if (c.nodeType !== 1) continue;
      const e = c as unknown as XElement;
      const name = e.localName;
      if (name === "defs" && el === root) {
        defs.push(embedImages(ctx, ser.serializeToString(e as any).replace(/ xmlns(:xlink)?="[^"]*"/g, "")));
        continue;
      }
      if ((name === "title" || name === "desc" || name === "metadata") && el === root) {
        defs.push(ser.serializeToString(e as any).replace(/ xmlns(:xlink)?="[^"]*"/g, ""));
        continue;
      }
      if (name === "text") {
        const spec = extractableText(e, inherit(inh, e));
        if (spec) {
          segs.push({ kind: "node", node: spec, group });
          continue;
        }
      }
      if (name === "image" && splittableImage(e)) {
        const o = own(e);
        const id = e.getAttribute("id") ?? group ?? "image";
        const par = o.preserveAspectRatio ?? "xMidYMid meet";
        const node: Node = { id, type: "image", asset: "sha256:" + "0".repeat(64), x: n(o.x), y: n(o.y), w: n(o.width), h: n(o.height), fit: par === "none" ? "fill" : par.includes("slice") ? "cover" : "contain" };
        if (group === "art" || id === "art") node.role = "art";
        if (o.opacity !== undefined && Number(o.opacity) < 1) node.opacity = Number(o.opacity);
        segs.push({ kind: "node", node, group });
        const href = e.getAttribute("href") ?? e.getAttribute("xlink:href") ?? "";
        imageJobs.push(async () => {
          const src = (await rasterSource(ctx, href))!;
          node.asset = await upload(ctx, src.bytes, src.name, src.from);
          node.meta = { source: src.from };
        });
        continue;
      }
      // The accent group stays whole: it is the frame's one accent object (DESIGN §1.4).
      if (name === "g" && e.getAttribute("id") !== "accent" && plainGroup(e) && containsSplittable(e, inherit(inh, e))) {
        const own_ = own(e);
        visit(e, inherit(inh, e), [...wrap, own_], e.getAttribute("id") ?? group);
        continue;
      }
      pushSvg(e, wrap);
    }
  };

  const containsSplittable = (g: XElement, inh: Attrs): boolean =>
    kids(g).some((k) => (k.localName === "image" && splittableImage(k)) || (k.localName === "text" && !!peekText(k, inh)) || (k.localName === "g" && plainGroup(k) && containsSplittable(k, inherit(inh, k))));
  const peekText = (el: XElement, inh: Attrs) => {
    const probe: string[] = [];
    const s = textSpec(ctx, el, inherit(inh, el), 0, 0, probe, roles, false);
    return s && !probe.length && s.role ? s : undefined;
  };

  visit(root, inherit({}, root), [], undefined);
  void reasons;
  for (const j of imageJobs) await j();
  if (comments) ctx.skipped.push(`${ctx.file}: ${comments} XML comment(s) (not drawn)`);

  // A first layer that is only a full-frame solid rect becomes the frame background.
  let background: string | undefined;
  const first = segs[0];
  if (first?.kind === "svg") {
    const m = /^<rect((?:\s+[\w:-]+="[^"]*")*)\s*\/>$/.exec(first.markup.trim());
    const at = Object.fromEntries([...(m?.[1] ?? "").matchAll(/([\w:-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const plain = m && Object.keys(at).every((k) => ["id", "x", "y", "width", "height", "fill"].includes(k));
    if (plain && (at.x ?? "0") === "0" && (at.y ?? "0") === "0" && at.width === String(W) && at.height === String(H) && /^#[0-9A-Fa-f]{6}$/.test(at.fill ?? "")) {
      background = at.fill.toUpperCase();
      segs.shift();
    }
  }

  // Consecutive SVG segments → one svg asset layer each.
  const rootAttrs = Array.from(root.attributes)
    .filter((a) => !["width", "height", "viewBox", "xmlns", "xmlns:xlink", "version"].includes(a.name))
    .map((a) => ` ${a.name}="${a.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)
    .join("");
  const items: Array<Node | TextSpec> = [];
  let layer: string[] = [];
  let layerN = 0;
  const flush = async () => {
    if (!layer.length) return;
    const body = layer.join("\n");
    layer = [];
    if (!body.replace(/<!--[\s\S]*?-->/g, "").trim()) return;
    layerN++;
    const asset = `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"${rootAttrs}>\n${defs.join("\n")}\n${body}\n</svg>\n`;
    const ref = await upload(ctx, Buffer.from(asset, "utf8"), `${ctx.file.replace(/\.svg$/, "")}-layer-${layerN}.svg`, `${ctx.file} (layer ${layerN})`);
    items.push({ id: `layer-${layerN}`, type: "svg", name: `${ctx.file} layer ${layerN}`, x: 0, y: 0, w: W, h: H, asset: ref, meta: { source: ctx.file, layer: layerN } });
  };
  for (const s of segs) {
    if (s.kind === "svg") layer.push(s.markup);
    else {
      await flush();
      items.push(s.node);
    }
  }
  await flush();

  const merged = mergeLines(items, isSpec) as Array<Node | TextSpec>;
  const nodes = merged.map((it) => (isSpec(it) ? textNodeFromSpec({ fonts: ctx.opts.fonts, lang: ctx.lang, frameW: W }, it) : it));
  const children = finalIds(nodes, ctx.ids, ctx.suffix);
  const frame: Frame = { id: ctx.frameId, name: ctx.frameName, w: W, h: H, children, meta: { source: ctx.file, mode: "fallback" } };
  if (background) frame.background = { color: background };
  return frame;
}

/** External raster hrefs left inside SVG layers are embedded (the sanitizer drops external links). */
function embedImages(ctx: SvgFrameCtx, markup: string): string {
  return markup.replace(/(<image\b[^>]*?\s(?:xlink:)?href=")([^"]+)(")/g, (m, a: string, href: string, b: string) => {
    if (href.startsWith("data:") || href.startsWith("#")) return m;
    const p = resolveHref(href.replace(/&amp;/g, "&"), ctx.dir);
    const bytes = p ? readFile(p) : undefined;
    const mime = bytes ? sniffRaster(bytes) : undefined;
    if (!bytes || !mime) {
      ctx.warnings.push(`${ctx.file}: image '${href.slice(0, 120)}' not found; the sanitizer will drop it`);
      return m;
    }
    return `${a}data:${mime};base64,${bytes.toString("base64")}${b}`;
  });
}

export function textNodes(frame: Frame): TextNode[] {
  const out: TextNode[] = [];
  const walk = (ns: Node[]) => ns.forEach((x) => (x.type === "text" ? out.push(x) : x.type === "group" ? walk(x.children) : undefined));
  walk(frame.children);
  return out;
}

export { norm, boxOf };
