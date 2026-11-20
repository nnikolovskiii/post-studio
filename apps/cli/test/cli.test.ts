// End to end: a real server process on a free port, driven only through the pstudio CLI.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findFfmpeg } from "@post-studio/render";

// Real processes (tsx start-up ≈ 1.5 s per call); under `pnpm check` they share the CPU with every other test file.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = join(root, "apps/cli/bin/pstudio");
const fixture = join(root, "fixtures/lux-6-square.hand.json");
const logo = join(root, "fixtures/assets/logo-on-paper.png");

let dir: string;
let data: string;
let url: string;
let server: ChildProcess;
const agentToken = () => join(dir, "agent.token");
const humanToken = () => join(dir, "human.token");

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => res(p));
    });
  });
}

/** Runs the CLI without blocking the test worker (a blocked worker misses vitest's RPC deadline). */
function ps(args: string[], tokenFile = agentToken(), input?: string): Promise<{ code: number | null; json: any; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["--json", "--url", url, "--token-file", tokenFile, ...args], { env: { ...process.env, PSTUDIO_TOKEN: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      resolve({ code, json, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pstudio-cli-"));
  data = join(dir, "data");
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  expect((await ps(["token", "create", "claude", "--data-dir", data, "--save", agentToken()])).json.saved).toBe(agentToken());
  expect((await ps(["token", "create", "nikola", "--human", "--data-dir", data, "--save", humanToken()])).json.kind).toBe("human");
  server = spawn(bin, ["serve", "--no-build", "--data-dir", data, "--port", String(port)], { stdio: "ignore" });
  // 30 s: under the full suite (editor e2e in parallel) tsx start-up can take longer than 10 s.
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${url}/v1/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}, 180_000);

afterAll(() => {
  server?.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
});

describe("pstudio end to end", () => {
  let project: string;

  it("refuses requests without a valid token", async () => {
    const r = (await ps(["list"], join(dir, "missing.token")));
    expect(r.code).toBe(1);
    expect(r.json.error.status).toBe(401);
  });

  it("uploads the logo and creates the LUX project from the hand-written JSON", async () => {
    const a = (await ps(["asset", "add", logo]));
    expect(a.json.ref).toMatch(/^sha256:13f0981f/);
    const c = (await ps(["create", "--from", fixture, "--title", "LUX-6 (CLI test)"]));
    expect(c.code).toBe(0);
    project = c.json.project;
    expect(c.json.editorUrl).toContain(`/p/${project}`);
    expect((await ps(["list"])).json.projects[0]).toMatchObject({ id: project, title: "LUX-6 (CLI test)", head_rev: 0, turn: "human" });
  });

  it("prints an outline and the full document", async () => {
    const o = spawnSync(bin, ["--url", url, "--token-file", agentToken(), "outline", project], { encoding: "utf8", env: { ...process.env, PSTUDIO_TOKEN: "" } });
    expect(o.stdout).toMatch(/headline text @135,100 810×112/);
    const g = (await ps(["get", project]));
    expect(g.json.doc.frames[0].id).toBe("square");
  });

  it("runs a human tweak → hand-off → agent turn → hand back loop", async () => {
    const opsFile = join(dir, "human.json");
    writeFileSync(opsFile, JSON.stringify([{ op: "set", node: "headline", path: "y", value: 76 }]));
    expect((await ps(["apply", project, "--base", "0", "--ops", opsFile, "-m", "moved headline up"], humanToken())).json.rev).toBe(1);
    expect((await ps(["handoff", "give", project, "--note", "shorter headline, keep my layout"], humanToken())).json.checkpoint).toBe("handoff-1");

    const show = (await ps(["handoff", "show", project]));
    expect(show.json).toMatchObject({ turn: "agent", handoff: { note: "shorter headline, keep my layout" } });
    expect((await ps(["lease", "take", project])).json.holder).toBe("agent:claude");
    const diff = (await ps(["diff", project, "--since", "created"]));
    expect(diff.json.text).toContain("headline: moved 0,-24   (human, rev 1)");
    expect((await ps(["pins", project])).json.effective).toEqual([{ node: "headline", path: "y", source: "soft", rev: 1 }]);

    // Pinned → exit 4; stale base on the same property → exit 3 (conflict) would need two writers, see below.
    const undo = (await ps(["apply", project, "--base", "1", "--ops", "-", "-m", "recenter"], agentToken(), JSON.stringify([{ op: "set", node: "headline", path: "y", value: 100 }])));
    expect(undo.code).toBe(4);
    expect(undo.json.error.code).toBe("pinned");

    const words = (await ps(["apply", project, "--base", "1", "--ops", "-", "-m", "shorter headline per note"], agentToken(), JSON.stringify([{ op: "set", node: "headline", path: "spans", value: [{ text: "Исти модели,\nразлични оценки." }] }])));
    expect(words.code).toBe(0);
    expect(words.json.rev).toBe(2);
    const override = (await ps(["apply", project, "--base", "2", "--ops", "-", "-m", "nudge", "--override-pin", "headline.y=he asked to recenter"], agentToken(), JSON.stringify([{ op: "set", node: "headline", path: "y", value: 90 }])));
    expect(override.json.overridden).toEqual([{ key: "headline.y", reason: "he asked to recenter" }]);
    expect((await ps(["handoff", "back", project, "--summary", "Shorter headline; kept his position"])).json).toMatchObject({ checkpoint: "agent-1", turn: "human" });
    expect((await ps(["diff", project])).json.text).toBe("no changes");
    const hist = (await ps(["history", project])).json.revisions.map((r: any) => r.author);
    expect(hist).toEqual(["agent:claude", "human", "agent:claude", "agent:claude"]);
  });

  it("returns exit 3 with conflict details for a stale base", async () => {
    const a = (await ps(["apply", project, "--base", "3", "--ops", "-", "-m", "a"], humanToken(), JSON.stringify([{ op: "set", node: "sub", path: "x", value: 140 }])));
    expect(a.code).toBe(0);
    const b = (await ps(["apply", project, "--base", "3", "--ops", "-", "-m", "b"], humanToken(), JSON.stringify([{ op: "set", node: "sub", path: "x", value: 150 }])));
    expect(b.code).toBe(3);
    expect(b.json.error.details.conflicts).toEqual([{ node: "sub", path: "x", theirs: "x", rev: 4 }]);
  });

  it("Phase 4: exit 6 out of turn, revert (exit 3 on a later change), approve (human only), rev references", async () => {
    // Head is rev 4 (human); he changes sub.x again (rev 5). His turn, his changes: the agent waits.
    expect((await ps(["apply", project, "--base", "4", "--ops", "-", "-m", "c"], humanToken(), JSON.stringify([{ op: "set", node: "sub", path: "x", value: 150 }]))).json.rev).toBe(5);
    const out = await ps(["apply", project, "--base", "5", "--ops", "-", "-m", "x"], agentToken(), JSON.stringify([{ op: "set", node: "kicker", path: "x", value: 680 }]));
    expect(out.code).toBe(6);
    expect(out.json.error.code).toBe("not-your-turn");
    expect((await ps(["lease", "take", project])).code).toBe(6);
    // Revert rev 4 (sub.x 140): rev 5 changed the same property → exit 3 and a readable message.
    const c = await ps(["revert", project, "--rev", "4"], humanToken());
    expect(c.code).toBe(3);
    expect(c.json.error.message).toMatch(/^rev 4 can't be reverted on its own: later changes touch the same things: sub\.x \(rev 5\)/);
    const r = await ps(["revert", project, "--rev", "5"], humanToken());
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ rev: 6, base: 5 });
    expect((await ps(["history", project])).json.revisions.at(-1)).toMatchObject({ kind: "revert", reverts: 5 });
    // Approve: the agent can't (exit 1, 403); Nikola can; export by reference.
    const no = await ps(["approve", project]);
    expect(no.code).toBe(1);
    expect(no.json.error.status).toBe(403);
    expect((await ps(["approve", project, "--note", "ship it"], humanToken())).json).toMatchObject({ checkpoint: "approved", rev: 6 });
    expect((await ps(["handoff", "show", project])).json.approved).toMatchObject({ name: "approved", rev: 6, current: true });
    const ex = await ps(["export", project, "--rev", "last-approved", "--frame", "square", "--to", join(dir, "approved-export")]);
    expect(ex.json.rev).toBe(6);
    expect(existsSync(join(dir, "approved-export", "post.png"))).toBe(true);
    // Take back a hand-off nobody started.
    await ps(["handoff", "give", project, "--note", "never mind"], humanToken());
    expect((await ps(["handoff", "take-back", project], humanToken())).json).toMatchObject({ turn: "human", changed: true });
  });

  it("backs up and restores into a fresh data dir with identical documents", async () => {
    const before = (await ps(["get", project])).json.doc;
    const b = (await ps(["backup", "--data-dir", data, "--keep", "3"]));
    expect(b.code).toBe(0);
    expect(existsSync(b.json.file)).toBe(true);
    expect(b.json.manifest.projects).toHaveLength(1);
    const target = join(dir, "restored");
    const r = (await ps(["restore-backup", b.json.file, "--data-dir", target]));
    expect(r.json.verified).toEqual({ integrity: "ok", projects: 1, assets: 1 });
    // Refuses to overwrite without --force.
    expect((await ps(["restore-backup", b.json.file, "--data-dir", target])).code).toBe(1);
    const sqlite = spawnSync("node", ["-e", `const D=require(${JSON.stringify(join(root, "apps/server/node_modules/better-sqlite3"))});const d=new D(${JSON.stringify(join(target, "post-studio.db"))},{readonly:true});process.stdout.write(d.prepare("select doc_json from projects").get().doc_json)`], { encoding: "utf8" });
    expect(JSON.parse(sqlite.stdout)).toEqual(before);
    expect(readFileSync(join(target, "assets", "13", "13f0981fa53b024f13cb69ba583de91d3d4db82ed7d393a4480ddb1c7f065843")).equals(readFileSync(logo))).toBe(true);
  });
});

describe("pstudio import / render / export", () => {
  const post = join(root, "fixtures/social-posts/lux-1-leaderboard");
  let project: string;

  it("dry-runs an import without touching the server, then imports for real", async () => {
    const before = (await ps(["list"])).json.projects.length;
    const scene = join(dir, "lux1.json");
    const dry = (await ps(["import", "social-posts", post, "--dry-run", "--out", scene]));
    expect(dry.code).toBe(0);
    expect(dry.json).toMatchObject({ dryRun: true, report: { mode: "template" } });
    expect(JSON.parse(readFileSync(scene, "utf8")).frames.map((f: any) => f.id)).toEqual(["square", "li"]);
    expect((await ps(["list"])).json.projects.length).toBe(before);

    const r = (await ps(["import", "social-posts", post]));
    expect(r.code).toBe(0);
    project = r.json.project;
    expect(r.json.report.frames[0].roles.headline).toEqual(["headline"]);
    expect(r.json.editorUrl).toContain(project);
    expect((await ps(["get", project])).json.doc.meta.source).toBe("social-posts/posts/lux-1-leaderboard");
  });

  it("explains why an import mode can't be used (exit 1, reasons in details)", async () => {
    const r = (await ps(["import", "social-posts", join(root, "fixtures/social-posts/daily-2026-10-26-tochna-cena"), "--mode", "template", "--dry-run"]));
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("import-failed");
    expect(r.json.error.details.reasons.join(" ")).toMatch(/filter/);
  });

  it("renders a frame to PNG (format from the extension) and to SVG", async () => {
    const png = join(dir, "li.png");
    const r = (await ps(["render", project, "--frame", "li", "--out", png]));
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ format: "png", frame: "li", rev: 0, warnings: [] });
    expect(readFileSync(png).subarray(1, 4).toString()).toBe("PNG");
    expect(readFileSync(png).readUInt32BE(20)).toBe(1350);
    const svg = join(dir, "sq.svg");
    expect((await ps(["render", project, "--out", svg])).json.format).toBe("svg");
    expect(readFileSync(svg, "utf8")).toContain("Only 4 of 44 models clear");
    expect((await ps(["render", project, "--frame", "nope", "--out", png])).json.error.status).toBe(404);
  });

  it("exports the social-posts file set, and refuses a real social-posts/posts/ folder", async () => {
    const to = join(dir, "export");
    const r = (await ps(["export", project, "--to", to]));
    expect(r.code).toBe(0);
    for (const f of ["post.svg", "post.png", "post.jpg", "post-li.svg", "post-li.png", "post-li.jpg", "figma/post.figma-ready.svg", "figma/post-li.outlined.svg", "post-studio.json", "export.json"]) expect(existsSync(join(to, f))).toBe(true);
    expect(JSON.parse(readFileSync(join(to, "export.json"), "utf8")).project).toBe(project);
    const refused = (await ps(["export", project, "--to", join(dir, "social-posts", "posts", "x")]));
    expect(refused.code).toBe(1);
    expect(refused.json.error.message).toMatch(/--social-posts/);
  });

  // Motion Part 2: the agent-side motion commands on the imported two-frame LUX-1 post.
  it("anim preset writes ops only (never applies); apply turns the post into a 1 s motion project", async () => {
    const ops = join(dir, "anim.json");
    const head = (await ps(["get", project])).json.head;
    const r = await ps(["anim", "preset", project, "--node", "headline", "--preset", "fade-up", "--at", "0.1", "--dur", "0.5", "--out", ops]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ project, base: head, addsMotion: true, ops: 5 });
    expect((await ps(["get", project])).json.head).toBe(head); // nothing applied
    expect(JSON.parse(readFileSync(ops, "utf8"))).toContainEqual({ op: "set", node: "headline", path: "anim.tracks.dy.in1", value: { t: 100, v: 40, ease: "out" } });
    expect((await ps(["apply", project, "--base", String(head), "--ops", ops, "-m", "headline fade-up"])).code).toBe(0);
    writeFileSync(join(dir, "short.json"), JSON.stringify([{ op: "set", node: "$doc", path: "motion.duration", value: 1000 }]));
    expect((await ps(["apply", project, "--base", String(head + 1), "--ops", join(dir, "short.json"), "-m", "1 s"])).code).toBe(0);

    const bad = await ps(["anim", "preset", project, "--node", "headline", "--preset", "wobble", "--out", ops]);
    expect([bad.code, bad.json.error.code]).toEqual([1, "bad-preset"]);
    const badAt = await ps(["anim", "preset", project, "--node", "headline", "--preset", "typewriter", "--at", "x", "--out", ops]);
    expect(badAt.json.error.message).toMatch(/--at is a time in seconds/);
    expect((await ps(["anim", "presets"])).json.presets.map((x: any) => x.id)).toContain("grow-left");
  });

  it("timeline, render --at, render --contact", async () => {
    const tl = await ps(["timeline", project]);
    expect(tl.code).toBe(0);
    expect(tl.json.text).toMatch(/^motion: 1\.0 s @ 30 fps, loop, poster rest · 30 frames · 1 animated layer/);
    expect(tl.json.text).toMatch(/headline\s+[█·]+\s+0\.10–0\.60 s/);
    const at = join(dir, "at.png");
    const r = await ps(["render", project, "--at", "0.1", "--out", at]);
    expect(r.json).toMatchObject({ time: 100, frame: "square" });
    const rest = await ps(["render", project, "--out", join(dir, "rest.png")]);
    expect(rest.json.time).toBe("rest");
    expect(readFileSync(at).equals(readFileSync(join(dir, "rest.png")))).toBe(false);
    const c = await ps(["render", project, "--contact", "--moments", "4", "--out", join(dir, "contact.png")]);
    expect(c.json).toMatchObject({ contact: true, times: [0, 333, 633, 967] });
    expect((await ps(["render", project, "--contact", "--at", "1", "--out", at])).code).toBe(1);
  });

  it("handoff give --at stores the moment; handoff show returns it (Motion Part 4)", async () => {
    const g = await ps(["handoff", "give", project, "--note", "punchier here", "--at", "0.5"], humanToken());
    expect(g.code).toBe(0);
    expect(g.json).toMatchObject({ at: 500 });
    const show = await ps(["handoff", "show", project]);
    expect(show.json.handoff).toMatchObject({ note: "punchier here", at: 500, atText: "0.50 s" });
    const late = await ps(["handoff", "give", project, "--note", "x", "--at", "9"], humanToken());
    expect([late.code, late.json.error.code]).toEqual([1, "bad-at"]);
    const bad = await ps(["handoff", "give", project, "--note", "x", "--at", "soon"], humanToken());
    expect(bad.json.error.message).toMatch(/--at is a time in seconds/);
  });

  it.skipIf(!findFfmpeg())("video and export write MP4s (one per frame), listed in export.json", async () => {
    const out = join(dir, "v.mp4");
    const v = await ps(["video", project, "--frame", "li", "--out", out]);
    expect(v.code).toBe(0);
    expect(v.json).toMatchObject({ frame: "li", frames: 30, fps: 30, width: 1080, height: 1350, durationMs: 1000, cached: false });
    expect(readFileSync(out).subarray(4, 8).toString()).toBe("ftyp");
    expect((await ps(["video", project, "--frame", "li", "--out", out])).json.cached).toBe(true);

    const to = join(dir, "export-motion");
    const e = await ps(["export", project, "--to", to]);
    expect(e.code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(to, "export.json"), "utf8"));
    expect(manifest.motion).toMatchObject({ duration: 1000, fps: 30, frames: 30 });
    for (const f of ["post.mp4", "post-li.mp4"]) {
      const entry = manifest.files.find((x: any) => x.path === f);
      expect(entry.bytes).toBe(statSync(join(to, f)).size);
    }
    expect(readFileSync(join(to, "post-li.mp4")).equals(readFileSync(out))).toBe(true);
    const still = await ps(["export", project, "--to", join(dir, "export-still"), "--no-video"]);
    expect(still.json.notes).toContain("motion project: videos skipped (--no-video)");
    expect(existsSync(join(dir, "export-still", "post.mp4"))).toBe(false);
  });
});

