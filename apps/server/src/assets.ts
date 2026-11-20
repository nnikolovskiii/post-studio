import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "./config.ts";
import { sanitizeSvg } from "./sanitize-svg.ts";

export type AssetMime = "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";

export class AssetRejected extends Error {
  constructor(
    public readonly code: "too-large" | "unsupported-type" | "bad-svg",
    message: string,
  ) {
    super(message);
  }
}

/** Decide the type from the bytes, never from the client's Content-Type or filename. */
export function sniffMime(buf: Uint8Array): AssetMime | undefined {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  const head = b.toString("utf8", 0, Math.min(b.length, 4096)).replace(/^\uFEFF/, "").trimStart();
  if ((head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!--")) && /<svg[\s>]/.test(head)) return "image/svg+xml";
  return undefined;
}

export interface PreparedAsset {
  sha256: string;
  mime: AssetMime;
  bytes: Buffer;
  removed: string[];
}

/** Sniff, size-check and (for SVG) sanitize. The hash is of the stored bytes. */
export function prepareAsset(input: Uint8Array): PreparedAsset {
  const mime = sniffMime(input);
  if (!mime) throw new AssetRejected("unsupported-type", "only PNG, JPEG, WebP and SVG are accepted");
  let bytes = Buffer.from(input);
  let removed: string[] = [];
  if (mime === "image/svg+xml") {
    if (bytes.length > LIMITS.svgBytes) throw new AssetRejected("too-large", `SVG is ${bytes.length} bytes; limit is ${LIMITS.svgBytes}`);
    try {
      const s = sanitizeSvg(bytes.toString("utf8"));
      bytes = Buffer.from(s.svg, "utf8");
      removed = s.removed;
    } catch (e) {
      throw new AssetRejected("bad-svg", (e as Error).message);
    }
  } else if (bytes.length > LIMITS.imageBytes) {
    throw new AssetRejected("too-large", `image is ${bytes.length} bytes; limit is ${LIMITS.imageBytes}`);
  }
  return { sha256: createHash("sha256").update(bytes).digest("hex"), mime, bytes, removed };
}

/** Content-addressed files: <dir>/<aa>/<sha256>. */
export class AssetFiles {
  constructor(public readonly dir: string) {}

  path(sha256: string): string {
    return join(this.dir, sha256.slice(0, 2), sha256);
  }

  has(sha256: string): boolean {
    return existsSync(this.path(sha256));
  }

  write(sha256: string, bytes: Buffer): void {
    const p = this.path(sha256);
    if (existsSync(p)) return;
    mkdirSync(join(this.dir, sha256.slice(0, 2)), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, p);
  }

  read(sha256: string): Buffer {
    return readFileSync(this.path(sha256));
  }
}
