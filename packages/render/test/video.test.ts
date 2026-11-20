// Motion Part 2 "done when": the LUX-6 motion fixture exports an MP4 with the right frame count,
// size and fps, and decoded frames match the PNG of the same moment (render --at) within a stated
// tolerance. Needs ffmpeg (POST_STUDIO_FFMPEG, PATH or ~/.local/bin/ffmpeg); skipped without it.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { frameCount, frameTime } from "@post-studio/motion";
import type { Document } from "@post-studio/schema";
import { FontRegistry } from "@post-studio/text";
import { comparePng, decodeVideoFrames, encodeVideo, findFfmpeg, probeVideo, renderPng, type AssetData } from "../src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
const motion = JSON.parse(readFileSync(new URL("fixtures/lux-6-motion.json", ROOT), "utf8")) as Document;
const logo = readFileSync(new URL("fixtures/assets/logo-on-paper.png", ROOT));
const logoSha = createHash("sha256").update(logo).digest("hex");
const assets = (s: string): AssetData | undefined => (s === logoSha ? { mime: "image/png", bytes: logo } : undefined);
const ffmpeg = findFfmpeg();

/**
 * Decoded MP4 frame vs. the PNG of the same moment. H.264 at crf 18 with 4:2:0 chroma blurs
 * colour edges (the red DRAFT line, the blue dots) and leaves small noise in flat paper.
 * Measured on the server (job 839), worst of 10 frames: mean 0.0043 (about one level of 255: the
 * RGB → YUV → RGB round trip), pixels off by > 16 0.11 %, shift-tolerant (1 px) 0.11 %. Limits
 * with headroom: mean 0.008, over16 0.5 %, shift-tolerant 0.5 %. The same frame against the PNG
 * three frames later (headline mid fade-up) measures 0.98 % shift-tolerant and must fail.
 */
const LIMIT = { mean: 0.008, over16: 0.005, shift: 0.005 };

let fonts: FontRegistry;
let dir: string;
beforeAll(async () => {
  fonts = await FontRegistry.load();
  dir = mkdtempSync(join(tmpdir(), "pstudio-video-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rgbPng = (raw: Buffer, w: number, h: number) => sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();

describe.skipIf(!ffmpeg)("MP4 export", () => {
  it("LUX-6 motion fixture: 180 frames, 1080×1080, 30 fps, H.264 yuv420p; decoded frames match render --at", async () => {
    const out = join(dir, "post.mp4");
    let calls = 0;
    const r = await encodeVideo(motion, { fonts, assets, ffmpeg: ffmpeg!, out, onProgress: () => calls++ });
    expect(r).toMatchObject({ frames: 180, fps: 30, width: 1080, height: 1080, durationMs: 6000, warnings: [] });
    expect(calls).toBe(180);
    expect(frameCount(motion.motion!)).toBe(180);
    const info = await probeVideo(ffmpeg!, out);
    expect(info).toEqual({ codec: "h264", pixFmt: "yuv420p", width: 1080, height: 1080, fps: 30, frames: 180 });
    // faststart: the moov atom comes before the media data.
    const head = readFileSync(out).subarray(0, 4096).toString("latin1");
    expect(head.indexOf("moov")).toBeGreaterThan(0);
    expect(head.indexOf("moov")).toBeLessThan(head.indexOf("mdat") === -1 ? Infinity : head.indexOf("mdat"));

    // Moments where a lot moves: logo spin, headline fade-up, typewriter, bar grow, pops, exit.
    const idx = [0, 9, 15, 27, 36, 42, 47, 60, 160, 179];
    const frames = await decodeVideoFrames(ffmpeg!, out, 1080, 1080, idx);
    expect(frames).toHaveLength(idx.length);
    const worst = { mean: 0, over16: 0, shift: 0 };
    for (let k = 0; k < idx.length; k++) {
      const png = (await renderPng(motion, { fonts, assets, time: frameTime(idx[k], 30) })).png;
      const d = await comparePng(await rgbPng(frames[k], 1080, 1080), png);
      worst.mean = Math.max(worst.mean, d.meanChannelError);
      worst.over16 = Math.max(worst.over16, d.pixelsOverFraction);
      worst.shift = Math.max(worst.shift, d.shiftTolerantPixelsOverFraction);
    }
    console.log(`MP4 vs PNG (worst of ${idx.length} frames): mean ${worst.mean.toFixed(5)}, over16 ${(worst.over16 * 100).toFixed(3)} %, shift-tolerant ${(worst.shift * 100).toFixed(3)} %; export ${r.ms} ms, ${r.bytes} bytes`);
    expect(worst.mean).toBeLessThanOrEqual(LIMIT.mean);
    expect(worst.over16).toBeLessThanOrEqual(LIMIT.over16);
    expect(worst.shift).toBeLessThanOrEqual(LIMIT.shift);

    // Sensitivity: frame 15 (headline mid fade-up) against the PNG of frame 18 fails the limits.
    const off = await comparePng(await rgbPng(frames[idx.indexOf(15)], 1080, 1080), (await renderPng(motion, { fonts, assets, time: frameTime(18, 30) })).png);
    console.log(`frame 15 vs PNG of frame 18: mean ${off.meanChannelError.toFixed(5)}, over16 ${(off.pixelsOverFraction * 100).toFixed(3)} %, shift-tolerant ${(off.shiftTolerantPixelsOverFraction * 100).toFixed(3)} %`);
    expect(off.shiftTolerantPixelsOverFraction).toBeGreaterThan(LIMIT.shift);
  }, 180_000);

  it("scale, odd sizes padded to even, 25 fps, and a still post is refused", async () => {
    const d = { ...motion, motion: { duration: 1000, fps: 25 as const } };
    const out = join(dir, "small.mp4");
    const r = await encodeVideo(d, { fonts, assets, ffmpeg: ffmpeg!, out, scale: 0.25 + 1 / 1080 });
    expect(r).toMatchObject({ frames: 25, fps: 25, width: 272, height: 272 });
    expect(await probeVideo(ffmpeg!, out)).toMatchObject({ width: 272, height: 272, fps: 25, frames: 25 });
    await expect(encodeVideo({ ...motion, motion: undefined }, { fonts, assets, ffmpeg: ffmpeg!, out })).rejects.toThrow(/still post/);
  }, 60_000);

  it("a broken ffmpeg fails with its message, and cancelling stops the export", async () => {
    await expect(encodeVideo(motion, { fonts, assets, ffmpeg: "/nonexistent/ffmpeg", out: join(dir, "x.mp4") })).rejects.toThrow(/ffmpeg could not start/);
    const ac = new AbortController();
    const p = encodeVideo(motion, { fonts, assets, ffmpeg: ffmpeg!, out: join(dir, "c.mp4"), signal: ac.signal, onProgress: (n) => n === 5 && ac.abort() });
    await expect(p).rejects.toThrow(/cancelled/);
  }, 60_000);
});
