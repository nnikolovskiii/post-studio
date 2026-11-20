#!/usr/bin/env node
// pstudio: the agent-facing CLI for Post Studio. Every command takes --json.
// Project commands go through the HTTP API with a bearer token; admin commands
// (token, backup, restore-backup, serve) work on the local data dir.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Command, Option } from "commander";
import { createHash } from "node:crypto";
import { EASES } from "@post-studio/schema";
import { MotionError, PRESET_ALIASES, PRESETS, presetOps, readingOrder } from "@post-studio/motion";
import { FIELD_KEYS, fieldDef, idsOfType, matchingIds, setFieldOps, type FieldKey, type Op } from "@post-studio/ops";
import { findItem, NODE_TYPES } from "@post-studio/schema";
import { ApiError, Client, DEFAULT_TOKEN_FILE, DEFAULT_URL, resolveToken } from "./client.ts";
import { approved, copyJsonFor, insideSocialPosts, mayWriteCopy, notApprovedMessage, OWNED, ownership, PROPOSAL, SocialPostsRefused, socialPostsTarget } from "./social-posts.ts";

const program = new Command();
program
  .name("pstudio")
  .description(
    "Post Studio CLI. Agents: handoff show → lease take → diff → outline/get → apply --base → render and look → handoff back.\n" +
      "Exit codes: 0 ok · 1 error · 3 conflict · 4 pinned · 5 leased · 6 not your turn. Full procedure: post-studio/AGENTS.md.",
  )
  .option("--json", "machine-readable output")
  .addOption(new Option("--url <url>", "server URL").env("PSTUDIO_URL").default(DEFAULT_URL))
  .option("--token-file <path>", `token file (default ${DEFAULT_TOKEN_FILE}; PSTUDIO_TOKEN wins)`)
  .showHelpAfterError();

const g = () => program.opts() as { json?: boolean; url: string; tokenFile?: string };
const client = () => new Client(g().url, resolveToken(g().tokenFile));

const EXIT = { conflict: 3, pinned: 4, leased: 5, "not-your-turn": 6 } as Record<string, number>;

function out(data: unknown, text?: string | (() => string)): void {
  if (g().json || text === undefined) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  else process.stdout.write((typeof text === "function" ? text() : text) + "\n");
}

function readInput(path: string): string {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}

function readJson(path: string): any {
  try {
    return JSON.parse(readInput(path));
  } catch (e) {
    throw new ApiError(0, "bad-input", `${path}: ${(e as Error).message}`);
  }
}

/** Wrap an action: errors become JSON (with --json) or a readable message, with a stable exit code. */
function act<A extends unknown[]>(fn: (...args: A) => Promise<void> | void) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, "error", (e as Error).message);
      if (g().json) process.stdout.write(JSON.stringify({ error: { status: err.status, code: err.code, message: err.message, details: err.details } }, null, 2) + "\n");
      else {
        process.stderr.write(`pstudio: ${err.message}${err.status ? ` [${err.status} ${err.code}]` : ""}\n`);
        const d = err.details as any;
        for (const x of d?.blocked ?? []) process.stderr.write(`  pinned: ${x.message}\n`);
        for (const x of d?.conflicts ?? []) process.stderr.write(`  conflict: ${x.node}.${x.path} (theirs: ${x.theirs}, rev ${x.rev})\n`);
        for (const x of d?.errors ?? []) process.stderr.write(`  ${x.path ?? ""}: ${x.message}\n`);
      }
      process.exitCode = EXIT[err.code] ?? 1;
    }
  };
}

const warnText = (w: Array<{ path: string; message: string }>) => (w?.length ? "\n" + w.map((x) => `  warning ${x.path}: ${x.message}`).join("\n") : "");

// ---------------------------------------------------------------- projects

program
  .command("create")
  .description("create a project from a post-studio scene JSON (post-studio/1 or /2), or from a lane template (pstudio templates)")
  .option("--from <file>", "scene JSON ('-' for stdin)")
  .option("--template <id>", "lane template, e.g. lux/post, lux/square, mosaic/square, kites/square, studio/square")
  .option("--title <title>", "override the title")
  .option("--lang <lang>", "document language with --template (e.g. mk, en)")
  .option("-m, --message <msg>", "revision message")
  .action(
    act(async (o: { from?: string; template?: string; title?: string; lang?: string; message?: string }) => {
      if (!!o.from === !!o.template) throw new ApiError(0, "bad-input", "give exactly one of --from <scene.json> or --template <lane/name> (list: pstudio templates)");
      let r: any;
      if (o.template) r = await client().request("POST", "/v1/projects", { template: o.template, title: o.title, lang: o.lang, message: o.message });
      else {
        const doc = readJson(o.from!);
        if (o.title) doc.title = o.title;
        r = await client().request("POST", "/v1/projects", { doc, message: o.message ?? "created" });
      }
      out(r, `created ${r.project} (rev ${r.rev})${r.template ? ` from template ${r.template}` : ""}\n${r.editorUrl}${warnText(r.warnings)}`);
    }),
  );

program
  .command("templates")
  .description("lane templates for create --template (brand-kits/templates)")
  .action(
    act(async () => {
      const r = await client().request("GET", "/v1/templates");
      out(r, () => r.templates.map((t: any) => `${t.id.padEnd(16)} kit ${t.kit.padEnd(8)} ${t.frames.map((f: any) => `${f.id} ${f.w}×${f.h}`).join(", ").padEnd(30)} ${t.name}`).join("\n"));
    }),
  );

const kits = program.command("kits").description("brand kits (brand-kits/<id>.json): colour tokens, type styles, guides");
kits
  .command("list", { isDefault: true })
  .action(
    act(async () => {
      const r = await client().request("GET", "/v1/brand-kits");
      out(r, () => r.kits.map((k: any) => `${k.id.padEnd(8)} ${k.name}  ·  paper ${k.paperHex} accent ${k.accentHex} · ${k.colors.length} colours · ${k.type.length} type styles`).join("\n"));
    }),
  );
kits
  .command("show <kit>")
  .description("tokens ({ \"token\": \"<kit>.<name>\" }) and type styles of one kit")
  .action(
    act(async (id: string) => {
      const k = await client().request("GET", `/v1/brand-kits/${encodeURIComponent(id)}`);
      out(k, () =>
        [
          `${k.id}: ${k.name}`,
          `  ${k.description}`,
          `  colours (token ${k.id}.<name>):`,
          ...k.colors.map((c: any) => `    ${c.name.padEnd(13)} ${c.hex}  ${c.label}${c.name === k.paper ? " · paper" : ""}${c.name === k.accent ? " · ACCENT (once, inside the accent object)" : ""}${c.note ? ` · ${c.note}` : ""}`),
          ...(Object.keys(k.aliases).length ? [`  aliases: ${Object.entries(k.aliases).map(([a, t]) => `${a} → ${t}`).join(", ")}`] : []),
          `  type styles:`,
          ...k.type.map((t: any) => `    ${t.name.padEnd(13)} ${t.font} ${t.weight} ${t.size}/${Math.round(t.size * t.lineHeight)}${t.letterSpacing ? ` +${t.letterSpacing}px` : ""} ${k.id}.${t.fill}${t.case ? ` ${t.case}case` : ""}${t.min ? ` (min ${t.min})` : ""}${t.assumed ? " (size assumed)" : ""}`),
          `  guides: ${Object.entries(k.guides).map(([s, g]) => `${s} → ${g}`).join(", ")}`,
        ].join("\n"),
      );
    }),
  );

