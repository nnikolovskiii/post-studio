// Inline an `svg` node's asset into the frame SVG: ids are prefixed so several assets can't clash,
// the recolor map is applied, and the asset's viewBox is mapped onto the node box with a transform.
// Assets were sanitized on upload (apps/server/src/sanitize-svg.ts); this module only rewrites.
import { DOMParser, XMLSerializer, type Element as XElement, type Node as XNode } from "@xmldom/xmldom";
import { recolorMap, recolorText } from "@post-studio/brand";
import { attrs, dataUri, num, utf8Bytes } from "./util.ts";

const COLOR_ATTRS = new Set(["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color", "style"]);
const SKIP_ROOT_ATTRS = new Set(["xmlns", "xmlns:xlink", "width", "height", "viewBox", "preserveAspectRatio", "x", "y", "version", "id", "xml:space", "data-name"]);

export interface InlineSvgInput {
  svg: string;
  /** Unique per node; used to prefix ids and classes. */
  prefix: string;
  x: number;
  y: number;
  w: number;
  h: number;
  recolor?: Record<string, string>;
  /** Keep id="accent" as is (not prefixed), so the exported post.svg keeps the art's <g id="accent"> for check_palette.py. */
  keepAccentId?: boolean;
}

export interface InlineSvgOutput {
  /** Markup to place in the frame (a <g> or an <image>). */
  markup: string;
  /** How it was placed: inline (editable in Figma) or image (isolated, when the asset carries global CSS). */
  mode: "inline" | "image";
  warnings: string[];
}

export { recolorText };

function parseLength(v: string | null): number | undefined {
  if (!v) return undefined;
  const m = /^\s*([0-9.eE+-]+)\s*(px)?\s*$/.exec(v);
  return m ? Number(m[1]) : undefined;
}

export function viewBoxOf(root: { getAttribute(n: string): string | null }): [number, number, number, number] | undefined {
  const vb = root.getAttribute("viewBox");
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0) return p as [number, number, number, number];
  }
  const w = parseLength(root.getAttribute("width"));
  const h = parseLength(root.getAttribute("height"));
  return w && h ? [0, 0, w, h] : undefined;
}

/** viewBox → viewport transform per preserveAspectRatio. */
export function fitViewBox(vb: [number, number, number, number], w: number, h: number, par: string | null) {
  const [vx, vy, vw, vh] = vb;
  const p = (par ?? "xMidYMid meet").trim().split(/\s+/);
  const align = p[0] ?? "xMidYMid";
  if (align === "none") return { sx: w / vw, sy: h / vh, tx: -vx * (w / vw), ty: -vy * (h / vh), slice: false };
  const slice = p[1] === "slice";
  const s = slice ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
  const ax = align.startsWith("xMin") ? 0 : align.startsWith("xMax") ? 1 : 0.5;
  const ay = align.endsWith("YMin") ? 0 : align.endsWith("YMax") ? 1 : 0.5;
  return { sx: s, sy: s, tx: (w - vw * s) * ax - vx * s, ty: (h - vh * s) * ay - vy * s, slice };
}

