// (a) LUX Figma pack: figma/editable-layout.json is a flat scene graph per frame
// (rect / circle / line / image / baseline text with font requests and score data-*).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Frame, Node, TextNode } from "@post-studio/schema";
import { measureAdvance } from "@post-studio/text";
import { bakeMultiply } from "./assets.ts";
import { RoleMatcher, copyLines } from "./copy.ts";
import { boxOf, makeGroup } from "./geometry.ts";
import { Ids, slug } from "./ids.ts";
import { mergeLines, textNodeFromSpec, type Anchor, type TextSpec } from "./text.ts";
import { ImportError, type ImportOptions, type ImportedAsset } from "./types.ts";

interface LayoutItem {
  kind: "rect" | "circle" | "line" | "image" | "text";
  attrs: Record<string, string>;
  text?: string;
  font?: { family: string; style: string };
  inkBounds?: number[];
  advance?: number;
}

interface LayoutFrame {
  name: string;
  width: number;
  height: number;
  items: LayoutItem[];
}

export interface LayoutFrameResult {
  frame: Frame;
  maxAdvanceDelta: number;
}

const num = (v: string | undefined, d = 0) => (v === undefined || v === "" ? d : Number(v));
const hex = (v: string | undefined) => {
  if (!v || v === "none") return null;
  if (!/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(v)) throw new ImportError("unsupported color", [v]);
  const s = v.toUpperCase();
  return s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
};
const family = (v: string) => v.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
const isSpec = (x: unknown): x is TextSpec => !!x && typeof x === "object" && "lines" in (x as any) && "anchor" in (x as any);

export function readLayout(dir: string): LayoutFrame[] | undefined {
  const p = join(dir, "figma", "editable-layout.json");
  if (!existsSync(p)) return undefined;
  const data = JSON.parse(readFileSync(p, "utf8"));
  if (!Array.isArray(data) || !data.every((f) => Array.isArray(f?.items) && f.width > 0 && f.height > 0)) throw new ImportError("figma/editable-layout.json is not a list of frames with items");
  return data;
}

/** The layout's image items carry no href; the Figma pack ships the logo pre-blended on paper. */
async function logoAsset(dir: string, opts: ImportOptions, paper: string | null, assets: ImportedAsset[], cache: Map<string, string>): Promise<string> {
  const key = "logo";
  if (cache.has(key)) return cache.get(key)!;
  const onPaper = join(dir, "figma", "assets", "logo-on-paper.png");
  const light = [join(dir, "figma", "assets", "logo-light.png"), join(dir, "source", "logo-light.png")].find((p) => existsSync(p));
  let bytes: Buffer;
  let from: string;
  let note: string | undefined;
  if (existsSync(onPaper)) {
    bytes = readFileSync(onPaper);
    from = "figma/assets/logo-on-paper.png";
    note = "LUX logo pre-blended (multiply) on paper by the Figma pack";
  } else if (light && paper) {
    bytes = await bakeMultiply(readFileSync(light), paper);
    from = light.slice(dir.length + 1);
    note = `multiply onto ${paper} baked into the pixels`;
  } else throw new ImportError("layout has an image item but no figma/assets/logo-on-paper.png or logo-light.png");
  const up = await opts.upload(bytes, "logo.png");
  assets.push({ ref: up.ref, mime: up.mime, from, note });
  cache.set(key, up.ref);
  return up.ref;
}

