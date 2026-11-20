import { validateMotion } from "@post-studio/motion";
import { checkDocumentPalette, getKit, issueKey, listKits, resolveBrandToken, type DocPaletteResult } from "@post-studio/brand";
import { indexDocument, validateStructure, walk, type Document, type Issue, type Node, type TextNode } from "@post-studio/schema";

export interface TextMeasure {
  width: number;
  height: number;
  lines: number;
  overflowX: number;
  overflowY: number;
  missingGlyphs: string[];
}

export interface ValidationContext {
  /** Returns an error message when the family/weight is not registered. */
  checkFont?(family: string, weight: number): string | undefined;
  assetExists?(ref: string): boolean;
  measureText?(node: TextNode, lang: string): TextMeasure;
  /** Hex for a '<kit>.<name>' token, or undefined when unknown. Default: the registered brand kits. */
  resolveToken?(token: string): string | undefined;
  /** Overrides the document's own `strictPalette`: palette problems and unresolved tokens become errors. */
  strictPalette?: boolean;
  /** SVG text of an asset, so svg nodes' art can be palette-checked. */
  svgAsset?(ref: string): string | undefined;
  /** Previous version: nodes already outside their frame there do not warn again. */
  previous?: Document;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** Text measurements by node id (when measureText is available). */
  text?: Record<string, TextMeasure>;
  /** Brand kit palette check (when the document has a kit). */
  palette?: DocPaletteResult;
}

/** Full validation used on every apply: schema, ids, fonts, assets, tokens, text overflow, frame bounds, motion. */
export function validateDocument(input: unknown, ctx: ValidationContext = {}): ValidationResult {
  const s = validateStructure(input);
  if (!s.ok) return { ok: false, errors: s.errors, warnings: [] };
  const doc = s.doc!;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const text: Record<string, TextMeasure> = {};
  const prevOutside = ctx.previous ? outsideIds(ctx.previous) : new Set<string>();
  const nowOutside = outsideIds(doc);
  const resolveToken = ctx.resolveToken ?? resolveBrandToken;
  const strict = ctx.strictPalette ?? doc.strictPalette === true;

  for (const loc of walk(doc)) {
    const node = loc.item as Node;
    const issue = (code: string, message: string, path = loc.id): Issue => ({ path, node: loc.id, code, message });
    for (const c of colorsOf(loc.item)) {
      if (typeof c.value === "object" && c.value && "token" in c.value) {
        const t = (c.value as { token: string }).token;
        if (!resolveToken(t)) {
          (strict ? errors : warnings).push(issue("token", `color token '${t}' is not in a brand kit`, `${loc.id}.${c.path}`));
        }
      }
    }
    if (loc.kind !== "node") continue;
    if (node.type === "text") {
      const weights = new Set([node.style.weight, ...node.spans.map((s) => s.weight ?? node.style.weight)]);
      for (const w of weights) {
        const msg = ctx.checkFont?.(node.style.font, w);
        if (msg) errors.push(issue("font", msg, `${loc.id}.style.font`));
      }
      if (ctx.measureText && !errors.some((e) => e.node === loc.id && e.code === "font")) {
        const m = ctx.measureText(node, doc.lang);
        text[loc.id] = m;
        if (m.missingGlyphs.length) errors.push(issue("glyph", `font '${node.style.font}' has no glyph for ${m.missingGlyphs.map((c) => `'${c}'`).join(" ")}`));
        if (m.overflowX > 0.5) warnings.push(issue("overflow", `text is ${round(m.overflowX)} px wider than its box (a word does not fit)`));
        if (m.overflowY > 0.5) warnings.push(issue("overflow", `text overflows its box by ${round(m.overflowY)} px (${m.lines} lines)`));
      }
    }
    if ((node.type === "image" || node.type === "svg") && ctx.assetExists && !ctx.assetExists(node.asset)) {
      errors.push(issue("asset", `asset ${node.asset} is not uploaded`, `${loc.id}.asset`));
    }
    if (nowOutside.has(loc.id) && !prevOutside.has(loc.id)) {
      warnings.push(issue("bounds", `'${loc.id}' sticks out of frame '${loc.frame}'`));
    }
  }
  // Motion (post-studio/2): 'reveal' on a non-text layer and the keyframe budget are errors;
  // a keyframe after the end is a warning. Unknown tracks and out-of-range values already
  // failed the schema above.
  const motion = validateMotion(doc);
  errors.push(...motion.errors);
  warnings.push(...motion.warnings);
  let palette: DocPaletteResult | undefined;
  if (doc.brandKit) {
    const kit = getKit(doc.brandKit);
    if (!kit) {
      errors.push({ path: "brandKit", node: "$doc", code: "brand-kit", message: `unknown brand kit '${doc.brandKit}' (kits: ${listKits().map((k) => k.id).join(", ")})` });
    } else {
      const opts = { svgAsset: ctx.svgAsset, resolveToken };
      palette = checkDocumentPalette(doc, kit, opts);
      if (strict) {
        // Strict mode blocks new problems only; ones already in the previous version stay warnings,
        // so a fix that removes one of three problems is not refused (like the bounds rule).
        const prev = ctx.previous && ctx.previous.brandKit === doc.brandKit ? new Set(checkDocumentPalette(ctx.previous, kit, opts).issues.map(issueKey)) : new Set<string>();
        for (const i of palette.issues) {
          if (prev.has(issueKey(i))) warnings.push({ ...i, message: `${i.message} (already there before this change)` });
          else errors.push({ ...i, message: `${i.message} (strict palette)` });
        }
      } else warnings.push(...palette.issues);
    }
  }
  return { ok: errors.length === 0, errors, warnings, ...(ctx.measureText ? { text } : {}), ...(palette ? { palette } : {}) };
}