/** CSS we can scope by prefixing: no @font-face / @import and only class / id selectors. */
function scopableCss(css: string): boolean {
  if (/@font-face|@import|@namespace/i.test(css)) return false;
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{[^}]*\}/g, "\n").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return selectors.every((s) => /^([.#][A-Za-z_][\w-]*)(\s*[>+~\s]\s*[.#][A-Za-z_][\w-]*)*(:{1,2}[a-z-]+)?$/.test(s));
}

export function inlineSvgAsset(input: InlineSvgInput): InlineSvgOutput {
  const warnings: string[] = [];
  const map = recolorMap(input.recolor);
  const doc = new DOMParser({ onError: () => undefined }).parseFromString(input.svg, "image/svg+xml");
  const root = doc.documentElement as unknown as XElement | null;
  if (!root || root.localName !== "svg") {
    warnings.push("svg asset does not parse; skipped");
    return { markup: "", mode: "inline", warnings };
  }
  const vb = viewBoxOf(root) ?? [0, 0, input.w || 1, input.h || 1];
  const par = root.getAttribute("preserveAspectRatio");

  const styles = Array.from(root.getElementsByTagName("style")) as unknown as XElement[];
  const css = styles.map((s) => s.textContent ?? "").join("\n");
  if (css.trim() && !scopableCss(css)) {
    // Global CSS (fonts, element selectors) would leak into the frame. Isolate as an image.
    const text = recolorText(input.svg, map);
    return {
      markup: `<image${attrs({ id: input.prefix.replace(/-+$/, ""), x: input.x, y: input.y, width: input.w, height: input.h, preserveAspectRatio: par ?? "xMidYMid meet", href: dataUri("image/svg+xml", utf8Bytes(text)) })}/>`,
      mode: "image",
      warnings,
    };
  }

  const P = input.prefix;
  const ids = new Set<string>();
  const all = Array.from(root.getElementsByTagName("*")) as unknown as XElement[];
  for (const el of [root, ...all]) {
    const id = el.getAttribute("id");
    if (id) ids.add(id);
  }
  if (input.keepAccentId) ids.delete("accent");
  const refUrl = (s: string) => s.replace(/url\(\s*(['"]?)#([^)'"]+)\1\s*\)/g, (m, q: string, id: string) => (ids.has(id) ? `url(${q}#${P}${id}${q})` : m));
  const refHref = (s: string) => s.replace(/^#(.+)$/, (m, id: string) => (ids.has(id) ? `#${P}${id}` : m));
  const scopeCss = (text: string) =>
    text.replace(/([.#])([A-Za-z_][\w-]*)(?=[^{}]*\{)/g, (m, kind: string, name: string) => (kind === "#" && !ids.has(name) ? m : `${kind}${P}${name}`));

  for (const el of all) {
    for (const a of Array.from(el.attributes)) {
      let v = a.value;
      if (a.name === "id") v = input.keepAccentId && v === "accent" ? v : P + v;
      else if (a.name === "class") v = v.split(/\s+/).filter(Boolean).map((c) => P + c).join(" ");
      else {
        if (a.name === "href" || a.name === "xlink:href") v = refHref(v);
        else if (/url\(/.test(v)) v = refUrl(v);
        if (COLOR_ATTRS.has(a.name)) v = recolorText(v, map);
      }
      if (v !== a.value) el.setAttribute(a.name, v);
    }
    if (el.localName === "style") {
      const text = recolorText(scopeCss(el.textContent ?? ""), map);
      while (el.firstChild) el.removeChild(el.firstChild);
      el.appendChild(doc.createTextNode(text));
    }
  }

  const fit = fitViewBox(vb, input.w, input.h, par);
  const rootAttrs: Record<string, string> = {};
  for (const a of Array.from(root.attributes)) {
    if (SKIP_ROOT_ATTRS.has(a.name) || a.name.startsWith("xmlns")) continue;
    let v = a.value;
    if (a.name === "class") v = v.split(/\s+/).filter(Boolean).map((c) => P + c).join(" ");
    else if (COLOR_ATTRS.has(a.name)) v = recolorText(v, map);
    rootAttrs[a.name] = v;
  }

  const ser = new XMLSerializer();
  const body = (Array.from(root.childNodes) as XNode[])
    .filter((n) => n.nodeType === 1 || (n.nodeType === 3 && (n.nodeValue ?? "").trim()))
    .map((n) => ser.serializeToString(n as any).replace(/ xmlns(:xlink)?="[^"]*"/g, ""))
    .join("");

  const transform = `translate(${num(input.x + fit.tx)} ${num(input.y + fit.ty)})${fit.sx !== 1 || fit.sy !== 1 ? ` scale(${num(fit.sx)}${fit.sx === fit.sy ? "" : " " + num(fit.sy)})` : ""}`;
  let clip = "";
  let clipAttr: string | undefined;
  if (fit.slice) {
    clip = `<clipPath id="${P}clip"><rect${attrs({ x: input.x, y: input.y, width: input.w, height: input.h })}/></clipPath>`;
    clipAttr = `url(#${P}clip)`;
  }
  const inner = `<g${attrs({ transform, ...rootAttrs })}>${body}</g>`;
  const markup = clipAttr ? `${clip}<g clip-path="${clipAttr}">${inner}</g>` : inner;
  return { markup, mode: "inline", warnings };
}
