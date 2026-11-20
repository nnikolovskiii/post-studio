// The hand-off dispatcher (PLAN Phase 8 extra): runs on the host (the server) as the user service
// post-studio-dispatch.service, outside the container. Every poll it asks the Post Studio API
// for hand-offs that have no agent job yet, claims one, starts one OptiBot session job for it with
// telegram-mcp/bin/sessions.py, and marks it started (with the job id) or failed. The container
// never sees the session runner, the Telegram token or the workspace; the dispatcher's own token
// can only call /v1/dispatch/*.
//
// Exactly one job per hand-off, also across crashes: claim before start (at most once). A claim
// whose dispatcher died before it marked the result is "orphaned": the next dispatcher looks the
// job up in the runner by its unique --source and adopts it, or marks the hand-off failed (he can
// press Retry). It never starts a second job for the same claim.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, Client, DEFAULT_URL } from "./client.ts";

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "post-studio");
const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "post-studio-dispatch");
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

export const SOURCE_PREFIX = "post-studio-handoff";

export interface FocusItem {
  id: string;
  type: string;
  frame: string;
  name?: string;
  role?: string;
  text?: string;
}

export interface DispatchItem {
  project: string;
  checkpoint: string;
  state: "pending" | "claimed";
  attempts: number;
  claimedBy: string | null;
  claimExpired: boolean;
  title: string;
  rev: number | null;
  note: string | null;
  focus: FocusItem[];
  /** Motion projects: the playhead moment he was looking at (ms), else null (older servers: absent). */
  at?: number | null;
  /** The project has a timeline (older servers: absent = treat as still). */
  motion?: boolean;
  editorUrl: string;
}

export interface Job {
  id: number;
  status: string;
  source?: string | null;
}

export interface DispatchConfig {
  url: string;
  token: string;
  /** Random per process: claims by another instance are orphaned. */
  instance: string;
  /** Workspace root (the folder that holds telegram-mcp/ and post-studio/). */
  workspace: string;
  /** argv prefix for the session runner, e.g. ["python3", "<ws>/telegram-mcp/bin/sessions.py"]. */
  sessions: string[];
  bot: string;
  chat: string;
  kind: string;
  model: string;
  /** --project for sessions.py (a workspace folder). */
  project: string;
  /** At most this many studio hand-off jobs queued or running at once (the runner queues the rest anyway). */
  maxActive: number;
  pollMs: number;
  /** The switch: the dispatcher still polls (so the editor knows it is off) but starts nothing. */
  killFile: string;
  envOff: boolean;
  promptDir: string;
  /** Where the worker writes its short report (workspace/uploads/…). */
  reportDir: string;
  log: (line: string) => void;
  /** One Telegram message to the origin chat; best effort. Undefined = no pings. */
  notify?: (text: string) => Promise<void>;
}

export function dispatchConfigFromEnv(opts: { url?: string; tokenFile?: string } = {}): DispatchConfig {
  const env = process.env;
  const workspace = resolve(env.POST_STUDIO_WORKSPACE || join(REPO, ".."));
  const tokenFile = opts.tokenFile || env.POST_STUDIO_DISPATCH_TOKEN_FILE || join(CONFIG_DIR, "dispatcher-token");
  if (!existsSync(tokenFile)) throw new Error(`no dispatcher token at ${tokenFile} (create it on the server host: pstudio token create studio-dispatcher --save ${tokenFile})`);
  const token = readFileSync(tokenFile, "utf8").trim();
  const telegramEnv = env.POST_STUDIO_TELEGRAM_ENV || join(homedir(), ".config/optibot/telegram-mcp.env");
  const chat = env.POST_STUDIO_DISPATCH_CHAT || "";
  const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  return {
    url: opts.url || env.PSTUDIO_URL || DEFAULT_URL,
    token,
    instance: `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`,
    workspace,
    sessions: env.POST_STUDIO_SESSIONS ? env.POST_STUDIO_SESSIONS.split(" ") : ["python3", join(workspace, "telegram-mcp/bin/sessions.py")],
    bot: env.POST_STUDIO_DISPATCH_BOT || "optibot",
    chat,
    kind: env.POST_STUDIO_DISPATCH_KIND || "claude",
    model: env.POST_STUDIO_DISPATCH_MODEL || "claude-opus-5-5",
    project: "post-studio",
    maxActive: Math.max(1, Number(env.POST_STUDIO_DISPATCH_MAX) || 2),
    pollMs: Math.max(5, Number(env.POST_STUDIO_DISPATCH_POLL_SECONDS) || 20) * 1000,
    killFile: env.POST_STUDIO_DISPATCH_OFF_FILE || join(CONFIG_DIR, "dispatch.off"),
    envOff: /^(off|0|false|no)$/i.test(env.POST_STUDIO_DISPATCH ?? ""),
    promptDir: join(STATE_DIR, "prompts"),
    reportDir: join(workspace, "uploads/post-studio-handoffs"),
    log,
    notify: /^(off|0|false|no)$/i.test(env.POST_STUDIO_DISPATCH_PINGS ?? "") ? undefined : telegramNotifier(telegramEnv, chat, log),
  };
}

