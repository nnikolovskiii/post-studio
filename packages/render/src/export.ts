// One export = every frame as post.svg / post.png / post.jpg (+ -li and other frame variants),
// the two Figma SVG variants under figma/, the document itself and a manifest.
// File names follow social-posts (review-site/build.py reads post.jpg, post-li.png, copy.json …).
import { createHash } from "node:crypto";
import { fpsOf, frameCount, posterTime } from "@post-studio/motion";
import type { Document, Frame } from "@post-studio/schema";
import { renderPng, pngToJpeg } from "./raster.ts";
import { renderSvg } from "./render.ts";
import type { AssetResolver } from "./types.ts";
import type { FontRegistry } from "@post-studio/text";

export interface ExportFile {
  /** Relative path inside the export folder, '/' separated. */
  path: string;
  mime: string;
  bytes: Buffer;
  sha256: string;
}

export interface ExportFrameInfo {
  id: string;
  name: string;
  w: number;
  h: number;
  /** File stem: 'post', 'post-li' or 'post-<frame id>'. */
  stem: string;
  files: string[];
  /** Motion projects: the MP4 of this frame ('<stem>.mp4'), written by the video export (pstudio export). */
  video?: string;
}

export interface ExportResult {
  files: ExportFile[];
  frames: ExportFrameInfo[];
  warnings: string[];
  manifest: Record<string, unknown>;
}

export interface ExportOptions {
  fonts: FontRegistry;
  assets: AssetResolver;
  resolveToken?: (token: string) => string | undefined;
  /** Only these frames (default all). */
  frames?: string[];
  /** Stored in the manifest. */
  project?: string;
  rev?: number;
  /** Clock for the manifest (tests). */
  now?: () => Date;
  /** JPEG quality (default 92, like social-posts/tools/to_jpg.py). */
  jpegQuality?: number;
}

const LI = /(^|[^a-z])(li|linkedin|portrait)([^a-z]|$)/i;

/**
 * File stem per frame. The first frame is the main post ('post'); a LinkedIn / portrait frame
 * (id or name says so, or the first 1080×1350 frame) is 'post-li'; anything else 'post-<id>'.
 */
export function frameStems(doc: Document): Map<string, string> {
  const stems = new Map<string, string>();
  const used = new Set<string>();
  const take = (f: Frame, stem: string) => {
    stems.set(f.id, stem);
    used.add(stem);
  };
  take(doc.frames[0], "post");
  const liCandidate = doc.frames.slice(1).find((f) => LI.test(f.id) || LI.test(f.name)) ?? doc.frames.slice(1).find((f) => f.w === 1080 && f.h === 1350);
  if (liCandidate) take(liCandidate, "post-li");
  for (const f of doc.frames) {
    if (stems.has(f.id)) continue;
    let stem = `post-${f.id}`;
    for (let k = 2; used.has(stem); k++) stem = `post-${f.id}-${k}`;
    take(f, stem);
  }
  return stems;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const file = (path: string, mime: string, bytes: Buffer): ExportFile => ({ path, mime, bytes, sha256: sha(bytes) });

export async function exportProject(doc: Document, opts: ExportOptions): Promise<ExportResult> {
  const stems = frameStems(doc);
  const wanted = opts.frames?.length ? doc.frames.filter((f) => opts.frames!.includes(f.id)) : doc.frames;
  const missing = (opts.frames ?? []).filter((id) => !doc.frames.some((f) => f.id === id));
  if (missing.length) throw new Error(`frame(s) not found: ${missing.join(", ")} (frames: ${doc.frames.map((f) => f.id).join(", ")})`);
  // A motion project's stills are its poster moment ('rest' = the layout as designed).
  const time = doc.motion ? posterTime(doc.motion) : undefined;
  const base = { fonts: opts.fonts, assets: opts.assets, resolveToken: opts.resolveToken, ...(time !== undefined ? { time } : {}) };
  const files: ExportFile[] = [];
  const frames: ExportFrameInfo[] = [];
  const warnings = new Set<string>();

  for (const f of wanted) {
    const stem = stems.get(f.id)!;
    // post.svg: live <text> with the registered fonts embedded, so it renders the same anywhere.
    const live = renderSvg(doc, { ...base, frame: f.id, text: "live", embedFonts: true });
    // Figma ignores @font-face; it maps family + weight to its own installed fonts.
    const figma = renderSvg(doc, { ...base, frame: f.id, text: "live", embedFonts: false, positioning: "line" });
    const png = await renderPng(doc, { ...base, frame: f.id });
    const jpg = await pngToJpeg(png.png, opts.jpegQuality ?? 92);
    for (const w of [...live.warnings, ...png.warnings]) warnings.add(`${f.id}: ${w}`);
    const out = [
      file(`${stem}.svg`, "image/svg+xml", Buffer.from(live.svg, "utf8")),
      file(`${stem}.png`, "image/png", png.png),
      file(`${stem}.jpg`, "image/jpeg", jpg),
      file(`figma/${stem}.figma-ready.svg`, "image/svg+xml", Buffer.from(figma.svg, "utf8")),
      file(`figma/${stem}.outlined.svg`, "image/svg+xml", Buffer.from(png.svg, "utf8")),
    ];
    files.push(...out);
    frames.push({ id: f.id, name: f.name, w: f.w, h: f.h, stem, files: out.map((x) => x.path), ...(doc.motion ? { video: `${stem}.mp4` } : {}) });
  }

  files.push(file("post-studio.json", "application/json", Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8")));
  const manifest = {
    format: "post-studio-export/1",
    project: opts.project ?? doc.id,
    rev: opts.rev ?? null,
    title: doc.title,
    exportedAt: (opts.now?.() ?? new Date()).toISOString(),
    frames,
    ...(doc.motion
      ? { motion: { duration: doc.motion.duration, fps: fpsOf(doc.motion), frames: frameCount(doc.motion), loop: !!doc.motion.loop, poster: doc.motion.poster ?? "rest" } }
      : {}),
    files: files.map((x) => ({ path: x.path, bytes: x.bytes.length, sha256: x.sha256 })),
    warnings: [...warnings],
    notes: {
      ...(doc.motion
        ? {
            "post.mp4": "one pass of the motion (H.264 crf 18, yuv420p, +faststart, frame i at round(i × 1000 / fps) ms); the stills are the poster moment",
          }
        : {}),
      "post.svg": "live text, registered fonts embedded as @font-face, every glyph at its HarfBuzz x (renders like post.png in any browser)",
      "figma/*.figma-ready.svg": "live text, one x per line, no embedded fonts; Figma maps family + weight to its installed fonts",
      "figma/*.outlined.svg": "text as glyph paths shaped by HarfBuzz; needs no fonts; the PNG is rasterized from it",
      "post.png": "resvg-js from the outlined SVG",
      "post.jpg": "sharp, quality 92, 4:4:4, flattened onto white",
    },
  };
  files.push(file("export.json", "application/json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8")));
  return { files, frames, warnings: [...warnings], manifest };
}