export async function importLayoutFrame(
  dir: string,
  lf: LayoutFrame,
  index: number,
  ctx: { opts: ImportOptions; lang: string; copy?: Record<string, unknown>; ids: Ids; assets: ImportedAsset[]; cache: Map<string, string>; warnings: string[] },
): Promise<LayoutFrameResult> {
  const { opts, lang, ids } = ctx;
  const W = lf.width;
  const H = lf.height;
  const isLi = W === 1080 && H === 1350;
  const frameId = index === 0 ? "square" : isLi ? "li" : `frame-${index + 1}`;
  const suffix = index === 0 ? "" : `-${frameId}`;
  const roles = new RoleMatcher(copyLines(ctx.copy));
  let background: string | null = null;
  let maxDelta = 0;

  const entries: Array<Node | TextSpec> = [];
  lf.items.forEach((it, i) => {
    const a = it.attrs ?? {};
    const srcId = a.id ?? `${it.kind}-${i + 1}`;
    if (it.kind === "rect" && i === 0 && num(a.x) === 0 && num(a.y) === 0 && num(a.width) === W && num(a.height) === H && !a.stroke) {
      background = hex(a.fill);
      return;
    }
    switch (it.kind) {
      case "rect": {
        const n: Node = { id: srcId, type: "rect", x: num(a.x), y: num(a.y), w: num(a.width), h: num(a.height), fill: a.fill === undefined ? "#000000" : hex(a.fill) };
        if (a.rx) n.radius = num(a.rx);
        if (a.stroke && a.stroke !== "none") n.stroke = { color: hex(a.stroke)!, width: num(a["stroke-width"], 1) };
        entries.push(n);
        return;
      }
      case "circle": {
        const r = num(a.r);
        const n: Node = { id: srcId, type: "ellipse", x: num(a.cx) - r, y: num(a.cy) - r, w: 2 * r, h: 2 * r, fill: a.fill === undefined ? "#000000" : hex(a.fill) };
        if (a.stroke && a.stroke !== "none") n.stroke = { color: hex(a.stroke)!, width: num(a["stroke-width"], 1) };
        entries.push(n);
        return;
      }
      case "line": {
        const x1 = num(a.x1);
        const y1 = num(a.y1);
        const n: Node = { id: srcId, type: "line", x: x1, y: y1, w: Math.round((num(a.x2) - x1) * 1000) / 1000, h: Math.round((num(a.y2) - y1) * 1000) / 1000, stroke: { color: hex(a.stroke) ?? "#000000", width: num(a["stroke-width"], 1) } };
        if (a["stroke-linecap"]) n.stroke.cap = a["stroke-linecap"] as "butt" | "round" | "square";
        entries.push(n);
        return;
      }
      case "image": {
        const par = a.preserveAspectRatio ?? "xMidYMid meet";
        entries.push({ id: srcId, type: "image", role: "logo", asset: "sha256:" + "0".repeat(64), x: num(a.x), y: num(a.y), w: num(a.width), h: num(a.height), fit: par === "none" ? "fill" : par.includes("slice") ? "cover" : "contain" });
        return;
      }
      case "text": {
        const text = it.text ?? "";
        const spec: TextSpec = {
          id: srcId,
          lines: [[{ text }]],
          font: family(a["font-family"] ?? it.font?.family ?? "IBM Plex Sans"),
          weight: num(a["font-weight"], 400),
          size: num(a["font-size"], 16),
          fill: hex(a.fill) ?? "#000000",
          anchor: (a["text-anchor"] ?? "start") as Anchor,
          x: num(a.x),
          baseline: num(a.y),
        };
        if (a["letter-spacing"]) spec.letterSpacing = num(a["letter-spacing"]);
        const meta: Record<string, unknown> = {};
        if (a["data-model"]) meta.model = a["data-model"];
        if (a["data-judge"]) meta.judge = a["data-judge"];
        if (a["data-score"]) meta.score = Number(a["data-score"]);
        if (Object.keys(meta).length) spec.meta = meta;
        const role = roles.take(text);
        if (role) spec.role = role.role;
        else if (meta.score !== undefined) spec.role = "score";
        if (typeof it.advance === "number") {
          const ours = measureAdvance(opts.fonts, text, { font: spec.font, weight: spec.weight, size: spec.size, letterSpacing: spec.letterSpacing }, lang);
          maxDelta = Math.max(maxDelta, Math.abs(ours - it.advance));
        }
        entries.push(spec);
        return;
      }
      default:
        ctx.warnings.push(`${lf.name}: item ${i + 1} kind '${(it as LayoutItem).kind}' is not supported; skipped`);
    }
  });

  // Text: merge headline lines, then boxes from packages/text metrics.
  const merged = mergeLines(entries, isSpec) as Array<Node | TextSpec>;
  const nodes: Node[] = [];
  for (const e of merged) {
    if (isSpec(e)) nodes.push(textNodeFromSpec({ fonts: opts.fonts, lang, frameW: W }, e));
    else if (e.type === "image") nodes.push({ ...e, asset: await logoAsset(dir, opts, background, ctx.assets, ctx.cache) });
    else nodes.push(e);
  }

  const grouped = groupChart(nodes);
  const finalNodes = assignIds(grouped, ids, suffix);
  const frame: Frame = { id: frameId, name: isLi ? "LinkedIn" : index === 0 ? "Square" : lf.name, w: W, h: H, children: finalNodes, meta: { source: `figma/editable-layout.json#${index}`, sourceName: lf.name } };
  if (background) frame.background = { color: background };
  return { frame, maxAdvanceDelta: maxDelta };
}

