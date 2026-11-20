import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { DB_SCHEMA_VERSION, openDb } from "./db.ts";

export const BACKUP_RE = /^post-studio-(\d{8}-\d{6})\.tar\.gz$/;

export interface BackupManifest {
  format: "post-studio-backup/1";
  createdAt: string;
  dbSchema: number;
  projects: Array<{ id: string; head: number; sha256: string }>;
  assets: number;
}

export interface BackupResult {
  file: string;
  bytes: number;
  manifest: BackupManifest;
  pruned: string[];
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function digests(db: Database.Database) {
  return (db.prepare(`SELECT id, head_rev, doc_json FROM projects ORDER BY id`).all() as Array<{ id: string; head_rev: number; doc_json: string }>).map((r) => ({
    id: r.id,
    head: r.head_rev,
    sha256: sha(r.doc_json),
  }));
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  return n;
}

/**
 * Consistent snapshot (VACUUM INTO) + the content-addressed asset folder in one dated tarball.
 * Keeps the newest `keep` backups in `outDir`.
 */
export function backup(dataDir: string, outDir = join(dataDir, "backups"), keep = 14): BackupResult {
  const db = openDb(join(dataDir, "post-studio.db"));
  const work = mkdtempSync(join(tmpdir(), "post-studio-backup-"));
  try {
    const snap = join(work, "post-studio.db");
    db.prepare(`VACUUM INTO ?`).run(snap);
    const manifest: BackupManifest = {
      format: "post-studio-backup/1",
      createdAt: new Date().toISOString(),
      dbSchema: DB_SCHEMA_VERSION,
      projects: digests(db),
      assets: countFiles(join(dataDir, "assets")),
    };
    db.close();
    writeFileSync(join(work, "manifest.json"), JSON.stringify(manifest, null, 2));
    mkdirSync(join(work, "assets"), { recursive: true });
    if (existsSync(join(dataDir, "assets"))) execFileSync("cp", ["-a", join(dataDir, "assets") + "/.", join(work, "assets")]);
    mkdirSync(outDir, { recursive: true });
    let name = `post-studio-${stamp()}.tar.gz`;
    for (let i = 1; existsSync(join(outDir, name)); i++) name = `post-studio-${stamp(new Date(Date.now() + i * 1000))}.tar.gz`;
    const file = join(outDir, name);
    const tmp = `${file}.partial`;
    execFileSync("tar", ["-czf", tmp, "-C", work, "manifest.json", "post-studio.db", "assets"]);
    renameSync(tmp, file);
    const pruned = readdirSync(outDir)
      .filter((f) => BACKUP_RE.test(f))
      .sort()
      .reverse()
      .slice(Math.max(1, keep))
      .map((f) => {
        rmSync(join(outDir, f));
        return f;
      });
    return { file, bytes: statSync(file).size, manifest, pruned };
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(work, { recursive: true, force: true });
  }
}

export interface RestoreResult {
  target: string;
  movedAside?: string;
  manifest: BackupManifest;
  verified: { integrity: string; projects: number; assets: number };
}

/**
 * Restore a backup into `target` (a data dir). Verifies integrity and every project's head
 * document against the manifest before anything is replaced. An existing data dir is only
 * replaced with `force`, and is moved aside, not deleted.
 */
export function restore(tarball: string, target: string, opts: { force?: boolean } = {}): RestoreResult {
  if (!existsSync(tarball)) throw new Error(`no such backup: ${tarball}`);
  target = resolve(target);
  // Stage next to the target so the final renames stay on one filesystem (/tmp is often tmpfs).
  mkdirSync(dirname(target), { recursive: true });
  const work = mkdtempSync(join(dirname(target), `.${basename(target)}.restore-`));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", work, "--no-same-owner"]);
    const manifest = JSON.parse(readFileSync(join(work, "manifest.json"), "utf8")) as BackupManifest;
    if (manifest.format !== "post-studio-backup/1") throw new Error(`unknown backup format ${manifest.format}`);
    const db = new Database(join(work, "post-studio.db"), { readonly: true });
    const integrity = db.pragma("integrity_check", { simple: true }) as string;
    const got = digests(db);
    db.close();
    if (integrity !== "ok") throw new Error(`backup database failed integrity_check: ${integrity}`);
    if (JSON.stringify(got) !== JSON.stringify(manifest.projects)) throw new Error("project documents do not match the backup manifest");
    const assets = countFiles(join(work, "assets"));
    if (assets !== manifest.assets) throw new Error(`asset count ${assets} != manifest ${manifest.assets}`);

    let movedAside: string | undefined;
    if (existsSync(target) && readdirSync(target).length) {
      if (!opts.force) throw new Error(`${target} is not empty; pass --force to move it aside and restore`);
      movedAside = `${target}.before-restore-${stamp()}`;
      renameSync(target, movedAside);
    }
    mkdirSync(target, { recursive: true, mode: 0o700 });
    renameSync(join(work, "post-studio.db"), join(target, "post-studio.db"));
    renameSync(join(work, "assets"), join(target, "assets"));
    if (movedAside && existsSync(join(movedAside, "backups"))) execFileSync("cp", ["-a", join(movedAside, "backups"), join(target, "backups")]);
    return { target, movedAside, manifest, verified: { integrity, projects: got.length, assets } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function listBackups(outDir: string): Array<{ file: string; bytes: number }> {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((f) => BACKUP_RE.test(f))
    .sort()
    .reverse()
    .map((f) => ({ file: join(outDir, f), bytes: statSync(join(outDir, f)).size }));
}

