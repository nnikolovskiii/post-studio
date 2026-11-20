// pstudio import social-posts <post-dir>: layout (LUX Figma pack) → template post.svg → fallback.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { SCHEMA_VERSION, type Document, type Frame, type Node } from "@post-studio/schema";
import { accentTexts, knownKit, laneKit, markAccentTexts } from "./brand.ts";
import { copyLines } from "./copy.ts";
import { Ids } from "./ids.ts";
import { importLayoutFrame, readLayout } from "./layout.ts";
import { importFallbackFrame, importTemplateFrame, textNodes, type SvgFrameCtx } from "./svg.ts";
import { ImportError, type FrameReport, type ImportMode, type ImportOptions, type ImportReport, type ImportResult, type ImportedAsset } from "./types.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function readCopy(dir: string): Record<string, unknown> | undefined {
  const p = join(dir, "copy.json");
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new ImportError(`copy.json does not parse: ${(e as Error).message}`);
  }
}

function langOf(copy: Record<string, unknown> | undefined): string {
  if (typeof copy?.language === "string" && /^[a-z]{2,3}$/.test(copy.language)) return copy.language;
  const text = copyLines(copy).map((l) => l.text).join(" ");
  return /[Ѐ-ӿ]/.test(text) ? "mk" : "en";
}

function titleOf(copy: Record<string, unknown> | undefined, slug: string): string {
  const head = copyLines(copy).filter((l) => l.role === "headline").map((l) => l.text).join(" ");
  return (head || slug).slice(0, 200);
}

/** post.svg (+ post-li.svg) of a post folder: [file, frame id, frame name]. */
function svgFrames(dir: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  if (existsSync(join(dir, "post.svg"))) out.push(["post.svg", "square", "Square"]);
  if (existsSync(join(dir, "post-li.svg"))) out.push(["post-li.svg", "li", "LinkedIn"]);
  return out;
}

function frameReport(frame: Frame, source: string): FrameReport {
  let count = 0;
  const roles: Record<string, string[]> = {};
  const walk = (ns: Node[]) =>
    ns.forEach((n) => {
      count++;
      if (n.role) (roles[n.role] ??= []).push(n.id);
      if (n.type === "group") walk(n.children);
    });
  walk(frame.children);
  return { id: frame.id, name: frame.name, w: frame.w, h: frame.h, source, nodes: count, texts: textNodes(frame).length, roles };
}

export async function importSocialPost(postDir: string, opts: ImportOptions): Promise<ImportResult> {
  const dir = resolve(postDir);
  if (!existsSync(dir)) throw new ImportError(`no such folder: ${postDir}`);
  const slug = basename(dir);
  const copy = readCopy(dir);
  const lang = langOf(copy);
  const want = opts.mode ?? "auto";
  const why: string[] = [];
  const warnings: string[] = [];
  const skipped: string[] = [];

  const attempt = async (mode: ImportMode) => {
    const ids = new Ids();
    const assets: ImportedAsset[] = [];
    const cache = new Map<string, string>();
    const w: string[] = [];
    const sk: string[] = [];
    const frames: Frame[] = [];
    const sources: string[] = [];
    let maxAdvanceDelta: number | undefined;
    if (mode === "layout") {
      const layout = readLayout(dir);
      if (!layout) throw new ImportError("no figma/editable-layout.json");
      for (let i = 0; i < layout.length; i++) {
        const r = await importLayoutFrame(dir, layout[i], i, { opts, lang, copy, ids, assets, cache, warnings: w });
        // The layout pack is flat: take the accent object from post.svg's <g id="accent">.
        const marked = markAccentTexts(r.frame, accentTexts(dir, r.frame.id === "li" ? "post-li.svg" : "post.svg"));
        if (marked.length) w.push(`${r.frame.id}: accent object ${marked.join(", ")} (inside <g id="accent"> in ${r.frame.id === "li" ? "post-li.svg" : "post.svg"})`);
        frames.push(r.frame);
        sources.push(`figma/editable-layout.json#${i}`);
        maxAdvanceDelta = Math.max(maxAdvanceDelta ?? 0, r.maxAdvanceDelta);
      }
    } else {
      const files = svgFrames(dir);
      if (!files.length) throw new ImportError("no post.svg");
      for (const [file, frameId, frameName] of files) {
        const ctx: SvgFrameCtx = { opts, dir, lang, copy, ids, assets, cache, warnings: w, skipped: sk, frameId, frameName, suffix: frameId === "square" ? "" : `-${frameId}`, file };
        const svg = readFileSync(join(dir, file), "utf8");
        frames.push(mode === "template" ? await importTemplateFrame(ctx, svg) : await importFallbackFrame(ctx, svg));
        sources.push(file);
      }
    }
    return { frames, sources, assets, warnings: w, skipped: sk, maxAdvanceDelta };
  };

  const order: ImportMode[] = want === "auto" ? ["layout", "template", "fallback"] : [want];
  let result: Awaited<ReturnType<typeof attempt>> | undefined;
  let mode: ImportMode | undefined;
  for (const m of order) {
    try {
      result = await attempt(m);
      mode = m;
      break;
    } catch (e) {
      if (!(e instanceof ImportError) || want !== "auto") throw e;
      why.push(`${m}: ${e.message}`);
    }
  }
  if (!result || !mode) throw new ImportError(`nothing to import in ${postDir}`, why);
  warnings.push(...new Set(result.warnings));
  skipped.push(...new Set(result.skipped));

  const inputs: Record<string, string> = {};
  for (const f of ["copy.json", "post.svg", "post-li.svg", "figma/editable-layout.json"]) {
    const p = join(dir, f);
    if (existsSync(p)) inputs[f] = sha(readFileSync(p));
  }
  const kit = opts.kit === undefined ? laneKit(slug, copy) : opts.kit ?? undefined;
  if (kit && !knownKit(kit)) throw new ImportError(`unknown brand kit '${kit}'`);
  const doc: Document = {
    schema: SCHEMA_VERSION,
    id: "prj_import",
    title: (opts.title ?? titleOf(copy, slug)).slice(0, 200),
    lang,
    ...(kit ? { brandKit: kit } : {}),
    frames: result.frames,
    meta: {
      source: `social-posts/posts/${slug}`,
      import: { mode, at: (opts.now?.() ?? new Date()).toISOString(), inputs, ...(why.length ? { why } : {}), ...(skipped.length ? { skipped } : {}) },
      ...(copy ? { copy } : {}),
    },
  };
  const report: ImportReport = {
    mode,
    why,
    source: dir,
    frames: result.frames.map((f, i) => frameReport(f, result!.sources[i])),
    assets: result.assets,
    warnings,
    skipped,
    ...(result.maxAdvanceDelta !== undefined ? { maxAdvanceDelta: Math.round(result.maxAdvanceDelta * 1000) / 1000 } : {}),
  };
  return { doc, report };
}
