// Render and export endpoints. Rendering is pure (packages/render); the server only supplies
// the document at a revision, the registered fonts and the asset bytes.
import type { FastifyInstance } from "fastify";
import { MOTION_LIMITS } from "@post-studio/schema";
import { posterTime } from "@post-studio/motion";
import { contactSheet, contactTimes, exportProject, pngToJpeg, renderPng, renderSvg, type AssetResolver } from "@post-studio/render";
import { StoreError, type Store } from "./store.ts";

export const RENDER_FORMATS = ["png", "jpg", "svg", "figma", "outlined"] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

export function assetResolver(store: Store): AssetResolver {
  return (sha) => (store.hasAsset(sha) ? store.getAsset(sha) : undefined);
}

export interface RenderRequest {
  rev?: number;
  frame?: string;
  format?: RenderFormat;
  scale?: number;
  /**
   * The moment of a motion project, ms. Undefined = its poster moment (`motion.poster`; 'rest' =
   * no animation applied), so thumbnails and history pictures show the still. 'rest' = the rest
   * pose. Ignored for still posts.
   */
  t?: number | "rest";
}

/** The `t` query value: whole ms 0–600000, or 'rest'. */
export function timeParam(v: unknown): number | "rest" | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (v === "rest") return "rest";
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MOTION_LIMITS.maxTime) throw new StoreError(400, "bad-request", `t is a time in whole ms (0–${MOTION_LIMITS.maxTime}) or 'rest'`);
  return n;
}

type Rendered = { rev: number; frame: string; mime: string; bytes: Buffer; warnings: string[]; time: number | "rest" };
// A revision never changes, so (project, rev, frame, format, scale) → bytes can be cached.
// The editor's project list asks for thumbnails on every visit.
const cache = new WeakMap<Store, Map<string, Rendered>>();

export async function renderProject(store: Store, id: string, req: RenderRequest): Promise<Rendered> {
  const p = store.getProject(id, req.rev);
  const key = `${id}|${p.rev}|${req.frame ?? ""}|${req.format ?? "png"}|${req.scale ?? 1}|${req.t ?? "poster"}`;
  let perStore = cache.get(store);
  if (!perStore) cache.set(store, (perStore = new Map()));
  const hit = perStore.get(key);
  if (hit) return hit;
  const r = await renderUncached(store, p, req);
  if (perStore.size >= 64) perStore.delete(perStore.keys().next().value!);
  perStore.set(key, r);
  return r;
}

async function renderUncached(store: Store, p: ReturnType<Store["getProject"]>, req: RenderRequest): Promise<Rendered> {
  const format = req.format ?? "png";
  if (!RENDER_FORMATS.includes(format)) throw new StoreError(400, "bad-request", `format must be one of ${RENDER_FORMATS.join(", ")}`);
  if (req.frame !== undefined && !p.doc.frames.some((f) => f.id === req.frame)) {
    throw new StoreError(404, "not-found", `frame '${req.frame}' not found (frames: ${p.doc.frames.map((f) => f.id).join(", ")})`);
  }
  const scale = req.scale ?? 1;
  if (!(scale >= 0.1 && scale <= 4)) throw new StoreError(400, "bad-request", "scale must be 0.1–4");
  const time = !p.doc.motion ? undefined : req.t === undefined ? posterTime(p.doc.motion) : req.t === "rest" ? undefined : req.t;
  const base = { fonts: store.fonts, assets: assetResolver(store), frame: req.frame, ...(time !== undefined ? { time } : {}) };
  const t = time ?? "rest";
  if (format === "png" || format === "jpg") {
    const r = await renderPng(p.doc, { ...base, scale });
    const bytes = format === "png" ? r.png : await pngToJpeg(r.png);
    return { rev: p.rev, frame: req.frame ?? p.doc.frames[0].id, mime: format === "png" ? "image/png" : "image/jpeg", bytes, warnings: r.warnings, time: t };
  }
  const r = renderSvg(p.doc, { ...base, text: format === "outlined" ? "outlined" : "live", embedFonts: format === "svg", positioning: format === "figma" ? "line" : "glyph" });
  return { rev: p.rev, frame: r.frame.id, mime: "image/svg+xml", bytes: Buffer.from(r.svg, "utf8"), warnings: r.warnings, time: t };
}

