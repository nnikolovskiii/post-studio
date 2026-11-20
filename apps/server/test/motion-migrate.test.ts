// Motion Part 1: DB step v5 rewrites every stored document and snapshot to post-studio/2
// (PLAN-motion.md §4.2). Live data is at step 4 (post-studio/1 documents) when this ships, so
// build real history with the current code, turn it back into a v4 database with v1 documents,
// open it with the new code and check that nothing but the schema string changed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, validateStructure } from "@post-studio/schema";
import { restore } from "../src/backup.ts";
import { DB_STEPS, migrateStoredDocuments, openDb } from "../src/db.ts";
import { replayHistory, storedJson, storedVersions, versionFree } from "../src/history-check.ts";
import { Store } from "../src/store.ts";
import { createLux, loadFixture, setup, sharedFonts } from "./helpers.ts";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const V1 = '"schema":"post-studio/1"';
const V2 = '"schema":"post-studio/2"';

/** Real history: an imported LUX-6, two template projects, > 50 revisions (a second snapshot), restore, revert, hand-off and hand-back. */
async function buildHistory() {
  const ctx = await setup();
  const lux = await createLux(ctx);
  const human = { author: "human" as const };
  const agent = { author: "agent:claude" as const };
  for (let i = 0; i < 55; i++) {
    ctx.store.applyOps(lux, { base: i, ops: [{ op: "set", node: "sub", path: "x", value: 130 + (i % 7) }, { op: "set", node: "headline", path: "y", value: 100 + i }], message: `edit ${i}` }, human);
  }
  ctx.store.applyOps(lux, { base: 55, ops: [{ op: "insert", parent: "square", node: { id: "badge", type: "rect", x: 900, y: 40, w: 40, h: 40, fill: "#AC1922" } }], message: "badge" }, human);
  ctx.store.restore(lux, 40, human);
  ctx.store.revert(lux, 57, human);
  ctx.store.handoff(lux, human, "make it punchier", ["headline"]);
  ctx.store.takeLease(lux, agent);
  const head = ctx.store.getProject(lux).head;
  ctx.store.applyOps(lux, { base: head, ops: [{ op: "set", node: "headline", path: "style.size", value: 58 }], message: "agent edit" }, agent);
  ctx.store.handBack(lux, agent, "bigger headline");
  const a = ctx.store.createFromTemplate("lux/post", human, { title: "Template post" }).project;
  ctx.store.applyOps(a, { base: 0, ops: [{ op: "set", node: "$doc", path: "title", value: "Renamed" }], message: "rename" }, human);
  const b = ctx.store.createFromTemplate("kites/square", agent).project;
  return { ctx, projects: [lux, a, b] };
}

/** A copy of the current database as it looked at step 4: v1 documents, user_version 4. */
function toV4(ctx: Awaited<ReturnType<typeof setup>>, dataDir: string): string {
  const path = join(dataDir, "post-studio.db");
  ctx.store.db.prepare(`VACUUM INTO ?`).run(path);
  const db = new Database(path);
  for (const table of ["projects", "snapshots"]) {
    for (const r of db.prepare(`SELECT rowid AS rid, doc_json FROM ${table}`).all() as Array<{ rid: number; doc_json: string }>) {
      expect(r.doc_json.startsWith(`{${V2}`)).toBe(true);
      db.prepare(`UPDATE ${table} SET doc_json = ? WHERE rowid = ?`).run(r.doc_json.replace(V2, V1), r.rid);
    }
  }
  // Columns added by later steps (v6 at_ms) did not exist at v4.
  db.exec(`ALTER TABLE checkpoints DROP COLUMN at_ms`);
  db.pragma("user_version = 4");
  db.close();
  cpSync(join(ctx.dataDir, "assets"), join(dataDir, "assets"), { recursive: true });
  return path;
}

