import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/**
 * Find the file an SVG href points at. Absolute file:// paths are often from the other machine
 * (server `~/workspace` vs laptop `~/dev/workspace`), so when the path does not exist
 * its tail is tried under the workspace root (the folder holding social-posts) and the post
 * folder, then the bare file name inside the post folder (art/, source/, figma/assets/).
 */
export function resolveHref(href: string, postDir: string): string | undefined {
  if (!href || href.startsWith("data:") || href.startsWith("#") || /^https?:/i.test(href)) return undefined;
  let p: string;
  try {
    p = href.startsWith("file:") ? fileURLToPath(href) : resolve(postDir, decodeURIComponent(href));
  } catch {
    return undefined;
  }
  const ok = (f: string) => existsSync(f) && statSync(f).isFile();
  if (ok(p)) return p;
  const parts = p.split(sep).filter(Boolean);
  const workspace = dirname(dirname(dirname(resolve(postDir))));
  for (const root of [resolve(postDir), workspace]) {
    for (let i = 1; i < parts.length; i++) {
      const cand = join(root, ...parts.slice(i));
      if (ok(cand)) return cand;
    }
  }
  const name = basename(p);
  for (const sub of ["", "art", "source", "figma/assets", "assets"]) {
    const cand = join(postDir, sub, name);
    if (ok(cand)) return cand;
  }
  return undefined;
}

export function readDataUri(href: string): { mime: string; bytes: Buffer } | undefined {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(href);
  if (!m) return undefined;
  return { mime: m[1], bytes: m[2] ? Buffer.from(m[3].replace(/\s+/g, ""), "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8") };
}

export function sniffRaster(b: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | undefined {
  const s = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (s.length > 8 && s.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (s.length > 3 && s[0] === 0xff && s[1] === 0xd8) return "image/jpeg";
  if (s.length > 12 && s.toString("latin1", 0, 4) === "RIFF" && s.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/**
 * Bake `mix-blend-mode: multiply` over a solid backdrop into the pixels: colour × backdrop,
 * alpha kept. Drawn normally on that backdrop it looks the same as the blend
 * ((1 − a)·B + a·C·B), without needing blend modes (post-studio/1 has none).
 */
export async function bakeMultiply(bytes: Uint8Array, backdrop: string): Promise<Buffer> {
  const bg = [1, 3, 5].map((i) => parseInt(backdrop.slice(i, i + 2), 16));
  const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) data[i + c] = Math.round((data[i + c] * bg[c]) / 255);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

export function readFile(path: string): Buffer {
  return readFileSync(path);
}
