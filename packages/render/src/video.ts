// Motion export (PLAN-motion.md §5.4): every frame time of one pass → renderSvg(outlined, time) →
// resvg → raw RGBA streamed into ffmpeg (libx264, crf 18, yuv420p, +faststart: the settings of
// social-posts make_video.py). Frames are never all in memory: at most `concurrency` frames are
// being rasterized while earlier ones are written in order. Node only (child process, resvg).
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import sharp from "sharp";
import { fpsOf, frameTimes } from "@post-studio/motion";
import type { Document } from "@post-studio/schema";
import type { FontRegistry } from "@post-studio/text";
import { pngSafeAssets, rasterize } from "./raster.ts";
import { pickFrame, renderSvg, RenderError } from "./render.ts";
import type { AssetResolver } from "./types.ts";

/** Bumped when the renderer's output for a moment changes, so cached videos are not reused. */
export const RENDER_VERSION = "post-studio-render/motion-1";

/** Encoder settings, kept in one place (the cache key of a rendered video includes them). */
export const VIDEO_SETTINGS = { codec: "libx264", preset: "slow", crf: 18, pixFmt: "yuv420p", faststart: true, background: "#FFFFFF" } as const;

/**
 * ffmpeg to use: POST_STUDIO_FFMPEG, then the first `ffmpeg` on PATH, then ~/.local/bin/ffmpeg
 * (where the server keeps its static build; a systemd unit may not have it on PATH). Undefined when
 * none is executable.
 */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const ok = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (env.POST_STUDIO_FFMPEG) return ok(env.POST_STUDIO_FFMPEG) ? env.POST_STUDIO_FFMPEG : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const p = join(dir, "ffmpeg");
    if (ok(p)) return p;
  }
  const home = join(env.HOME ?? homedir(), ".local/bin/ffmpeg");
  return ok(home) ? home : undefined;
}

export interface VideoOptions {
  fonts: FontRegistry;
  assets: AssetResolver;
  resolveToken?: (token: string) => string | undefined;
  /** Frame id (default the first frame). */
  frame?: string;
  /** Output scale (default 1). Odd pixel sizes are padded by one pixel (yuv420p needs even sizes). */
  scale?: number;
  /** Path of the ffmpeg binary (findFfmpeg()). */
  ffmpeg: string;
  /** Output file (.mp4). Written by ffmpeg; the caller renames a temporary path into place. */
  out: string;
  /** Frames rasterized at the same time (default 3; resvg runs on the libuv thread pool). */
  concurrency?: number;
  /** ffmpeg / x264 threads (default: ffmpeg's choice). */
  threads?: number;
  /** Called after each frame is handed to ffmpeg. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface VideoResult {
  frames: number;
  fps: number;
  width: number;
  height: number;
  /** One pass: frames × 1000 / fps. */
  durationMs: number;
  bytes: number;
  /** Wall time of the whole export. */
  ms: number;
  warnings: string[];
}

class Ffmpeg {
  readonly proc: ChildProcess;
  private stderr = "";
  readonly done: Promise<void>;
  private failed: Error | undefined;

  constructor(bin: string, args: string[]) {
    this.proc = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
    this.proc.stderr!.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString("utf8")).slice(-4000);
    });
    // Writes after ffmpeg died fail with EPIPE; the exit code carries the real reason.
    this.proc.stdin!.on("error", () => {});
    this.done = new Promise((resolve, reject) => {
      this.proc.on("error", (e) => {
        this.failed = new RenderError(`ffmpeg could not start (${bin}): ${e.message}`);
        reject(this.failed);
      });
      this.proc.on("close", (code, sig) => {
        if (code === 0) return resolve();
        if (this.failed) return reject(this.failed);
        this.failed = new RenderError(`ffmpeg failed (${sig ?? `exit ${code}`}): ${this.stderr.trim().split("\n").slice(-5).join(" | ") || "no message"}`);
        reject(this.failed);
      });
    });
    this.done.catch(() => {});
  }

  async write(buf: Buffer): Promise<void> {
    if (this.failed) throw this.failed;
    const stdin = this.proc.stdin!;
    if (stdin.write(buf)) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onDone = () => {
        cleanup();
        reject(this.failed ?? new RenderError("ffmpeg stopped reading frames"));
      };
      const cleanup = () => {
        stdin.off("drain", onDrain);
        this.proc.off("close", onDone);
      };
      stdin.on("drain", onDrain);
      this.proc.on("close", onDone);
    });
  }

  async finish(): Promise<void> {
    this.proc.stdin!.end();
    await this.done;
  }

  kill(): void {
    if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
  }
}

