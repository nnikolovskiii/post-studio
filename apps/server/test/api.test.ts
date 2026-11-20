import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGO, createLux, loadFixture, setup } from "./helpers.ts";

let ctx: Awaited<ReturnType<typeof setup>>;
let t = Date.parse("2026-10-30T12:00:00Z");
beforeEach(async () => {
  t = Date.parse("2026-10-30T12:00:00Z");
  ctx = await setup(() => t);
});
afterEach(async () => ctx.cleanup());

const ops = (project: string, who: "claude" | "grok" | "nikola", base: number, list: unknown[], extra: Record<string, unknown> = {}) =>
  ctx.call(who, "POST", `/v1/projects/${project}/ops`, { base, ops: list, message: "test edit", ...extra });

describe("access", () => {
  it("serves health and the JSON Schema without a token, everything else needs one", async () => {
    expect((await ctx.call(null, "GET", "/v1/health")).json.ok).toBe(true);
    const schema = await ctx.call(null, "GET", "/v1/schema");
    expect(schema.status).toBe(200);
    expect(schema.json.title).toBe("post-studio/2");
    expect((await ctx.call(null, "GET", "/v1/projects")).status).toBe(401);
    expect((await ctx.call("claude", "GET", "/v1/whoami")).json).toEqual({ name: "claude", kind: "agent", author: "agent:claude" });
    expect((await ctx.call("nikola", "GET", "/v1/whoami")).json.author).toBe("human");
  });

  it("rejects revoked tokens and stores only hashes", async () => {
    ctx.store.revokeToken("grok");
    expect((await ctx.call("grok", "GET", "/v1/projects")).status).toBe(401);
    const rows = ctx.store.db.prepare("SELECT token_hash FROM api_tokens").all() as Array<{ token_hash: string }>;
    for (const r of rows) expect(Object.values(ctx.tokens)).not.toContain(r.token_hash);
  });

  it("lists registered fonts with their Macedonian check", async () => {
    const f = (await ctx.call("claude", "GET", "/v1/fonts")).json.fonts;
    expect(f.length).toBe(12);
    expect(f.every((x: any) => x.macedonian === "all 62 letters")).toBe(true);
  });
});

describe("create and read", () => {
  it("refuses a document whose image asset was never uploaded", async () => {
    const r = await ctx.call("claude", "POST", "/v1/projects", loadFixture());
    expect(r.status).toBe(422);
    expect(r.json.error.details.errors[0]).toMatchObject({ node: "logo", code: "asset" });
  });

  it("creates the hand-written LUX project and reads it back", async () => {
    const id = await createLux(ctx);
    expect(id).toMatch(/^prj_[0-9a-z]{12}$/);
    const p = (await ctx.call("nikola", "GET", `/v1/projects/${id}`)).json;
    expect(p).toMatchObject({ rev: 0, head: 0, turn: "human", lease: null, editorUrl: `http://127.0.0.1:3472/p/${id}` });
    expect(p.doc.id).toBe(id);
    expect(p.doc.frames[0].children).toHaveLength(11);
    const outline = (await ctx.call("claude", "GET", `/v1/projects/${id}/outline?format=text`)).body;
    expect(outline).toMatch(/\n {4}headline text @135,100/); // role equals id, shown once
    expect(outline).toMatch(/frame square "Square" 1080×1080/);
    const cps = (await ctx.call("claude", "GET", `/v1/projects/${id}/checkpoints`)).json.checkpoints;
    expect(cps.map((c: any) => c.name)).toEqual(["created"]);
  });

  it("rejects unknown fonts and weights at create time", async () => {
    await ctx.call("claude", "POST", "/v1/assets", LOGO(), { "content-type": "application/octet-stream" });
    const doc = loadFixture();
    doc.frames[0].children.find((n: any) => n.id === "headline").style.weight = 800;
    const r = await ctx.call("claude", "POST", "/v1/projects", doc);
    expect(r.status).toBe(422);
    expect(r.json.error.details.errors[0].message).toBe("'IBM Plex Sans' has no weight 800 (available: 400–600)");
  });
});

