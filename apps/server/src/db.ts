import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrate, SCHEMA_VERSION } from "@post-studio/schema";

export type DB = Database.Database;

/** One schema step: SQL, or a function for a data rewrite SQL cannot do safely. */
export type DbStep = string | ((db: DB) => void);

/**
 * v5 (Motion Part 1): stored documents → the current document schema (post-studio/2). Every
 * projects.doc_json and snapshots.doc_json goes through migrate(), the same chain that documents
 * from outside use. post-studio/2 is a superset of /1, so only the "schema" string changes: the
 * key order is kept and JSON.stringify writes the rest byte for byte as the store did. Revision
 * ops never write `schema`, so every revision replays to the same document as before.
 */
export function migrateStoredDocuments(db: DB): { projects: number; snapshots: number } {
  const counts = { projects: 0, snapshots: 0 };
  for (const table of ["projects", "snapshots"] as const) {
    const rows = db.prepare(`SELECT rowid AS rid, doc_json FROM ${table}`).all() as Array<{ rid: number; doc_json: string }>;
    const update = db.prepare(`UPDATE ${table} SET doc_json = ? WHERE rowid = ?`);
    for (const r of rows) {
      const doc = JSON.parse(r.doc_json) as Record<string, unknown>;
      if (doc.schema === SCHEMA_VERSION) continue;
      update.run(JSON.stringify(migrate(doc).doc), r.rid);
      counts[table]++;
    }
  }
  return counts;
}

/** Run one step (no transaction; openDb wraps each step in one). */
export function runDbStep(db: DB, step: DbStep): void {
  if (typeof step === "string") db.exec(step);
  else step(db);
}

