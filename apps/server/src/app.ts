import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { getKit, kitJson, listKits, listTemplates } from "@post-studio/brand";
import { documentJsonSchema, SCHEMA_VERSION } from "@post-studio/schema";
import { AssetRejected } from "./assets.ts";
import { AuthError, EDITOR_HEADER, SESSION_COOKIE, clearedCookie, parseCookies, sessionCookie, SESSION_DAYS } from "./auth.ts";
import { DEFAULT_HOST, DEFAULT_PORT, LIMITS } from "./config.ts";
import { registerEditorRoutes } from "./editor.ts";
import { registerRenderRoutes, revParam } from "./render.ts";
import { StoreError, type Actor, type Store } from "./store.ts";
import { registerVideoRoutes, VideoJobs, videoConfigFromEnv, type VideoConfig } from "./video.ts";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor & { name: string; kind: string };
  }
  interface FastifyInstance {
    /** Video export jobs (apps/server/src/video.ts). */
    videos: VideoJobs;
  }
}

export interface AppOptions {
  store: Store;
  /** Base URL used in editorUrl links. */
  publicUrl?: string;
  logger?: boolean;
  /** Built editor (apps/editor/dist). */
  editorDir?: string;
  /**
   * Proxies whose X-Forwarded-For / -Proto are believed (Fastify trustProxy: CIDRs, IPs or true).
   * Behind Traefik this makes req.ip the real client, which the login back-off is keyed on.
   * Default: none (direct connections on 127.0.0.1).
   */
  trustProxy?: boolean | string | string[];
  /** "always" (deployed behind HTTPS): every session cookie is Secure. "auto": only on https requests. */
  secureCookies?: "auto" | "always";
  /**
   * Agent tokens allowed to drive hand-off dispatch (/v1/dispatch/*). Such a token can do nothing
   * else (no project reads or writes). Default: ["studio-dispatcher"].
   */
  dispatcherTokens?: string[];
  /** Video export (ffmpeg, job pool, renders/ cache). Default: from the environment (videoConfigFromEnv). */
  video?: VideoConfig;
}