describe("ops, revisions and conflicts", () => {
  it("applies a batch, reports text overflow, and bumps the revision", async () => {
    const id = await createLux(ctx);
    const r = await ops(id, "claude", 0, [
      { op: "set", node: "headline", path: "spans", value: [{ text: "Исти модели. Различни оценки од двајца оценувачи. И уште многу зборови." }] },
      { op: "set", node: "headline", path: "box", value: "fixed" },
    ]);
    expect(r.status).toBe(200);
    expect(r.json.rev).toBe(1);
    expect(r.json.text.headline.lines).toBeGreaterThan(2);
    expect(r.json.warnings.some((w: any) => w.node === "headline" && w.code === "overflow")).toBe(true);
  });

  it("is all-or-nothing and explains bad ops", async () => {
    const id = await createLux(ctx);
    const r = await ops(id, "claude", 0, [{ op: "set", node: "headline", path: "x", value: 1 }, { op: "delete", node: "nope" }]);
    expect(r.status).toBe(422);
    expect(r.json.error).toMatchObject({ code: "invalid-ops", message: "op 1: node 'nope' not found" });
    expect((await ctx.call("claude", "GET", `/v1/projects/${id}`)).json.head).toBe(0);
    const bad = await ops(id, "claude", 0, [{ op: "set", node: "headline", path: "style.font", value: "Comic Sans" }]);
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe("invalid-document");
  });

  it("rebases writes to different properties and returns 409 for the same property", async () => {
    const id = await createLux(ctx);
    // Agent vs agent, so soft pins (human changes) do not get in the way.
    expect((await ops(id, "claude", 0, [{ op: "set", node: "headline", path: "y", value: 80 }])).json.rev).toBe(1);
    const merged = await ops(id, "grok", 0, [{ op: "set", node: "sub", path: "style.size", value: 24 }]);
    expect(merged.status).toBe(200);
    expect(merged.json).toMatchObject({ rev: 2, base: 0, rebased: true });
    const clash = await ops(id, "grok", 0, [{ op: "set", node: "headline", path: "y", value: 120 }]);
    expect(clash.status).toBe(409);
    expect(clash.json.error.details).toEqual({ head: 2, conflicts: [{ node: "headline", path: "y", theirs: "y", rev: 1 }] });
    const doc = (await ctx.call("claude", "GET", `/v1/projects/${id}`)).json.doc;
    const head = doc.frames[0].children.find((n: any) => n.id === "headline");
    expect(head.y).toBe(80);
  });

  it("rebuilds any revision from snapshots and restores as a new revision", async () => {
    const id = await createLux(ctx);
    const states: number[] = [];
    for (let i = 1; i <= 120; i++) {
      const r = await ops(id, "nikola", i - 1, [{ op: "set", node: "rule-top", path: "y", value: 88 + i }]);
      expect(r.status).toBe(200);
      states.push(88 + i);
    }
    expect((ctx.store.db.prepare("SELECT rev FROM snapshots WHERE project_id = ? ORDER BY rev").all(id) as any[]).map((r) => r.rev)).toEqual([0, 50, 100]);
    for (const rev of [0, 49, 50, 51, 77, 100, 119]) {
      const doc = (await ctx.call("claude", "GET", `/v1/projects/${id}?rev=${rev}`)).json.doc;
      expect(doc.frames[0].children.find((n: any) => n.id === "rule-top").y).toBe(rev === 0 ? 88 : states[rev - 1]);
    }
    const restored = await ctx.call("nikola", "POST", `/v1/projects/${id}/restore`, { rev: 10 });
    expect(restored.json.rev).toBe(121);
    const now = (await ctx.call("claude", "GET", `/v1/projects/${id}`)).json.doc;
    const at10 = (await ctx.call("claude", "GET", `/v1/projects/${id}?rev=10`)).json.doc;
    expect(now).toEqual(at10);
    const hist = (await ctx.call("claude", "GET", `/v1/projects/${id}/revisions?since=119`)).json.revisions;
    expect(hist.map((h: any) => [h.rev, h.kind, h.author])).toEqual([[120, "ops", "human"], [121, "restore", "human"]]);
  });
});

