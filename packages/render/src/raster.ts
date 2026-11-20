// PNG via resvg-js from the outlined SVG (no system fonts involved), JPEG via sharp.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAsync, type RenderedImage } from "@resvg/resvg-js";
import sharp from "sharp";
import type { Document } from "@post-studio/schema";
import type { FontRegistry } from "@post-studio/text";
import { pickFrame, renderSvg } from "./render.ts";
import type { AssetData, AssetResolver, RenderOptions } from "./types.ts";

const fontFileCache = new WeakMap<FontRegistry, string[]>();

/**
 * resvg reads fonts from files only. Text inside `svg` assets (the only text resvg ever sees,
 * since our own text is outlined) uses the registered fonts, decompressed once into the temp dir.
 */
export function resvgFontFiles(reg: FontRegistry): string[] {
  let files = fontFileCache.get(reg);
  if (files) return files;
  const dir = join(tmpdir(), "post-studio-fonts");
  mkdirSync(dir, { recursive: true });
  files = reg.allFiles().map((f) => {
    // Named by the hash of the bytes written, so a bad file from an older run is never reused.
    const p = join(dir, `${createHash("sha256").update(f.sfnt).digest("hex").slice(0, 32)}.ttf`);
    if (!existsSync(p)) {
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, f.sfnt);
      renameSync(tmp, p);
    }
    return p;
  });
  fontFileCache.set(reg, files);
  return files;
}

/** resvg-js has no WebP decoder; hand it PNG copies. */
export async function pngSafeAssets(doc: Document, frameId: string | undefined, assets: AssetResolver): Promise<AssetResolver> {
  const frame = pickFrame(doc, frameId);
  const converted = new Map<string, AssetData>();
  const visit = async (nodes: Document["frames"][number]["children"]) => {
    for (const n of nodes) {
      if (n.type === "group") await visit(n.children);
      else if (n.type === "image") {
        const sha = n.asset.slice(7);
        const d = assets(sha);
        if (d?.mime === "image/webp" && !converted.has(sha)) converted.set(sha, { mime: "image/png", bytes: await sharp(Buffer.from(d.bytes)).png().toBuffer() });
      }
    }
  };
  await visit(frame.children);
  return converted.size ? (sha) => converted.get(sha) ?? assets(sha) : assets;
}

export interface PngOptions extends Omit<RenderOptions, "text" | "embedFonts"> {
  /** Output scale (1 = frame size in px). */
  scale?: number;
}

export interface PngResult {
  png: Buffer;
  width: number;
  height: number;
  /** The outlined SVG that was rasterized. */
  svg: string;
  warnings: string[];
}

/**
 * Rasterize an outlined SVG with resvg (no system fonts: text inside svg art uses the registered
 * fonts). `background` fills transparent areas (the video export flattens onto white like JPEG).
 */
export function rasterize(svg: string, fonts: FontRegistry, scale = 1, background?: string): Promise<RenderedImage> {
  return renderAsync(svg, {
    font: { loadSystemFonts: false, fontFiles: resvgFontFiles(fonts), defaultFontFamily: "IBM Plex Sans", sansSerifFamily: "IBM Plex Sans", serifFamily: "Alegreya", monospaceFamily: "IBM Plex Mono" },
    fitTo: scale !== 1 ? { mode: "zoom", value: scale } : { mode: "original" },
    shapeRendering: 2,
    textRendering: 2,
    imageRendering: 0,
    logLevel: "off",
    ...(background ? { background } : {}),
  });
}

export async function renderPng(doc: Document, opts: PngOptions): Promise<PngResult> {
  const assets = await pngSafeAssets(doc, opts.frame, opts.assets);
  const r = renderSvg(doc, { ...opts, assets, text: "outlined" });
  const img = await rasterize(r.svg, opts.fonts, opts.scale ?? 1);
  return { png: img.asPng(), width: img.width, height: img.height, svg: r.svg, warnings: r.warnings };
}

/** PNG → JPEG like social-posts/tools/to_jpg.py: quality 92, 4:4:4, alpha flattened onto white. */
export async function pngToJpeg(png: Buffer, quality = 92): Promise<Buffer> {
  return sharp(png).flatten({ background: "#ffffff" }).jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: false }).toBuffer();
}