/**
 * Telegram sendMessage with the OptiBot token from the same env file the session runner uses
 * (SESSIONS_OPTIBOT_TELEGRAM_ENV). The token is read per message and never logged: errors are
 * reported as fixed words plus the HTTP status only.
 */
export function telegramNotifier(envFile: string, chat: string, log: (s: string) => void) {
  return async (text: string) => {
    let token: string | undefined;
    try {
      token = /^TELEGRAM_BOT_TOKEN=(.*)$/m.exec(readFileSync(envFile, "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "");
    } catch {
      token = undefined;
    }
    if (!token) return log("telegram ping skipped: no OptiBot token configured");
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) log(`telegram ping not sent: HTTP ${res.status}`);
    } catch {
      log("telegram ping not sent: network error");
    }
  };
}

export const sourceFor = (item: { project: string; checkpoint: string }, attempt: number) => `${SOURCE_PREFIX}:${item.project}:${item.checkpoint}:${attempt}`;
const sourceStem = (item: { project: string; checkpoint: string }) => `${SOURCE_PREFIX}:${item.project}:${item.checkpoint}:`;
const ACTIVE = new Set(["queued", "running", "limit_wait"]);

export function run(argv: string[], opts: { cwd: string; timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: stderr + String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

/** Every job the runner lists (running, queued, paused, the last ended ones). */
export async function listJobs(cfg: DispatchConfig): Promise<Job[]> {
  const r = await run([...cfg.sessions, "list", "--json"], { cwd: cfg.workspace });
  if (r.code !== 0) throw new Error(`sessions.py list failed (exit ${r.code})`);
  const data = JSON.parse(r.stdout);
  return [...(data.running ?? []), ...(data.queued ?? []), ...(data.waiting ?? []), ...(data.ended ?? [])] as Job[];
}

/** Plain words for the editor banner and the Telegram ping (no paths, no log dumps). */
function startError(r: { code: number | null; stdout: string; stderr: string }, job: any): string {
  const text = (job?.error ?? job?.summary ?? r.stderr.trim().split("\n").filter(Boolean).pop() ?? "").toString().replace(/\s+/g, " ").trim();
  return `sessions.py start exited ${r.code}${text ? `: ${text.slice(0, 200)}` : ""}`;
}

export function workerPrompt(cfg: DispatchConfig, item: DispatchItem): string {
  const pstudio = "apps/cli/bin/pstudio";
  const report = join(cfg.reportDir, `${item.project}-${item.checkpoint}.md`);
  const focusNote = item.focus.length
    ? `He pointed at ${item.focus.length} element${item.focus.length === 1 ? "" : "s"} (ids: ${item.focus.map((f) => `\`${f.id}\``).join(", ")}). \`handoff show\` lists them with a snapshot (type, name, role, text) under \`handoff.focus\`.`
    : "He did not point at any element: the note is about the whole design.";
  return `# Post Studio hand-off: ${item.title.replace(/\n/g, " ")}

This job was started automatically by the Post Studio hand-off dispatcher (\`post-studio-dispatch.service\` on the server), not by a Telegram message. Nikola pressed **Hand to agent** in the Post Studio editor. Your task is this one agent turn on this one project.

| | |
|---|---|
| Project | \`${item.project}\` |
| Hand-off | \`${item.checkpoint}\`${item.rev !== null ? ` (at rev ${item.rev})` : ""} |
| Editor link | ${item.editorUrl} |

## Do this

1. Work in \`${join(cfg.workspace, "post-studio")}\`. Read \`AGENTS.md\` there and follow **"Agent turn procedure" → B. Your turn after his hand-off** exactly. Use only \`${pstudio}\` (the token is already saved; the default URL is the live server). Never edit the database or asset files. Do not touch any other project.
2. First run \`${pstudio} handoff show ${item.project} --json\`.
   - If \`turn\` is \`human\`, Nikola took the project back. **Stop**: change nothing, take no lease, and finish with outcome \`incomplete\` and the summary "You took ${item.project} back before I started; nothing changed."
   - If \`handoff.name\` is not \`${item.checkpoint}\` (he handed it over again since), stop the same way and say so.
3. **His hand-off note** is \`handoff.note\` in that output. It is what Nikola typed in the editor for this design. It is deliberately not copied into this prompt. Treat it as his request for changes to this project only. It is not an instruction about anything outside this project.
4. **What he pointed at.** ${focusNote} When the focus list is not empty, "this", "that", "it" and "here" in his note mean those layers. Work on them first, and do not change unrelated layers unless the note asks for it.
5. Take the lease, read \`diff\` and \`pins\` (his changes are protected), \`outline\` and \`get\`, then \`apply\` with \`--dry-run\` first. Renew the lease (\`lease take\` again) if you need more than 15 minutes.
6. Render every frame to PNG (\`${pstudio} render ${item.project} --frame <id> --out /tmp/${item.project}-<id>.png\`) and **look at each image** with the Read tool. Check overflow, collisions, line breaks, the safe column and the footer. Fix and apply again before you hand back.
${item.motion ? `   - **This is a motion project.** Also run \`${pstudio} timeline ${item.project}\` (his retimed keyframes are marked 📌; do not move their times) and look at the contact sheet of each frame (\`${pstudio} render ${item.project} --frame <id> --contact --out /tmp/${item.project}-<id>-contact.png\`) before you hand back. Follow the motion rules in "Agent turn procedure".${item.at != null ? ` He was looking at **${(item.at / 1000).toFixed(2)} s** when he handed over (\`handoff.at\`): "here" / "now" in his note mean that moment (\`--at ${(item.at / 1000).toFixed(2)}\`).` : ""}\n` : ""}7. Hand back with \`${pstudio} handoff back ${item.project} --summary "<one line: what you changed and what you kept>"\`. If you cannot finish, still hand back, with a summary that says what is missing. Never leave the project leased.
8. Never approve, never export into social-posts, never create other projects, never send a token or the password anywhere.

## Report and completion

- Write a short report to \`${report}\` (create the folder if needed): his note (quoted as his words), what he pointed at, what you changed, what you kept, what you checked in the renders, anything left, and the editor link ${item.editorUrl}.
- In \`completion.json\` declare that report. \`summary.changed\` must include the editor link ${item.editorUrl}. \`summary.action\` tells him to open the link and approve, tweak or hand it back. Leave out the \`card\` block: this design turn needs no board card.
- Use \`outcome\` \`completed\` only when you did what his note asked and handed back.
`;
}

