// History replay check for the v5 DB step (Motion Part 1, PLAN-motion.md §4.2). Reads the raw
// tables of any database version, rebuilds every revision of every project from its rev-0
// snapshot plus the ops after it, and checks the stored snapshots and head against that replay.
// Used by apps/server/test/motion-migrate.test.ts and scripts/motion-migration-check.ts (which
// runs it on a scratch copy of a backup, never on the live database).
import { createHash } from "node:crypto";
import { apply } from "@post-studio/ops";
import type { Document } from "@post-studio/schema";
import type { DB } from "./db.ts";

export interface ProjectReplay {
  id: string;
  head: number;
  /** sha256 of the canonical JSON of every revision 0…head, with the schema string blanked. */
  revs: string[];
  snapshots: number;
  /** Problems: a stored snapshot or the head differs from the replay. */
  problems: string[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** JSON of a document with `schema` blanked, so a v1 and a v2 copy of the same content compare equal. */
export function versionFree(doc: Document | Record<string, unknown>): string {
  return JSON.stringify({ ...doc, schema: "*" });
}

export function replayHistory(db: DB): ProjectReplay[] {
  const projects = db.prepare(`SELECT id, head_rev, doc_json FROM projects ORDER BY id`).all() as Array<{ id: string; head_rev: number; doc_json: string }>;
  const out: ProjectReplay[] = [];
  for (const p of projects) {
    const snaps = db.prepare(`SELECT rev, doc_json FROM snapshots WHERE project_id = ? ORDER BY rev`).all(p.id) as Array<{ rev: number; doc_json: string }>;
    const revs = db.prepare(`SELECT rev, ops_json FROM revisions WHERE project_id = ? ORDER BY rev`).all(p.id) as Array<{ rev: number; ops_json: string }>;
    const problems: string[] = [];
    const bySnap = new Map(snaps.map((s) => [s.rev, s.doc_json]));
    const first = bySnap.get(0);
    if (first === undefined) {
      out.push({ id: p.id, head: p.head_rev, revs: [], snapshots: snaps.length, problems: ["no rev-0 snapshot"] });
      continue;
    }
    let doc = JSON.parse(first) as Document;
    const hashes = [sha(versionFree(doc))];
    for (const r of revs) {
      if (r.rev === 0) continue;
      doc = apply(doc, JSON.parse(r.ops_json), { validate: false }).doc;
      hashes.push(sha(versionFree(doc)));
      const snap = bySnap.get(r.rev);
      if (snap !== undefined && versionFree(JSON.parse(snap)) !== versionFree(doc)) problems.push(`snapshot at rev ${r.rev} differs from the replay`);
    }
    if (hashes.length !== p.head_rev + 1) problems.push(`${hashes.length} revisions replayed, head is ${p.head_rev}`);
    if (versionFree(JSON.parse(p.doc_json)) !== versionFree(doc)) problems.push("head document differs from the replay");
    out.push({ id: p.id, head: p.head_rev, revs: hashes, snapshots: snaps.length, problems });
  }
  return out;
}

/** The schema string of every stored document, counted. */
export function storedVersions(db: DB): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ["projects", "snapshots"]) {
    for (const r of db.prepare(`SELECT doc_json FROM ${table}`).all() as Array<{ doc_json: string }>) {
      const v = `${table}:${String((JSON.parse(r.doc_json) as { schema?: unknown }).schema)}`;
      counts[v] = (counts[v] ?? 0) + 1;
    }
  }
  return counts;
}

/** Raw doc_json of every project head and snapshot, keyed `<table>:<project>:<rev>`. */
export function storedJson(db: DB): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of db.prepare(`SELECT id, head_rev, doc_json FROM projects`).all() as Array<{ id: string; head_rev: number; doc_json: string }>) m.set(`projects:${r.id}:${r.head_rev}`, r.doc_json);
  for (const r of db.prepare(`SELECT project_id, rev, doc_json FROM snapshots`).all() as Array<{ project_id: string; rev: number; doc_json: string }>) m.set(`snapshots:${r.project_id}:${r.rev}`, r.doc_json);
  return m;
}