describe("pstudio admin (editor login)", () => {
  it("generates a password into a 0600 file without printing it, refuses to overwrite, and reports status", async () => {
    const adminData = join(dir, "admin-data");
    const file = join(dir, "secrets", "admin-password");
    expect((await ps(["admin", "status", "--data-dir", adminData])).json).toEqual({ passwordSet: false, username: null, sessions: 0 });
    const r = await ps(["admin", "set-password", "--generate", file, "--data-dir", adminData]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ ok: true, username: "nikola", savedTo: file });
    const password = readFileSync(file, "utf8").trim();
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.stdout + r.stderr).not.toContain(password);
    const again = await ps(["admin", "set-password", "--generate", file, "--data-dir", adminData]);
    expect(again.code).toBe(1);
    expect(again.json.error.message).toMatch(/already exists/);
    expect(readFileSync(file, "utf8").trim()).toBe(password);
    expect((await ps(["admin", "status", "--data-dir", adminData])).json).toMatchObject({ passwordSet: true, username: "nikola" });
    const viaStdin = await ps(["admin", "set-password", "--stdin", "--data-dir", adminData], agentToken(), "short\n");
    expect(viaStdin.code).toBe(1);
    expect(viaStdin.json.error.message).toMatch(/at least 10/);
    expect((await ps(["admin", "logout-all", "--data-dir", adminData])).json).toEqual({ ended: 0 });
  });
});