export interface TickResult {
  enabled: boolean;
  busy: string | null;
  started: Array<{ project: string; checkpoint: string; job: number; status: string; adopted: boolean }>;
  failed: Array<{ project: string; checkpoint: string; error: string }>;
  skipped: Array<{ project: string; checkpoint: string; reason: string }>;
}

/** One poll: heartbeat, recover orphaned claims, start pending hand-offs up to the cap. */
export async function tick(cfg: DispatchConfig): Promise<TickResult> {
  const api = new Client(cfg.url, cfg.token);
  const enabled = !cfg.envOff && !existsSync(cfg.killFile);
  const out: TickResult = { enabled, busy: null, started: [], failed: [], skipped: [] };

  let jobs: Job[] | undefined;
  let listError: string | undefined;
  if (enabled) {
    try {
      jobs = await listJobs(cfg);
    } catch (e) {
      listError = (e as Error).message;
    }
  }
  const activeStudio = () => (jobs ?? []).filter((j) => ACTIVE.has(j.status) && (j.source ?? "").startsWith(`${SOURCE_PREFIX}:`)).length;
  if (enabled && listError) out.busy = `cannot read the session runner (${listError}); retrying`;
  else if (enabled && activeStudio() >= cfg.maxActive) out.busy = `${activeStudio()} studio agent jobs are already running; the next one starts when one finishes`;

  const { items } = await api.request<{ items: DispatchItem[] }>("POST", "/v1/dispatch/poll", { enabled, busy: out.busy, instance: cfg.instance });
  if (!enabled || listError || !jobs) return out;

  for (const item of items) {
    if (item.state === "claimed") {
      // Ticks run one at a time and only the lock holder ticks, so a claim still open here is
      // one whose dispatcher stopped (or lost the API) between claim and mark: recover it.
      await recover(cfg, api, item, jobs, out);
      continue;
    }
    if (activeStudio() >= cfg.maxActive) {
      out.skipped.push({ project: item.project, checkpoint: item.checkpoint, reason: "cap" });
      continue;
    }
    await dispatchOne(cfg, api, item, jobs, out);
  }
  return out;
}