/** What a dispatcher token may call besides /v1/dispatch/*. */
const DISPATCHER_ALSO = new Set(["/v1/whoami"]);
const PUBLIC = new Set(["/v1/health", "/v1/schema", "/v1/auth/state", "/v1/auth/login", "/v1/auth/logout"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function buildApp(opts: AppOptions): FastifyInstance {
  const { store } = opts;
  const publicUrl = opts.publicUrl ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const dispatchers = new Set(opts.dispatcherTokens ?? ["studio-dispatcher"]);
  const isDispatcher = (req: FastifyRequest) => req.actor?.kind === "agent" && dispatchers.has(req.actor.name);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: LIMITS.jsonBytes, trustProxy: opts.trustProxy ?? false });

  app.addContentTypeParser(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "application/octet-stream"], { parseAs: "buffer", bodyLimit: LIMITS.imageBytes }, (_req, body, done) =>
    done(null, body),
  );

  app.decorateRequest("actor", null as any);
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    // Everything outside /v1 is the editor's static shell; it holds no data.
    if (!path.startsWith("/v1/") || PUBLIC.has(path)) return;
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "");
    if (m) {
      const actor = store.authenticate(m[1]);
      if (!actor) return reply.code(401).send({ error: { code: "unauthorized", message: "unknown or revoked token" } });
      req.actor = actor;
      // Least privilege: the dispatcher token only drives dispatch; a normal token never does.
      const dispatchPath = path.startsWith("/v1/dispatch/");
      if (actor.kind === "agent" && dispatchers.has(actor.name)) {
        if (!dispatchPath && !DISPATCHER_ALSO.has(path)) return reply.code(403).send({ error: { code: "dispatcher-only", message: "the dispatcher token can only call /v1/dispatch/*" } });
      } else if (dispatchPath) {
        return reply.code(403).send({ error: { code: "forbidden", message: "only the dispatcher token calls /v1/dispatch/*" } });
      }
      return;
    }
    // The editor: session cookie. Writes must carry the editor header (CSRF guard on top of SameSite=Strict).
    const session = store.auth.session(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (session) {
      if (!SAFE_METHODS.has(req.method) && req.headers[EDITOR_HEADER] !== "1") {
        return reply.code(403).send({ error: { code: "csrf", message: `editor writes need the ${EDITOR_HEADER} header` } });
      }
      if (path.startsWith("/v1/dispatch/")) return reply.code(403).send({ error: { code: "forbidden", message: "only the dispatcher token calls /v1/dispatch/*" } });
      req.actor = { author: "human", name: "editor", kind: "session" };
      return;
    }
    return reply.code(401).send({ error: { code: "unauthorized", message: "send 'Authorization: Bearer <token>' (create one with: pstudio token create <name>) or log in to the editor" } });
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AuthError) {
      if (err.retryAfter) reply.header("Retry-After", String(err.retryAfter));
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof StoreError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof AssetRejected) return reply.code(err.code === "too-large" ? 413 : err.code === "unsupported-type" ? 415 : 422).send({ error: { code: err.code, message: err.message } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: err.code ?? "bad-request", message: err.message } });
    reply.log.error(err);
    return reply.code(500).send({ error: { code: "internal", message: "internal error" } });
  });

  const P = (req: FastifyRequest) => (req.params as { id: string }).id;
  const Q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
  const B = (req: FastifyRequest) => (req.body ?? {}) as Record<string, any>;
  const int = (v: unknown, name: string) => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new StoreError(400, "bad-request", `${name} must be an integer`);
    return n;
  };
  const editorUrl = (id: string) => `${publicUrl}/p/${id}`;

  // ---- public
  app.get("/v1/health", async () => ({ ok: true, service: "post-studio", schema: SCHEMA_VERSION }));
  app.get("/v1/schema", async () => documentJsonSchema());

  // ---- editor login
  const secure = (req: FastifyRequest) => opts.secureCookies === "always" || req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
  const cookieToken = (req: FastifyRequest) => parseCookies(req.headers.cookie)[SESSION_COOKIE];
  app.get("/v1/auth/state", async (req) => {
    const s = store.auth.session(cookieToken(req));
    return { passwordSet: store.auth.hasPassword(), loggedIn: !!s, username: s ? store.auth.username() : undefined, expiresAt: s ? new Date(s.expiresAt).toISOString() : undefined };
  });
  app.post("/v1/auth/login", async (req, reply) => {
    if (req.headers[EDITOR_HEADER] !== "1") throw new AuthError(403, "csrf", `login needs the ${EDITOR_HEADER} header`);
    const { token, session } = store.auth.login(B(req).password, req.headers["user-agent"], req.ip);
    reply.header("Set-Cookie", sessionCookie(token, { secure: secure(req), maxAgeSeconds: SESSION_DAYS * 86_400 }));
    return { ok: true, username: store.auth.username(), expiresAt: new Date(session.expiresAt).toISOString() };
  });
  app.post("/v1/auth/logout", async (req, reply) => {
    const out = store.auth.logout(cookieToken(req));
    reply.header("Set-Cookie", clearedCookie(secure(req)));
    return { ok: true, ended: out };
  });

  // ---- meta
  app.get("/v1/whoami", async (req) => ({ name: req.actor.name, kind: req.actor.kind, author: req.actor.author }));
  app.get("/v1/fonts", async () => ({ fonts: store.listFonts() }));
  app.post("/v1/validate", async (req) => store.validate(req.body));
  app.get("/v1/brand-kits", async () => ({ kits: listKits().map(kitJson) }));
  app.get("/v1/brand-kits/:kit", async (req) => {
    const kit = getKit((req.params as { kit: string }).kit);
    if (!kit) throw new StoreError(404, "not-found", `brand kit '${(req.params as { kit: string }).kit}' not found (kits: ${listKits().map((k) => k.id).join(", ")})`);
    return kitJson(kit);
  });
  app.get("/v1/templates", async () => ({ templates: listTemplates() }));

  // ---- projects
  app.get("/v1/projects", async (req) => ({ projects: store.listProjects(Q(req).archived === "1") }));
  app.post("/v1/projects", async (req, reply) => {
    const body = B(req);
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    if (typeof body.template === "string") {
      const lang = str(body.lang);
      if (lang && !/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(lang)) throw new StoreError(400, "bad-request", "lang is a BCP 47 language like 'mk'");
      const r = store.createFromTemplate(body.template, req.actor, { title: str(body.title), lang, message: str(body.message) });
      return reply.code(201).send({ project: r.project, rev: r.rev, warnings: r.warnings, editorUrl: editorUrl(r.project), template: body.template });
    }
    const doc = body.doc ?? body;
    const r = store.createProject(doc, req.actor, typeof body.message === "string" ? body.message : "created");
    return reply.code(201).send({ project: r.project, rev: r.rev, warnings: r.warnings, editorUrl: editorUrl(r.project) });
  });
  app.get("/v1/projects/:id", async (req) => {
    const p = store.getProject(P(req), revParam(store, P(req), Q(req).rev, int));
    return { ...p, editorUrl: editorUrl(p.id) };
  });
  app.patch("/v1/projects/:id", async (req) => {
    const body = B(req);
    if (typeof body.title !== "string") throw new StoreError(400, "bad-request", "only 'title' can be patched; use ops for everything else");
    return store.applyOps(P(req), { base: int(body.base, "base") ?? store.getProject(P(req)).head, ops: [{ op: "set", node: "$doc", path: "title", value: body.title }], message: `rename to “${body.title}”` }, req.actor);
  });
  app.delete("/v1/projects/:id", async (req) => {
    store.archiveProject(P(req));
    return { archived: true };
  });

  // ---- ops, history
  app.post("/v1/projects/:id/ops", async (req) => {
    const body = B(req);
    return store.applyOps(
      P(req),
      { base: int(body.base, "base") as number, ops: body.ops, message: body.message, overridePins: body.overridePins, dryRun: !!body.dryRun },
      req.actor,
    );
  });
  app.get("/v1/projects/:id/revisions", async (req) => ({
    revisions: store.revisions(P(req), { since: int(Q(req).since, "since"), withOps: Q(req).ops === "1" }),
  }));
  app.get("/v1/projects/:id/revisions/:rev", async (req) => store.revision(P(req), int((req.params as any).rev, "rev")!));
  app.post("/v1/projects/:id/restore", async (req) => store.restore(P(req), int(B(req).rev, "rev")!, req.actor, B(req).message));
  app.post("/v1/projects/:id/revert", async (req) => {
    const rev = int(B(req).rev, "rev");
    if (rev === undefined) throw new StoreError(400, "bad-request", "rev is required: the revision to undo");
    return store.revert(P(req), rev, req.actor, B(req).message);
  });
  app.post("/v1/projects/:id/approve", async (req) => store.approve(P(req), req.actor, B(req).note));
  app.get("/v1/projects/:id/diff", async (req) => store.diff(P(req), Q(req).since, Q(req).to));
  app.get("/v1/projects/:id/outline", async (req, reply) => {
    const text = store.outline(P(req), revParam(store, P(req), Q(req).rev, int));
    if (Q(req).format === "text") return reply.type("text/plain; charset=utf-8").send(text + "\n");
    return { text };
  });
  app.get("/v1/projects/:id/pins", async (req) => store.pins(P(req)));
  app.get("/v1/projects/:id/timeline", async (req, reply) => {
    const r = store.timeline(P(req), revParam(store, P(req), Q(req).rev, int));
    if (Q(req).format === "text") return reply.type("text/plain; charset=utf-8").send(r.text + "\n");
    return r;
  });
  app.get("/v1/projects/:id/palette", async (req) => store.palette(P(req), revParam(store, P(req), Q(req).rev, int)));

  // ---- checkpoints, hand-off, lease
  app.get("/v1/projects/:id/checkpoints", async (req) => ({ checkpoints: store.checkpoints(P(req)) }));
  app.post("/v1/projects/:id/checkpoints", async (req, reply) => reply.code(201).send(store.createCheckpoint(P(req), B(req).name, req.actor, B(req).note)));
  app.get("/v1/projects/:id/handoff", async (req) => store.handoffState(P(req)));
  app.post("/v1/projects/:id/handoff", async (req) => {
    const r = store.handoff(P(req), req.actor, typeof B(req).note === "string" ? B(req).note : "", B(req).focus, B(req).at);
    return { ...r, editorUrl: editorUrl(P(req)) };
  });
  app.post("/v1/projects/:id/handoff/retry-dispatch", async (req) => store.retryDispatch(P(req), req.actor));
  app.post("/v1/projects/:id/handoff/back", async (req) => store.handBack(P(req), req.actor, B(req).summary));
  app.post("/v1/projects/:id/handoff/take-back", async (req) => store.takeBack(P(req), req.actor));
  app.post("/v1/projects/:id/lease", async (req) => store.takeLease(P(req), req.actor, int(B(req).seconds, "seconds")));
  app.delete("/v1/projects/:id/lease", async (req) => ({ released: store.releaseLease(P(req), req.actor) }));

  // ---- hand-off dispatch (the host dispatcher's token only; see AGENTS.md "Hand-off dispatch")
  const str = (v: unknown, name: string, max = 200) => {
    if (typeof v !== "string" || !v.trim() || v.length > max) throw new StoreError(400, "bad-request", `${name} is required`);
    return v.trim();
  };
  app.post("/v1/dispatch/poll", async (req) => {
    if (!isDispatcher(req)) throw new StoreError(403, "forbidden", "dispatcher only");
    const body = B(req);
    const r = store.dispatchPoll({ enabled: body.enabled !== false, busy: typeof body.busy === "string" ? body.busy.slice(0, 200) : null, instance: str(body.instance, "instance", 80) });
    return { items: r.items.map((i) => ({ ...i, editorUrl: editorUrl(i.project) })) };
  });
  app.post("/v1/dispatch/claim", async (req) => {
    if (!isDispatcher(req)) throw new StoreError(403, "forbidden", "dispatcher only");
    const b = B(req);
    return store.dispatchClaim(str(b.project, "project", 64), str(b.checkpoint, "checkpoint", 40), str(b.instance, "instance", 80));
  });
  app.post("/v1/dispatch/started", async (req) => {
    if (!isDispatcher(req)) throw new StoreError(403, "forbidden", "dispatcher only");
    const b = B(req);
    return store.dispatchStarted(str(b.project, "project", 64), str(b.checkpoint, "checkpoint", 40), int(b.jobId, "jobId") ?? 0, typeof b.jobStatus === "string" ? b.jobStatus : undefined);
  });
  app.post("/v1/dispatch/failed", async (req) => {
    if (!isDispatcher(req)) throw new StoreError(403, "forbidden", "dispatcher only");
    const b = B(req);
    return store.dispatchFailed(str(b.project, "project", 64), str(b.checkpoint, "checkpoint", 40), typeof b.error === "string" ? b.error : "");
  });

  // ---- assets
  app.post("/v1/assets", async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) throw new StoreError(415, "unsupported-type", "send the raw file bytes (Content-Type: application/octet-stream or the image type)");
    const name = typeof req.headers["x-filename"] === "string" ? decodeURIComponent(req.headers["x-filename"]) : undefined;
    return reply.code(201).send(store.addAsset(req.body, req.actor, name));
  });
  app.get("/v1/assets/:sha", async (req, reply: FastifyReply) => {
    const sha = (req.params as { sha: string }).sha.replace(/^sha256:/, "");
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new StoreError(400, "bad-request", "asset ids are 64 hex chars");
    const a = store.getAsset(sha);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.type(a.mime).send(a.bytes);
  });

  // ---- render, export, video
  registerRenderRoutes(app, store, int);
  const videos = new VideoJobs(store, opts.video ?? videoConfigFromEnv());
  app.decorate("videos", videos);
  app.addHook("onClose", async () => videos.close());
  registerVideoRoutes(app, store, videos, int);

  // ---- the editor (static shell + fonts)
  registerEditorRoutes(app, store, opts.editorDir);

  return app;
}
