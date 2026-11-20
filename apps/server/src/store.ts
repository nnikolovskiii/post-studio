import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { migrate, SCHEMA_VERSION, type Document, type Issue } from "@post-studio/schema";
import {
  apply,
  attribute,
  checkPins,
  diffDocs,
  effectivePins,
  formatTimeline,
  timeline,
  explicitPins,
  footprint,
  formatDiff,
  isAgent,
  OpBatchSchema,
  OpError,
  outline,
  rebaseOrConflict,
  softPinsFromRevisions,
  canvasOnly,
  validateDocument,
  type Conflict,
  type Op,
  type Pin,
  type PinViolation,
  type Touch,
  type ValidationContext,
} from "@post-studio/ops";
import { checkDocumentPalette, getKit, templateDoc } from "@post-studio/brand";
import { FontRegistry, measureTextFor } from "@post-studio/text";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AssetFiles, prepareAsset } from "./assets.ts";
import { EditorAuth } from "./auth.ts";
import { LIMITS } from "./config.ts";
import { openDb, type DB } from "./db.ts";
import { atText, FocusError, focusLine, parseAt, parseFocus, type FocusItem } from "./focus.ts";

/** Errors carry an HTTP status and a stable code for agents. */
export class StoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface Actor {
  /** 'human' or 'agent:<name>'. */
  author: string;
  tokenId?: string;
}

export interface ProjectRow {
  id: string;
  title: string;
  head_rev: number;
  turn: "human" | "agent";
  doc_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface RevisionRow {
  project_id: string;
  rev: number;
  base_rev: number | null;
  kind: "create" | "ops" | "restore" | "revert";
  author: string;
  token_id: string | null;
  message: string;
  ops_json: string;
  inverse_json: string;
  touches_json: string;
  overrides_json: string | null;
  warnings_json: string | null;
  rebased: number;
  created_at: string;
  reverts: number | null;
}

export interface CheckpointRow {
  project_id: string;
  name: string;
  rev: number;
  kind: "created" | "handoff" | "agent" | "approved" | "named";
  author: string;
  note: string | null;
  created_at: string;
  /** Hand-offs since DB v4: what Nikola pointed at (JSON FocusItem[]), else null. */
  focus_json?: string | null;
  /** Hand-offs since DB v6, motion projects: the playhead moment he was looking at (ms), else null. */
  at_ms?: number | null;
}

export type DispatchState = "pending" | "claimed" | "started" | "failed" | "cancelled";

export interface DispatchRow {
  project_id: string;
  checkpoint: string;
  state: DispatchState;
  attempts: number;
  claimed_by: string | null;
  claimed_at: string | null;
  claim_expires_at: number | null;
  job_id: number | null;
  job_status: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** What the host dispatcher last told the server (kept in memory; lost on restart until its next poll). */
export interface DispatcherBeat {
  seenAt: number;
  enabled: boolean;
  busy: string | null;
  instance: string;
}

/** A claim lasts this long; a claim older than this is orphaned (the dispatcher died mid-start). */
export const DISPATCH_CLAIM_MS = 10 * 60 * 1000;
/** The editor calls the dispatcher offline when it has not polled for this long. */
export const DISPATCHER_STALE_MS = 2 * 60 * 1000;

export interface Lease {
  holder: string;
  expiresAt: string;
  secondsLeft: number;
}

export interface ApplyInput {
  base: number;
  ops: unknown;
  message: string;
  /** '<node>.<path>' → reason. Only meaningful for agents. */
  overridePins?: Record<string, string>;
  dryRun?: boolean;
  kind?: "ops" | "restore" | "revert";
  /** For kind 'revert': the revision being undone. */
  reverts?: number;
}

export interface ApplyOutcome {
  project: string;
  rev: number;
  base: number;
  rebased: boolean;
  dryRun: boolean;
  warnings: Issue[];
  overridden: Array<{ key: string; reason: string }>;
  text: Record<string, { lines: number; overflowX: number; overflowY: number }>;
  doc?: Document;
}

const now = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CHECKPOINT_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** brand-kits/ in the repo: kit JSON, templates and their assets. */
export const BRAND_KITS_DIR = fileURLToPath(new URL("../../../brand-kits/", import.meta.url));

export function newProjectId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return "prj_" + [...randomBytes(12)].map((b) => alphabet[b % 32]).join("");
}

export interface StoreOptions {
  dataDir: string;
  fonts: FontRegistry;
  /** Override the clock (tests). */
  clock?: () => number;
}

export class Store {
  readonly db: DB;
  readonly assets: AssetFiles;
  readonly fonts: FontRegistry;
  readonly auth: EditorAuth;
  private clock: () => number;
  private measure: ReturnType<typeof measureTextFor>;
  private beat: DispatcherBeat | undefined;

  constructor(public readonly opts: StoreOptions) {
    this.db = openDb(join(opts.dataDir, "post-studio.db"));
    this.assets = new AssetFiles(join(opts.dataDir, "assets"));
    this.fonts = opts.fonts;
    this.clock = opts.clock ?? Date.now;
    this.measure = measureTextFor(opts.fonts);
    this.auth = new EditorAuth(this.db, this.clock);
    this.syncFonts();
  }

  static async open(dataDir: string, fontsDir?: string): Promise<Store> {
    return new Store({ dataDir, fonts: await FontRegistry.load(fontsDir) });
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- fonts

  /** Mirror the registry into the fonts table. Faces failing the 62-letter check are refused. */
  private syncFonts(): void {
    const faces = this.fonts.describe();
    const failing = faces.filter((f) => f.missingMacedonian.length);
    if (failing.length) {
      throw new Error(`fonts fail the Macedonian coverage check: ${failing.map((f) => `${f.family} ${f.weightMin} (${f.missingMacedonian.join("")})`).join("; ")}`);
    }
    const upsert = this.db.prepare(
      `INSERT INTO fonts (id, family, weight_min, weight_max, variable, files_json, mk_missing, registered_at)
       VALUES (@id, @family, @weight_min, @weight_max, @variable, @files_json, @mk_missing, @registered_at)
       ON CONFLICT(id) DO UPDATE SET files_json = excluded.files_json, mk_missing = excluded.mk_missing,
         registered_at = CASE WHEN fonts.files_json = excluded.files_json THEN fonts.registered_at ELSE excluded.registered_at END`,
    );
    this.db.transaction(() => {
      const ids = new Set<string>();
      for (const f of faces) {
        const id = `${f.family}@${f.weightMin}-${f.weightMax}`;
        ids.add(id);
        upsert.run({
          id,
          family: f.family,
          weight_min: f.weightMin,
          weight_max: f.weightMax,
          variable: f.variable ? 1 : 0,
          files_json: JSON.stringify(f.files),
          mk_missing: f.missingMacedonian.join(""),
          registered_at: now(),
        });
      }
      for (const row of this.db.prepare(`SELECT id FROM fonts`).all() as Array<{ id: string }>) {
        if (!ids.has(row.id)) this.db.prepare(`DELETE FROM fonts WHERE id = ?`).run(row.id);
      }
    })();
  }

  listFonts() {
    return (this.db.prepare(`SELECT * FROM fonts ORDER BY family, weight_min`).all() as any[]).map((r) => ({
      family: r.family,
      weights: [r.weight_min, r.weight_max],
      variable: !!r.variable,
      files: JSON.parse(r.files_json),
      macedonian: r.mk_missing ? `missing ${r.mk_missing}` : "all 62 letters",
      registeredAt: r.registered_at,
    }));
  }

  // ---------------------------------------------------------------- tokens

  createToken(name: string, kind: "agent" | "human"): { id: string; name: string; kind: string; token: string } {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(name)) throw new StoreError(400, "bad-name", "token names are lower-case words like 'optibot-claude'");
    if (this.db.prepare(`SELECT 1 FROM api_tokens WHERE name = ?`).get(name)) {
      throw new StoreError(409, "exists", `a token named '${name}' exists; revoke it first`);
    }
    const token = "pst_" + randomBytes(32).toString("base64url");
    const id = "tok_" + randomBytes(6).toString("hex");
    this.db
      .prepare(`INSERT INTO api_tokens (id, name, kind, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, name, kind, sha(token), token.slice(0, 8), now());
    return { id, name, kind, token };
  }

  listTokens() {
    return this.db.prepare(`SELECT id, name, kind, prefix, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY created_at`).all();
  }

  revokeToken(name: string): boolean {
    return this.db.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL`).run(now(), name).changes > 0;
  }