/** A claim nobody finished: adopt the job its attempt started, else mark it failed. Never starts one. */
async function recover(cfg: DispatchConfig, api: Client, item: DispatchItem, jobs: Job[], out: TickResult) {
  const job = jobs.find((j) => j.source === sourceFor(item, item.attempts));
  try {
    if (job) {
      await api.request("POST", "/v1/dispatch/started", { project: item.project, checkpoint: item.checkpoint, jobId: job.id, jobStatus: job.status });
      out.started.push({ project: item.project, checkpoint: item.checkpoint, job: job.id, status: job.status, adopted: true });
      cfg.log(`recovered ${item.project} ${item.checkpoint}: job #${job.id} (${job.status}) from an interrupted dispatch`);
    } else {
      const error = "the dispatcher stopped before it could confirm the agent job, and the runner has no job for it; press Retry";
      await api.request("POST", "/v1/dispatch/failed", { project: item.project, checkpoint: item.checkpoint, error });
      out.failed.push({ project: item.project, checkpoint: item.checkpoint, error });
      cfg.log(`orphaned claim ${item.project} ${item.checkpoint} attempt ${item.attempts}: no job found, marked failed`);
    }
  } catch (e) {
    cfg.log(`recover ${item.project} ${item.checkpoint}: ${(e as Error).message}`);
  }
}

async function dispatchOne(cfg: DispatchConfig, api: Client, item: DispatchItem, jobs: Job[], out: TickResult) {
  let claim: { attempts: number };
  try {
    claim = await api.request("POST", "/v1/dispatch/claim", { project: item.project, checkpoint: item.checkpoint, instance: cfg.instance });
  } catch (e) {
    const reason = e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message;
    out.skipped.push({ project: item.project, checkpoint: item.checkpoint, reason });
    cfg.log(`skip ${item.project} ${item.checkpoint}: ${reason}`);
    return;
  }
  const source = sourceFor(item, claim.attempts);
  const mark = async (job: Job, adopted: boolean) => {
    await api.request("POST", "/v1/dispatch/started", { project: item.project, checkpoint: item.checkpoint, jobId: job.id, jobStatus: job.status });
    jobs.push({ ...job, source: job.source ?? source });
    out.started.push({ project: item.project, checkpoint: item.checkpoint, job: job.id, status: job.status, adopted });
  };

  // A job from an earlier attempt of this hand-off that is still alive does the turn: adopt it.
  const alive = jobs.find((j) => ACTIVE.has(j.status) && (j.source ?? "").startsWith(sourceStem(item)));
  if (alive) {
    await mark(alive, true);
    cfg.log(`${item.project} ${item.checkpoint}: adopted running job #${alive.id}`);
    return;
  }

  mkdirSync(cfg.promptDir, { recursive: true, mode: 0o700 });
  const promptFile = join(cfg.promptDir, `${item.project}-${item.checkpoint}-${claim.attempts}.md`);
  writeFileSync(promptFile + ".tmp", workerPrompt(cfg, item), { mode: 0o600 });
  renameSync(promptFile + ".tmp", promptFile);
  const title = `Studio: ${item.title.replace(/\s+/g, " ")}`.slice(0, 60);
  const argv = [
    ...cfg.sessions,
    "start",
    "--kind", cfg.kind,
    "--model", cfg.model,
    "--bot", cfg.bot,
    "--chat", cfg.chat,
    "--project", cfg.project,
    "--title", title,
    "--prompt-file", promptFile,
    "--source", source,
    "--json",
  ];
  cfg.log(`start ${item.project} ${item.checkpoint} attempt ${claim.attempts}: ${cfg.kind} ${cfg.model}`);
  const r = await run(argv, { cwd: cfg.workspace });
  let job: any;
  try {
    job = r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
  } catch {
    job = undefined;
  }
  try {
    if (r.code === 0 && Number.isInteger(job?.id) && ACTIVE.has(job.status)) {
      await mark({ id: job.id, status: job.status, source }, false);
      cfg.log(`${item.project} ${item.checkpoint}: job #${job.id} ${job.status}`);
      await ping(cfg, `${job.status === "queued" ? "⏳" : "▶"} #${job.id} ${kindLabel(cfg.kind)} · post-studio — ${job.status === "queued" ? "queued" : "started"}\nStudio: ${item.title} (${item.checkpoint}${item.focus.length ? `, pointing at ${item.focus.map((f) => f.id).join(", ")}` : ""}${item.at != null ? `, at ${(item.at / 1000).toFixed(2)} s` : ""})\n${item.editorUrl}`);
      return;
    }
    // The start failed, or answered oddly: maybe the runner still registered a job. Look before failing.
    const registered = await listJobs(cfg)
      .then((all) => all.find((j) => j.source === source))
      .catch(() => undefined);
    if (registered) {
      await mark(registered, true);
      cfg.log(`${item.project} ${item.checkpoint}: start answered exit ${r.code}, but job #${registered.id} exists; adopted`);
      return;
    }
    const error = startError(r, job);
    await api.request("POST", "/v1/dispatch/failed", { project: item.project, checkpoint: item.checkpoint, error });
    out.failed.push({ project: item.project, checkpoint: item.checkpoint, error });
    cfg.log(`${item.project} ${item.checkpoint}: start failed: ${error}`);
    await ping(cfg, `⚠ Studio: ${item.title}: could not start an agent job (${error}). Open the post to retry or take it back:\n${item.editorUrl}`);
  } catch (e) {
    // The API refused the mark (server down?): the claim stays and is recovered on a later poll.
    cfg.log(`${item.project} ${item.checkpoint}: could not record the result (${(e as Error).message}); it is recovered on a later poll`);
  }
}