/** A rev query value: a number, or a reference such as 'approved', 'last-approved', 'agent-2', 'head'. */
export function revParam(store: Store, id: string, v: unknown, int: (v: unknown, name: string) => number | undefined): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number" || /^\d+$/.test(String(v))) return int(v, "rev");
  return store.resolveRef(id, String(v));
}

export function registerRenderRoutes(app: FastifyInstance, store: Store, int: (v: unknown, name: string) => number | undefined): void {
  // GET /v1/projects/:id/render?frame=&rev=&format=png|jpg|svg|figma|outlined&scale=&t=
  app.get("/v1/projects/:id/render", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const scale = q.scale === undefined || q.scale === "" ? undefined : Number(q.scale);
    const r = await renderProject(store, (req.params as { id: string }).id, { rev: revParam(store, (req.params as { id: string }).id, q.rev, int), frame: q.frame || undefined, format: (q.format || "png") as RenderFormat, scale, t: timeParam(q.t) });
    reply.header("X-Post-Studio-Rev", String(r.rev));
    reply.header("X-Post-Studio-Frame", r.frame);
    reply.header("X-Post-Studio-Time", String(r.time));
    reply.header("X-Post-Studio-Warnings", encodeURIComponent(JSON.stringify(r.warnings.slice(0, 50))));
    reply.header("X-Content-Type-Options", "nosniff");
    if (r.mime === "image/svg+xml") reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
    return reply.type(r.mime).send(r.bytes);
  });

  // GET /v1/projects/:id/contact?frame=&rev=&n=12&columns=4&width=360 → one PNG with n moments.
  app.get("/v1/projects/:id/contact", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as Record<string, string | undefined>;
    const p = store.getProject(id, revParam(store, id, q.rev, int));
    if (!p.doc.motion) throw new StoreError(422, "no-motion", `${id} rev ${p.rev} is a still post (no motion): render it without --contact`);
    if (q.frame && !p.doc.frames.some((f) => f.id === q.frame)) throw new StoreError(404, "not-found", `frame '${q.frame}' not found (frames: ${p.doc.frames.map((f) => f.id).join(", ")})`);
    const n = int(q.n, "n") ?? 12;
    const columns = int(q.columns, "columns") ?? 4;
    const cellWidth = int(q.width, "width") ?? 360;
    if (n < 2 || n > 48 || columns < 1 || columns > 12 || cellWidth < 80 || cellWidth > 1080) throw new StoreError(400, "bad-request", "n is 2–48, columns 1–12, width 80–1080");
    const r = await contactSheet(p.doc, { fonts: store.fonts, assets: assetResolver(store), frame: q.frame || undefined, times: contactTimes(p.doc.motion, n), columns, cellWidth });
    reply.header("X-Post-Studio-Rev", String(p.rev));
    reply.header("X-Post-Studio-Frame", q.frame || p.doc.frames[0].id);
    reply.header("X-Post-Studio-Times", r.times.join(","));
    reply.header("X-Post-Studio-Warnings", encodeURIComponent(JSON.stringify(r.warnings.slice(0, 50))));
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.type("image/png").send(r.png);
  });

  // POST /v1/projects/:id/export {rev?, frames?} → every file, base64, plus the manifest.
  app.post("/v1/projects/:id/export", async (req) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const id = (req.params as { id: string }).id;
    const p = store.getProject(id, revParam(store, id, body.rev, int));
    if (body.frames !== undefined && (!Array.isArray(body.frames) || body.frames.some((f: unknown) => typeof f !== "string"))) {
      throw new StoreError(400, "bad-request", "frames must be a list of frame ids");
    }
    const unknown = (body.frames ?? []).filter((f: string) => !p.doc.frames.some((x) => x.id === f));
    if (unknown.length) throw new StoreError(404, "not-found", `frame(s) not found: ${unknown.join(", ")}`);
    const r = await exportProject(p.doc, { fonts: store.fonts, assets: assetResolver(store), frames: body.frames, project: id, rev: p.rev });
    return {
      project: id,
      rev: p.rev,
      frames: r.frames,
      // Motion projects: the stills above are the poster moment; the MP4s come from the video jobs.
      ...(p.doc.motion ? { motion: p.doc.motion } : {}),
      warnings: r.warnings,
      files: r.files.map((f) => ({ path: f.path, mime: f.mime, bytes: f.bytes.length, sha256: f.sha256, base64: f.bytes.toString("base64") })),
    };
  });
}