describe("the agent loop: turns, leases, pins, diff", () => {
  it("runs a full hand-off round trip", async () => {
    const id = await createLux(ctx);
    // Nikola tweaks: moves the headline up, enlarges it, adds a sticker, then hands over.
    expect((await ops(id, "nikola", 0, [{ op: "set", node: "headline", path: "y", value: 76 }, { op: "set", node: "headline", path: "style.size", value: 56 }])).status).toBe(200);
    expect((await ops(id, "nikola", 1, [{ op: "insert", parent: "square", node: { id: "sticker", type: "ellipse", x: 900, y: 120, w: 40, h: 40, fill: "#AC1922" } }])).status).toBe(200);
    expect((await ctx.call("claude", "POST", `/v1/projects/${id}/handoff`, { note: "x" })).status).toBe(403);
    const h = await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "make the headline shorter, keep my layout" });
    expect(h.json).toMatchObject({ checkpoint: "handoff-1", rev: 2, turn: "agent", focus: [] });

    // Agent takes the lease; the editor (human) is now read-only, other agents too.
    const lease = await ctx.call("claude", "POST", `/v1/projects/${id}/lease`, {});
    expect(lease.json).toMatchObject({ holder: "agent:claude", secondsLeft: 900 });
    expect((await ops(id, "nikola", 2, [{ op: "set", node: "sub", path: "x", value: 0 }])).status).toBe(423);
    expect((await ops(id, "grok", 2, [{ op: "set", node: "sub", path: "x", value: 0 }])).status).toBe(423);

    // Agent reads the note and what changed since its last checkpoint.
    const state = (await ctx.call("claude", "GET", `/v1/projects/${id}/handoff`)).json;
    expect(state.handoff.note).toBe("make the headline shorter, keep my layout");
    const diff = (await ctx.call("claude", "GET", `/v1/projects/${id}/diff`)).json;
    expect(diff.from).toBe(0);
    expect(diff.text).toContain("headline: moved 0,-24 · size 50 → 56   (human, rev 1)");
    expect(diff.text).toContain("sticker:");
    expect(diff.text).toContain("added ellipse in square   (human, rev 2)");

    // Moving the headline back is blocked by a soft pin; changing the words is fine.
    const pinned = await ops(id, "claude", 2, [{ op: "set", node: "headline", path: "y", value: 100 }]);
    expect(pinned.status).toBe(422);
    expect(pinned.json.error.code).toBe("pinned");
    expect(pinned.json.error.details.blocked[0]).toMatchObject({ key: "headline.y", source: "soft" });
    expect((await ops(id, "claude", 2, [{ op: "delete", node: "sticker" }])).json.error.code).toBe("pinned");
    const ok = await ops(id, "claude", 2, [{ op: "set", node: "headline", path: "spans", value: [{ text: "Исти модели,\nразлични оценки." }] }]);
    expect(ok.status).toBe(200);

    // An override needs a reason and is kept in history.
    const ov = await ops(id, "claude", 3, [{ op: "set", node: "headline", path: "style.size", value: 54 }], {
      overridePins: { "headline.style.size": "56 px overflows two lines after the rewrite" },
    });
    expect(ov.status).toBe(200);
    expect((await ctx.call("claude", "GET", `/v1/projects/${id}/revisions/4`)).json.overrides).toEqual([
      { key: "headline.style.size", reason: "56 px overflows two lines after the rewrite" },
    ]);

    // Hand back: checkpoint agent-1, lease gone, turn human, soft pins reset.
    const back = await ctx.call("claude", "POST", `/v1/projects/${id}/handoff/back`, { summary: "Shorter headline; kept his position and sticker" });
    expect(back.json).toEqual({ checkpoint: "agent-1", rev: 4, turn: "human" });
    expect((await ctx.call("claude", "GET", `/v1/projects/${id}`)).json.lease).toBeNull();
    expect((await ctx.call("claude", "GET", `/v1/projects/${id}/pins`)).json.soft).toEqual([]);
    expect((await ctx.call("claude", "GET", `/v1/projects/${id}/diff?since=agent-1`)).json.text).toBe("no changes");
    // Diff between his hand-off and the agent's turn shows only the agent's edits.
    const agentDiff = (await ctx.call("nikola", "GET", `/v1/projects/${id}/diff?since=handoff-1&to=agent-1`)).json.text;
    expect(agentDiff).toMatch(/^headline:\s+size 56 → 54 · text "Исти модели\.\\nРазлични оценки\." → "Исти модели,\\nразлични оценки\." {3}\(agent:claude, rev 3–4\)/);
  });

  it("explicit pins protect a node for good, and agents cannot unpin", async () => {
    const id = await createLux(ctx);
    await ops(id, "nikola", 0, [{ op: "set", node: "logo", path: "pins", value: ["*"] }]);
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "" });
    await ctx.call("claude", "POST", `/v1/projects/${id}/handoff/back`, { summary: "nothing" });
    // After the agent checkpoint the soft pin is gone, but the explicit pin stays.
    expect((await ops(id, "claude", 1, [{ op: "set", node: "logo", path: "x", value: 0 }])).json.error.code).toBe("pinned");
    expect((await ops(id, "claude", 1, [{ op: "set", node: "logo", path: "pins", value: [] }])).json.error.code).toBe("pinned");
    expect((await ops(id, "nikola", 1, [{ op: "set", node: "logo", path: "x", value: 140 }])).status).toBe(200);
  });

  it("expires leases, and only Nikola can approve", async () => {
    const id = await createLux(ctx);
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "" });
    await ctx.call("claude", "POST", `/v1/projects/${id}/lease`, { seconds: 60 });
    expect((await ops(id, "nikola", 0, [{ op: "set", node: "sub", path: "x", value: 130 }])).status).toBe(423);
    t += 61_000;
    expect((await ops(id, "nikola", 0, [{ op: "set", node: "sub", path: "x", value: 130 }])).status).toBe(200);
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff/take-back`, {});
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/lease`, {})).status).toBe(403);
    expect((await ctx.call("claude", "POST", `/v1/projects/${id}/checkpoints`, { name: "approved" })).status).toBe(403);
    const ap = await ctx.call("nikola", "POST", `/v1/projects/${id}/checkpoints`, { name: "approved", note: "ship it" });
    expect(ap.json).toMatchObject({ name: "approved", kind: "approved", rev: 1 });
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/checkpoints`, { name: "agent-7" })).status).toBe(400);
  });

  it("dry-runs without writing", async () => {
    const id = await createLux(ctx);
    const r = await ops(id, "claude", 0, [{ op: "set", node: "sub", path: "x", value: 2000 }], { dryRun: true });
    expect(r.json).toMatchObject({ dryRun: true, rev: 0 });
    expect(r.json.warnings.map((w: any) => w.code)).toContain("bounds");
    expect((await ctx.call("claude", "GET", `/v1/projects/${id}`)).json.head).toBe(0);
  });
});

describe("assets", () => {
  it("stores PNG by content hash and serves it back", async () => {
    const up = await ctx.call("claude", "POST", "/v1/assets", LOGO(), { "content-type": "application/octet-stream", "x-filename": "logo.png" });
    expect(up.json).toMatchObject({ ref: "sha256:13f0981fa53b024f13cb69ba583de91d3d4db82ed7d393a4480ddb1c7f065843", mime: "image/png" });
    const again = await ctx.call("claude", "POST", "/v1/assets", LOGO(), { "content-type": "image/png" });
    expect(again.json.ref).toBe(up.json.ref);
    const get = await ctx.call("claude", "GET", `/v1/assets/${up.json.ref}`);
    expect(get.status).toBe(200);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sanitizes SVG: no script, no handlers, no external references", async () => {
    const evil = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)">
      <script>alert(1)</script><foreignObject><div/></foreignObject>
      <style>@import url(https://evil.example/x.css);</style>
      <rect width="10" height="10" fill="#AC1922" onclick="x()" style="fill:url(https://evil.example/p)"/>
      <use xlink:href="https://evil.example/s.svg#a"/><use href="#ok"/>
      <a href="javascript:alert(1)"><circle r="2"/></a>
      <image href="https://evil.example/i.png"/><path id="ok" d="M0 0L10 10" stroke="#000"/></svg>`;
    const up = await ctx.call("claude", "POST", "/v1/assets", Buffer.from(evil), { "content-type": "image/svg+xml" });
    expect(up.status).toBe(201);
    const svg = (await ctx.call("claude", "GET", `/v1/assets/${up.json.ref}`)).body;
    for (const bad of ["script", "onload", "onclick", "foreignObject", "evil.example", "javascript", "@import", "<a"]) expect(svg).not.toContain(bad);
    expect(svg).toContain('fill="#AC1922"');
    expect(svg).toContain('href="#ok"');
    expect(up.json.sanitized.length).toBeGreaterThan(5);
  });

  it("rejects unknown types, entity tricks and oversized SVG", async () => {
    expect((await ctx.call("claude", "POST", "/v1/assets", Buffer.from("GIF89a..."), { "content-type": "application/octet-stream" })).status).toBe(415);
    const xxe = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>`;
    expect((await ctx.call("claude", "POST", "/v1/assets", Buffer.from(xxe), { "content-type": "image/svg+xml" })).status).toBe(422);
    const big = `<svg xmlns="http://www.w3.org/2000/svg"><desc>${"a".repeat(2 * 1024 * 1024)}</desc></svg>`;
    expect((await ctx.call("claude", "POST", "/v1/assets", Buffer.from(big), { "content-type": "image/svg+xml" })).status).toBe(413);
  });
});

describe("projects list and archive", () => {
  it("lists, renames through an op revision, and archives", async () => {
    const id = await createLux(ctx);
    const ren = await ctx.call("nikola", "PATCH", `/v1/projects/${id}`, { title: "LUX-6 v2" });
    expect(ren.json.rev).toBe(1);
    const list = (await ctx.call("claude", "GET", "/v1/projects")).json.projects;
    expect(list.map((p: any) => [p.id, p.title, p.head_rev])).toEqual([[id, "LUX-6 v2", 1]]);
    await ctx.call("nikola", "DELETE", `/v1/projects/${id}`);
    expect((await ctx.call("claude", "GET", "/v1/projects")).json.projects).toEqual([]);
    expect((await ops(id, "claude", 1, [{ op: "set", node: "sub", path: "x", value: 1 }])).status).toBe(409);
  });
});