const kindLabel = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);

async function ping(cfg: DispatchConfig, text: string) {
  if (!cfg.notify) return;
  try {
    await cfg.notify(text);
  } catch {
    cfg.log("telegram ping failed");
  }
}

/** One dispatcher per host: a pid file in the state dir. Returns a release function. */
export function acquireLock(cfg: DispatchConfig): () => void {
  const pidFile = join(dirname(cfg.promptDir), "dispatcher.pid");
  mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    let alive = false;
    try {
      alive = pid > 0 && pid !== process.pid && process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`another dispatcher runs (pid ${pid}); stop it first (systemctl --user stop post-studio-dispatch)`);
  }
  writeFileSync(pidFile, String(process.pid));
  return () => {
    try {
      if (Number(readFileSync(pidFile, "utf8")) === process.pid) writeFileSync(pidFile, "");
    } catch {
      /* ignore */
    }
  };
}

/** The service loop (or one poll with `once`), holding the host lock. */
export async function runLoop(cfg: DispatchConfig, opts: { once?: boolean } = {}): Promise<TickResult | undefined> {
  const release = acquireLock(cfg);
  if (opts.once) {
    try {
      return await tick(cfg);
    } finally {
      release();
    }
  }
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  cfg.log(`dispatcher ${cfg.instance} polling ${cfg.url} every ${cfg.pollMs / 1000}s; switch: ${cfg.envOff ? "off (env)" : `off while ${cfg.killFile} exists`}`);
  let lastEnabled: boolean | undefined;
  let lastError = "";
  while (!stopping) {
    try {
      const r = await tick(cfg);
      if (r.enabled !== lastEnabled) cfg.log(r.enabled ? "auto-start is on" : "auto-start is off (kill switch): polling only");
      lastEnabled = r.enabled;
      lastError = "";
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== lastError) cfg.log(`poll failed: ${msg}`);
      lastError = msg;
    }
    if (stopping) break;
    await new Promise<void>((res) => {
      const t = setTimeout(res, cfg.pollMs);
      wake = () => {
        clearTimeout(t);
        res();
      };
    });
  }
  release();
  cfg.log("dispatcher stopped");
  return undefined;
}