program
  .command("palette <project>")
  .description("brand-kit palette check (the check_palette.py rules): verdict per frame and every problem")
  .option("--rev <ref>", "a past revision (number or checkpoint)")
  .action(
    act(async (project: string, o: { rev?: string }) => {
      const r = await client().request("GET", `/v1/projects/${project}/palette${o.rev ? `?rev=${encodeURIComponent(o.rev)}` : ""}`);
      out(r, () => {
        if (!r.check) return `${project} rev ${r.rev}: no brand kit (set one with: apply … {"op":"set","node":"$doc","path":"brandKit","value":"lux"})`;
        const c = r.check;
        return [
          `${project} rev ${r.rev} · kit ${r.kit}${r.strict ? " · strict" : ""}: ${c.ok ? "OK" : `FAIL (${c.issues.length} problem${c.issues.length === 1 ? "" : "s"})`}`,
          ...c.frames.map((f: any) => `  frame ${f.frame}: ${f.ok ? "OK" : "FAIL"} · ${f.accentObjects} accent object${f.accentObjects === 1 ? "" : "s"}`),
          ...c.issues.map((i: any) => `  ${i.code.padEnd(14)} ${i.path}: ${i.message}`),
          ...c.advice.map((i: any) => `  note           ${i.path}: ${i.message}`),
        ].join("\n");
      });
    }),
  );

program
  .command("list")
  .description("list projects")
  .option("--archived", "include archived")
  .action(
    act(async (o: { archived?: boolean }) => {
      const r = await client().request("GET", `/v1/projects${o.archived ? "?archived=1" : ""}`);
      out(r, () =>
        r.projects.length
          ? r.projects.map((p: any) => `${p.id}  rev ${p.head_rev}  ${p.turn}${p.lease ? ` (lease: ${p.lease.holder})` : ""}  ${p.title}`).join("\n")
          : "no projects",
      );
    }),
  );

program
  .command("get <project>")
  .description("full document + head revision (always JSON)")
  .option("--rev <ref>", "a past revision: number, checkpoint (agent-1, approved) or last-approved")
  .option("--out <file>", "write the document to a file")
  .action(
    act(async (project: string, o: { rev?: string; out?: string }) => {
      const r = await client().request("GET", `/v1/projects/${project}${o.rev ? `?rev=${encodeURIComponent(o.rev)}` : ""}`);
      if (o.out) {
        writeFileSync(o.out, JSON.stringify(r.doc, null, 2) + "\n");
        out({ ...r, doc: undefined, written: o.out }, `wrote ${o.out} (rev ${r.rev}, head ${r.head}, turn ${r.turn})`);
      } else out(r);
    }),
  );

program
  .command("outline <project>")
  .description("short text tree for an LLM's context (📌 = pinned)")
  .option("--rev <ref>", "a past revision (number or checkpoint)")
  .action(
    act(async (project: string, o: { rev?: string }) => {
      const r = await client().request("GET", `/v1/projects/${project}/outline${o.rev ? `?rev=${encodeURIComponent(o.rev)}` : ""}`);
      out(r, r.text);
    }),
  );

program
  .command("apply <project>")
  .description("apply an op batch on top of the revision you read")
  .requiredOption("--base <rev>", "revision your ops were written against")
  .requiredOption("--ops <file>", "JSON array of ops ('-' for stdin)")
  .requiredOption("-m, --message <msg>", "what and why, shown in history")
  .option("--override-pin <key=reason...>", "override a pin, e.g. headline.style.size='he asked for 54'")
  .option("--dry-run", "validate and report without writing")
  .action(
    act(async (project: string, o: { base: string; ops: string; message: string; overridePin?: string[]; dryRun?: boolean }) => {
      const overridePins: Record<string, string> = {};
      for (const s of o.overridePin ?? []) {
        const i = s.indexOf("=");
        if (i < 1 || !s.slice(i + 1).trim()) throw new ApiError(0, "bad-input", `--override-pin needs key=reason, got '${s}'`);
        overridePins[s.slice(0, i)] = s.slice(i + 1).trim();
      }
      const ops = readJson(o.ops);
      const r = await client().request("POST", `/v1/projects/${project}/ops`, { base: Number(o.base), ops: Array.isArray(ops) ? ops : ops.ops, message: o.message, overridePins, dryRun: !!o.dryRun });
      const overflow = Object.entries(r.text ?? {})
        .filter(([, m]: any) => m.overflowX || m.overflowY)
        .map(([k, m]: any) => `  overflow ${k}: x ${m.overflowX} px, y ${m.overflowY} px`);
      out(r, `${r.dryRun ? "dry run ok" : `rev ${r.rev}`}${r.rebased ? ` (rebased from ${r.base})` : ""}${warnText(r.warnings)}${overflow.length ? "\n" + overflow.join("\n") : ""}`);
    }),
  );

program
  .command("diff <project>")
  .description("what changed, by node (default: since the last agent checkpoint)")
  .option("--since <ref>", "rev number, checkpoint name, last-agent or last-handoff")
  .option("--to <ref>", "rev number or checkpoint (default head)")
  .action(
    act(async (project: string, o: { since?: string; to?: string }) => {
      const q = new URLSearchParams({ ...(o.since ? { since: o.since } : {}), ...(o.to ? { to: o.to } : {}) });
      const r = await client().request("GET", `/v1/projects/${project}/diff?${q}`);
      out(r, `rev ${r.from} → ${r.to}\n${r.text}`);
    }),
  );

program
  .command("history <project>")
  .description("revisions with author and message")
  .option("--since <rev>", "only after this revision")
  .action(
    act(async (project: string, o: { since?: string }) => {
      const r = await client().request("GET", `/v1/projects/${project}/revisions${o.since ? `?since=${o.since}` : ""}`);
      out(r, () =>
        r.revisions
          .map((x: any) => `${String(x.rev).padStart(4)}  ${x.createdAt.slice(0, 19)}  ${x.author.padEnd(16)} ${x.kind === "ops" ? "" : `[${x.kind}] `}${x.message}${x.overrides.length ? `  (overrode ${x.overrides.map((v: any) => v.key).join(", ")})` : ""}`)
          .join("\n"),
      );
    }),
  );

program
  .command("restore <project>")
  .description("restore an old revision (as a new revision; history is kept)")
  .requiredOption("--rev <n>", "revision to go back to")
  .option("-m, --message <msg>", "revision message")
  .action(
    act(async (project: string, o: { rev: string; message?: string }) => {
      const r = await client().request("POST", `/v1/projects/${project}/restore`, { rev: Number(o.rev), message: o.message });
      out(r, `restored rev ${o.rev} as rev ${r.rev}`);
    }),
  );

program
  .command("revert <project>")
  .description("undo one past revision as a new revision; later changes stay (exit 3 when a later revision changed the same thing)")
  .requiredOption("--rev <n>", "revision to undo")
  .option("-m, --message <msg>", "revision message (default: revert rev N (“…”))")
  .action(
    act(async (project: string, o: { rev: string; message?: string }) => {
      if (!/^\d+$/.test(o.rev)) throw new ApiError(0, "bad-input", "--rev must be a revision number");
      const r = await client().request("POST", `/v1/projects/${project}/revert`, { rev: Number(o.rev), message: o.message });
      out(r, `reverted rev ${o.rev} as rev ${r.rev}${r.rebased ? " (later changes kept)" : ""}${warnText(r.warnings)}`);
    }),
  );

program
  .command("approve <project>")
  .description("(human) approve the head revision: checkpoint 'approved', then 'approved-2', …")
  .option("--note <text>", "why it is done")
  .action(
    act(async (project: string, o: { note?: string }) => {
      const r = await client().request("POST", `/v1/projects/${project}/approve`, { note: o.note });
      out(r, `${r.checkpoint} at rev ${r.rev}`);
    }),
  );

program
  .command("pins <project>")
  .description("properties the agent must not change (explicit + soft since the last agent turn)")
  .action(
    act(async (project: string) => {
      const r = await client().request("GET", `/v1/projects/${project}/pins`);
      out(r, () => (r.effective.length ? r.effective.map((p: any) => `${p.node}.${p.path}  (${p.source}${p.rev ? `, rev ${p.rev}` : ""})`).join("\n") : `no pins (since ${r.since})`));
    }),
  );