const modelOf = (n: Node): string | undefined => (n.type === "text" && typeof n.meta?.model === "string" ? (n.meta.model as string) : undefined);

/**
 * Chart rows: each model's two score labels plus the items drawn just before them back to the
 * model's name label (connector line, square and dot markers) become one group with the scores
 * in meta. The rows plus the header just above them become the 'chart' group.
 */
function groupChart(nodes: Node[]): Node[] {
  const models = [...new Set(nodes.map(modelOf).filter((m): m is string => !!m))];
  if (!models.length) return nodes;
  const rows: Array<{ start: number; end: number; model: string }> = [];
  for (const model of models) {
    const idx = nodes.map((n, i) => (modelOf(n) === model ? i : -1)).filter((i) => i >= 0);
    let start = idx[0] - 1;
    while (start >= 0 && !(nodes[start].type === "text" && !modelOf(nodes[start]))) start--;
    if (start < 0) continue;
    const end = idx[idx.length - 1];
    if (nodes.slice(start, end + 1).some((n) => modelOf(n) && modelOf(n) !== model)) continue;
    rows.push({ start, end, model });
  }
  if (!rows.length) return nodes;
  const out: Node[] = [];
  let i = 0;
  const rowNodes: Node[] = [];
  for (const row of rows.sort((a, b) => a.start - b.start)) {
    while (i < row.start) out.push(nodes[i++]);
    const members = nodes.slice(row.start, row.end + 1);
    const scores: Record<string, number> = {};
    for (const m of members) if (m.type === "text" && m.meta?.judge && typeof m.meta.score === "number") scores[m.meta.judge as string] = m.meta.score;
    const label = members[0] as TextNode;
    const s = slug(row.model.split("/").pop() ?? row.model);
    label.role = "label";
    label.meta = { ...(label.meta ?? {}), model: row.model };
    (label as any)._id = `label-${s}`;
    for (const m of members) if (m.type === "text" && m.meta?.judge) (m as any)._id = `score-${s}-${slug(String(m.meta.judge))}`;
    const g = makeGroup("row", members, { role: "chart-row", name: label.spans.map((x) => x.text).join(""), meta: { model: row.model, scores } });
    (g as any)._id = `row-${s}`;
    out.push(g);
    rowNodes.push(g);
    i = row.end + 1;
  }
  while (i < nodes.length) out.push(nodes[i++]);

  // Header (column titles, axis lines) directly above the first row joins the chart group.
  const first = out.indexOf(rowNodes[0]);
  const last = out.indexOf(rowNodes[rowNodes.length - 1]);
  const top = boxOf(rowNodes[0]).y;
  let start = first;
  while (start > 0 && boxOf(out[start - 1]).y >= top - 60) start--;
  const members = out.slice(start, last + 1);
  const judges = [...new Set(rowNodes.flatMap((r) => Object.keys((r.meta?.scores as object) ?? {})))];
  const chart = makeGroup("chart", members, { role: "chart", name: "Chart", meta: { judges, rows: rowNodes.map((r) => ({ model: r.meta!.model, scores: r.meta!.scores })) } });
  (chart as any)._id = "chart";
  return [...out.slice(0, start), chart, ...out.slice(last + 1)];
}

/** Final ids: the role for copy roles (headline, kicker …), readable row ids, otherwise the source id. */
function assignIds(nodes: Node[], ids: Ids, suffix: string): Node[] {
  const COPY_ROLES = new Set(["kicker", "headline", "sub", "chip", "emphasis", "source", "footer", "status", "cta", "logo"]);
  return nodes.map((n) => {
    const preferred = (n as any)._id ?? (n.role && COPY_ROLES.has(n.role) ? n.role : n.id.replace(/-copy$/, ""));
    const { _id: _drop, ...rest } = n as any;
    const out = { ...rest, id: ids.take(preferred, suffix) } as Node;
    if (preferred !== n.id && !out.name) out.name = n.id;
    if (out.type === "group") out.children = assignIds(out.children, ids, suffix);
    return out;
  });
}