/** Ordered schema steps; PRAGMA user_version records how many ran. */
export const DB_STEPS: DbStep[] = [
  `
  CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    head_rev    INTEGER NOT NULL,
    turn        TEXT NOT NULL CHECK (turn IN ('human', 'agent')),
    doc_json    TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE TABLE revisions (
    project_id     TEXT NOT NULL REFERENCES projects(id),
    rev            INTEGER NOT NULL,
    base_rev       INTEGER,
    kind           TEXT NOT NULL CHECK (kind IN ('create', 'ops', 'restore')),
    author         TEXT NOT NULL,
    token_id       TEXT,
    message        TEXT NOT NULL,
    ops_json       TEXT NOT NULL,
    inverse_json   TEXT NOT NULL,
    touches_json   TEXT NOT NULL,
    overrides_json TEXT,
    warnings_json  TEXT,
    rebased        INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    PRIMARY KEY (project_id, rev)
  );
  CREATE TABLE snapshots (
    project_id TEXT NOT NULL REFERENCES projects(id),
    rev        INTEGER NOT NULL,
    doc_json   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, rev)
  );
  CREATE TABLE checkpoints (
    project_id TEXT NOT NULL REFERENCES projects(id),
    name       TEXT NOT NULL,
    rev        INTEGER NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('created', 'handoff', 'agent', 'approved', 'named')),
    author     TEXT NOT NULL,
    note       TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, name)
  );
  CREATE TABLE assets (
    sha256        TEXT PRIMARY KEY,
    mime          TEXT NOT NULL,
    bytes         INTEGER NOT NULL,
    original_name TEXT,
    created_by    TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE fonts (
    id            TEXT PRIMARY KEY,
    family        TEXT NOT NULL,
    weight_min    INTEGER NOT NULL,
    weight_max    INTEGER NOT NULL,
    variable      INTEGER NOT NULL,
    files_json    TEXT NOT NULL,
    mk_missing    TEXT NOT NULL,
    registered_at TEXT NOT NULL
  );
  CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL CHECK (kind IN ('agent', 'human')),
    token_hash   TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
  );
  CREATE TABLE leases (
    project_id TEXT PRIMARY KEY REFERENCES projects(id),
    holder     TEXT NOT NULL,
    token_id   TEXT,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX revisions_author ON revisions (project_id, author);
  CREATE INDEX checkpoints_kind ON checkpoints (project_id, kind, rev);
  `,
  // v2 (Phase 3): editor login. One admin user; sessions are stored as token hashes.
  `
  CREATE TABLE admin_user (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id_hash      TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at TEXT,
    user_agent   TEXT
  );
  `,
  // v3 (Phase 4): per-revision revert. A 'revert' revision undoes one earlier revision; the
  // reverted rev is kept in its own column. SQLite cannot alter a CHECK, so the table is rebuilt.
  `
  CREATE TABLE revisions_v3 (
    project_id     TEXT NOT NULL REFERENCES projects(id),
    rev            INTEGER NOT NULL,
    base_rev       INTEGER,
    kind           TEXT NOT NULL CHECK (kind IN ('create', 'ops', 'restore', 'revert')),
    author         TEXT NOT NULL,
    token_id       TEXT,
    message        TEXT NOT NULL,
    ops_json       TEXT NOT NULL,
    inverse_json   TEXT NOT NULL,
    touches_json   TEXT NOT NULL,
    overrides_json TEXT,
    warnings_json  TEXT,
    rebased        INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    reverts        INTEGER,
    PRIMARY KEY (project_id, rev)
  );
  INSERT INTO revisions_v3 (project_id, rev, base_rev, kind, author, token_id, message, ops_json, inverse_json, touches_json, overrides_json, warnings_json, rebased, created_at)
    SELECT project_id, rev, base_rev, kind, author, token_id, message, ops_json, inverse_json, touches_json, overrides_json, warnings_json, rebased, created_at FROM revisions;
  DROP TABLE revisions;
  ALTER TABLE revisions_v3 RENAME TO revisions;
  CREATE INDEX revisions_author ON revisions (project_id, author);
  `,
  // v4 (Phase 8 hand-off dispatch): what Nikola pointed at when he handed over (a readable
  // snapshot per node, JSON), and one dispatch row per hand-off made after this step: the host
  // dispatcher claims it, starts one agent job and marks it started (or failed). Hand-offs made
  // before v4 get no row, so they are never auto-started.
  `
  ALTER TABLE checkpoints ADD COLUMN focus_json TEXT;
  CREATE TABLE dispatches (
    project_id       TEXT NOT NULL REFERENCES projects(id),
    checkpoint       TEXT NOT NULL,
    state            TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'started', 'failed', 'cancelled')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    claimed_by       TEXT,
    claimed_at       TEXT,
    claim_expires_at INTEGER,
    job_id           INTEGER,
    job_status       TEXT,
    error            TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (project_id, checkpoint)
  );
  CREATE INDEX dispatches_state ON dispatches (state, created_at);
  `,
  // v5 (Motion Part 1): every stored document and snapshot becomes post-studio/2, in the same
  // transaction as the user_version bump.
  (db) => {
    migrateStoredDocuments(db);
  },
  // v6 (Motion Part 4): the playhead moment Nikola was looking at when he handed a motion project
  // over (ms, null = none). Older hand-offs keep null. Written as a function so a database that
  // already has the column (a copy made by newer code) is not refused.
  (db) => {
    const cols = (db.prepare(`PRAGMA table_info(checkpoints)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("at_ms")) db.exec(`ALTER TABLE checkpoints ADD COLUMN at_ms INTEGER`);
  },
];

export const DB_SCHEMA_VERSION = DB_STEPS.length;

/** Open a database file read-only, without running any step (checks on copies of old data). */
export function openReadOnly(path: string): DB {
  return new Database(path, { readonly: true, fileMustExist: true });
}

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > DB_STEPS.length) throw new Error(`database schema v${current} is newer than this build (v${DB_STEPS.length})`);
  for (let v = current; v < DB_STEPS.length; v++) {
    db.transaction(() => {
      runDbStep(db, DB_STEPS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}