describe("database migration v4 → v5 (documents become post-studio/2)", () => {
  it("rewrites only the schema string and every revision replays to the same document", async () => {
    expect(DB_STEPS.length).toBeGreaterThanOrEqual(5);
    const { ctx, projects } = await buildHistory();
    const docsBefore = new Map(projects.map((id) => [id, ctx.store.getProject(id)]));
    const revsBefore = new Map(projects.map((id) => [id, ctx.store.revisions(id, { withOps: true })]));
    const checkpoints = new Map(projects.map((id) => [id, ctx.store.checkpoints(id)]));
    const dataDir = tmp("pstudio-motion-v4-");
    const path = toV4(ctx, dataDir);
    await ctx.cleanup();

    // Before: a v4 database with v1 documents. Replay it with the raw tables (no Store).
    const old = new Database(path, { readonly: true });
    const before = replayHistory(old);
    const rawBefore = storedJson(old);
    const versionsBefore = storedVersions(old);
    old.close();
    expect(Object.keys(versionsBefore).every((k) => k.endsWith("post-studio/1"))).toBe(true);
    expect(before.map((p) => p.problems)).toEqual(projects.map(() => []));
    const lux = before.find((p) => p.id === projects[0])!;
    expect(lux.head).toBeGreaterThan(55);
    expect(lux.snapshots).toBe(2); // rev 0 and rev 50

    // Open with the new code: step 5 runs once (and the later steps after it).
    const db = openDb(path);
    expect(db.pragma("user_version", { simple: true })).toBe(DB_STEPS.length);
    const after = replayHistory(db);
    const rawAfter = storedJson(db);
    expect(Object.keys(storedVersions(db)).every((k) => k.endsWith(SCHEMA_VERSION))).toBe(true);
    // Byte for byte: only the schema string changed in every stored document.
    expect([...rawAfter.keys()].sort()).toEqual([...rawBefore.keys()].sort());
    for (const [k, json] of rawAfter) expect(json, k).toBe(rawBefore.get(k)!.replace(V1, V2));
    // Every revision of every project replays to the same document as before.
    expect(after).toEqual(before);
    // Running the rewrite again changes nothing.
    expect(migrateStoredDocuments(db)).toEqual({ projects: 0, snapshots: 0 });
    db.close();

    const store = new Store({ dataDir, fonts: await sharedFonts() });
    try {
      for (const id of projects) {
        const p = store.getProject(id);
        expect(p.doc.schema).toBe(SCHEMA_VERSION);
        expect(validateStructure(p.doc).ok).toBe(true);
        expect(versionFree(p.doc)).toBe(versionFree(docsBefore.get(id)!.doc));
        expect(store.revisions(id, { withOps: true })).toEqual(revsBefore.get(id));
        expect(store.checkpoints(id)).toEqual(checkpoints.get(id));
        const replay = after.find((r) => r.id === id)!;
        for (let rev = 0; rev <= p.head; rev++) {
          const doc = store.docAt(id, rev);
          expect(doc.schema, `${id} rev ${rev}`).toBe(SCHEMA_VERSION);
          expect(createHash("sha256").update(versionFree(doc)).digest("hex"), `${id} rev ${rev}`).toBe(replay.revs[rev]);
        }
      }
      // Writes keep working on the migrated history (restore across the old snapshot, revert).
      const id = projects[0];
      const head = store.getProject(id).head;
      store.restore(id, 10, { author: "human" });
      expect(versionFree(store.getProject(id).doc)).toBe(versionFree(store.docAt(id, 10)));
      store.revert(id, head + 1, { author: "human" });
      expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      store.close();
    }
  });

  it("restores an old (v4) backup and migrates it on the first open", async () => {
    const { ctx, projects } = await buildHistory();
    const stage = tmp("pstudio-motion-bk-");
    const path = toV4(ctx, stage);
    await ctx.cleanup();
    // A backup tarball as the v4 code wrote it (manifest digests over the v1 documents).
    const db = new Database(path, { readonly: true });
    const rows = db.prepare(`SELECT id, head_rev, doc_json FROM projects ORDER BY id`).all() as Array<{ id: string; head_rev: number; doc_json: string }>;
    db.close();
    const count = (d: string): number => Number(execFileSync("sh", ["-c", `find "${d}" -type f | wc -l`]).toString().trim());
    const manifest = {
      format: "post-studio-backup/1",
      createdAt: new Date().toISOString(),
      dbSchema: 4,
      projects: rows.map((r) => ({ id: r.id, head: r.head_rev, sha256: createHash("sha256").update(r.doc_json).digest("hex") })),
      assets: count(join(stage, "assets")),
    };
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest));
    const out = tmp("pstudio-motion-tar-");
    const tarball = join(out, "post-studio-20261110-000000.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", stage, "manifest.json", "post-studio.db", "assets"]);
    const target = join(tmp("pstudio-motion-restore-"), "data");
    mkdirSync(target);
    const r = restore(tarball, target);
    expect(r.verified.projects).toBe(projects.length);
    const store = new Store({ dataDir: target, fonts: await sharedFonts() });
    try {
      expect(store.db.pragma("user_version", { simple: true })).toBe(DB_STEPS.length);
      for (const id of projects) expect(store.getProject(id).doc.schema).toBe(SCHEMA_VERSION);
    } finally {
      store.close();
    }
  });
});

describe("documents from outside still go through migrate()", () => {
  it("creates a project from a post-studio/1 scene and stores it as post-studio/2", async () => {
    const ctx = await setup();
    try {
      await createLux(ctx);
      const v1 = { ...loadFixture(), schema: "post-studio/1" };
      const res = await ctx.call("claude", "POST", "/v1/projects", v1);
      expect(res.status).toBe(201);
      const got = await ctx.call("claude", "GET", `/v1/projects/${res.json.project}`);
      expect(got.json.doc.schema).toBe("post-studio/2");
      expect(versionFree(got.json.doc)).toBe(versionFree({ ...v1, id: res.json.project }));
      const unknown = await ctx.call("claude", "POST", "/v1/projects", { ...v1, schema: "post-studio/9" });
      expect(unknown.status).toBeGreaterThanOrEqual(400);
      const health = await ctx.call(null, "GET", "/v1/health");
      expect(health.json.schema).toBe("post-studio/2");
    } finally {
      await ctx.cleanup();
    }
  });
});