/** Encode one pass of a motion project's frame as H.264 MP4. */
export async function encodeVideo(doc: Document, opts: VideoOptions): Promise<VideoResult> {
  const started = performance.now();
  if (!doc.motion) throw new RenderError("this is a still post (no motion): there is no video to export");
  const frame = pickFrame(doc, opts.frame);
  const scale = opts.scale ?? 1;
  if (!(scale >= 0.1 && scale <= 4)) throw new RenderError("scale must be 0.1–4");
  const fps = fpsOf(doc.motion);
  const times = frameTimes(doc.motion);
  const total = times.length;
  const assets = await pngSafeAssets(doc, frame.id, opts.assets);
  const warnings = new Set<string>();
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 3));

  const renderAt = async (t: number) => {
    const r = renderSvg(doc, { fonts: opts.fonts, assets, resolveToken: opts.resolveToken, frame: frame.id, text: "outlined", time: t });
    for (const w of r.warnings) warnings.add(w);
    const img = await rasterize(r.svg, opts.fonts, scale, VIDEO_SETTINGS.background);
    return { pixels: img.pixels, width: img.width, height: img.height };
  };

  const inFlight: Array<ReturnType<typeof renderAt>> = [];
  let next = 0;
  const fill = () => {
    while (next < total && inFlight.length < concurrency) {
      const p = renderAt(times[next++]);
      p.catch(() => {});
      inFlight.push(p);
    }
  };

  let ff: Ffmpeg | undefined;
  const abort = () => ff?.kill();
  opts.signal?.addEventListener("abort", abort, { once: true });
  try {
    fill();
    const first = await inFlight[0];
    const { width, height } = first;
    const evenW = width + (width % 2);
    const evenH = height + (height % 2);
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-framerate", String(fps), "-i", "pipe:0",
      ...(evenW !== width || evenH !== height ? ["-vf", `pad=${evenW}:${evenH}:0:0:white`] : []),
      "-c:v", VIDEO_SETTINGS.codec, "-preset", VIDEO_SETTINGS.preset, "-crf", String(VIDEO_SETTINGS.crf), "-pix_fmt", VIDEO_SETTINGS.pixFmt,
      ...(opts.threads ? ["-threads", String(opts.threads)] : []),
      "-movflags", "+faststart", "-an", "-f", "mp4", "-y", opts.out,
    ];
    ff = new Ffmpeg(opts.ffmpeg, args);
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) throw new RenderError("video export cancelled");
      const f = await inFlight.shift()!;
      fill();
      if (f.width !== width || f.height !== height) throw new RenderError(`frame ${i} rendered at ${f.width}×${f.height}, expected ${width}×${height}`);
      await ff.write(f.pixels);
      opts.onProgress?.(i + 1, total);
    }
    await ff.finish();
    return { frames: total, fps, width: evenW, height: evenH, durationMs: Math.round((total * 1000) / fps), bytes: statSync(opts.out).size, ms: Math.round(performance.now() - started), warnings: [...warnings] };
  } catch (e) {
    ff?.kill();
    if (opts.signal?.aborted) throw new RenderError("video export cancelled");
    throw e;
  } finally {
    opts.signal?.removeEventListener("abort", abort);
  }
}

export interface VideoInfo {
  codec: string;
  pixFmt: string;
  width: number;
  height: number;
  fps: number;
  /** Frames counted by reading the whole stream (not the container's estimate). */
  frames: number;
}

/** What is in a video file, read with ffmpeg itself (no ffprobe needed). */
export async function probeVideo(ffmpeg: string, file: string): Promise<VideoInfo> {
  const err = await new Promise<string>((resolve, reject) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-nostdin", "-i", file, "-map", "0:v:0", "-f", "null", "-progress", "pipe:2", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let s = "";
    p.stderr.on("data", (d: Buffer) => (s += d.toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(s) : reject(new RenderError(`ffmpeg could not read ${file}: ${s.trim().split("\n").slice(-2).join(" ")}`))));
  });
  const stream = /Stream #0:0[^:]*: Video: (\w+)[^,]*, (\w+)[^,]*(?:\([^)]*\))?, (\d+)x(\d+)[^\n]*?, ([\d.]+) fps/.exec(err);
  if (!stream) throw new RenderError(`no video stream found in ${file}`);
  const frames = [...err.matchAll(/^frame=(\d+)$/gm)].pop();
  return { codec: stream[1], pixFmt: stream[2], width: Number(stream[3]), height: Number(stream[4]), fps: Number(stream[5]), frames: frames ? Number(frames[1]) : 0 };
}