const round = (n: number) => Math.round(n * 10) / 10;

function colorsOf(item: unknown): Array<{ path: string; value: unknown }> {
  const it = item as Record<string, any>;
  const out: Array<{ path: string; value: unknown }> = [];
  if (it.fill !== undefined) out.push({ path: "fill", value: it.fill });
  if (it.stroke?.color !== undefined) out.push({ path: "stroke.color", value: it.stroke.color });
  if (it.style?.fill !== undefined) out.push({ path: "style.fill", value: it.style.fill });
  if (it.background?.color !== undefined) out.push({ path: "background.color", value: it.background.color });
  (it.spans ?? []).forEach((s: any, i: number) => s.fill !== undefined && out.push({ path: `spans.${i}.fill`, value: s.fill }));
  return out;
}

/** Ids of nodes whose (rotated) box is not fully inside their frame. Groups are judged by their children. */
export function outsideIds(doc: Document): Set<string> {
  const out = new Set<string>();
  const frames = new Map(doc.frames.map((f) => [f.id, f]));
  const idx = indexDocument(doc);
  for (const loc of idx.values()) {
    if (loc.kind !== "node") continue;
    const n = loc.item as Node;
    if (n.type === "group" || n.visible === false) continue;
    const f = frames.get(loc.frame)!;
    const [x0, y0, x1, y1] = bbox(n, loc.offset);
    const eps = 0.5;
    if (x0 < -eps || y0 < -eps || x1 > f.w + eps || y1 > f.h + eps) out.add(loc.id);
  }
  return out;
}

export function bbox(n: Node, offset = { x: 0, y: 0 }): [number, number, number, number] {
  const x = n.x + offset.x;
  const y = n.y + offset.y;
  const pts: Array<[number, number]> = [
    [x, y],
    [x + n.w, y],
    [x, y + n.h],
    [x + n.w, y + n.h],
  ];
  const r = ((n.rotation ?? 0) * Math.PI) / 180;
  let rotated = pts;
  if (r) {
    const cx = x + n.w / 2,
      cy = y + n.h / 2;
    rotated = pts.map(([px, py]) => [cx + (px - cx) * Math.cos(r) - (py - cy) * Math.sin(r), cy + (px - cx) * Math.sin(r) + (py - cy) * Math.cos(r)]);
  }
  const xs = rotated.map((p) => p[0]),
    ys = rotated.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
