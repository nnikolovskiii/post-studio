// Motion Part 1 (PLAN-motion.md §4.2): prove the v5 DB step on real data without touching it.
// Extracts a backup tarball into a fresh /tmp directory (never the live data dir), replays every
// revision of every project from the raw tables, opens the copy with the new code (which runs the
// pending DB steps), replays again and compares. Also rebuilds every revision through the Store.
//   pnpm exec tsx scripts/motion-migration-check.ts [backup.tar.gz] [--keep]
// Without a path it takes the newest post-studio-*.tar.gz in ~/.local/share/post-studio/backups.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { validateMotion } from "@post-studio/motion";
import { SCHEMA_VERSION, validateStructure } from "@post-studio/schema";
import { BACKUP_RE } from "../apps/server/src/backup.ts";
import { DB_STEPS, openDb, openReadOnly } from "../apps/server/src/db.ts";
import { replayHistory, storedJson, storedVersions, versionFree } from "../apps/server/src/history-check.ts";
import { Store } from "../apps/server/src/store.ts";
import { FontRegistry } from "@post-studio/text";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const dir = join(homedir(), ".local/share/post-studio/backups");
const tarball =
  args.find((a) => !a.startsWith("--")) ??
  join(
    dir,
    readdirSync(dir)
      .filter((f) => BACKUP_RE.test(f))
      .sort()
      .at(-1) ?? "",
  );

const work = mkdtempSync(join(tmpdir(), "ps-motion-backup-"));
try {
  execFileSync("tar", ["-xzf", tarball, "-C", work, "--no-same-owner"]);
  const manifest = JSON.parse(readFileSync(join(work, "manifest.json"), "utf8"));
  const path = join(work, "post-studio.db");

  const old = openReadOnly(path);
  const fromVersion = old.pragma("user_version", { simple: true }) as number;
  const t0 = performance.now();
  const before = replayHistory(old);
  const rawBefore = storedJson(old);
  const versionsBefore = storedVersions(old);
  old.close();

  const t1 = performance.now();
  const db = openDb(path);
  const stepMs = performance.now() - t1;
  const toVersion = db.pragma("user_version", { simple: true }) as number;
  const after = replayHistory(db);
  const rawAfter = storedJson(db);
  const versionsAfter = storedVersions(db);
  const integrity = db.pragma("integrity_check", { simple: true });
  db.close();

  const problems: string[] = [];
  for (const p of before) for (const x of p.problems) problems.push(`before ${p.id}: ${x}`);
  for (const p of after) for (const x of p.problems) problems.push(`after ${p.id}: ${x}`);
  if (JSON.stringify(after) !== JSON.stringify(before)) problems.push("replayed revisions differ before / after the DB step");
  let rewritten = 0;
  for (const [k, json] of rawAfter) {
    const was = rawBefore.get(k);
    if (was === undefined) problems.push(`${k} appeared`);
    else if (json !== was.replace('"schema":"post-studio/1"', `"schema":"${SCHEMA_VERSION}"`)) problems.push(`${k}: more than the schema string changed`);
    else if (json !== was) rewritten++;
  }
  if (rawAfter.size !== rawBefore.size) problems.push(`${rawBefore.size} stored documents before, ${rawAfter.size} after`);

  // Every revision through the Store (the code path the server uses), plus full structure checks.
  const store = new Store({ dataDir: work, fonts: await FontRegistry.load() });
  let revisions = 0;
  let motionErrors = 0;
  try {
    for (const p of after) {
      const head = store.getProject(p.id);
      const v = validateStructure(head.doc);
      if (!v.ok) problems.push(`${p.id} head does not validate as ${SCHEMA_VERSION}: ${JSON.stringify(v.errors.slice(0, 3))}`);
      else motionErrors += validateMotion(head.doc).errors.length;
      for (let rev = 0; rev <= p.head; rev++) {
        const doc = store.docAt(p.id, rev);
        revisions++;
        if (doc.schema !== SCHEMA_VERSION) problems.push(`${p.id} rev ${rev} is ${doc.schema}`);
        if (createHash("sha256").update(versionFree(doc)).digest("hex") !== p.revs[rev]) problems.push(`${p.id} rev ${rev} differs from the raw replay`);
      }
    }
  } finally {
    store.close();
  }

  const report = {
    backup: tarball,
    backupCreatedAt: manifest.createdAt,
    scratchCopy: work,
    dbVersion: { before: fromVersion, after: toVersion, steps: DB_STEPS.length },
    projects: after.length,
    revisions,
    snapshots: after.reduce((n, p) => n + p.snapshots, 0),
    storedDocuments: rawAfter.size,
    rewritten,
    versionsBefore,
    versionsAfter,
    stepMs: Math.round(stepMs),
    replayMs: Math.round(t1 - t0),
    integrity,
    motionErrors,
    problems,
    ok: problems.length === 0 && integrity === "ok" && motionErrors === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
} finally {
  if (!keep) rmSync(work, { recursive: true, force: true });
}
