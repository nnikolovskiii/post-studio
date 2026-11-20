// Video export jobs (PLAN-motion.md §5.7). GET /v1/projects/:id/video starts (or reuses) a job and
// answers 202 { job } (200 when the file is already there); GET /v1/video-jobs/:job gives its
// status, GET /v1/video-jobs/:job/file the MP4. Finished files live in <data>/renders/, keyed by a
// hash of (document at that rev, frame, scale, renderer + encoder settings, fonts), so the same
// request is instant the second time and survives a restart. renders/ is a cache: not in backups,
// trimmed to the newest `keep` files and `maxBytes`, rebuilt on demand.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { fpsOf, frameCount } from "@post-studio/motion";
import { encodeVideo, findFfmpeg, RENDER_VERSION, VIDEO_SETTINGS } from "@post-studio/render";
import type { Document } from "@post-studio/schema";
import { assetResolver, revParam } from "./render.ts";
import { StoreError, type Store } from "./store.ts";

export interface VideoConfig {
  /** ffmpeg binary; null = none found (video requests answer 503). Default: findFfmpeg(). */
  ffmpeg?: string | null;
  /** Video jobs encoding at the same time (default 1). */
  maxJobs?: number;
  /** Jobs waiting at most (default 8); more answer 503 busy. */
  maxQueued?: number;
  /** Frames rasterized at the same time inside one job (default 3). */
  concurrency?: number;
  /** ffmpeg / x264 threads (default ffmpeg's choice). */
  threads?: number;
  /** Cache: keep at most this many videos (default 20) … */
  keep?: number;
  /** … and at most this many bytes (default 2 GB), whichever is reached first. */
  maxBytes?: number;
}

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

/** POST_STUDIO_FFMPEG / PATH / ~/.local/bin, POST_STUDIO_VIDEO_JOBS (1), _CONCURRENCY (3), _THREADS (4), _KEEP (20), _CACHE_MB (2048). */
export function videoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VideoConfig {
  return {
    ffmpeg: findFfmpeg(env) ?? null,
    maxJobs: int(env.POST_STUDIO_VIDEO_JOBS, 1),
    concurrency: int(env.POST_STUDIO_VIDEO_CONCURRENCY, 3),
    // 4 x264 threads: as fast as ffmpeg's default on the server (8 cores) but ~95 MB less peak memory
    // inside the 1 GB container (measured in Motion Part 2). 0 = ffmpeg's own choice.
    threads: int(env.POST_STUDIO_VIDEO_THREADS, 4) || undefined,
    keep: int(env.POST_STUDIO_VIDEO_KEEP, 20),
    maxBytes: int(env.POST_STUDIO_VIDEO_CACHE_MB, 2048) * 1024 * 1024,
  };
}

export type VideoStatus = "queued" | "running" | "done" | "failed";

interface Job {
  id: string;
  status: VideoStatus;
  project: string;
  rev: number;
  frame: string;
  scale: number;
  fps: number;
  frames: number;
  done: number;
  width?: number;
  height?: number;
  bytes?: number;
  ms?: number;
  error?: string;
  warnings: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  doc?: Document;
  abort?: AbortController;
}

export interface VideoJobView {
  id: string;
  status: VideoStatus;
  project: string;
  rev: number;
  frame: string;
  scale: number;
  fps: number;
  frames: number;
  /** Frames encoded so far. */
  done: number;
  progress: number;
  /** Place in the queue (1 = next), while queued. */
  position?: number;
  width?: number;
  height?: number;
  bytes?: number;
  ms?: number;
  error?: string;
  warnings: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Where the MP4 is, once done. */
  url: string;
  filename: string;
}

const JOB_RE = /^vid_[0-9a-f]{32}$/;
const now = () => new Date().toISOString();

export class VideoJobs {
  readonly dir: string;
  readonly ffmpeg: string | null;
  private readonly cfg: Required<Omit<VideoConfig, "ffmpeg" | "threads">> & { threads?: number };
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = 0;
  private fontsKey: string;
  private closed = false;

  constructor(
    private readonly store: Store,
    cfg: VideoConfig = {},
  ) {
    this.dir = join(store.opts.dataDir, "renders");
    this.ffmpeg = cfg.ffmpeg === undefined ? (findFfmpeg() ?? null) : cfg.ffmpeg;
    this.cfg = { maxJobs: cfg.maxJobs ?? 1, maxQueued: cfg.maxQueued ?? 8, concurrency: cfg.concurrency ?? 3, threads: cfg.threads, keep: cfg.keep ?? 20, maxBytes: cfg.maxBytes ?? 2 * 1024 ** 3 };
    this.fontsKey = createHash("sha256")
      .update(JSON.stringify(store.fonts.allFiles().map((f) => [f.file, f.sfnt.length])))
      .digest("hex");
    mkdirSync(this.dir, { recursive: true });
    // Half-written files of a previous process (it was stopped mid-export).
    for (const f of readdirSync(this.dir)) if (f.includes(".tmp-")) rmSync(join(this.dir, f), { force: true });
    this.trim();
  }