  /** Bearer token → actor. Undefined when unknown or revoked. */
  authenticate(token: string): (Actor & { name: string; kind: string }) | undefined {
    const row = this.db.prepare(`SELECT id, name, kind FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL`).get(sha(token)) as
      | { id: string; name: string; kind: string }
      | undefined;
    if (!row) return undefined;
    this.db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`).run(now(), row.id);
    return { author: row.kind === "human" ? "human" : `agent:${row.name}`, tokenId: row.id, name: row.name, kind: row.kind };
  }

  // ---------------------------------------------------------------- validation

  validationContext(previous?: Document): ValidationContext {
    return {
      checkFont: (f, w) => this.fonts.checkFont(f, w),
      assetExists: (ref) => this.hasAsset(ref.slice("sha256:".length)),
      measureText: this.measure,
      svgAsset: (ref) => this.svgText(ref.slice("sha256:".length)),
      previous,
    };
  }

  private svgCache = new Map<string, string | undefined>();
  /** SVG asset text (cached: assets never change), for the palette check of svg nodes. */
  svgText(sha256: string): string | undefined {
    if (this.svgCache.has(sha256)) return this.svgCache.get(sha256);
    let text: string | undefined;
    try {
      const a = this.getAsset(sha256);
      text = a.mime === "image/svg+xml" ? a.bytes.toString("utf8") : undefined;
    } catch {
      text = undefined;
    }
    if (text === undefined) return undefined; // maybe not uploaded yet: do not remember a miss
    if (this.svgCache.size > 64) this.svgCache.delete(this.svgCache.keys().next().value!);
    this.svgCache.set(sha256, text);
    return text;
  }

  validate(doc: unknown) {
    return validateDocument(doc, this.validationContext());
  }

  // ---------------------------------------------------------------- projects

  private row(id: string): ProjectRow {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
    if (!row) throw new StoreError(404, "not-found", `project '${id}' not found`);
    return row;
  }

  createProject(input: unknown, actor: Actor, message = "created"): { project: string; rev: number; warnings: Issue[]; doc: Document } {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new StoreError(400, "bad-request", `body must be a ${SCHEMA_VERSION} document`);
    const raw = { ...(input as Record<string, unknown>) };
    raw.schema ??= SCHEMA_VERSION;
    const migrated = migrate(raw).doc;
    const id = newProjectId();
    migrated.id = id;
    const v = validateDocument(migrated, this.validationContext());
    if (!v.ok) throw new StoreError(422, "invalid-document", "document does not validate", { errors: v.errors, warnings: v.warnings });
    const doc = migrated as unknown as Document;
    const t = now();
    const json = JSON.stringify(doc);
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO projects (id, title, head_rev, turn, doc_json, created_by, created_at, updated_at) VALUES (?, ?, 0, 'human', ?, ?, ?, ?)`)
        .run(id, doc.title, json, actor.author, t, t);
      this.insertRevision({ project_id: id, rev: 0, base_rev: null, kind: "create", author: actor.author, token_id: actor.tokenId ?? null, message, ops: [], inverse: [], touches: [], warnings: v.warnings, created_at: t });
      this.db.prepare(`INSERT INTO snapshots (project_id, rev, doc_json, created_at) VALUES (?, 0, ?, ?)`).run(id, json, t);
      this.db.prepare(`INSERT INTO checkpoints (project_id, name, rev, kind, author, note, created_at) VALUES (?, 'created', 0, 'created', ?, ?, ?)`).run(id, actor.author, message, t);
    })();
    return { project: id, rev: 0, warnings: v.warnings, doc };
  }

  /**
   * New project from a lane template (brand-kits/templates): its assets (the LUX logo …) are
   * uploaded from brand-kits/ first, through the normal asset path.
   */
  createFromTemplate(template: string, actor: Actor, opts: { title?: string; lang?: string; message?: string } = {}) {
    const t = templateDoc(template, opts);
    if (!t) throw new StoreError(404, "not-found", `template '${template}' not found (see GET /v1/templates)`);
    for (const [ref, file] of Object.entries(t.assets)) {
      if (this.hasAsset(ref.slice(7))) continue;
      const r = this.addAsset(readFileSync(join(BRAND_KITS_DIR, file)), actor, file.split("/").pop());
      if (r.ref !== ref) throw new StoreError(500, "template-asset", `template asset ${file} hashes to ${r.ref}, expected ${ref}`);
    }
    return this.createProject(t.doc, actor, opts.message ?? `created from template ${template}`);
  }

  /** The brand-kit palette check of a document at a revision (null when it has no kit). */
  palette(id: string, rev?: number) {
    const p = this.getProject(id, rev);
    const kit = getKit(p.doc.brandKit);
    if (!kit) return { project: id, rev: p.rev, kit: p.doc.brandKit ?? null, strict: p.doc.strictPalette === true, check: null };
    const check = checkDocumentPalette(p.doc, kit, { svgAsset: (ref) => this.svgText(ref.slice(7)) });
    return { project: id, rev: p.rev, kit: kit.id, strict: p.doc.strictPalette === true, check };
  }

  listProjects(includeArchived = false) {
    const rows = this.db
      .prepare(
        `SELECT id, title, head_rev, turn, created_by, created_at, updated_at, archived_at,
           (SELECT MAX(rev) FROM checkpoints c WHERE c.project_id = projects.id AND c.kind = 'approved') AS approved_rev
         FROM projects ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY updated_at DESC`,
      )
      .all() as Array<Omit<ProjectRow, "doc_json"> & { approved_rev: number | null }>;
    return rows.map((r) => ({ ...r, lease: this.lease(r.id) ?? null }));
  }

  getProject(id: string, rev?: number) {
    const row = this.row(id);
    const doc = rev === undefined || rev === row.head_rev ? (JSON.parse(row.doc_json) as Document) : this.docAt(id, rev);
    return {
      id: row.id,
      title: row.title,
      rev: rev ?? row.head_rev,
      head: row.head_rev,
      turn: row.turn,
      archived: !!row.archived_at,
      lease: this.lease(id) ?? null,
      doc,
    };
  }

  archiveProject(id: string): void {
    this.row(id);
    this.db.prepare(`UPDATE projects SET archived_at = ? WHERE id = ?`).run(now(), id);
    this.endOpenDispatches(id, "cancelled", "the project was archived");
  }

  /** Rebuild any revision from the nearest snapshot plus the ops after it. */
  docAt(id: string, rev: number): Document {
    const row = this.row(id);
    if (!Number.isInteger(rev) || rev < 0 || rev > row.head_rev) throw new StoreError(400, "bad-rev", `revision must be 0–${row.head_rev}`);
    if (rev === row.head_rev) return JSON.parse(row.doc_json);
    const snap = this.db.prepare(`SELECT rev, doc_json FROM snapshots WHERE project_id = ? AND rev <= ? ORDER BY rev DESC LIMIT 1`).get(id, rev) as {
      rev: number;
      doc_json: string;
    };
    let doc = JSON.parse(snap.doc_json) as Document;
    const revs = this.db.prepare(`SELECT ops_json FROM revisions WHERE project_id = ? AND rev > ? AND rev <= ? ORDER BY rev`).all(id, snap.rev, rev) as Array<{ ops_json: string }>;
    for (const r of revs) doc = apply(doc, JSON.parse(r.ops_json), { validate: false }).doc;
    return doc;
  }

  // ---------------------------------------------------------------- revisions

  private insertRevision(r: {
    project_id: string;
    rev: number;
    base_rev: number | null;
    kind: RevisionRow["kind"];
    author: string;
    token_id: string | null;
    message: string;
    ops: Op[];
    inverse: Op[];
    touches: Touch[];
    overrides?: Array<{ key: string; reason: string }>;
    warnings?: Issue[];
    rebased?: boolean;
    created_at: string;
    reverts?: number;
  }) {
    this.db
      .prepare(
        `INSERT INTO revisions (project_id, rev, base_rev, kind, author, token_id, message, ops_json, inverse_json, touches_json, overrides_json, warnings_json, rebased, created_at, reverts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.project_id,
        r.rev,
        r.base_rev,
        r.kind,
        r.author,
        r.token_id,
        r.message,
        JSON.stringify(r.ops),
        JSON.stringify(r.inverse),
        JSON.stringify(r.touches),
        r.overrides?.length ? JSON.stringify(r.overrides) : null,
        r.warnings?.length ? JSON.stringify(r.warnings) : null,
        r.rebased ? 1 : 0,
        r.created_at,
        r.reverts ?? null,
      );
  }

  revisions(id: string, opts: { since?: number; to?: number; withOps?: boolean } = {}) {
    this.row(id);
    const rows = this.db
      .prepare(`SELECT * FROM revisions WHERE project_id = ? AND rev > ? AND rev <= ? ORDER BY rev`)
      .all(id, opts.since ?? -1, opts.to ?? Number.MAX_SAFE_INTEGER) as RevisionRow[];
    return rows.map((r) => ({
      rev: r.rev,
      base: r.base_rev,
      kind: r.kind,
      author: r.author,
      message: r.message,
      opCount: JSON.parse(r.ops_json).length as number,
      rebased: !!r.rebased,
      reverts: r.reverts ?? undefined,
      overrides: r.overrides_json ? (JSON.parse(r.overrides_json) as Array<{ key: string; reason: string }>) : [],
      warnings: r.warnings_json ? (JSON.parse(r.warnings_json) as Issue[]).length : 0,
      createdAt: r.created_at,
      ...(opts.withOps ? { ops: JSON.parse(r.ops_json) as Op[] } : {}),
    }));
  }

  revision(id: string, rev: number) {
    const r = this.db.prepare(`SELECT * FROM revisions WHERE project_id = ? AND rev = ?`).get(id, rev) as RevisionRow | undefined;
    if (!r) throw new StoreError(404, "not-found", `revision ${rev} not found`);
    return {
      rev: r.rev,
      base: r.base_rev,
      kind: r.kind,
      author: r.author,
      message: r.message,
      ops: JSON.parse(r.ops_json),
      inverse: JSON.parse(r.inverse_json),
      touches: JSON.parse(r.touches_json),
      overrides: r.overrides_json ? JSON.parse(r.overrides_json) : [],
      warnings: r.warnings_json ? JSON.parse(r.warnings_json) : [],
      rebased: !!r.rebased,
      reverts: r.reverts ?? undefined,
      createdAt: r.created_at,
    };
  }

  /** The heart of the API: pins → lease → rebase-or-conflict → validate → one new revision. */
  applyOps(id: string, input: ApplyInput, actor: Actor): ApplyOutcome {
    const parsed = OpBatchSchema.safeParse(input.ops);
    if (!parsed.success) {
      throw new StoreError(422, "invalid-ops", "op batch does not match the op schema", {
        errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const ops = parsed.data as Op[];
    if (!Number.isInteger(input.base)) throw new StoreError(400, "bad-base", "base revision is required (the rev you read)");
    if (!input.message?.trim()) throw new StoreError(400, "bad-message", "a message is required");

    const run = () => {
      const row = this.row(id);
      if (row.archived_at) throw new StoreError(409, "archived", "project is archived");
      if (input.base < 0 || input.base > row.head_rev) throw new StoreError(400, "bad-base", `base must be 0–${row.head_rev}`);
      this.assertCanWrite(id, actor);
      if (isAgent(actor.author)) this.assertAgentTurn(id, row, "write");
      const head = JSON.parse(row.doc_json) as Document;

      let overridden: Array<{ key: string; reason: string }> = [];
      if (isAgent(actor.author)) {
        const pins = this.effectivePins(id, head);
        const check = checkPins(head, ops, pins, input.overridePins ?? {});
        if (!check.ok) {
          throw new StoreError(422, "pinned", `${check.blocked.length} op(s) touch properties Nikola pinned or changed since your last turn`, {
            blocked: check.blocked.map((b: PinViolation) => ({ op: b.opIndex, key: b.key, source: b.pin.source, message: b.message })),
          });
        }
        overridden = check.overridden.map((o) => ({ key: o.key, reason: o.reason }));
      }

      let result: { doc: Document; inverse: Op[] };
      let rebased = false;
      try {
        if (input.base === row.head_rev) {
          result = apply(head, ops);
        } else {
          const base = this.docAt(id, input.base);
          const theirs = this.db
            .prepare(`SELECT rev, touches_json FROM revisions WHERE project_id = ? AND rev > ? ORDER BY rev`)
            .all(id, input.base)
            .flatMap((r: any) => (JSON.parse(r.touches_json) as Touch[]).map((t) => ({ ...t, rev: r.rev as number })));
          const rb = rebaseOrConflict(base, head, ops, theirs);
          if (!rb.ok) {
            throw new StoreError(409, "conflict", rb.error ?? `someone changed the same properties since rev ${input.base}; re-read and retry`, {
              head: row.head_rev,
              conflicts: rb.conflicts.map((c: Conflict) => ({ node: c.node, path: c.path, theirs: c.theirs, rev: c.rev })),
            });
          }
          result = rb;
          rebased = rb.rebased;
        }
      } catch (e) {
        if (e instanceof OpError) {
          throw new StoreError(422, e.code === "invalid-document" ? "invalid-document" : "invalid-ops", e.message, { opIndex: e.opIndex, code: e.code, errors: e.details });
        }
        throw e;
      }

      const v = validateDocument(result.doc, this.validationContext(head));
      if (!v.ok) throw new StoreError(422, "invalid-document", "the result does not validate", { errors: v.errors, warnings: v.warnings });
      const text = Object.fromEntries(Object.entries(v.text ?? {}).map(([k, m]) => [k, { lines: m.lines, overflowX: round(m.overflowX), overflowY: round(m.overflowY) }]));
      const rev = row.head_rev + 1;
      const outcome: ApplyOutcome = { project: id, rev, base: input.base, rebased, dryRun: !!input.dryRun, warnings: v.warnings, overridden, text };
      if (input.dryRun) return { ...outcome, rev: row.head_rev, doc: result.doc };

      const t = now();
      const json = JSON.stringify(result.doc);
      this.insertRevision({
        project_id: id,
        rev,
        base_rev: input.base,
        kind: input.kind ?? "ops",
        author: actor.author,
        token_id: actor.tokenId ?? null,
        message: input.message.trim(),
        ops,
        inverse: result.inverse,
        touches: footprint(head, ops),
        overrides: overridden,
        warnings: v.warnings,
        rebased,
        created_at: t,
        reverts: input.reverts,
      });
      this.db.prepare(`UPDATE projects SET doc_json = ?, head_rev = ?, title = ?, updated_at = ? WHERE id = ?`).run(json, rev, result.doc.title, t, id);
      if (rev % LIMITS.snapshotEvery === 0) {
        this.db.prepare(`INSERT INTO snapshots (project_id, rev, doc_json, created_at) VALUES (?, ?, ?, ?)`).run(id, rev, json, t);
      }
      return outcome;
    };
    return this.db.transaction(run).immediate();
  }

  /** A restore is a new revision that undoes everything after `rev`. History is never rewritten. */
  restore(id: string, rev: number, actor: Actor, message?: string): ApplyOutcome {
    const row = this.row(id);
    if (!Number.isInteger(rev) || rev < 0 || rev >= row.head_rev) throw new StoreError(400, "bad-rev", `restore target must be 0–${row.head_rev - 1}`);
    const later = this.db.prepare(`SELECT inverse_json FROM revisions WHERE project_id = ? AND rev > ? ORDER BY rev DESC`).all(id, rev) as Array<{ inverse_json: string }>;
    const ops = later.flatMap((r) => JSON.parse(r.inverse_json) as Op[]);
    if (!ops.length) throw new StoreError(400, "nothing-to-restore", "no changes after that revision");
    return this.applyOps(id, { base: row.head_rev, ops, message: message ?? `restore to rev ${rev}`, kind: "restore" }, actor);
  }

  /**
   * Undo one past revision as a new revision. Its inverse ops are rebased over everything written
   * since: when a later revision changed the same properties, nothing is written (409) and the
   * message names them. Agents still go through pins, so an agent cannot revert his tweaks.
   */
  revert(id: string, rev: number, actor: Actor, message?: string): ApplyOutcome {
    const row = this.row(id);
    if (!Number.isInteger(rev) || rev < 1 || rev > row.head_rev) {
      throw new StoreError(400, "bad-rev", row.head_rev ? `revert target must be 1–${row.head_rev} (rev 0 is the creation)` : "nothing to revert yet");
    }
    const r = this.db.prepare(`SELECT message, inverse_json FROM revisions WHERE project_id = ? AND rev = ?`).get(id, rev) as { message: string; inverse_json: string };
    const inverse = JSON.parse(r.inverse_json) as Op[];
    if (!inverse.length) throw new StoreError(400, "nothing-to-revert", `revision ${rev} changed nothing`);
    try {
      return this.applyOps(id, { base: rev, ops: inverse, message: message?.trim() || `revert rev ${rev} (“${r.message}”)`, kind: "revert", reverts: rev }, actor);
    } catch (e) {
      if (e instanceof StoreError && e.code === "conflict") {
        const cs = ((e.details as any)?.conflicts ?? []) as Array<{ node: string; path: string; theirs: string; rev?: number }>;
        const seen = new Set<string>();
        const named = cs
          .map((c) => `${c.node}${c.theirs === "*" ? " (added / deleted" : c.theirs === "#parent" ? " (moved" : c.theirs === "#children" ? " (its layers" : `.${c.theirs} (`}${c.theirs.startsWith("#") || c.theirs === "*" ? ", " : ""}rev ${c.rev})`)
          .filter((x) => !seen.has(x) && seen.add(x));
        const later = [...new Set(cs.map((c) => c.rev).filter((x): x is number => x !== undefined))].sort((a, b) => b - a);
        const what = named.length ? `later changes touch the same things: ${named.slice(0, 4).join(", ")}${named.length > 4 ? ` and ${named.length - 4} more` : ""}` : (e.message ?? "later changes are in the way");
        throw new StoreError(
          409,
          "conflict",
          `rev ${rev} can't be reverted on its own: ${what}. Revert ${later.length ? `rev ${later.join(", ")} first` : "the later change first"}, or restore an older version.`,
          { ...(e.details as object), revert: rev, later },
        );
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------- checkpoints, turns, leases

  checkpoints(id: string) {
    this.row(id);
    const rows = this.db.prepare(`SELECT * FROM checkpoints WHERE project_id = ? ORDER BY rev, created_at`).all(id) as CheckpointRow[];
    return rows.map(({ focus_json, at_ms, ...c }) => ({ ...c, focus: focus_json ? (JSON.parse(focus_json) as FocusItem[]) : null, at: at_ms ?? null }));
  }

  createCheckpoint(id: string, name: string, actor: Actor, note?: string, kind: CheckpointRow["kind"] = "named"): CheckpointRow {
    const row = this.row(id);
    if (!CHECKPOINT_RE.test(name)) throw new StoreError(400, "bad-name", "checkpoint names are lower-case words like 'approved' or 'v2'");
    if (kind === "named" && /^(created|handoff-\d+|agent-\d+|approved-\d+)$/.test(name)) throw new StoreError(400, "reserved", `'${name}' is reserved for the hand-off flow`);
    if ((name === "approved" || kind === "approved") && isAgent(actor.author)) throw new StoreError(403, "human-only", "only Nikola approves");
    if (this.db.prepare(`SELECT 1 FROM checkpoints WHERE project_id = ? AND name = ?`).get(id, name)) {
      throw new StoreError(409, "exists", `checkpoint '${name}' exists`);
    }
    const cp: CheckpointRow = {
      project_id: id,
      name,
      rev: row.head_rev,
      kind: name === "approved" ? "approved" : kind,
      author: actor.author,
      note: note ?? null,
      created_at: now(),
    };
    this.db.prepare(`INSERT INTO checkpoints (project_id, name, rev, kind, author, note, created_at) VALUES (@project_id, @name, @rev, @kind, @author, @note, @created_at)`).run(cp);
    return cp;
  }

  /** Resolve a revision reference: a number, a checkpoint name, 'head', 'last-agent', 'last-handoff' or 'last-approved'. */
  resolveRef(id: string, ref: string | number | undefined, fallback: "head" | "last-agent" = "head"): number {
    const row = this.row(id);
    const r = ref === undefined || ref === "" ? fallback : String(ref);
    if (r === "head") return row.head_rev;
    if (/^\d+$/.test(r)) {
      const n = Number(r);
      if (n > row.head_rev) throw new StoreError(400, "bad-rev", `revision must be 0–${row.head_rev}`);
      return n;
    }
    if (r === "last-agent") return this.lastAgentCheckpoint(id).rev;
    if (r === "last-approved") {
      const cp = this.lastCheckpoint(id, "approved");
      if (!cp) throw new StoreError(404, "not-found", "not approved yet");
      return cp.rev;
    }
    if (r === "last-handoff") {
      const cp = this.db.prepare(`SELECT rev FROM checkpoints WHERE project_id = ? AND kind = 'handoff' ORDER BY rev DESC, created_at DESC LIMIT 1`).get(id) as { rev: number } | undefined;
      if (!cp) throw new StoreError(404, "not-found", "no hand-off yet");
      return cp.rev;
    }
    const cp = this.db.prepare(`SELECT rev FROM checkpoints WHERE project_id = ? AND name = ?`).get(id, r) as { rev: number } | undefined;
    if (!cp) throw new StoreError(404, "not-found", `no checkpoint '${r}'`);
    return cp.rev;
  }

  /** Latest 'agent-N' checkpoint, else 'created'. Soft pins and the default diff start here. */
  lastAgentCheckpoint(id: string): CheckpointRow {
    return this.db
      .prepare(`SELECT * FROM checkpoints WHERE project_id = ? AND kind IN ('agent', 'created') ORDER BY rev DESC, created_at DESC LIMIT 1`)
      .get(id) as CheckpointRow;
  }

  softPins(id: string): Pin[] {
    const since = this.lastAgentCheckpoint(id).rev;
    const revs = this.db.prepare(`SELECT rev, author, ops_json FROM revisions WHERE project_id = ? AND rev > ? ORDER BY rev`).all(id, since) as Array<{
      rev: number;
      author: string;
      ops_json: string;
    }>;
    return softPinsFromRevisions(revs.map((r) => ({ rev: r.rev, author: r.author, ops: JSON.parse(r.ops_json) })));
  }

  /** Revisions Nikola wrote since the agent's last checkpoint (the ones that make soft pins). */
  private humanEditsSinceAgent(id: string): number {
    const since = this.lastAgentCheckpoint(id).rev;
    const rows = this.db.prepare(`SELECT ops_json FROM revisions WHERE project_id = ? AND rev > ? AND author = 'human'`).all(id, since) as Array<{ ops_json: string }>;
    // Moving frames around the editor canvas is not a change to the design (no soft pins either).
    return rows.filter((r) => !canvasOnly(JSON.parse(r.ops_json) as Op[])).length;
  }

  /**
   * Turns (PLAN §3.6). In Nikola's turn an agent may only write (or hand back) until he makes his
   * first change: that covers polishing a project right after creating it, and stops an agent from
   * editing under him or resetting his soft pins with a hand-back he never asked for.
   */
  private assertAgentTurn(id: string, row: ProjectRow, what: "write" | "lease" | "hand back"): void {
    if (row.turn === "agent") return;
    if (what !== "lease" && this.humanEditsSinceAgent(id) === 0) return;
    throw new StoreError(
      409,
      "not-your-turn",
      what === "lease"
        ? "it is Nikola's turn: take the lease after he hands the project to you (pstudio handoff show)"
        : `it is Nikola's turn and he has changed the project since your last turn; you can ${what} again after he hands it to you`,
      { turn: row.turn },
    );
  }

  effectivePins(id: string, doc?: Document): Pin[] {
    const d = doc ?? (JSON.parse(this.row(id).doc_json) as Document);
    return effectivePins(d, this.softPins(id));
  }

  pins(id: string) {
    const doc = JSON.parse(this.row(id).doc_json) as Document;
    return { since: this.lastAgentCheckpoint(id).name, explicit: explicitPins(doc), soft: this.softPins(id), effective: effectivePins(doc, this.softPins(id)) };
  }

  lease(id: string): Lease | undefined {
    const l = this.db.prepare(`SELECT holder, expires_at FROM leases WHERE project_id = ?`).get(id) as { holder: string; expires_at: number } | undefined;
    if (!l || l.expires_at <= this.clock()) return undefined;
    return { holder: l.holder, expiresAt: new Date(l.expires_at).toISOString(), secondsLeft: Math.round((l.expires_at - this.clock()) / 1000) };
  }

  /** Nobody else may write while an agent holds the lease. */
  private assertCanWrite(id: string, actor: Actor): void {
    const l = this.lease(id);
    if (l && l.holder !== actor.author) {
      throw new StoreError(423, "leased", `${l.holder} is working on this project (lease ends in ${l.secondsLeft}s)`, { lease: l });
    }
  }

  takeLease(id: string, actor: Actor, seconds: number = LIMITS.leaseDefaultSeconds): Lease {
    if (!isAgent(actor.author)) throw new StoreError(403, "agent-only", "leases are for agents; the editor is read-only while one is held");
    const s = Math.min(Math.max(30, Math.round(seconds)), LIMITS.leaseMaxSeconds);
    return this.db
      .transaction(() => {
        const row = this.row(id);
        this.assertCanWrite(id, actor);
        this.assertAgentTurn(id, row, "lease");
        this.db
          .prepare(`INSERT INTO leases (project_id, holder, token_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(project_id) DO UPDATE SET holder = excluded.holder, token_id = excluded.token_id, expires_at = excluded.expires_at`)
          .run(id, actor.author, actor.tokenId ?? null, this.clock() + s * 1000, now());
        return this.lease(id)!;
      })
      .immediate();
  }

  releaseLease(id: string, actor: Actor): boolean {
    const l = this.lease(id);
    if (l && l.holder !== actor.author && isAgent(actor.author)) throw new StoreError(423, "leased", `lease is held by ${l.holder}`);
    return this.db.prepare(`DELETE FROM leases WHERE project_id = ?`).run(id).changes > 0;
  }

  /**
   * Nikola presses Hand to agent: checkpoint handoff-N with his note (and what he pointed at,
   * and for a motion project the moment he was looking at), turn flips to agent, and a pending
   * dispatch row asks the host dispatcher to start a worker.
   */
  handoff(id: string, actor: Actor, note: string, focus?: unknown, at?: unknown) {
    if (isAgent(actor.author)) throw new StoreError(403, "human-only", "agents hand back with 'handoff back'");
    return this.db
      .transaction(() => {
        const row = this.row(id);
        if (row.archived_at) throw new StoreError(409, "archived", "project is archived");
        this.assertCanWrite(id, actor);
        let items: FocusItem[];
        let atMs: number | null;
        const current = JSON.parse(row.doc_json) as Document;
        try {
          items = parseFocus(focus, current);
        } catch (e) {
          if (e instanceof FocusError) throw new StoreError(e.status, "bad-focus", e.message, e.details);
          throw e;
        }
        try {
          atMs = parseAt(at, current);
        } catch (e) {
          if (e instanceof FocusError) throw new StoreError(e.status, "bad-at", e.message, e.details);
          throw e;
        }
        const n = (this.db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE project_id = ? AND kind = 'handoff'`).get(id) as { n: number }).n + 1;
        const cp = this.createCheckpoint(id, `handoff-${n}`, actor, note?.trim() || "(no note)", "handoff");
        if (items.length) this.db.prepare(`UPDATE checkpoints SET focus_json = ? WHERE project_id = ? AND name = ?`).run(JSON.stringify(items), id, cp.name);
        if (atMs !== null) this.db.prepare(`UPDATE checkpoints SET at_ms = ? WHERE project_id = ? AND name = ?`).run(atMs, id, cp.name);
        this.db.prepare(`UPDATE projects SET turn = 'agent', updated_at = ? WHERE id = ?`).run(now(), id);
        // A hand-off supersedes any earlier one that never started.
        this.endOpenDispatches(id, "cancelled", "superseded by a newer hand-off");
        const t = now();
        this.db
          .prepare(`INSERT INTO dispatches (project_id, checkpoint, state, attempts, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?)`)
          .run(id, cp.name, t, t);
        return { checkpoint: cp.name, rev: row.head_rev, turn: "agent" as const, focus: items, at: atMs };
      })
      .immediate();
  }

  /** The agent finishes its turn: checkpoint agent-N with a summary, lease released, turn back to human. */
  handBack(id: string, actor: Actor, summary: string) {
    if (!isAgent(actor.author)) throw new StoreError(403, "agent-only", "only agents hand back");
    if (!summary?.trim()) throw new StoreError(400, "bad-summary", "a one-line summary is required");
    return this.db
      .transaction(() => {
        const row = this.row(id);
        this.assertCanWrite(id, actor);
        this.assertAgentTurn(id, row, "hand back");
        const n = (this.db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE project_id = ? AND kind = 'agent'`).get(id) as { n: number }).n + 1;
        const cp = this.createCheckpoint(id, `agent-${n}`, actor, summary.trim(), "agent");
        this.db.prepare(`DELETE FROM leases WHERE project_id = ?`).run(id);
        this.db.prepare(`UPDATE projects SET turn = 'human', updated_at = ? WHERE id = ?`).run(now(), id);
        // Someone already did the turn (e.g. a worker started by hand): never start another for it.
        this.endOpenDispatches(id, "cancelled", `${actor.author} handed back before a job was started`);
        return { checkpoint: cp.name, rev: row.head_rev, turn: "human" as const };
      })
      .immediate();
  }

  /** Nikola takes the project back before the agent started (or after its lease ran out). */
  takeBack(id: string, actor: Actor) {
    if (isAgent(actor.author)) throw new StoreError(403, "human-only", "agents hand back with 'handoff back'");
    return this.db
      .transaction(() => {
        const row = this.row(id);
        this.assertCanWrite(id, actor);
        if (row.turn === "agent") this.db.prepare(`UPDATE projects SET turn = 'human', updated_at = ? WHERE id = ?`).run(now(), id);
        // Not started yet → never start. A claim in flight finishes; its worker sees turn 'human' and stops.
        this.endOpenDispatches(id, "cancelled", "Nikola took it back");
        return { rev: row.head_rev, turn: "human" as const, changed: row.turn === "agent" };
      })
      .immediate();
  }

  // ---------------------------------------------------------------- hand-off dispatch (host dispatcher)

  /** pending / failed rows of a project → `state` (cancelled), so the dispatcher never starts them. */
  private endOpenDispatches(id: string, state: "cancelled", reason: string): void {
    this.db
      .prepare(`UPDATE dispatches SET state = ?, error = ?, updated_at = ? WHERE project_id = ? AND state IN ('pending', 'failed')`)
      .run(state, reason, now(), id);
  }

  private dispatchRow(id: string, checkpoint: string): DispatchRow | undefined {
    return this.db.prepare(`SELECT * FROM dispatches WHERE project_id = ? AND checkpoint = ?`).get(id, checkpoint) as DispatchRow | undefined;
  }

  private dispatchOrThrow(id: string, checkpoint: string): DispatchRow {
    this.row(id);
    const d = this.dispatchRow(id, checkpoint);
    if (!d) throw new StoreError(404, "not-found", `no dispatch for ${id} ${checkpoint}`);
    return d;
  }

  private dispatchJson(d: DispatchRow) {
    return {
      project: d.project_id,
      checkpoint: d.checkpoint,
      state: d.state,
      attempts: d.attempts,
      claimedBy: d.claimed_by,
      claimExpired: d.state === "claimed" && (d.claim_expires_at ?? 0) <= this.clock(),
      jobId: d.job_id,
      jobStatus: d.job_status,
      error: d.error,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    };
  }

  /** Why a hand-off must not get a worker now, or undefined when it may. */
  private notDispatchable(id: string, checkpoint: string): string | undefined {
    const row = this.row(id);
    if (row.archived_at) return "the project is archived";
    if (row.turn !== "agent") return "it is Nikola's turn again (taken back)";
    const latest = this.lastCheckpoint(id, "handoff");
    if (latest?.name !== checkpoint) return `a newer hand-off (${latest?.name}) replaced it`;
    const l = this.lease(id);
    if (l) return `${l.holder} is already working on it`;
    return undefined;
  }

  /**
   * The dispatcher's poll: records its heartbeat and returns the work. `pending` rows wait for a
   * start; `claimed` rows are in flight (an expired claim or one by another instance is orphaned:
   * the dispatcher recovers it without starting a second job).
   */
  dispatchPoll(beat: { enabled: boolean; busy?: string | null; instance: string }) {
    this.beat = { seenAt: this.clock(), enabled: !!beat.enabled, busy: beat.busy ?? null, instance: beat.instance };
    const rows = this.db.prepare(`SELECT * FROM dispatches WHERE state IN ('pending', 'claimed') ORDER BY created_at, project_id`).all() as DispatchRow[];
    return {
      items: rows.map((d) => {
        const row = this.row(d.project_id);
        const cp = this.db.prepare(`SELECT * FROM checkpoints WHERE project_id = ? AND name = ?`).get(d.project_id, d.checkpoint) as CheckpointRow | undefined;
        return {
          ...this.dispatchJson(d),
          title: row.title,
          rev: cp?.rev ?? null,
          note: cp?.note ?? null,
          focus: cp?.focus_json ? (JSON.parse(cp.focus_json) as FocusItem[]) : [],
          at: cp?.at_ms ?? null,
          /** A motion project: the worker also reads the timeline and looks at a contact sheet. */
          motion: !!(JSON.parse(row.doc_json) as Document).motion,
        };
      }),
    };
  }

  /** pending → claimed (attempts + 1). Refused with 409 when the hand-off is no longer current (row → cancelled). */
  dispatchClaim(id: string, checkpoint: string, instance: string) {
    const r = this.db
      .transaction(() => {
        const d = this.dispatchOrThrow(id, checkpoint);
        if (d.state !== "pending") throw new StoreError(409, "not-pending", `dispatch ${id} ${checkpoint} is ${d.state}`, { dispatch: this.dispatchJson(d) });
        const why = this.notDispatchable(id, checkpoint);
        if (why) {
          // Committed (not thrown inside the transaction, which would roll it back).
          this.db.prepare(`UPDATE dispatches SET state = 'cancelled', error = ?, updated_at = ? WHERE project_id = ? AND checkpoint = ?`).run(why, now(), id, checkpoint);
          return { refused: why, dispatch: this.dispatchJson(this.dispatchRow(id, checkpoint)!) };
        }
        this.db
          .prepare(
            `UPDATE dispatches SET state = 'claimed', attempts = attempts + 1, claimed_by = ?, claimed_at = ?, claim_expires_at = ?, error = NULL, updated_at = ?
             WHERE project_id = ? AND checkpoint = ?`,
          )
          .run(instance, now(), this.clock() + DISPATCH_CLAIM_MS, now(), id, checkpoint);
        return { refused: undefined, dispatch: this.dispatchJson(this.dispatchRow(id, checkpoint)!) };
      })
      .immediate();
    if (r.refused) throw new StoreError(409, "not-dispatchable", r.refused, { dispatch: r.dispatch });
    return r.dispatch;
  }

  /** claimed → started with the runner's job id. Repeating it with the same job id is a no-op. */
  dispatchStarted(id: string, checkpoint: string, jobId: number, jobStatus?: string) {
    if (!Number.isInteger(jobId) || jobId < 1) throw new StoreError(400, "bad-request", "jobId is the runner's job number");
    return this.db
      .transaction(() => {
        const d = this.dispatchOrThrow(id, checkpoint);
        if (d.state === "started" && d.job_id === jobId) return this.dispatchJson(d);
        if (d.state !== "claimed") throw new StoreError(409, "not-claimed", `dispatch ${id} ${checkpoint} is ${d.state}${d.job_id ? ` (job #${d.job_id})` : ""}`, { dispatch: this.dispatchJson(d) });
        this.db
          .prepare(`UPDATE dispatches SET state = 'started', job_id = ?, job_status = ?, error = NULL, claim_expires_at = NULL, updated_at = ? WHERE project_id = ? AND checkpoint = ?`)
          .run(jobId, typeof jobStatus === "string" ? jobStatus.slice(0, 20) : null, now(), id, checkpoint);
        return this.dispatchJson(this.dispatchRow(id, checkpoint)!);
      })
      .immediate();
  }

  /** claimed → failed with a plain reason the editor shows him. Repeating it is a no-op. */
  dispatchFailed(id: string, checkpoint: string, error: string) {
    const reason = (typeof error === "string" && error.trim() ? error.trim() : "the agent job could not be started").slice(0, 300);
    return this.db
      .transaction(() => {
        const d = this.dispatchOrThrow(id, checkpoint);
        if (d.state === "failed") return this.dispatchJson(d);
        if (d.state !== "claimed") throw new StoreError(409, "not-claimed", `dispatch ${id} ${checkpoint} is ${d.state}`, { dispatch: this.dispatchJson(d) });
        this.db
          .prepare(`UPDATE dispatches SET state = 'failed', error = ?, claim_expires_at = NULL, updated_at = ? WHERE project_id = ? AND checkpoint = ?`)
          .run(reason, now(), id, checkpoint);
        return this.dispatchJson(this.dispatchRow(id, checkpoint)!);
      })
      .immediate();
  }

  /**
   * Nikola presses Retry: the latest hand-off's failed dispatch → pending. A hand-off with no
   * dispatch (made before auto-start existed) gets a pending one. Human only, agent turn only.
   */
  retryDispatch(id: string, actor: Actor) {
    if (isAgent(actor.author)) throw new StoreError(403, "human-only", "only Nikola retries a hand-off");
    return this.db
      .transaction(() => {
        const row = this.row(id);
        if (row.turn !== "agent") throw new StoreError(409, "not-your-turn", "it is your turn; hand the project to the agent instead");
        const cp = this.lastCheckpoint(id, "handoff");
        if (!cp) throw new StoreError(409, "no-handoff", "no hand-off yet");
        const l = this.lease(id);
        if (l) throw new StoreError(423, "leased", `${l.holder} is already working on it`, { lease: l });
        const d = this.dispatchRow(id, cp.name);
        const t = now();
        if (!d) {
          this.db.prepare(`INSERT INTO dispatches (project_id, checkpoint, state, attempts, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?)`).run(id, cp.name, t, t);
        } else if (d.state === "failed" || d.state === "cancelled") {
          this.db.prepare(`UPDATE dispatches SET state = 'pending', error = NULL, updated_at = ? WHERE project_id = ? AND checkpoint = ?`).run(t, id, cp.name);
        } else {
          throw new StoreError(409, "not-failed", `the agent job is already ${d.state === "started" ? `started (#${d.job_id})` : d.state}`, { dispatch: this.dispatchJson(d) });
        }
        return this.dispatchJson(this.dispatchRow(id, cp.name)!);
      })
      .immediate();
  }

  /** The dispatcher as the editor sees it: online (polled recently), switched on, busy reason. */
  dispatcherStatus() {
    const b = this.beat;
    if (!b) return { online: false, enabled: false, busy: null, seenAt: null };
    return { online: this.clock() - b.seenAt < DISPATCHER_STALE_MS, enabled: b.enabled, busy: b.busy, seenAt: new Date(b.seenAt).toISOString() };
  }

  /** Nikola approves the head revision: checkpoint 'approved' (then 'approved-2', …). Human only. */
  approve(id: string, actor: Actor, note?: string) {
    if (isAgent(actor.author)) throw new StoreError(403, "human-only", "only Nikola approves");
    return this.db
      .transaction(() => {
        const row = this.row(id);
        if (row.archived_at) throw new StoreError(409, "archived", "project is archived");
        this.assertCanWrite(id, actor);
        if (row.turn === "agent") throw new StoreError(409, "not-your-turn", "the agent has the turn; wait for it to hand back (or take it back) before approving");
        const last = this.lastCheckpoint(id, "approved");
        if (last && last.rev === row.head_rev) throw new StoreError(409, "already-approved", `rev ${row.head_rev} is already approved (${last.name})`);
        const taken = (n: string) => !!this.db.prepare(`SELECT 1 FROM checkpoints WHERE project_id = ? AND name = ?`).get(id, n);
        let n = (this.db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE project_id = ? AND kind = 'approved'`).get(id) as { n: number }).n + 1;
        let name = n === 1 ? "approved" : `approved-${n}`;
        while (taken(name)) name = `approved-${++n}`;
        const cp = this.createCheckpoint(id, name, actor, note?.trim() || "approved", "approved");
        return { checkpoint: cp.name, rev: cp.rev, note: cp.note };
      })
      .immediate();
  }

  private lastCheckpoint(id: string, kind: CheckpointRow["kind"]): CheckpointRow | undefined {
    return this.db.prepare(`SELECT * FROM checkpoints WHERE project_id = ? AND kind = ? ORDER BY rev DESC, created_at DESC LIMIT 1`).get(id, kind) as CheckpointRow | undefined;
  }

  /**
   * Where an agent turn started: the checkpoint right before `agentCheckpoint` among created /
   * handoff-N / agent-N. "What the agent changed" is the diff from there to agent-N, so a second
   * hand-off never shows the first turn's edits again.
   */
  turnStart(id: string, agentCheckpoint: string): CheckpointRow | undefined {
    const rows = this.db
      .prepare(`SELECT * FROM checkpoints WHERE project_id = ? AND kind IN ('created', 'handoff', 'agent') ORDER BY created_at, rev`)
      .all(id) as CheckpointRow[];
    const i = rows.findIndex((r) => r.name === agentCheckpoint);
    return i > 0 ? rows[i - 1] : undefined;
  }

  handoffState(id: string) {
    const row = this.row(id);
    const pick = (c: CheckpointRow | undefined) => (c ? { name: c.name, rev: c.rev, author: c.author, note: c.note, created_at: c.created_at } : null);
    const agent = this.lastCheckpoint(id, "agent");
    const handoff = this.lastCheckpoint(id, "handoff");
    const focus = handoff?.focus_json ? (JSON.parse(handoff.focus_json) as FocusItem[]) : [];
    const dispatch = handoff ? this.dispatchRow(id, handoff.name) : undefined;
    const approved = this.lastCheckpoint(id, "approved");
    const since = agent ? this.turnStart(id, agent.name) : undefined;
    return {
      project: id,
      turn: row.turn,
      head: row.head_rev,
      lease: this.lease(id) ?? null,
      handoff: handoff
        ? { ...pick(handoff)!, focus, focusText: focus.length ? focusLine(focus) : null, at: handoff.at_ms ?? null, atText: handoff.at_ms != null ? atText(handoff.at_ms) : null }
        : null,
      /** The auto-start of the latest hand-off (null for hand-offs made before it existed). */
      dispatch: dispatch ? this.dispatchJson(dispatch) : null,
      dispatcher: this.dispatcherStatus(),
      agent: agent ? { ...pick(agent)!, since: since ? { name: since.name, rev: since.rev } : null } : null,
      approved: approved ? { ...pick(approved)!, current: approved.rev === row.head_rev } : null,
      /** Properties Nikola changed since the agent's last checkpoint (the agent cannot touch them). */
      softPins: this.softPins(id).length,
    };
  }

  // ---------------------------------------------------------------- diff / outline

  diff(id: string, since?: string | number, to?: string | number) {
    const from = this.resolveRef(id, since, "last-agent");
    const target = this.resolveRef(id, to, "head");
    if (from > target) throw new StoreError(400, "bad-range", `since (${from}) is after to (${target})`);
    const a = this.docAt(id, from);
    const b = this.docAt(id, target);
    const revs = this.db.prepare(`SELECT rev, author, ops_json FROM revisions WHERE project_id = ? AND rev > ? AND rev <= ? ORDER BY rev`).all(id, from, target) as Array<{
      rev: number;
      author: string;
      ops_json: string;
    }>;
    const d = attribute(
      diffDocs(a, b),
      revs.map((r) => ({ rev: r.rev, author: r.author, ops: JSON.parse(r.ops_json) })),
    );
    return { project: id, from, to: target, items: d.items, unchanged: d.unchanged, text: formatDiff(d) };
  }

  outline(id: string, rev?: number): string {
    const doc = rev === undefined ? (JSON.parse(this.row(id).doc_json) as Document) : this.docAt(id, rev);
    return outline(doc, { pins: rev === undefined ? this.effectivePins(id, doc) : [] });
  }

  /** Text timeline + structured keyframes (pins marked at the head, like outline). */
  timeline(id: string, rev?: number) {
    const head = this.row(id).head_rev as number;
    const doc = rev === undefined ? (JSON.parse(this.row(id).doc_json) as Document) : this.docAt(id, rev);
    const tl = timeline(doc, { pins: rev === undefined || rev === head ? this.effectivePins(id, doc) : [] });
    return { project: id, rev: rev ?? head, ...tl, text: formatTimeline(doc, tl) };
  }

  // ---------------------------------------------------------------- assets

  hasAsset(sha256: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM assets WHERE sha256 = ?`).get(sha256) && this.assets.has(sha256);
  }

  addAsset(bytes: Uint8Array, actor: Actor, originalName?: string) {
    const p = prepareAsset(bytes);
    this.assets.write(p.sha256, p.bytes);
    this.db
      .prepare(`INSERT OR IGNORE INTO assets (sha256, mime, bytes, original_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(p.sha256, p.mime, p.bytes.length, originalName ?? null, actor.author, now());
    return { ref: `sha256:${p.sha256}`, mime: p.mime, bytes: p.bytes.length, sanitized: p.removed };
  }

  getAsset(sha256: string): { mime: string; bytes: Buffer } {
    const row = this.db.prepare(`SELECT mime FROM assets WHERE sha256 = ?`).get(sha256) as { mime: string } | undefined;
    if (!row || !this.assets.has(sha256)) throw new StoreError(404, "not-found", `asset ${sha256} not found`);
    return { mime: row.mime, bytes: this.assets.read(sha256) };
  }

  /** Hash of each project's head document; used by backup manifests and restore checks. */
  projectDigests(): Array<{ id: string; head: number; sha256: string }> {
    return (this.db.prepare(`SELECT id, head_rev, doc_json FROM projects ORDER BY id`).all() as ProjectRow[]).map((r) => ({
      id: r.id,
      head: r.head_rev,
      sha256: sha(r.doc_json),
    }));
  }
}

const round = (n: number) => Math.round(n * 10) / 10;