program
  .command("validate <file>")
  .description("validate a scene JSON without creating it")
  .action(
    act(async (file: string) => {
      const r = await client().request("POST", "/v1/validate", readJson(file));
      out(r, `${r.ok ? "valid" : "INVALID"}${r.errors.map((e: any) => `\n  error ${e.path}: ${e.message}`).join("")}${warnText(r.warnings)}`);
      if (!r.ok) process.exitCode = 1;
    }),
  );

program
  .command("fonts")
  .description("registered fonts")
  .action(
    act(async () => {
      const r = await client().request("GET", "/v1/fonts");
      out(r, () => r.fonts.map((f: any) => `${f.family.padEnd(16)} ${f.weights[0] === f.weights[1] ? f.weights[0] : f.weights.join("–")}${f.variable ? " (variable)" : ""}  ${f.macedonian}`).join("\n"));
    }),
  );

// ---------------------------------------------------------------- render, export

const FORMATS = ["png", "jpg", "svg", "figma", "outlined"];

/** "1.2" (seconds) → 1200 ms. */
function seconds(v: string, name: string): number {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n) || n < 0) throw new ApiError(0, "bad-input", `${name} is a time in seconds ≥ 0 (e.g. 1.2), got '${v}'`);
  return Math.round(n * 1000);
}

program
  .command("render <project>")
  .description("render one frame (default PNG of the first frame at its poster moment); look at it after every apply")
  .requiredOption("--out <file>", "output file")
  .option("--frame <id>", "frame id (default the first frame)")
  .option("--rev <ref>", "a past revision: number or checkpoint (default head)")
  .option("--format <f>", `${FORMATS.join(" | ")} (default from the --out extension, else png)`)
  .option("--scale <n>", "PNG / JPEG scale, 0.1–4", "1")
  .option("--at <seconds>", "motion projects: the moment to draw, e.g. 1.2 (or 'rest' = no animation; default the poster moment)")
  .option("--contact", "motion projects: one PNG with 12 moments from the first to the last frame (check every moment at once)")
  .option("--moments <n>", "with --contact: how many moments (2–48)", "12")
  .action(
    act(async (project: string, o: { out: string; frame?: string; rev?: string; format?: string; scale: string; at?: string; contact?: boolean; moments: string }) => {
      if (o.contact) {
        if (o.at !== undefined) throw new ApiError(0, "bad-input", "--contact shows many moments; leave out --at");
        const q = new URLSearchParams({ n: o.moments, ...(o.frame ? { frame: o.frame } : {}), ...(o.rev ? { rev: o.rev } : {}) });
        const r = await client().raw("GET", `/v1/projects/${project}/contact?${q}`);
        writeAtomic(o.out, r.bytes);
        const times = (r.headers.get("x-post-studio-times") ?? "").split(",").filter(Boolean).map(Number);
        const warnings = JSON.parse(decodeURIComponent(r.headers.get("x-post-studio-warnings") ?? "%5B%5D")) as string[];
        const res = { out: o.out, bytes: r.bytes.length, format: "png", contact: true, frame: r.headers.get("x-post-studio-frame"), rev: Number(r.headers.get("x-post-studio-rev")), times, warnings };
        out(res, `wrote ${o.out} (contact sheet, frame ${res.frame}, rev ${res.rev}, ${times.length} moments: ${times.map((t) => (t / 1000).toFixed(2)).join(" ")} s)${warnings.map((w) => `\n  warning: ${w}`).join("")}`);
        return;
      }
      const ext = o.out.toLowerCase().split(".").pop() ?? "";
      const format = o.format ?? (ext === "jpg" || ext === "jpeg" ? "jpg" : ext === "svg" ? "svg" : "png");
      if (!FORMATS.includes(format)) throw new ApiError(0, "bad-input", `--format must be one of ${FORMATS.join(", ")}`);
      const t = o.at === undefined ? undefined : o.at === "rest" ? "rest" : String(seconds(o.at, "--at"));
      const q = new URLSearchParams({ format, scale: o.scale, ...(o.frame ? { frame: o.frame } : {}), ...(o.rev ? { rev: o.rev } : {}), ...(t !== undefined ? { t } : {}) });
      const r = await client().raw("GET", `/v1/projects/${project}/render?${q}`);
      writeAtomic(o.out, r.bytes);
      const warnings = JSON.parse(decodeURIComponent(r.headers.get("x-post-studio-warnings") ?? "%5B%5D")) as string[];
      const time = r.headers.get("x-post-studio-time");
      const at: number | "rest" = time === null || time === "rest" ? "rest" : Number(time);
      const res = { out: o.out, bytes: r.bytes.length, format, frame: r.headers.get("x-post-studio-frame"), rev: Number(r.headers.get("x-post-studio-rev")), time: at, warnings };
      out(res, `wrote ${o.out} (${format}, frame ${res.frame}, rev ${res.rev}${at !== "rest" ? `, at ${(at / 1000).toFixed(2)} s` : ""}, ${res.bytes} bytes)${warnings.map((w) => `\n  warning: ${w}`).join("")}`);
    }),
  );

interface VideoJob {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  project: string;
  rev: number;
  frame: string;
  frames: number;
  fps: number;
  done: number;
  progress: number;
  position?: number;
  width?: number;
  height?: number;
  bytes?: number;
  ms?: number;
  error?: string;
  warnings: string[];
  url: string;
  filename: string;
}

/** Ask the server for a video, wait for its job, download the MP4. */
async function fetchVideo(c: Client, project: string, q: { rev?: string | number; frame?: string; scale?: string }, timeoutS: number): Promise<{ job: VideoJob; bytes: Uint8Array; cached: boolean; waitedMs: number }> {
  const started = Date.now();
  const qs = new URLSearchParams({ ...(q.rev !== undefined ? { rev: String(q.rev) } : {}), ...(q.frame ? { frame: q.frame } : {}), ...(q.scale && q.scale !== "1" ? { scale: q.scale } : {}) });
  const first = await c.request("GET", `/v1/projects/${project}/video?${qs}`);
  let job = first.job as VideoJob;
  let shown = -1;
  const say = () => {
    if (g().json) return;
    const pct = Math.floor(job.progress * 10) * 10;
    if (pct === shown) return;
    shown = pct;
    process.stderr.write(job.status === "queued" ? `video ${job.frame}: waiting (place ${job.position ?? "?"} in the queue)\n` : `video ${job.frame}: ${pct} % (${job.done}/${job.frames} frames)\n`);
  };
  while (job.status === "queued" || job.status === "running") {
    if (Date.now() - started > timeoutS * 1000) throw new ApiError(0, "timeout", `the video of ${project} frame ${job.frame} is still ${job.status} after ${timeoutS} s (job ${job.id}; it keeps running on the server: run the same command again later)`);
    say();
    await new Promise((r) => setTimeout(r, 1000));
    job = (await c.request("GET", `/v1/video-jobs/${job.id}`)).job;
  }
  if (job.status === "failed") throw new ApiError(0, "video-failed", `the video export failed: ${job.error}`);
  const file = await c.raw("GET", job.url);
  return { job, bytes: file.bytes, cached: !!first.cached, waitedMs: Date.now() - started };
}

