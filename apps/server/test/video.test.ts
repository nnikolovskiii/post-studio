// Motion Part 2 (PLAN-motion.md §5.7): render at a time over HTTP, the poster moment for
// thumbnails and history pictures, the contact sheet, the timeline, and video export jobs with
// the renders/ cache.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findFfmpeg, probeVideo } from "@post-studio/render";
import { buildApp } from "../src/app.ts";
import { VideoJobs } from "../src/video.ts";
import { createLux, loadFixture, setup } from "./helpers.ts";

const ffmpeg = findFfmpeg();
const motionFixture = () => loadFixture("lux-6-motion.json");

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => ctx.cleanup());

const raw = async (url: string, headers: Record<string, string> = {}) => {
  const res = await ctx.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${ctx.tokens.claude}`, ...headers } });
  return { status: res.statusCode, headers: res.headers, bytes: res.rawPayload, json: res.headers["content-type"]?.toString().includes("json") ? res.json() : undefined };
};

/** The LUX-6 motion fixture as a project (logo uploaded first). */
async function createMotion(over: (doc: any) => any = (d) => d) {
  await createLux(ctx); // uploads the logo
  const res = await ctx.call("claude", "POST", "/v1/projects", over(motionFixture()));
  if (res.status !== 201) throw new Error(JSON.stringify(res.json));
  return res.json.project as string;
}

async function waitJob(id: string) {
  for (let i = 0; i < 600; i++) {
    const r = await ctx.call("claude", "GET", `/v1/video-jobs/${id}`);
    if (r.json.job.status === "done" || r.json.job.status === "failed") return r.json.job;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("video job did not finish");
}

describe("GET …/render?t=", () => {
  it("draws a moment of a motion project; without t the poster moment ('rest' = the still layout)", async () => {
    const id = await createMotion();
    const rest = await raw(`/v1/projects/${id}/render?format=svg`);
    expect(rest.headers["x-post-studio-time"]).toBe("rest");
    expect((await raw(`/v1/projects/${id}/render?format=svg&t=rest`)).bytes.equals(rest.bytes)).toBe(true);
    const t0 = await raw(`/v1/projects/${id}/render?format=svg&t=0`);
    expect(t0.headers["x-post-studio-time"]).toBe("0");
    expect(t0.bytes.equals(rest.bytes)).toBe(false);
    expect(t0.bytes.toString()).toContain('<g opacity="0"><text id="headline"');
    // Poster at 0.5 s: thumbnails and history pictures (no t) show that moment.
    const op = await ctx.call("claude", "POST", `/v1/projects/${id}/ops`, { base: 0, ops: [{ op: "set", node: "$doc", path: "motion.poster", value: 500 }], message: "poster" });
    expect(op.status).toBe(200);
    const poster = await raw(`/v1/projects/${id}/render?format=png&scale=0.3`);
    expect(poster.headers["x-post-studio-time"]).toBe("500");
    expect(poster.bytes.equals((await raw(`/v1/projects/${id}/render?format=png&scale=0.3&t=500`)).bytes)).toBe(true);
    // The old revision (poster rest) still renders as it did.
    expect((await raw(`/v1/projects/${id}/render?format=svg&rev=0`)).bytes.equals(rest.bytes)).toBe(true);
  });

  it("still posts ignore t; bad values are refused", async () => {
    const id = await createLux(ctx);
    const a = await raw(`/v1/projects/${id}/render?format=svg`);
    expect((await raw(`/v1/projects/${id}/render?format=svg&t=1200`)).bytes.equals(a.bytes)).toBe(true);
    for (const t of ["-1", "1.5", "abc", "600001"]) expect((await raw(`/v1/projects/${id}/render?t=${t}`)).json.error.code).toBe("bad-request");
  });
});

describe("contact sheet and timeline", () => {
  it("contact: one PNG of n moments; a still post is refused", async () => {
    const id = await createMotion();
    const r = await raw(`/v1/projects/${id}/contact?n=6&columns=3&width=200`);
    expect(r.status).toBe(200);
    expect(r.headers["x-post-studio-times"]).toBe("0,1200,2400,3567,4767,5967");
    const m = await sharp(r.bytes).metadata();
    expect([m.width, m.height]).toEqual([12 + 3 * 212, 12 + 2 * 238]);
    const still = await createLux(ctx);
    expect((await raw(`/v1/projects/${still}/contact`)).json.error.code).toBe("no-motion");
    expect((await raw(`/v1/projects/${id}/contact?n=100`)).json.error.code).toBe("bad-request");
  });

  it("timeline: text and structured keyframes, his retimed keyframe marked 📌t", async () => {
    const id = await createMotion();
    const edit = await ctx.call("nikola", "POST", `/v1/projects/${id}/ops`, { base: 0, ops: [{ op: "set", node: "headline", path: "anim.tracks.dy.in1.t", value: 300 }], message: "later headline" });
    expect(edit.status).toBe(200);
    const r = await ctx.call("claude", "GET", `/v1/projects/${id}/timeline`);
    expect(r.json.frames).toBe(180);
    const headline = r.json.layers.find((l: any) => l.id === "headline");
    expect(headline.tracks.find((t: any) => t.track === "dy").keys[0]).toMatchObject({ key: "in1", t: 300, v: 40, pinned: ["t"] });
    expect(r.json.text).toMatch(/^motion: 6\.0 s @ 30 fps, loop, poster rest · 180 frames · 12 animated layers/);
    expect(r.json.text).toContain("in1 0.30 s 40 (out) 📌t → in2 0.80 s 0");
    const text = await raw(`/v1/projects/${id}/timeline?format=text`);
    expect(text.headers["content-type"]).toContain("text/plain");
    // A past revision: no pins.
    expect((await ctx.call("claude", "GET", `/v1/projects/${id}/timeline?rev=0`)).json.text).not.toContain("📌");
  });
});

describe("export of a motion project", () => {
  it("stills at the poster moment, motion and the per-frame MP4 names in the manifest", async () => {
    const id = await createMotion((d) => ({ ...d, motion: { ...d.motion, poster: 1000 } }));
    const r = await ctx.call("claude", "POST", `/v1/projects/${id}/export`, {});
    expect(r.json.motion).toEqual({ duration: 6000, fps: 30, loop: true, poster: 1000 });
    expect(r.json.frames[0]).toMatchObject({ stem: "post", video: "post.mp4" });
    const manifest = JSON.parse(Buffer.from(r.json.files.find((f: any) => f.path === "export.json").base64, "base64").toString());
    expect(manifest.motion).toEqual({ duration: 6000, fps: 30, frames: 180, loop: true, poster: 1000 });
    expect(manifest.notes["post.mp4"]).toMatch(/H\.264/);
    const png = Buffer.from(r.json.files.find((f: any) => f.path === "post.png").base64, "base64");
    expect(png.equals((await raw(`/v1/projects/${id}/render?format=png&t=1000`)).bytes)).toBe(true);
  });
});

describe("video jobs", () => {
  it("refuses a still post and answers 503 without ffmpeg", async () => {
    const still = await createLux(ctx);
    expect((await raw(`/v1/projects/${still}/video`)).json.error.code).toBe("no-motion");
    const app = buildApp({ store: ctx.store, video: { ffmpeg: null } });
    const id = await createMotion();
    const res = await app.inject({ method: "GET", url: `/v1/projects/${id}/video`, headers: { authorization: `Bearer ${ctx.tokens.claude}` } });
    expect([res.statusCode, res.json().error.code]).toEqual([503, "no-ffmpeg"]);
    expect((await raw(`/v1/video-jobs/vid_${"0".repeat(32)}`)).status).toBe(404);
    expect((await raw(`/v1/video-jobs/../../etc`)).status).toBe(404);
    await app.close();
  });

  it.skipIf(!ffmpeg)("202 job → done → the MP4 (ranges too); the second request comes from the cache, also after a restart", async () => {
    const id = await createMotion((d) => ({ ...d, motion: { duration: 1000, fps: 25 } }));
    const first = await raw(`/v1/projects/${id}/video?scale=0.5`);
    expect(first.status).toBe(202);
    expect(first.json.job).toMatchObject({ project: id, rev: 0, frame: "square", scale: 0.5, fps: 25, frames: 25, url: expect.stringMatching(/^\/v1\/video-jobs\/vid_[0-9a-f]{32}\/file$/) });
    expect(["queued", "running"]).toContain(first.json.job.status);
    // Asking again while it runs returns the same job.
    expect((await raw(`/v1/projects/${id}/video?scale=0.5`)).json.job.id).toBe(first.json.job.id);
    const job = await waitJob(first.json.job.id);
    expect(job).toMatchObject({ status: "done", done: 25, progress: 1, width: 540, height: 540, filename: `${id}-rev0-square-x0.5.mp4` });

    const file = await raw(job.url);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("video/mp4");
    expect(file.headers["content-disposition"]).toBe(`attachment; filename="${id}-rev0-square-x0.5.mp4"`);
    const mp4 = join(ctx.dataDir, "renders", `${job.id}.mp4`);
    expect(await probeVideo(ffmpeg!, mp4)).toMatchObject({ codec: "h264", width: 540, height: 540, fps: 25, frames: 25 });
    const part = await raw(job.url, { range: "bytes=0-99" });
    expect([part.status, part.bytes.length, part.headers["content-range"]]).toEqual([206, 100, `bytes 0-99/${file.bytes.length}`]);
    expect(part.bytes.equals(file.bytes.subarray(0, 100))).toBe(true);
    expect((await raw(job.url, { range: `bytes=${file.bytes.length + 5}-` })).status).toBe(416);
    expect((await raw(`${job.url}?inline=1`)).headers["content-disposition"]).toMatch(/^inline;/);

    // Cache: same document → same job, at once (200), even at a later revision with the same doc.
    const again = await raw(`/v1/projects/${id}/video?scale=0.5`);
    expect([again.status, again.json.cached, again.json.job.id]).toEqual([200, true, job.id]);
    await ctx.call("claude", "POST", `/v1/projects/${id}/ops`, { base: 0, ops: [{ op: "set", node: "$doc", path: "title", value: "x" }], message: "x" });
    await ctx.call("claude", "POST", `/v1/projects/${id}/ops`, { base: 1, ops: [{ op: "set", node: "$doc", path: "title", value: motionFixture().title }], message: "back" });
    const later = await raw(`/v1/projects/${id}/video?scale=0.5`);
    expect([later.status, later.json.job.id, later.json.job.rev]).toEqual([200, job.id, 2]);

    // A restart: a new job registry on the same data dir finds the finished file.
    const jobs = new VideoJobs(ctx.store, { ffmpeg: ffmpeg! });
    expect(jobs.get(job.id)).toMatchObject({ status: "done", frames: 25, width: 540 });
    jobs.close();
  }, 120_000);

  it.skipIf(!ffmpeg)("the cache keeps the newest videos only, and half-written files are removed at start", async () => {
    const id = await createMotion((d) => ({ ...d, motion: { duration: 500, fps: 24 } }));
    writeFileSync(join(ctx.dataDir, "renders", `vid_${"a".repeat(32)}.mp4.tmp-1-2`), "partial");
    const jobs = new VideoJobs(ctx.store, { ffmpeg: ffmpeg!, keep: 1 });
    expect(readdirSync(join(ctx.dataDir, "renders")).some((f) => f.includes(".tmp-"))).toBe(false);
    const a = jobs.request(id, { scale: 0.2 });
    await waitFor(() => jobs.get(a.job.id).status === "done");
    const b = jobs.request(id, { scale: 0.3 });
    await waitFor(() => jobs.get(b.job.id).status === "done");
    expect(existsSync(join(jobs.dir, `${b.job.id}.mp4`))).toBe(true);
    expect(existsSync(join(jobs.dir, `${a.job.id}.mp4`))).toBe(false);
    expect(() => jobs.get(a.job.id)).toThrow(/not found|cleaned/);
    jobs.close();
  }, 120_000);

  it.skipIf(!ffmpeg)("a failing encoder marks the job failed with ffmpeg's reason; asking again retries", async () => {
    const id = await createMotion((d) => ({ ...d, motion: { duration: 500, fps: 24 } }));
    const jobs = new VideoJobs(ctx.store, { ffmpeg: "/bin/false" });
    const a = jobs.request(id, { scale: 0.2 });
    await waitFor(() => jobs.get(a.job.id).status === "failed");
    expect(jobs.get(a.job.id).error).toMatch(/ffmpeg failed \(exit 1\)/);
    expect(() => jobs.fileOf(a.job.id)).toThrow(/failed/);
    expect(jobs.request(id, { scale: 0.2 }).job.status).not.toBe("failed");
    jobs.close();
  }, 60_000);
});

async function waitFor(cond: () => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