// Multi-select editing for agents: `pstudio ops set` writes one property on many layers as an ops
// file (never applies); one apply = one revision, exactly like the editor's shared-property edit.
describe("pstudio ops set (one property on many layers)", () => {
  let p: string;
  it("same fill, by type, by ids → ops file; one apply = one revision", async () => {
    await ps(["asset", "add", logo]); // the fixture's logo (already there when the whole file runs)
    p = (await ps(["create", "--from", fixture, "--title", "multi-edit"])).json.project;
    const f = join(dir, "multi.json");
    // The two ellipses share #305880: --same-fill-as picks both (and nothing else).
    const r = await ps(["ops", "set", p, "--same-fill-as", "row-1-b", "--field", "fill", "--value", "#AC1922", "--out", f]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ base: 0, ops: 2, layers: ["row-1-b", "row-2-b"] });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual([
      { op: "set", node: "row-1-b", path: "fill", value: "#AC1922" },
      { op: "set", node: "row-2-b", path: "fill", value: "#AC1922" },
    ]);
    expect((await ps(["get", p])).json.head).toBe(0); // nothing applied yet
    expect((await ps(["apply", p, "--base", "0", "--ops", f, "-m", "accent dots"])).json.rev).toBe(1);

    // fill on texts is their colour (style.fill); --type text --frame square = every text in the frame.
    const t = await ps(["ops", "set", p, "--type", "text", "--frame", "square", "--field", "size", "--value", "30", "--out", f]);
    expect(t.json.matched).toBeGreaterThanOrEqual(8);
    const ops = JSON.parse(readFileSync(f, "utf8"));
    expect(ops.every((o: any) => o.path === "style.size" && o.value === 30)).toBe(true);
    const c = await ps(["ops", "set", p, "--node", "row-1-label", "row-1-a", "--field", "fill", "--value", '{"token":"lux.ink"}', "--out", join(dir, "c.json")]);
    expect(JSON.parse(readFileSync(join(dir, "c.json"), "utf8"))).toEqual([
      { op: "set", node: "row-1-label", path: "style.fill", value: { token: "lux.ink" } },
      { op: "set", node: "row-1-a", path: "fill", value: { token: "lux.ink" } },
    ]);
    expect(c.code).toBe(0);
    expect((await ps(["apply", p, "--base", "1", "--ops", f, "-m", "all text 30"])).json.rev).toBe(2);
    const h = await ps(["history", p]);
    expect(h.json.revisions.filter((x: any) => x.rev > 0).length).toBe(2);
  });

  it("raw --path, --unset, and refusals", async () => {
    const f = join(dir, "raw.json");
    const r = await ps(["ops", "set", p, "--node", "row-1-a", "row-2-a", "--path", "sketch.roughness", "--value", "2", "--out", f]);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual([
      { op: "set", node: "row-1-a", path: "sketch.roughness", value: 2 },
      { op: "set", node: "row-2-a", path: "sketch.roughness", value: 2 },
    ]);
    expect(r.code).toBe(0);
    const none = await ps(["ops", "set", p, "--node", "row-1-a", "--field", "opacity", "--unset", "--out", f]);
    expect([none.code, none.json.ops]).toEqual([0, 0]);
    const bad = async (args: string[], msg: RegExp) => {
      const x = await ps(["ops", "set", p, ...args, "--out", f]);
      expect(x.code).toBe(1);
      expect(x.json.error.message).toMatch(msg);
    };
    await bad(["--node", "row-1-a", "--field", "colour", "--value", "1"], /--field must be one of/);
    await bad(["--node", "nope", "--field", "fill", "--value", "#000000"], /no layer nope/);
    await bad(["--field", "fill", "--value", "#000000"], /--node, --type or --same-fill-as/);
    await bad(["--node", "row-1-a", "--field", "fill"], /--value or --unset/);
    await bad(["--type", "circle", "--field", "fill", "--value", "#000000"], /--type circle/);
  });
});
