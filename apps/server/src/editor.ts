// Serves the built editor (apps/editor/dist) and the font files the editor needs: woff2 for
// @font-face and decompressed sfnt for HarfBuzz in the browser (same layout as the server).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Store } from "./store.ts";
import { StoreError } from "./store.ts";

export const DEFAULT_EDITOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../editor/dist");

/** CSP for the editor page. WASM (HarfBuzz) needs 'wasm-unsafe-eval'; inline styles carry SVG art CSS. */
export const EDITOR_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

function securityHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY")
    .header("Referrer-Policy", "same-origin")
    .header("Content-Security-Policy", EDITOR_CSP);
}

export function registerEditorRoutes(app: FastifyInstance, store: Store, editorDir = DEFAULT_EDITOR_DIR): void {
  const root = resolve(editorDir);
  const indexPage = async (_req: unknown, reply: FastifyReply) => {
    const file = join(root, "index.html");
    securityHeaders(reply).header("Cache-Control", "no-cache");
    if (!existsSync(file)) {
      return reply
        .code(503)
        .type("text/html; charset=utf-8")
        .send(`<!doctype html><meta charset="utf-8"><title>Post Studio</title><p>The editor is not built. Run <code>pnpm build:editor</code> (or restart <code>pstudio serve</code>, which builds it).</p>`);
    }
    return reply.type("text/html; charset=utf-8").send(readFileSync(file));
  };
  app.get("/", indexPage);
  app.get("/login", indexPage);
  app.get("/p/:id", indexPage);

  app.get("/static/*", async (req, reply) => {
    const rel = (req.params as { "*": string })["*"];
    const file = resolve(root, "static", rel);
    if (!file.startsWith(join(root, "static") + sep) || rel.includes("\0") || !existsSync(file) || !statSync(file).isFile()) {
      return reply.code(404).type("text/plain").send("not found");
    }
    securityHeaders(reply).header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.type(MIME[extname(file)] ?? "application/octet-stream").send(readFileSync(file));
  });

  // ---- fonts for the editor (behind the same auth as the API)
  const files = () => new Map(store.fonts.allFiles().map((f) => [f.file, f]));
  app.get("/v1/fonts/manifest", async () => ({
    manifest: store.fonts.manifest(),
    files: store.fonts.allFiles().map((f) => ({ file: f.file, sha256: f.sha256, bytes: f.bytes })),
  }));
  const fontFile = (kind: "files" | "sfnt") => async (req: { params: unknown }, reply: FastifyReply) => {
    const name = (req.params as { file: string }).file;
    const f = files().get(name);
    if (!f) throw new StoreError(404, "not-found", `font file '${name}' is not registered`);
    reply.header("Cache-Control", "private, max-age=31536000, immutable").header("X-Content-Type-Options", "nosniff");
    if (kind === "files") {
      if (!f.raw) throw new StoreError(404, "not-found", "font bytes not loaded");
      return reply.type(f.file.endsWith(".woff2") ? "font/woff2" : "font/ttf").send(Buffer.from(f.raw));
    }
    return reply.type("font/sfnt").send(Buffer.from(f.sfnt));
  };
  app.get("/v1/fonts/files/:file", fontFile("files"));
  app.get("/v1/fonts/sfnt/:file", fontFile("sfnt"));
}