program
  .command("video <project>")
  .description("export one frame of a motion project as MP4 (H.264, one pass of its length) and wait for it (~10–60 s; cached after the first time)")
  .requiredOption("--out <file>", "output .mp4")
  .option("--frame <id>", "frame id (default the first frame)")
  .option("--rev <ref>", "a past revision: number or checkpoint (default head)")
  .option("--scale <n>", "0.1–2", "1")
  .option("--timeout <s>", "stop waiting after this many seconds (the job keeps running on the server)", "900")
  .action(
    act(async (project: string, o: { out: string; frame?: string; rev?: string; scale: string; timeout: string }) => {
      const r = await fetchVideo(client(), project, o, Number(o.timeout) || 900);
      writeAtomic(o.out, r.bytes);
      const j = r.job;
      const res = { out: o.out, bytes: r.bytes.length, project, rev: j.rev, frame: j.frame, frames: j.frames, fps: j.fps, width: j.width, height: j.height, durationMs: Math.round((j.frames * 1000) / j.fps), job: j.id, cached: r.cached, encodeMs: j.ms, waitedMs: r.waitedMs, warnings: j.warnings };
      out(res, `wrote ${o.out} (MP4 ${j.width}×${j.height}, ${j.frames} frames @ ${j.fps} fps = ${(res.durationMs / 1000).toFixed(2)} s, frame ${j.frame}, rev ${j.rev}, ${res.bytes} bytes${r.cached ? ", from the cache" : `, encoded in ${((j.ms ?? 0) / 1000).toFixed(1)} s`})${j.warnings.map((w) => `\n  warning: ${w}`).join("")}`);
    }),
  );

program
  .command("timeline <project>")
  .description("text timeline of a motion project: a bar per animated layer, then each track's keyframes (id, time, value, ease); 📌 = pinned (📌t = only its time)")
  .option("--rev <ref>", "a past revision (number or checkpoint; pins show at the head only)")
  .action(
    act(async (project: string, o: { rev?: string }) => {
      const r = await client().request("GET", `/v1/projects/${project}/timeline${o.rev ? `?rev=${encodeURIComponent(o.rev)}` : ""}`);
      out(r, r.text);
    }),
  );

const anim = program.command("anim").description("motion helpers: they write an ops file and never apply anything (apply it with pstudio apply --base, so pins and conflicts work as always)");
anim
  .command("presets")
  .description("the animation presets")
  .action(
    act(async () => {
      const list = PRESETS.map((p) => ({ id: p.id, label: p.label, kind: p.kind, ease: p.ease, tracks: p.tracks.map((t) => `${t.track} ${t.from}→${t.to}`), ...(p.origin ? { origin: p.origin } : {}), ...(p.textOnly ? { textOnly: true } : {}) }));
      out({ presets: list, aliases: PRESET_ALIASES }, () =>
        [
          ...list.map((p) => `${p.id.padEnd(15)} ${p.label.padEnd(20)} ${p.tracks.join(", ")} · ${p.ease}${p.origin ? ` · origin ${p.origin}` : ""}${p.textOnly ? " · text only" : ""}`),
          `aliases: ${Object.entries(PRESET_ALIASES).map(([a, b]) => `${a} = ${b}`).join(", ")}`,
        ].join("\n"),
      );
    }),
  );
anim
  .command("preset <project>")
  .description("write the keyframe ops of a preset on one or more layers to a file (e.g. --node headline --preset fade-up --at 0.4)")
  .requiredOption("--node <id...>", "layer id(s); several = staggered")
  .requiredOption("--preset <id>", `preset (pstudio anim presets): ${PRESETS.map((p) => p.id).join(", ")}`)
  .requiredOption("--out <file>", "ops file to write ('-' = stdout)")
  .option("--at <seconds>", "start of the first layer", "0")
  .option("--dur <seconds>", "length of each layer's animation (default 0.6)")
  .option("--ease <ease>", `curve from the first keyframe to the second: ${EASES.join(", ")}`)
  .option("--stagger <seconds>", "each further layer starts this much later (e.g. 0.08)")
  .option("--distance <px>", "slide distance for slide presets")
  .option("--order <order>", "stagger order: given (as listed) or reading (top to bottom, left to right)", "given")
  .option("--rev <ref>", "read the document at this revision (default head)")
  .action(
    act(async (project: string, o: { node: string[]; preset: string; out: string; at: string; dur?: string; ease?: string; stagger?: string; distance?: string; order: string; rev?: string }) => {
      if (o.ease && !(EASES as readonly string[]).includes(o.ease)) throw new ApiError(0, "bad-input", `--ease must be one of ${EASES.join(", ")}`);
      if (o.order !== "given" && o.order !== "reading") throw new ApiError(0, "bad-input", "--order is given or reading");
      const distance = o.distance === undefined ? undefined : Number(o.distance);
      if (distance !== undefined && !Number.isFinite(distance)) throw new ApiError(0, "bad-input", "--distance is a number of px");
      const p = await client().request("GET", `/v1/projects/${project}${o.rev ? `?rev=${encodeURIComponent(o.rev)}` : ""}`);
      let ops;
      try {
        const ids = o.order === "reading" ? readingOrder(p.doc, o.node) : o.node;
        ops = presetOps(p.doc, ids, o.preset, {
          at: seconds(o.at, "--at"),
          ...(o.dur !== undefined ? { dur: seconds(o.dur, "--dur") } : {}),
          ...(o.ease ? { ease: o.ease as (typeof EASES)[number] } : {}),
          ...(o.stagger !== undefined ? { stagger: seconds(o.stagger, "--stagger") } : {}),
          ...(distance !== undefined ? { distance } : {}),
        });
      } catch (e) {
        if (e instanceof MotionError) throw new ApiError(0, e.code, e.message);
        throw e;
      }
      const json = JSON.stringify(ops, null, 2) + "\n";
      if (o.out === "-") {
        process.stdout.write(json);
        return;
      }
      writeAtomic(o.out, Buffer.from(json, "utf8"));
      const addsMotion = ops.some((x) => x.node === "$doc");
      const res = { project, base: p.rev, out: o.out, ops: ops.length, addsMotion, apply: `pstudio apply ${project} --base ${p.rev} --ops ${o.out} -m "${o.preset} on ${o.node.join(", ")}"` };
      out(res, `wrote ${ops.length} ops to ${o.out} (read at rev ${p.rev}${addsMotion ? "; also turns on motion: 6 s @ 30 fps" : ""}). Nothing is applied yet:\n  ${res.apply}`);
    }),
  );