/**
 * Decode frames of a video as raw RGB (checks and tests). `indices`: only those frames (0-based,
 * in stream order); default every frame, so keep that to small videos.
 */
export async function decodeVideoFrames(ffmpeg: string, file: string, width: number, height: number, indices?: number[]): Promise<Buffer[]> {
  const select = indices?.length ? ["-vf", `select='${indices.map((i) => `eq(n\\,${i})`).join("+")}'`, "-fps_mode", "passthrough"] : [];
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, ...select, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    let s = "";
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => (s += d.toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new RenderError(`ffmpeg could not decode ${file}: ${s.trim()}`))));
  });
  const all = Buffer.concat(chunks);
  const size = width * height * 3;
  const out: Buffer[] = [];
  for (let o = 0; o + size <= all.length; o += size) out.push(all.subarray(o, o + size));
  return out;
}

/**
 * n moments spread over one pass for a contact sheet: the first frame, the last frame and evenly
 * spaced frames between them (each snapped to a real frame time, so it matches the video).
 */
export function contactTimes(motion: NonNullable<Document["motion"]>, n = 12): number[] {
  const times = frameTimes(motion);
  if (times.length <= n) return times;
  return Array.from({ length: n }, (_, i) => times[Math.round((i * (times.length - 1)) / (n - 1))]);
}

export interface ContactOptions {
  fonts: FontRegistry;
  assets: AssetResolver;
  resolveToken?: (token: string) => string | undefined;
  frame?: string;
  /** Moments in ms (default contactTimes(motion, 12)). */
  times?: number[];
  /** Columns (default 4). */
  columns?: number;
  /** Width of one cell in px (default 360). */
  cellWidth?: number;
}

/**
 * One PNG with many moments of a motion project's frame (like make_video.py --contact), each
 * labelled with its time, so an agent can check a whole animation by looking at one image.
 */
export async function contactSheet(doc: Document, opts: ContactOptions): Promise<{ png: Buffer; width: number; height: number; times: number[]; warnings: string[] }> {
  if (!doc.motion) throw new RenderError("this is a still post (no motion): render it without --contact");
  const frame = pickFrame(doc, opts.frame);
  const times = opts.times ?? contactTimes(doc.motion);
  const cols = Math.max(1, opts.columns ?? 4);
  const cellW = Math.round(opts.cellWidth ?? 360);
  const scale = cellW / frame.w;
  const cellH = Math.round(frame.h * scale);
  const pad = 12;
  const label = 26;
  const rows = Math.ceil(times.length / cols);
  const width = pad + cols * (cellW + pad);
  const height = pad + rows * (cellH + label + pad);
  const assets = await pngSafeAssets(doc, frame.id, opts.assets);
  const warnings = new Set<string>();
  const cells = await Promise.all(
    times.map(async (t) => {
      const r = renderSvg(doc, { fonts: opts.fonts, assets, resolveToken: opts.resolveToken, frame: frame.id, text: "outlined", time: t });
      for (const w of r.warnings) warnings.add(w);
      return (await rasterize(r.svg, opts.fonts, scale, VIDEO_SETTINGS.background)).asPng();
    }),
  );
  const pos = (i: number) => ({ left: pad + (i % cols) * (cellW + pad), top: pad + Math.floor(i / cols) * (cellH + label + pad) });
  const labels = times
    .map((t, i) => {
      const p = pos(i);
      return `<text x="${p.left}" y="${p.top + cellH + 19}" font-family="IBM Plex Mono" font-size="16" fill="#3A332F">${(t / 1000).toFixed(2)} s · frame ${Math.round((t * fpsOf(doc.motion)) / 1000)}</text>`;
    })
    .join("");
  const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#E9E6E1"/>${labels}</svg>`;
  const base = (await rasterize(bg, opts.fonts)).asPng();
  const png = await sharp(base)
    .composite(cells.map((input, i) => ({ input, ...pos(i) })))
    .png()
    .toBuffer();
  return { png, width, height, times, warnings: [...warnings] };
}