  private file(id: string) {
    return join(this.dir, `${id}.mp4`);
  }

  private view(j: Job): VideoJobView {
    const pos = j.status === "queued" ? this.queue.indexOf(j) + 1 : 0;
    return {
      id: j.id,
      status: j.status,
      project: j.project,
      rev: j.rev,
      frame: j.frame,
      scale: j.scale,
      fps: j.fps,
      frames: j.frames,
      done: j.done,
      progress: j.frames ? Math.round((j.done / j.frames) * 1000) / 1000 : 0,
      ...(pos > 0 ? { position: pos } : {}),
      ...(j.width ? { width: j.width, height: j.height } : {}),
      ...(j.bytes !== undefined ? { bytes: j.bytes } : {}),
      ...(j.ms !== undefined ? { ms: j.ms } : {}),
      ...(j.error ? { error: j.error } : {}),
      warnings: j.warnings,
      createdAt: j.createdAt,
      ...(j.startedAt ? { startedAt: j.startedAt } : {}),
      ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}),
      url: `/v1/video-jobs/${j.id}/file`,
      filename: `${j.project}-rev${j.rev}-${j.frame}${j.scale !== 1 ? `-x${j.scale}` : ""}.mp4`,
    };
  }

  /** Start (or reuse) the export of one frame of a project at a revision. */
  request(project: string, q: { rev?: number; frame?: string; scale?: number }): { job: VideoJobView; cached: boolean } {
    const p = this.store.getProject(project, q.rev);
    const doc = p.doc;
    if (!doc.motion) throw new StoreError(422, "no-motion", `${project} rev ${p.rev} is a still post (no motion): there is no video. Render it as PNG, or add motion first.`);
    const frame = q.frame ?? doc.frames[0].id;
    if (!doc.frames.some((f) => f.id === frame)) throw new StoreError(404, "not-found", `frame '${frame}' not found (frames: ${doc.frames.map((f) => f.id).join(", ")})`);
    const scale = q.scale ?? 1;
    if (!(scale >= 0.1 && scale <= 2)) throw new StoreError(400, "bad-request", "scale must be 0.1–2 for video");
    if (!this.ffmpeg) throw new StoreError(503, "no-ffmpeg", "ffmpeg is not installed on the server (set POST_STUDIO_FFMPEG or put ffmpeg on PATH)");
    if (this.closed) throw new StoreError(503, "closing", "the server is shutting down");

    const key = createHash("sha256")
      .update(JSON.stringify({ v: RENDER_VERSION, enc: VIDEO_SETTINGS, fonts: this.fontsKey, frame, scale, doc }))
      .digest("hex");
    const id = `vid_${key.slice(0, 32)}`;
    const base = { id, project, rev: p.rev, frame, scale, fps: fpsOf(doc.motion), frames: frameCount(doc.motion) };

    const existing = this.jobs.get(id);
    if (existing && (existing.status === "queued" || existing.status === "running")) return { job: this.view(existing), cached: false };
    if (existsSync(this.file(id))) {
      const t = new Date();
      utimesSync(this.file(id), t, t); // newest = kept longest
      const j = existing?.status === "done" ? existing : this.fromDisk(id);
      // The same document can sit at several revisions (or projects); answer for the one asked about.
      if (j) return { job: this.view({ ...j, project, rev: p.rev }), cached: true };
    }
    if (this.queue.length >= this.cfg.maxQueued) throw new StoreError(503, "busy", `${this.queue.length} videos are already waiting; try again in a minute`);
    const job: Job = { ...base, status: "queued", done: 0, warnings: [], createdAt: now(), doc };
    this.jobs.set(id, job);
    this.queue.push(job);
    this.prune();
    this.pump();
    return { job: this.view(job), cached: false };
  }

  get(id: string): VideoJobView {
    if (!JOB_RE.test(id)) throw new StoreError(404, "not-found", `video job '${id}' not found`);
    const j = this.jobs.get(id) ?? this.fromDisk(id);
    if (!j) throw new StoreError(404, "not-found", `video job '${id}' not found (finished videos are kept for a while; ask for the video again)`);
    if (j.status === "done" && !existsSync(this.file(id))) {
      this.jobs.delete(id);
      throw new StoreError(404, "expired", `video job '${id}' was cleaned from the cache; ask for the video again`);
    }
    return this.view(j);
  }

  /** Path and size of a finished video. */
  fileOf(id: string): { path: string; size: number; view: VideoJobView } {
    const view = this.get(id);
    if (view.status !== "done") throw new StoreError(409, "not-ready", `video job ${id} is ${view.status}${view.status === "failed" ? `: ${view.error}` : ""}`);
    const path = this.file(id);
    return { path, size: statSync(path).size, view };
  }

  private fromDisk(id: string): Job | undefined {
    const meta = join(this.dir, `${id}.json`);
    if (!existsSync(meta) || !existsSync(this.file(id))) return undefined;
    try {
      const m = JSON.parse(readFileSync(meta, "utf8")) as Job;
      const j: Job = { ...m, id, status: "done", warnings: m.warnings ?? [] };
      this.jobs.set(id, j);
      return j;
    } catch {
      return undefined;
    }
  }

  private pump(): void {
    while (!this.closed && this.running < this.cfg.maxJobs && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void this.run(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const doc = job.doc!;
    job.doc = undefined;
    job.status = "running";
    job.startedAt = now();
    job.abort = new AbortController();
    const tmp = join(this.dir, `${job.id}.mp4.tmp-${process.pid}-${Date.now()}`);
    try {
      const r = await encodeVideo(doc, {
        fonts: this.store.fonts,
        assets: assetResolver(this.store),
        frame: job.frame,
        scale: job.scale,
        ffmpeg: this.ffmpeg!,
        out: tmp,
        concurrency: this.cfg.concurrency,
        threads: this.cfg.threads,
        signal: job.abort.signal,
        onProgress: (d) => (job.done = d),
      });
      renameSync(tmp, this.file(job.id));
      Object.assign(job, { status: "done", width: r.width, height: r.height, bytes: r.bytes, ms: r.ms, warnings: r.warnings, finishedAt: now() });
      const { abort: _a, doc: _d, ...meta } = job;
      writeFileSync(join(this.dir, `${job.id}.json`), JSON.stringify(meta) + "\n");
      this.trim(job.id);
    } catch (e) {
      rmSync(tmp, { force: true });
      Object.assign(job, { status: "failed", error: (e as Error).message, finishedAt: now() });
    } finally {
      job.abort = undefined;
    }
  }

  /** Keep the newest `keep` videos within `maxBytes`; the one just made always stays. */
  trim(keepId?: string): void {
    const files = readdirSync(this.dir)
      .filter((f) => /^vid_[0-9a-f]{32}\.mp4$/.test(f))
      .map((f) => {
        const st = statSync(join(this.dir, f));
        return { id: f.slice(0, -4), size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => (a.id === keepId ? -1 : b.id === keepId ? 1 : b.mtime - a.mtime));
    let count = 0;
    let bytes = 0;
    for (const f of files) {
      if (f.id === keepId || (count < this.cfg.keep && bytes + f.size <= this.cfg.maxBytes)) {
        count++;
        bytes += f.size;
        continue;
      }
      rmSync(join(this.dir, `${f.id}.mp4`), { force: true });
      rmSync(join(this.dir, `${f.id}.json`), { force: true });
      this.jobs.delete(f.id);
    }
  }

  /** Forget finished jobs beyond the newest 200 (their files stay findable on disk). */
  private prune(): void {
    if (this.jobs.size <= 200) return;
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= 200) break;
      if (j.status === "done" || j.status === "failed") this.jobs.delete(id);
    }
  }

  /** Stop running encodes (server shutdown). */
  close(): void {
    this.closed = true;
    for (const j of this.queue) Object.assign(j, { status: "failed", error: "the server stopped before this video started", doc: undefined });
    this.queue = [];
    for (const j of this.jobs.values()) j.abort?.abort();
  }
}

export function registerVideoRoutes(app: FastifyInstance, store: Store, jobs: VideoJobs, int: (v: unknown, name: string) => number | undefined): void {
  // GET /v1/projects/:id/video?rev=&frame=&scale= → 202 { job } (200 when the video is ready)
  app.get("/v1/projects/:id/video", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as Record<string, string | undefined>;
    const scale = q.scale === undefined || q.scale === "" ? undefined : Number(q.scale);
    const r = jobs.request(id, { rev: revParam(store, id, q.rev, int), frame: q.frame || undefined, scale });
    return reply.code(r.job.status === "done" ? 200 : 202).send({ job: r.job, cached: r.cached });
  });

  app.get("/v1/video-jobs/:job", async (req) => ({ job: jobs.get((req.params as { job: string }).job) }));

  // The MP4. Range requests work, so a browser can play and seek it; ?inline=1 plays instead of
  // downloading.
  app.get("/v1/video-jobs/:job/file", async (req, reply) => {
    const f = jobs.fileOf((req.params as { job: string }).job);
    const inline = (req.query as Record<string, string | undefined>).inline === "1";
    reply.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${f.view.filename}"`);
    reply.header("Accept-Ranges", "bytes");
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Post-Studio-Rev", String(f.view.rev));
    reply.header("X-Post-Studio-Frame", f.view.frame);
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : f.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : f.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, f.size - 1);
      if (start > end) return reply.code(416).header("Content-Range", `bytes */${f.size}`).send();
      reply.code(206).header("Content-Range", `bytes ${start}-${end}/${f.size}`).header("Content-Length", String(end - start + 1));
      return reply.type("video/mp4").send(createReadStream(f.path, { start, end }));
    }
    // Hold the file open before streaming: a cache trim between stat and read can't break it.
    const fd = openSync(f.path, "r");
    reply.header("Content-Length", String(f.size));
    return reply.type("video/mp4").send(createReadStream(f.path, { fd, autoClose: true }));
  });
}
