// Asset bytes for the renderer. Images are drawn by URL (the browser caches them); SVG art is
// inlined by packages/render, so its (sanitized) text must be here before the node draws.
import type { AssetData } from "@post-studio/render";
import { walk, type Document } from "@post-studio/schema";
import { api } from "./api.ts";

const cache = new Map<string, AssetData>();
const inflight = new Map<string, Promise<void>>();

export const assetUrl = (sha: string) => `/v1/assets/${sha}`;
export const getAsset = (sha: string) => cache.get(sha);

export function docAssets(doc: Document): string[] {
  const out = new Set<string>();
  for (const loc of walk(doc)) {
    const n = loc.item as { asset?: string };
    if (typeof n.asset === "string") out.add(n.asset.replace(/^sha256:/, ""));
  }
  return [...out];
}

/** Fetch whatever the document needs. Resolves true when something new arrived. */
export async function ensureAssets(doc: Document): Promise<boolean> {
  const missing = docAssets(doc).filter((s) => !cache.has(s));
  if (!missing.length) return false;
  await Promise.all(missing.map((sha) => fetchAsset(sha).catch(() => undefined)));
  return true;
}

function fetchAsset(sha: string): Promise<void> {
  let p = inflight.get(sha);
  if (!p) {
    p = (async () => {
      const res = await fetch(assetUrl(sha), { credentials: "same-origin" });
      if (!res.ok) throw new Error(`asset ${sha}: ${res.status}`);
      const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0];
      cache.set(sha, { mime, bytes: new Uint8Array(await res.arrayBuffer()) });
    })().finally(() => inflight.delete(sha));
    inflight.set(sha, p);
  }
  return p;
}

/** Upload a file; the server sniffs the type and sanitizes SVG. */
export async function uploadAsset(file: File): Promise<{ ref: string; mime: string; bytes: number; sanitized?: string[] }> {
  const r = await api<{ ref: string; mime: string; bytes: number; sanitized?: string[] }>("POST", "/v1/assets", new Uint8Array(await file.arrayBuffer()), {
    "content-type": "application/octet-stream",
    "x-filename": encodeURIComponent(file.name),
  });
  await fetchAsset(r.ref.replace(/^sha256:/, ""));
  return r;
}
