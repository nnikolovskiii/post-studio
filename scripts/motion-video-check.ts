// Motion Part 2 evidence: drive a running Post Studio server (a scratch one, or a throwaway test
// container) through its HTTP API only. Creates the LUX-6 motion fixture as a NEW project (never
// touches existing ones), asks for the 6 s × 30 fps 1080² video, times the job, downloads the MP4,
// checks frame count / size / fps with the local ffmpeg, and compares decoded frames with the
// server's own PNG of the same moment (GET …/render?t=). Prints one JSON report.
//   pnpm exec tsx scripts/motion-video-check.ts --url http://127.0.0.1:3481 --token-file /tmp/x/token [--out /tmp/x/post.mp4]
// Never point it at the live server: it creates a project there.
import { readFileSync, writeFileSync } from "node:fs";
import { frameTime } from "@post-studio/motion";
import { comparePng, decodeVideoFrames, findFfmpeg, probeVideo, rgbToPng } from "@post-studio/render";

const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const url = arg("url")!;
const token = readFileSync(arg("token-file")!, "utf8").trim();
const outFile = arg("out", "/tmp/post-studio-motion-check.mp4")!;
if (!url || /:3472\b|studio\.example\.com/.test(url)) throw new Error("give --url of a scratch server or test container (not the live one)");
const ROOT = new URL("../", import.meta.url).pathname;
const ffmpeg = findFfmpeg();
if (!ffmpeg) throw new Error("no local ffmpeg to check the file with");

async function api(method: string, path: string, body?: unknown, raw = false): Promise<any> {
  const isBytes = body instanceof Uint8Array;
  const res = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": isBytes ? "application/octet-stream" : "application/json" } : {}) },
    body: body === undefined ? undefined : isBytes ? (body as any) : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 202) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

await api("POST", "/v1/assets", new Uint8Array(readFileSync(`${ROOT}fixtures/assets/logo-on-paper.png`)));
const doc = JSON.parse(readFileSync(`${ROOT}fixtures/lux-6-motion.json`, "utf8"));
doc.title = `motion check ${new Date().toISOString()}`; // a fresh cache key: never a cached video
const created = await api("POST", "/v1/projects", { doc, message: "Motion Part 2 check" });
const project = created.project as string;

const t0 = Date.now();
let job = (await api("GET", `/v1/projects/${project}/video`)).job;
while (job.status === "queued" || job.status === "running") {
  await new Promise((r) => setTimeout(r, 250));
  job = (await api("GET", `/v1/video-jobs/${job.id}`)).job;
}
const wallMs = Date.now() - t0;
if (job.status !== "done") throw new Error(`video job failed: ${job.error}`);
const mp4 = await api("GET", job.url, undefined, true);
writeFileSync(outFile, mp4);
const info = await probeVideo(ffmpeg, outFile);

const idx = [0, 9, 15, 27, 36, 47, 60, 179];
const frames = await decodeVideoFrames(ffmpeg, outFile, info.width, info.height, idx);
const worst = { mean: 0, over16: 0, shift: 0 };
for (let k = 0; k < idx.length; k++) {
  const png = await api("GET", `/v1/projects/${project}/render?format=png&t=${frameTime(idx[k], info.fps)}`, undefined, true);
  const dec = await rgbToPng(frames[k], info.width, info.height);
  const d = await comparePng(dec, png);
  worst.mean = Math.max(worst.mean, d.meanChannelError);
  worst.over16 = Math.max(worst.over16, d.pixelsOverFraction);
  worst.shift = Math.max(worst.shift, d.shiftTolerantPixelsOverFraction);
}
const expected = { frames: 180, width: 1080, height: 1080, fps: 30 };
const ok = info.frames === expected.frames && info.width === expected.width && info.height === expected.height && info.fps === expected.fps && worst.mean <= 0.008 && worst.over16 <= 0.005 && worst.shift <= 0.005;
console.log(
  JSON.stringify(
    {
      ok,
      project,
      job: job.id,
      encodeMs: job.ms,
      wallMs,
      bytes: mp4.length,
      video: info,
      expected,
      framesCompared: idx,
      worst: { mean: Number(worst.mean.toFixed(5)), over16Percent: Number((worst.over16 * 100).toFixed(3)), shiftTolerantPercent: Number((worst.shift * 100).toFixed(3)) },
      out: outFile,
    },
    null,
    2,
  ),
);
if (!ok) process.exitCode = 1;