const opsCmd = program.command("ops").description("op helpers: they write an ops file and never apply anything (apply it with pstudio apply --base, so pins and conflicts work as always)");
opsCmd
  .command("set <project>")
  .description(
    "one property on many layers at once (the editor's multi-select edit), e.g. --type text --field size --value 48, or --node bar-1 bar-2 --field fill --value '{\"token\":\"lux.ink\"}'",
  )
  .option("--node <id...>", "layer ids")
  .option("--type <type...>", `every layer of these types (${NODE_TYPES.join(", ")})`)
  .option("--same-fill-as <id>", "every visible, unlocked layer in its frame with the same fill / text colour as this layer")
  .option("--frame <id>", "only layers in this frame (with --type / --same-fill-as)")
  .option("--field <field>", `a shared field, mapped per layer type (fill = shape fill or text colour): ${FIELD_KEYS.join(", ")}`)
  .option("--path <path>", "a raw document path set on each layer as is (e.g. sketch.roughness)")
  .option("--value <json>", "the value as JSON (48, \"center\", {\"token\":\"lux.ink\"}, null); a bare word or #hex is taken as a string")
  .option("--unset", "remove the property (back to its default) instead of setting it")
  .requiredOption("--out <file>", "ops file to write ('-' = stdout)")
  .option("--rev <ref>", "read the document at this revision (default head)")
  .action(
    act(async (project: string, o: { node?: string[]; type?: string[]; sameFillAs?: string; frame?: string; field?: string; path?: string; value?: string; unset?: boolean; out: string; rev?: string }) => {
      if (!o.field === !o.path) throw new ApiError(0, "bad-input", "give exactly one of --field or --path");
      if (o.field && !fieldDef(o.field)) throw new ApiError(0, "bad-input", `--field must be one of ${FIELD_KEYS.join(", ")}`);
      if (!!o.unset === (o.value !== undefined)) throw new ApiError(0, "bad-input", "give exactly one of --value or --unset");
      if (!o.node?.length && !o.type?.length && !o.sameFillAs) throw new ApiError(0, "bad-input", "choose layers with --node, --type or --same-fill-as");
      for (const t of o.type ?? []) if (!(NODE_TYPES as readonly string[]).includes(t)) throw new ApiError(0, "bad-input", `--type ${t}: types are ${NODE_TYPES.join(", ")}`);
      let value: unknown = undefined;
      if (o.value !== undefined) {
        try {
          value = JSON.parse(o.value);
        } catch {
          value = o.value;
        }
      }
      const p = await client().request("GET", `/v1/projects/${project}${o.rev ? `?rev=${encodeURIComponent(o.rev)}` : ""}`);
      const doc = p.doc;
      if (o.frame && !doc.frames.some((f: { id: string }) => f.id === o.frame)) throw new ApiError(0, "bad-input", `no frame ${o.frame}`);
      const ids: string[] = [];
      const add = (xs: string[]) => xs.forEach((x) => !ids.includes(x) && ids.push(x));
      for (const id of o.node ?? []) {
        const loc = findItem(doc, id);
        if (!loc || loc.kind !== "node") throw new ApiError(0, "bad-input", `no layer ${id}`);
        add([id]);
      }
      if (o.type?.length) add(idsOfType(doc, o.type, o.frame));
      if (o.sameFillAs) {
        const loc = findItem(doc, o.sameFillAs);
        if (!loc || loc.kind !== "node") throw new ApiError(0, "bad-input", `no layer ${o.sameFillAs}`);
        add(matchingIds(doc, [o.sameFillAs], "fill", o.frame ? { frames: [o.frame] } : {}));
      }
      let ops: Op[];
      if (o.field) ops = setFieldOps(doc, ids, o.field as FieldKey, value);
      else {
        ops = [];
        for (const id of ids) {
          const item = findItem(doc, id)!.item as any;
          const cur = o.path!.split(".").reduce((x: any, k) => (x == null ? undefined : x[k]), item);
          if (o.unset) {
            if (cur !== undefined) ops.push({ op: "unset", node: id, path: o.path! });
          } else if (JSON.stringify(cur) !== JSON.stringify(value)) ops.push({ op: "set", node: id, path: o.path!, value });
        }
      }
      const json = JSON.stringify(ops, null, 2) + "\n";
      const what = `${o.field ?? o.path} ${o.unset ? "unset" : JSON.stringify(value)}`;
      if (o.out === "-") {
        process.stdout.write(json);
        return;
      }
      writeAtomic(o.out, Buffer.from(json, "utf8"));
      const touched = [...new Set(ops.map((x) => (x as { node: string }).node))];
      const res = { project, base: p.rev, out: o.out, ops: ops.length, layers: touched, matched: ids.length, apply: `pstudio apply ${project} --base ${p.rev} --ops ${o.out} -m "${what.replace(/"/g, "'")} on ${touched.length} layers"` };
      out(
        res,
        ops.length
          ? `wrote ${ops.length} ops for ${touched.length} of ${ids.length} matched layers to ${o.out} (read at rev ${p.rev}). Nothing is applied yet; one apply = one revision:\n  ${res.apply}`
          : `nothing to change: ${ids.length} matched layers already have ${what} (or do not have that property). Wrote an empty list to ${o.out}.`,
      );
    }),
  );

/** Without --social-posts, a real social-posts/posts/ folder is refused (PLAN §3.9). */
function refuseSocialPosts(dir: string): void {
  if (insideSocialPosts(dir)) {
    throw new ApiError(0, "refused", `${dir} is inside social-posts/posts/. Writing there needs --social-posts and Nikola's approved rule in social-posts/AGENTS.md (${PROPOSAL}); otherwise export to another folder.`);
  }
}

