// DB step 3 (Phase 4) rebuilds the revisions table to allow 'revert'. Live data is at step 2
// when this ships, so migrate a populated v2 database and check nothing is lost.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DB_STEPS, openDb, runDbStep } from "../src/db.ts";
import { Store } from "../src/store.ts";
import { createLux, setup, sharedFonts } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("database migration v2 → v3", () => {
  it("keeps every revision, checkpoint and project, and then accepts revert revisions", async () => {
    // Build real data with the current code, then turn it back into a v2 database.
    const ctx = await setup();
    const id = await createLux(ctx);
    for (let i = 0; i < 3; i++) await ctx.call("nikola", "POST", `/v1/projects/${id}/ops`, { base: i, ops: [{ op: "set", node: "sub", path: "x", value: 130 + i }], message: `edit ${i}` });
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "go" });
    const before = ctx.store.revisions(id, { withOps: true });
    const doc = ctx.store.getProject(id).doc;
    const dataDir = mkdtempSync(join(tmpdir(), "pstudio-migrate-"));
    dirs.push(dataDir);
    const v2 = join(dataDir, "post-studio.db");
    const old = new Database(v2);
    runDbStep(old, DB_STEPS[0]);
    runDbStep(old, DB_STEPS[1]);
    old.pragma("user_version = 2");
    for (const table of ["projects", "revisions", "snapshots", "checkpoints", "assets", "fonts", "api_tokens"]) {
      const rows = ctx.store.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        if (table === "revisions") delete r.reverts;
        if (table === "checkpoints") {
          delete r.focus_json;
          delete r.at_ms;
        }
        const cols = Object.keys(r);
        old.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`).run(r);
      }
    }
    old.close();
    cpSync(join(ctx.dataDir, "assets"), join(dataDir, "assets"), { recursive: true });
    await ctx.cleanup();

    // Open with the new code: step 3 runs once.
    const migrated = openDb(v2);
    expect(migrated.pragma("user_version", { simple: true })).toBe(DB_STEPS.length);
    expect((migrated.prepare(`SELECT sql FROM sqlite_master WHERE name = 'revisions'`).get() as { sql: string }).sql).toMatch(/'revert'/);
    expect(migrated.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'revisions_author'`).get()).toBeTruthy();
    migrated.close();

    const store = new Store({ dataDir, fonts: await sharedFonts() });
    try {
      expect(store.revisions(id, { withOps: true })).toEqual(before);
      expect(store.getProject(id).doc).toEqual(doc);
      expect(store.handoffState(id)).toMatchObject({ turn: "agent", handoff: { name: "handoff-1" } });
      store.takeBack(id, { author: "human" });
      const r = store.revert(id, 3, { author: "human" });
      expect(store.revision(id, r.rev)).toMatchObject({ kind: "revert", reverts: 3 });
      expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(store.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("database migration v3 → v4 (hand-off focus and dispatch)", () => {
  it("keeps everything, gives old hand-offs no auto-start, and accepts focus afterwards", async () => {
    const ctx = await setup();
    const id = await createLux(ctx);
    await ctx.call("nikola", "POST", `/v1/projects/${id}/ops`, { base: 0, ops: [{ op: "set", node: "sub", path: "x", value: 131 }], message: "edit" });
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "old hand-off, live before v4" });
    const before = ctx.store.revisions(id, { withOps: true });
    const checkpoints = ctx.store.checkpoints(id);
    const dataDir = mkdtempSync(join(tmpdir(), "pstudio-migrate4-"));
    dirs.push(dataDir);
    const v3 = join(dataDir, "post-studio.db");
    const old = new Database(v3);
    for (let i = 0; i < 3; i++) runDbStep(old, DB_STEPS[i]);
    old.pragma("user_version = 3");
    for (const table of ["projects", "revisions", "snapshots", "checkpoints", "assets", "fonts", "api_tokens"]) {
      const rows = ctx.store.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        if (table === "checkpoints") {
          delete r.focus_json;
          delete r.at_ms;
        }
        const cols = Object.keys(r);
        old.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`).run(r);
      }
    }
    old.close();
    cpSync(join(ctx.dataDir, "assets"), join(dataDir, "assets"), { recursive: true });
    await ctx.cleanup();

    const migrated = openDb(v3);
    expect(migrated.pragma("user_version", { simple: true })).toBe(DB_STEPS.length);
    expect((migrated.prepare(`PRAGMA table_info(checkpoints)`).all() as Array<{ name: string }>).map((c) => c.name)).toContain("focus_json");
    expect(migrated.prepare(`SELECT COUNT(*) AS n FROM dispatches`).get()).toEqual({ n: 0 });
    migrated.close();

    const store = new Store({ dataDir, fonts: await sharedFonts() });
    try {
      expect(store.revisions(id, { withOps: true })).toEqual(before);
      expect(store.checkpoints(id)).toEqual(checkpoints.map((c) => ({ ...c, focus: null })));
      // The hand-off made before v4 is still the agent's turn, with no focus and no auto-start.
      expect(store.handoffState(id)).toMatchObject({ turn: "agent", handoff: { name: "handoff-1", focus: [] }, dispatch: null });
      expect(store.dispatchPoll({ enabled: true, instance: "t" }).items).toEqual([]);
      store.takeBack(id, { author: "human" });
      const r = store.handoff(id, { author: "human" }, "new one", ["headline"]);
      expect(r.focus[0]).toMatchObject({ id: "headline", type: "text" });
      expect(store.handoffState(id)).toMatchObject({ handoff: { name: "handoff-2" }, dispatch: { state: "pending" } });
      expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(store.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("database migration v5 → v6 (the hand-off moment)", () => {
  it("adds at_ms, keeps every checkpoint (old hand-offs get no moment), and accepts at afterwards", async () => {
    const ctx = await setup();
    const id = await createLux(ctx);
    await ctx.call("nikola", "POST", `/v1/projects/${id}/ops`, { base: 0, ops: [{ op: "set", node: "$doc", path: "motion", value: { duration: 3000, fps: 30 } }], message: "motion" });
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "old hand-off, live before v6", focus: ["headline"] });
    const before = ctx.store.revisions(id, { withOps: true });
    const checkpoints = ctx.store.checkpoints(id);
    const dataDir = mkdtempSync(join(tmpdir(), "pstudio-migrate6-"));
    dirs.push(dataDir);
    const path = join(dataDir, "post-studio.db");
    ctx.store.db.prepare(`VACUUM INTO ?`).run(path);
    cpSync(join(ctx.dataDir, "assets"), join(dataDir, "assets"), { recursive: true });
    await ctx.cleanup();
    // Back to v5 as the live server has it: no at_ms column.
    const old = new Database(path);
    old.exec(`ALTER TABLE checkpoints DROP COLUMN at_ms`);
    old.pragma("user_version = 5");
    old.close();

    const migrated = openDb(path);
    expect(migrated.pragma("user_version", { simple: true })).toBe(DB_STEPS.length);
    expect(DB_STEPS.length).toBe(6);
    expect((migrated.prepare(`PRAGMA table_info(checkpoints)`).all() as Array<{ name: string }>).map((c) => c.name)).toContain("at_ms");
    // Opening again runs nothing (and a copy that already has the column is not refused).
    migrated.pragma("user_version = 5");
    migrated.close();
    openDb(path).close();

    const store = new Store({ dataDir, fonts: await sharedFonts() });
    try {
      expect(store.revisions(id, { withOps: true })).toEqual(before);
      expect(store.checkpoints(id)).toEqual(checkpoints);
      expect(store.handoffState(id)).toMatchObject({ turn: "agent", handoff: { name: "handoff-1", at: null, atText: null, focus: [{ id: "headline" }] }, dispatch: { state: "pending" } });
      store.takeBack(id, { author: "human" });
      expect(store.handoff(id, { author: "human" }, "here", [], 1500).at).toBe(1500);
      expect(store.handoffState(id).handoff).toMatchObject({ name: "handoff-2", at: 1500, atText: "1.50 s" });
      expect(store.dispatchPoll({ enabled: true, instance: "t" }).items[0]).toMatchObject({ checkpoint: "handoff-2", at: 1500, motion: true });
      expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      store.close();
    }
  });
});
