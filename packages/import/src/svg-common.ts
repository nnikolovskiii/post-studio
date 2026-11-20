// SVG attribute helpers shared by the CLI importer (svg.ts, xmldom) and the editor's paste /
// drop converter (paste.ts, the browser's DOM). Pure: no Node APIs, any DOM-like element works.
import type { Node } from "@post-studio/schema";

/** The parts of a DOM / xmldom element these helpers read. */
export interface SvgElementLike {
  readonly localName: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  readonly attributes: ArrayLike<{ name: string; value: string }>;
  readonly childNodes: ArrayLike<SvgNodeLike>;
  readonly textContent: string | null;
}
export interface SvgNodeLike {
  readonly nodeType: number;
  readonly nodeValue: string | null;
}

export type Attrs = Record<string, string>;

export const INHERITED = ["font-feature-settings", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "text-anchor", "visibility", "white-space"];
export const NAMED: Record<string, string> = { black: "#000000", white: "#FFFFFF", red: "#FF0000" };

export const kids = <E extends SvgElementLike>(el: E): E[] => (Array.from(el.childNodes) as unknown as E[]).filter((c) => (c as unknown as SvgNodeLike).nodeType === 1);

export function styleDecls(el: SvgElementLike): Attrs {
  const out: Attrs = {};
  for (const d of (el.getAttribute("style") ?? "").split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
  }
  return out;
}

/** Own attributes with style declarations on top (CSS wins over presentation attributes). */
export function own(el: SvgElementLike): Attrs {
  const out: Attrs = {};
  for (const a of Array.from(el.attributes)) if (a.name !== "style") out[a.name] = a.value;
  return { ...out, ...styleDecls(el) };
}

export function inherit(parent: Attrs, el: SvgElementLike, keys: readonly string[] = INHERITED): Attrs {
  const o = own(el);
  const out: Attrs = {};
  for (const k of keys) if (parent[k] !== undefined) out[k] = parent[k];
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export function parseColor(v: string | undefined, reasons: string[], what: string): string | null | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (s === "none" || s === "transparent") return null;
  if (NAMED[s.toLowerCase()]) return NAMED[s.toLowerCase()];
  if (/^#[0-9A-Fa-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toUpperCase();
  if (/^#[0-9A-Fa-f]{6}$/.test(s)) return s.toUpperCase();
  reasons.push(`${what}: color '${s}' (gradients, patterns and named colors are not post-studio/1 colors)`);
  return undefined;
}

export function withAlpha(hex: string | null | undefined, a: string | undefined): string | null | undefined {
  if (!hex || a === undefined) return hex;
  const v = Math.max(0, Math.min(1, Number(a)));
  if (!(v < 1)) return hex;
  return hex + Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase();
}

export const num = (v: string | null | undefined, d = 0) => (v === null || v === undefined || v === "" ? d : Number(v));
export const fam = (v: string | undefined) => (v ?? "").split(",")[0].trim().replace(/^['"]|['"]$/g, "");

export function letterSpacingPx(v: string | undefined, size: number): number | undefined {
  if (!v || v === "normal") return undefined;
  const m = /^(-?[\d.]+)(em|px)?$/.exec(v.trim());
  if (!m) return undefined;
  return m[2] === "em" ? Number(m[1]) * size : Number(m[1]);
}

export function shapeStroke(a: Attrs, reasons: string[], what: string) {
  const color = withAlpha(parseColor(a.stroke, reasons, what), a["stroke-opacity"]);
  if (!color) return undefined;
  const s: NonNullable<Extract<Node, { type: "rect" }>["stroke"]> = { color, width: num(a["stroke-width"], 1) };
  if (a["stroke-dasharray"] && a["stroke-dasharray"] !== "none") s.dash = a["stroke-dasharray"].split(/[\s,]+/).map(Number);
  if (a["stroke-linecap"]) s.cap = a["stroke-linecap"] as "butt" | "round" | "square";
  return s;
}

// ---------------------------------------------------------------- transforms

/** 2-D affine matrix [a b c d e f] (SVG order). */
export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m: Mat, n: Mat): Mat {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
export const applyMat = (m: Mat, p: { x: number; y: number }) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/** A transform attribute → matrix; undefined when it does not parse. */
export function parseTransform(t: string | null | undefined): Mat | undefined {
  if (!t || !t.trim()) return IDENTITY;
  let m: Mat = IDENTITY;
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/gy;
  let pos = 0;
  const s = t.trim();
  for (;;) {
    re.lastIndex = pos;
    const g = re.exec(s);
    if (!g) break;
    pos = re.lastIndex;
    const v = g[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (v.some((x) => !Number.isFinite(x))) return undefined;
    let k: Mat;
    switch (g[1]) {
      case "matrix":
        if (v.length !== 6) return undefined;
        k = v as Mat;
        break;
      case "translate":
        k = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case "scale":
        k = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const r = ((v[0] ?? 0) * Math.PI) / 180;
        const c = Math.cos(r);
        const sn = Math.sin(r);
        const cx = v[1] ?? 0;
        const cy = v[2] ?? 0;
        k = mul(mul([1, 0, 0, 1, cx, cy], [c, sn, -sn, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case "skewX":
        k = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        k = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    m = mul(m, k);
  }
  return pos === s.length ? m : undefined;
}

/** Rotation in degrees when `m` is a rotation + translation (no scale or skew), else undefined. */
export function rigidAngle(m: Mat): number | undefined {
  const [a, b, c, d] = m;
  if (Math.abs(a - d) > 1e-4 || Math.abs(b + c) > 1e-4 || Math.abs(a * a + b * b - 1) > 1e-4) return undefined;
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return Math.abs(deg) < 1e-6 ? 0 : Math.round(deg * 1000) / 1000;
}