function writeAtomic(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

program
  .command("export <project>")
  .description("write post.svg / post.png / post.jpg (+ -li per frame), figma/*.figma-ready.svg, figma/*.outlined.svg, post-studio.json; motion projects also post.mp4 per frame (stills = the poster moment)")
  .requiredOption("--to <dir>", "target folder (a real social-posts/posts/<slug> needs --social-posts)")
  .option("--rev <ref>", "a past revision: number, checkpoint or last-approved (default head; with --social-posts: last-approved)")
  .option("--frame <id...>", "only these frames")
  .option("--social-posts", "export into social-posts/posts/<slug>/: only an approved revision that passes the palette check, and only once social-posts/AGENTS.md allows it")
  .option("--force", "with --social-posts: overwrite a post folder Post Studio did not write")
  .option("--no-video", "motion projects: skip post*.mp4 (stills only)")
  .option("--timeout <s>", "motion projects: stop waiting for each video after this many seconds", "900")
  .action(
    act(async (project: string, o: { to: string; rev?: string; frame?: string[]; socialPosts?: boolean; force?: boolean; video: boolean; timeout: string }) => {
      const c = client();
      let rev: string | number | undefined = o.rev ? (/^\d+$/.test(o.rev) ? Number(o.rev) : o.rev) : undefined;
      let target: ReturnType<typeof socialPostsTarget> | undefined;
      const notes: string[] = [];
      if (o.socialPosts) {
        try {
          target = socialPostsTarget(o.to);
          if (!approved(target.root)) throw new SocialPostsRefused("not-approved", notApprovedMessage(target.root));
          const head = await c.request("GET", `/v1/projects/${project}?rev=${encodeURIComponent(String(rev ?? "last-approved"))}`).catch((e: ApiError) => {
            throw e.status === 404 && rev === undefined ? new SocialPostsRefused("not-approved", `${project} has no approved revision yet: Nikola approves it in the editor first`) : e;
          });
          const cps = (await c.request("GET", `/v1/projects/${project}/checkpoints`)).checkpoints as Array<{ name: string; rev: number; kind: string }>;
          const ok = cps.filter((x) => x.kind === "approved" && x.rev === head.rev);
          if (!ok.length) throw new SocialPostsRefused("not-approved", `rev ${head.rev} of ${project} is not approved (approved: ${cps.filter((x) => x.kind === "approved").map((x) => `${x.name}@${x.rev}`).join(", ") || "none"}); only an approved revision goes into social-posts`);
          rev = head.rev;
          const pal = await c.request("GET", `/v1/projects/${project}/palette?rev=${head.rev}`);
          if (!pal.check) throw new SocialPostsRefused("palette", `${project} has no brand kit: social-posts posts belong to a lane (set brandKit to lux, mosaic, kites or studio)`);
          if (!pal.check.ok) throw new SocialPostsRefused("palette", `rev ${head.rev} fails the ${pal.kit} palette check (the check_palette.py rules): ${pal.check.issues.slice(0, 5).map((i: any) => `${i.path}: ${i.message}`).join("; ")}${pal.check.issues.length > 5 ? ` … (${pal.check.issues.length} in all; pstudio palette ${project} --rev ${head.rev})` : ""}`);
          const own = ownership(target.dir, project);
          if (own.problem && !o.force) throw new SocialPostsRefused("exists", own.problem);
          notes.push(`approved ${ok.map((x) => x.name).join(", ")} · palette ${pal.kit} OK`);
        } catch (e) {
          if (e instanceof SocialPostsRefused) throw new ApiError(0, e.code, e.message);
          throw e;
        }
      } else refuseSocialPosts(o.to);
      const r = await c.request("POST", `/v1/projects/${project}/export`, { ...(rev !== undefined ? { rev } : {}), ...(o.frame ? { frames: o.frame } : {}) });
      const dir = target?.dir ?? o.to;
      // Motion projects: one MP4 per frame from the video jobs (same revision), listed in export.json.
      const videos: Array<{ path: string; mime: string; bytes: Uint8Array }> = [];
      if (r.motion && o.video) {
        for (const f of r.frames) {
          const v = await fetchVideo(c, project, { rev: r.rev, frame: f.id }, Number(o.timeout) || 900);
          videos.push({ path: f.video ?? `${f.stem}.mp4`, mime: "video/mp4", bytes: v.bytes });
        }
        const manifestFile = r.files.find((f: any) => f.path === "export.json");
        const manifest = JSON.parse(Buffer.from(manifestFile.base64, "base64").toString("utf8"));
        manifest.files.push(...videos.map((v) => ({ path: v.path, bytes: v.bytes.length, sha256: createHash("sha256").update(v.bytes).digest("hex") })));
        const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
        Object.assign(manifestFile, { base64: bytes.toString("base64"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      } else if (r.motion) notes.push("motion project: videos skipped (--no-video)");
      for (const v of videos) writeAtomic(join(dir, v.path), v.bytes);
      for (const f of r.files) writeAtomic(join(dir, ...f.path.split("/")), Buffer.from(f.base64, "base64"));
      const written = [
        ...r.files.map((f: any) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
        ...videos.map((v) => ({ path: v.path, bytes: v.bytes.length, sha256: createHash("sha256").update(v.bytes).digest("hex") })),
      ];
      if (target) {
        if (mayWriteCopy(target.dir)) {
          const doc = JSON.parse(Buffer.from(r.files.find((f: any) => f.path === "post-studio.json").base64, "base64").toString("utf8"));
          const bytes = Buffer.from(JSON.stringify(copyJsonFor(doc, project, r.rev), null, 2) + "\n", "utf8");
          writeAtomic(join(target.dir, "copy.json"), bytes);
          written.push({ path: "copy.json", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
        } else notes.push("copy.json kept: it was not written by Post Studio");
        for (const f of written) if (!OWNED.test(f.path)) throw new ApiError(0, "internal", `unexpected export file ${f.path}`);
      }
      const res = { project, rev: r.rev, to: dir, socialPosts: !!target, frames: r.frames, warnings: r.warnings, notes, files: written };
      out(res, `exported ${project} rev ${r.rev} to ${dir}${target ? " (social-posts)" : ""}\n${written.map((f: any) => `  ${f.path}  ${f.bytes} bytes`).join("\n")}${notes.map((n) => `\n  ${n}`).join("")}${r.warnings.map((w: string) => `\n  warning: ${w}`).join("")}`);
    }),
  );

// ---------------------------------------------------------------- import

const importCmd = program.command("import").description("bring existing posts into Post Studio");
importCmd
  .command("social-posts <post-dir>")
  .description("import a social-posts/posts/<slug> folder: figma/editable-layout.json → template post.svg → whole-SVG fallback")
  .option("--mode <mode>", "auto | layout | template | fallback", "auto")
  .option("--title <title>", "project title (default: the headline from copy.json)")
  .option("--kit <id>", "brand kit: lux | mosaic | kites | studio | none (default: copy.json lane or the slug prefix)")
  .option("--out <file>", "also write the converted scene JSON")
  .option("--dry-run", "convert only: nothing is uploaded or created (asset refs are computed locally)")
  .action(
    act(async (postDir: string, o: { mode: string; title?: string; kit?: string; out?: string; dryRun?: boolean }) => {
      if (!["auto", "layout", "template", "fallback"].includes(o.mode)) throw new ApiError(0, "bad-input", "--mode must be auto, layout, template or fallback");
      const [{ importSocialPost, ImportError }, { FontRegistry }] = await Promise.all([import("@post-studio/import"), import("@post-studio/text")]);
      const fonts = await FontRegistry.load();
      const { prepareAsset } = o.dryRun ? await local() : { prepareAsset: undefined };
      const c = o.dryRun ? undefined : client();
      const upload = async (bytes: Uint8Array, name: string) => {
        if (prepareAsset) {
          const p = prepareAsset(bytes);
          return { ref: `sha256:${p.sha256}`, mime: p.mime, bytes: p.bytes.length };
        }
        return c!.request("POST", "/v1/assets", bytes, { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(name) });
      };
      let result;
      try {
        result = await importSocialPost(postDir, { fonts, upload, mode: o.mode as any, title: o.title, ...(o.kit ? { kit: o.kit === "none" ? null : o.kit } : {}) });
      } catch (e) {
        if (e instanceof ImportError) throw new ApiError(0, "import-failed", e.message, { reasons: e.reasons });
        throw e;
      }
      const { doc, report } = result;
      if (o.out) writeAtomic(o.out, Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8"));
      let created: any;
      if (!o.dryRun) created = await c!.request("POST", "/v1/projects", { doc, message: `import ${doc.meta?.source} (${report.mode})` });
      const res = { ...(created ? { project: created.project, rev: created.rev, editorUrl: created.editorUrl, warnings: created.warnings } : { dryRun: true }), report, ...(o.out ? { out: o.out } : {}) };
      out(res, () =>
        [
          created ? `created ${created.project} (rev ${created.rev}) from ${postDir} · mode ${report.mode}\n${created.editorUrl}` : `dry run: ${postDir} · mode ${report.mode} (nothing uploaded or created)`,
          ...report.why.map((w) => `  not ${w}`),
          ...report.frames.map((f) => `  frame ${f.id} ${f.w}×${f.h} from ${f.source}: ${f.nodes} nodes, ${f.texts} text · roles ${Object.keys(f.roles).join(", ")}`),
          ...report.assets.map((a) => `  asset ${a.ref.slice(0, 19)}… ${a.mime} from ${a.from}${a.note ? ` (${a.note})` : ""}`),
          ...report.skipped.map((s) => `  skipped ${s}`),
          ...report.warnings.map((w) => `  warning ${w}`),
          ...(created?.warnings ?? []).map((w: any) => `  warning ${w.path}: ${w.message}`),
          o.out ? `  scene written to ${o.out}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }),
  );

// ---------------------------------------------------------------- checkpoints, hand-off, lease

const checkpoint = program.command("checkpoint").description("named revisions");
checkpoint
  .command("list <project>")
  .action(
    act(async (project: string) => {
      const r = await client().request("GET", `/v1/projects/${project}/checkpoints`);
      out(r, () => r.checkpoints.map((c: any) => `${c.name.padEnd(12)} rev ${String(c.rev).padEnd(4)} ${c.author.padEnd(16)} ${c.note ?? ""}`).join("\n"));
    }),
  );
checkpoint
  .command("create <project> <name>")
  .option("--note <text>")
  .action(
    act(async (project: string, name: string, o: { note?: string }) => {
      const r = await client().request("POST", `/v1/projects/${project}/checkpoints`, { name, note: o.note });
      out(r, `checkpoint ${r.name} at rev ${r.rev}`);
    }),
  );

const handoff = program.command("handoff").description("turns: Nikola hands to the agent, the agent hands back");
handoff
  .command("show <project>")
  .description("turn, lease, Nikola's latest note, what he pointed at (focus) and, for motion, the moment he was looking at (at)")
  .action(
    act(async (project: string) => {
      const r = await client().request("GET", `/v1/projects/${project}/handoff`);
      out(r, () => {
        const focus = r.handoff?.focus ?? [];
        const d = r.dispatch;
        return [
          `turn: ${r.turn === "agent" ? "agent (yours: take the lease and work)" : "human (Nikola's: wait for his hand-off)"}   head: rev ${r.head}${r.lease ? `   lease: ${r.lease.holder} (${r.lease.secondsLeft}s left)` : ""}`,
          r.handoff ? `handed over: ${r.handoff.name} at rev ${r.handoff.rev}\nnote (his words): ${r.handoff.note}` : "no hand-off yet",
          focus.length
            ? `Nikola pointed at: ${r.handoff.focusText}\n  → "this", "that", "it" in his note mean these layers; work on them first and leave unrelated layers alone unless the note asks`
            : r.handoff
              ? "pointed at: nothing (the note is about the whole design)"
              : "",
          r.handoff?.at != null
            ? `at: ${r.handoff.atText} (the moment he was looking at on the timeline)\n  → "here", "now", "this moment" in his note mean ${r.handoff.atText}; look with pstudio render ${project} --at ${(r.handoff.at / 1000).toFixed(2)} and pstudio timeline ${project}`
            : "",
          d ? `auto-start: ${d.state}${d.jobId ? ` (job #${d.jobId}${d.jobStatus ? `, ${d.jobStatus} when it was started` : ""})` : ""}${d.error ? ` · ${d.error}` : ""}` : "",
          r.agent ? `last agent turn: ${r.agent.name} at rev ${r.agent.rev}: ${r.agent.note}` : "",
          `protected (his changes since ${r.agent ? r.agent.name : "created"}): ${r.softPins} propert${r.softPins === 1 ? "y" : "ies"}; see pstudio pins / diff`,
          r.approved ? `approved: ${r.approved.name} at rev ${r.approved.rev}${r.approved.current ? " (the head)" : " (changed since)"}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      });
    }),
  );
handoff
  .command("give <project>")
  .description("(human) hand the project to the agent with a note; --focus points at layers")
  .option("--note <text>", "what you want", "")
  .option("--focus <ids>", "comma-separated node ids the note is about, e.g. headline,bar-3")
  .option("--at <seconds>", "motion projects: the moment the note is about, e.g. 1.2")
  .action(
    act(async (project: string, o: { note: string; focus?: string; at?: string }) => {
      const focus = o.focus ? o.focus.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
      const at = o.at === undefined ? undefined : seconds(o.at, "--at");
      const r = await client().request("POST", `/v1/projects/${project}/handoff`, { note: o.note, focus, ...(at !== undefined ? { at } : {}) });
      out(r, `${r.checkpoint} at rev ${r.rev}; turn: ${r.turn}${r.focus?.length ? `; pointing at ${r.focus.map((f: any) => f.id).join(", ")}` : ""}${r.at != null ? `; at ${(r.at / 1000).toFixed(2)} s` : ""}`);
    }),
  );
handoff
  .command("retry <project>")
  .description("(human) ask the dispatcher again to start an agent job for the latest hand-off")
  .action(
    act(async (project: string) => {
      const r = await client().request("POST", `/v1/projects/${project}/handoff/retry-dispatch`, {});
      out(r, `${r.checkpoint}: auto-start ${r.state} (attempt ${r.attempts + 1} next)`);
    }),
  );
handoff
  .command("take-back <project>")
  .description("(human) take a hand-off back before the agent starts (refused while it holds a lease)")
  .action(
    act(async (project: string) => {
      const r = await client().request("POST", `/v1/projects/${project}/handoff/take-back`, {});
      out(r, r.changed ? `taken back at rev ${r.rev}; turn: human` : "it was already your turn");
    }),
  );
handoff
  .command("back <project>")
  .description("(agent) end the turn: checkpoint agent-N, release the lease")
  .requiredOption("--summary <text>", "one line: what you changed")
  .action(
    act(async (project: string, o: { summary: string }) => {
      const r = await client().request("POST", `/v1/projects/${project}/handoff/back`, { summary: o.summary });
      out(r, `${r.checkpoint} at rev ${r.rev}; turn: ${r.turn}`);
    }),
  );

const dispatch = program.command("dispatch").description("(host service) start an agent job for each new hand-off; see AGENTS.md \"Hand-off dispatch\"");
for (const [name, once] of [["run", false], ["once", true]] as const) {
  dispatch
    .command(name)
    .description(once ? "one poll, then exit (stop the service first)" : "poll forever (post-studio-dispatch.service)")
    .option("--token <file>", "dispatcher token file (default ~/.config/post-studio/dispatcher-token)")
    .action(
      act(async (o: { token?: string }) => {
        const { dispatchConfigFromEnv, runLoop } = await import("./dispatch.ts");
        const url = program.getOptionValueSource("url") === "default" ? undefined : g().url;
        const r = await runLoop(dispatchConfigFromEnv({ url, tokenFile: o.token }), { once });
        if (r) out(r, `auto-start ${r.enabled ? "on" : "off"}${r.busy ? ` · ${r.busy}` : ""} · started ${r.started.length} · failed ${r.failed.length} · skipped ${r.skipped.length}`);
      }),
    );
}

const lease = program.command("lease").description("(agent) hold the project while you work; the editor goes read-only");
lease
  .command("take <project>")
  .description("take or renew")
  .option("--seconds <n>", "duration (default 900)")
  .action(
    act(async (project: string, o: { seconds?: string }) => {
      const r = await client().request("POST", `/v1/projects/${project}/lease`, o.seconds ? { seconds: Number(o.seconds) } : {});
      out(r, `lease held by ${r.holder} until ${r.expiresAt}`);
    }),
  );
lease
  .command("release <project>")
  .action(
    act(async (project: string) => {
      const r = await client().request("DELETE", `/v1/projects/${project}/lease`);
      out(r, r.released ? "released" : "no lease");
    }),
  );

// ---------------------------------------------------------------- assets

const asset = program.command("asset").description("images and SVG art (content-addressed)");
asset
  .command("add <file>")
  .description("upload PNG / JPEG / WebP / SVG; prints the sha256 ref to use in nodes")
  .action(
    act(async (file: string) => {
      const r = await client().request("POST", "/v1/assets", new Uint8Array(readFileSync(file)), { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(basename(file)) });
      out(r, `${r.ref}  ${r.mime}  ${r.bytes} bytes${r.sanitized.length ? `\n  sanitized: ${r.sanitized.join(", ")}` : ""}`);
    }),
  );
asset
  .command("get <ref>")
  .requiredOption("--out <file>")
  .action(
    act(async (ref: string, o: { out: string }) => {
      const bytes = await client().request<Uint8Array>("GET", `/v1/assets/${ref}`);
      writeFileSync(o.out, bytes);
      out({ ref, out: o.out, bytes: bytes.length }, `wrote ${o.out}`);
    }),
  );

// ---------------------------------------------------------------- admin (local data dir)

const local = async () => import("@post-studio/server");
const dataDirOpt = (c: Command) => c.option("--data-dir <dir>", "data dir (default $POST_STUDIO_DATA or ~/.local/share/post-studio)");

dataDirOpt(program.command("serve").description("start the API and the editor on 127.0.0.1:3472"))
  .option("--port <n>", "port", process.env.POST_STUDIO_PORT ?? "3472")
  .option("--no-build", "do not (re)build the editor when its sources are newer than apps/editor/dist")
  .action(
    act(async (o: { dataDir?: string; port: string; build: boolean }) => {
      // Refuse before opening any data dir when a Post Studio already answers on that port
      // (on the server: the deployed container, Phase 6).
      const running = await fetch(`http://127.0.0.1:${o.port}/v1/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
      if (running) throw new ApiError(0, "port-in-use", `a Post Studio server already answers on 127.0.0.1:${o.port}. On a server that runs deploy/compose.yaml, that is the deployed container (docker compose -f deploy/compose.yaml ps): use it instead of serve (the CLI talks to it by default), or pass --port <other> --data-dir <scratch dir> for a scratch server.`);
      if (o.build) await ensureEditorBuilt();
      const { serve } = await local();
      let s: Awaited<ReturnType<typeof serve>>;
      try {
        s = await serve({ dataDir: o.dataDir, port: Number(o.port) });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
        // Since Phase 6 the deployed container owns 127.0.0.1:3472 on the server.
        throw new ApiError(0, "port-in-use", `port ${o.port} is taken. On a server that runs deploy/compose.yaml, that is the deployed Post Studio container (docker compose -f deploy/compose.yaml ps); use it instead of serve, or pass --port <other> --data-dir <scratch dir> for a scratch server. Never point a second server at the live data dir.`);
      }
      const auth = s.store.auth.hasPassword() ? "" : "\n  no editor password yet: run `pstudio admin set-password`";
      process.stderr.write(`post-studio listening on http://${s.host}:${s.port} (data: ${s.dataDir})\n  editor: http://${s.host}:${s.port}/${auth}\n`);
    }),
  );

/** Build apps/editor/dist when any editor or package source is newer than it. */
async function ensureEditorBuilt(): Promise<void> {
  const { ensureEditorBuilt: build } = await import("../../editor/build-if-stale.ts");
  build();
}

const admin = program.command("admin").description("(admin, local) the editor's login");
dataDirOpt(admin.command("set-password").description("set the editor password (signs out every session)"))
  .option("--password-file <file>", "read the password from the first line of a file")
  .option("--stdin", "read the password from stdin")
  .option("--generate [file]", "generate a random password and write it to a 0600 file (default ~/.config/post-studio/admin-password); it is not printed")
  .option("--force", "with --generate: replace an existing password file")
  .action(
    act(async (o: { dataDir?: string; passwordFile?: string; stdin?: boolean; generate?: string | boolean; force?: boolean }) => {
      let password: string;
      let savedTo: string | undefined;
      if (o.generate) {
        const { randomBytes } = await import("node:crypto");
        const { homedir } = await import("node:os");
        password = randomBytes(15).toString("base64url");
        savedTo = typeof o.generate === "string" ? o.generate : join(homedir(), ".config/post-studio/admin-password");
        if (existsSync(savedTo) && !o.force) throw new ApiError(0, "exists", `${savedTo} already exists; pass --force to replace it (this changes the editor password)`);
        mkdirSync(dirname(savedTo), { recursive: true, mode: 0o700 });
        writeFileSync(savedTo, password + "\n", { mode: 0o600 });
        chmodSync(savedTo, 0o600);
      } else if (o.passwordFile) password = readFileSync(o.passwordFile, "utf8").split(/\r?\n/)[0];
      else if (o.stdin) password = readFileSync(0, "utf8").split(/\r?\n/)[0];
      else if (process.stdin.isTTY) {
        password = await promptHidden("new editor password: ");
        const again = await promptHidden("again: ");
        if (again !== password) throw new ApiError(0, "mismatch", "the two passwords differ");
      } else throw new ApiError(0, "bad-input", "pass --password-file, --stdin or --generate (no terminal to prompt on)");
      const { Store, defaultDataDir } = await local();
      const store = await Store.open(o.dataDir ?? defaultDataDir());
      try {
        store.auth.setPassword(password);
        out({ ok: true, username: store.auth.username(), ...(savedTo ? { savedTo } : {}) }, savedTo ? `editor password set; saved (0600) to ${savedTo}` : "editor password set; all sessions signed out");
      } finally {
        store.close();
      }
    }),
  );
dataDirOpt(admin.command("logout-all").description("end every editor session")).action(
  act(async (o: { dataDir?: string }) => {
    const { Store, defaultDataDir } = await local();
    const store = await Store.open(o.dataDir ?? defaultDataDir());
    try {
      const n = store.auth.logoutAll();
      out({ ended: n }, `ended ${n} session${n === 1 ? "" : "s"}`);
    } finally {
      store.close();
    }
  }),
);
dataDirOpt(admin.command("status").description("is a password set, how many sessions")).action(
  act(async (o: { dataDir?: string }) => {
    const { Store, defaultDataDir } = await local();
    const store = await Store.open(o.dataDir ?? defaultDataDir());
    try {
      const r = { passwordSet: store.auth.hasPassword(), username: store.auth.username() ?? null, sessions: store.auth.sessionCount() };
      out(r, `password ${r.passwordSet ? "set" : "NOT set"} · ${r.sessions} active session${r.sessions === 1 ? "" : "s"}`);
    } finally {
      store.close();
    }
  }),
);

function promptHidden(question: string): Promise<string> {
  return new Promise((resolveP, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          return resolveP(value);
        }
        if (c === "\u0003") {
          stdin.setRawMode?.(false);
          return reject(new ApiError(0, "cancelled", "cancelled"));
        }
        if (c === "\u007f") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

const token = program.command("token").description("(admin, local) API tokens for agents and the human");
dataDirOpt(token.command("create <name>").description("create a token; printed once"))
  .option("--human", "token acts as Nikola (author 'human') instead of an agent")
  .option("--save [file]", `also write it to a 0600 file (default ${DEFAULT_TOKEN_FILE})`)
  .action(
    act(async (name: string, o: { dataDir?: string; human?: boolean; save?: string | boolean }) => {
      const { Store, defaultDataDir } = await local();
      const store = await Store.open(o.dataDir ?? defaultDataDir());
      try {
        const t = store.createToken(name, o.human ? "human" : "agent");
        let saved: string | undefined;
        if (o.save) {
          saved = typeof o.save === "string" ? o.save : DEFAULT_TOKEN_FILE;
          mkdirSync(dirname(saved), { recursive: true, mode: 0o700 });
          writeFileSync(saved, t.token + "\n", { mode: 0o600 });
          chmodSync(saved, 0o600);
        }
        const shown = saved ? { ...t, token: undefined, saved } : t;
        out(shown, saved ? `token '${name}' (${t.kind}) saved to ${saved}` : `token '${name}' (${t.kind}): ${t.token}\nShown once. Keep it off Telegram.`);
      } finally {
        store.close();
      }
    }),
  );
dataDirOpt(token.command("list")).action(
  act(async (o: { dataDir?: string }) => {
    const { Store, defaultDataDir } = await local();
    const store = await Store.open(o.dataDir ?? defaultDataDir());
    try {
      const rows = store.listTokens() as any[];
      out({ tokens: rows }, () => rows.map((r) => `${r.name.padEnd(20)} ${r.kind.padEnd(6)} ${r.prefix}…  ${r.revoked_at ? "REVOKED" : `last used ${r.last_used_at ?? "never"}`}`).join("\n") || "no tokens");
    } finally {
      store.close();
    }
  }),
);
dataDirOpt(token.command("revoke <name>")).action(
  act(async (name: string, o: { dataDir?: string }) => {
    const { Store, defaultDataDir } = await local();
    const store = await Store.open(o.dataDir ?? defaultDataDir());
    try {
      const ok = store.revokeToken(name);
      out({ revoked: ok }, ok ? `revoked ${name}` : `no active token '${name}'`);
    } finally {
      store.close();
    }
  }),
);

const backupCmd = dataDirOpt(program.command("backup").description("(admin, local) SQLite snapshot + assets → dated tarball"))
  .option("--out <dir>", "backup folder (default <data-dir>/backups)")
  .option("--keep <n>", "keep the newest N", "14")
  .action(
    act(async (o: { dataDir?: string; out?: string; keep: string }) => {
      const { backup, defaultDataDir } = await local();
      const r = backup(o.dataDir ?? defaultDataDir(), o.out, Number(o.keep));
      out(r, `${r.file} (${r.bytes} bytes, ${r.manifest.projects.length} projects, ${r.manifest.assets} assets)${r.pruned.length ? `\npruned ${r.pruned.length}` : ""}`);
    }),
  );
dataDirOpt(backupCmd.command("list"))
  .option("--out <dir>", "backup folder")
  .action(
    act(async (o: { dataDir?: string; out?: string }) => {
      const { listBackups, defaultDataDir } = await local();
      const r = listBackups(o.out ?? `${o.dataDir ?? defaultDataDir()}/backups`);
      out({ backups: r }, r.map((b) => `${b.file}  ${b.bytes} bytes`).join("\n") || "no backups");
    }),
  );

dataDirOpt(program.command("restore-backup <tarball>").description("(admin, local) restore a backup into a data dir after verifying it"))
  .option("--force", "move a non-empty data dir aside and replace it")
  .action(
    act(async (tarball: string, o: { dataDir?: string; force?: boolean }) => {
      const { restore, defaultDataDir } = await local();
      const r = restore(tarball, o.dataDir ?? defaultDataDir(), { force: o.force });
      out(r, `restored into ${r.target}: ${r.verified.projects} projects, ${r.verified.assets} assets, integrity ${r.verified.integrity}${r.movedAside ? `\nprevious data moved to ${r.movedAside}` : ""}`);
    }),
  );

await program.parseAsync(process.argv);
