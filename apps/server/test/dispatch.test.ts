// Phase 8 extra: "Hand to agent" carries what Nikola pointed at (focus) and asks the host
// dispatcher to start exactly one agent job. These tests drive the API the editor and the
// dispatcher use: focus validation and storage, the dispatch state machine
// (pending → claimed → started | failed → retry), idempotence and the token boundaries.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { DISPATCH_CLAIM_MS } from "../src/store.ts";
import { createLux, setup } from "./helpers.ts";

let ctx: Awaited<ReturnType<typeof setup>>;
let now = Date.parse("2026-11-11T10:00:00Z");
let dispatcher: string;
beforeEach(async () => {
  now = Date.parse("2026-11-11T10:00:00Z");
  ctx = await setup(() => now);
  dispatcher = ctx.store.createToken("studio-dispatcher", "agent").token;
});
afterEach(async () => ctx.cleanup());

const asDispatcher = async (method: string, url: string, body?: unknown) => {
  const res = await ctx.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${dispatcher}` }, ...(body === undefined ? {} : { payload: body as any }) });
  return { status: res.statusCode, json: res.json() };
};
const poll = (enabled = true, busy: string | null = null, instance = "test-1") => asDispatcher("POST", "/v1/dispatch/poll", { enabled, busy, instance });
const claim = (project: string, checkpoint = "handoff-1", instance = "test-1") => asDispatcher("POST", "/v1/dispatch/claim", { project, checkpoint, instance });
const started = (project: string, jobId: number, checkpoint = "handoff-1") => asDispatcher("POST", "/v1/dispatch/started", { project, checkpoint, jobId, jobStatus: "running" });
const failed = (project: string, error: string, checkpoint = "handoff-1") => asDispatcher("POST", "/v1/dispatch/failed", { project, checkpoint, error });
const state = async (id: string) => (await ctx.call("claude", "GET", `/v1/projects/${id}/handoff`)).json;
const giveTo = (id: string, body: Record<string, unknown>) => ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, body);

describe("focus: what Nikola pointed at", () => {
  it("stores a readable snapshot per node with the hand-off and shows it to the agent", async () => {
    const id = await createLux(ctx);
    const r = await giveTo(id, { note: "make this shorter", focus: ["headline", "row-2-a", "headline"] });
    expect(r.status).toBe(200);
    expect(r.json.focus).toHaveLength(2);
    const h = await state(id);
    expect(h.handoff.name).toBe("handoff-1");
    expect(h.handoff.focus[0]).toMatchObject({ id: "headline", type: "text", frame: "square", role: "headline" });
    expect(h.handoff.focus[0].text.length).toBeGreaterThan(3);
    expect(h.handoff.focus[0].text.length).toBeLessThanOrEqual(80);
    expect(h.handoff.focus[1]).toEqual({ id: "row-2-a", type: "rect", frame: "square" });
    expect(h.handoff.focusText).toMatch(/^headline \(text ".+", role headline, in square\), row-2-a \(rect, in square\)$/);
    // The snapshot is the moment of the hand-off: a later rename does not change it.
    await ctx.call("claude", "POST", `/v1/projects/${id}/lease`, {});
    await ctx.call("claude", "POST", `/v1/projects/${id}/ops`, { base: h.head, ops: [{ op: "set", node: "headline", path: "spans", value: [{ text: "Ново." }] }], message: "x" });
    expect((await state(id)).handoff.focus[0].text).toBe(h.handoff.focus[0].text);
    // And the checkpoint list carries it too.
    const cps = (await ctx.call("nikola", "GET", `/v1/projects/${id}/checkpoints`)).json.checkpoints;
    expect(cps.find((c: any) => c.name === "handoff-1").focus).toHaveLength(2);
    expect(cps.find((c: any) => c.name === "created").focus).toBeNull();
  });

  it("refuses unknown ids, bad shapes and more than 20 elements, and changes nothing", async () => {
    const id = await createLux(ctx);
    const unknown = await giveTo(id, { note: "x", focus: ["headline", "nope", "nada"] });
    expect(unknown.status).toBe(422);
    expect(unknown.json.error).toMatchObject({ code: "bad-focus", details: { missing: ["nope", "nada"] } });
    expect((await giveTo(id, { note: "x", focus: "headline" })).status).toBe(400);
    expect((await giveTo(id, { note: "x", focus: ["bad id!"] })).status).toBe(400);
    expect((await giveTo(id, { note: "x", focus: Array.from({ length: 21 }, (_, i) => `n${i}`) })).json.error.message).toMatch(/20 elements at most/);
    const h = await state(id);
    expect(h.turn).toBe("human");
    expect(h.handoff).toBeNull();
    expect(h.dispatch).toBeNull();
  });

  it("a hand-off without focus works as before (empty focus)", async () => {
    const id = await createLux(ctx);
    expect((await giveTo(id, { note: "polish" })).status).toBe(200);
    expect((await giveTo(id, { note: "again", focus: [] })).status).toBe(200);
    const h = await state(id);
    expect(h.handoff).toMatchObject({ name: "handoff-2", note: "again", focus: [], focusText: null });
  });
});

describe("dispatch state machine", () => {
  it("pending → claimed → started, exactly once, and the editor sees the job number", async () => {
    const id = await createLux(ctx);
    await giveTo(id, { note: "shorter headline", focus: ["headline"] });
    let h = await state(id);
    expect(h.dispatch).toMatchObject({ checkpoint: "handoff-1", state: "pending", attempts: 0, jobId: null });
    expect(h.dispatcher).toMatchObject({ online: false });

    const p = await poll();
    expect(p.json.items).toEqual([expect.objectContaining({ project: id, checkpoint: "handoff-1", state: "pending", note: "shorter headline", editorUrl: expect.stringContaining(`/p/${id}`) })]);
    expect(p.json.items[0].focus[0].id).toBe("headline");
    expect((await state(id)).dispatcher).toMatchObject({ online: true, enabled: true, busy: null });

    const c = await claim(id);
    expect(c.json).toMatchObject({ state: "claimed", attempts: 1, claimedBy: "test-1" });
    // A second claim (another poll, a restarted dispatcher) is refused: one job per hand-off.
    expect((await claim(id, "handoff-1", "test-2")).json.error.code).toBe("not-pending");
    expect((await started(id, 901)).json).toMatchObject({ state: "started", jobId: 901, jobStatus: "running" });
    // Marking it again with the same job is a no-op; another job is refused.
    expect((await started(id, 901)).status).toBe(200);
    expect((await started(id, 902)).json.error.code).toBe("not-claimed");
    expect((await failed(id, "late")).json.error.code).toBe("not-claimed");
    h = await state(id);
    expect(h.dispatch).toMatchObject({ state: "started", jobId: 901 });
    // Nothing left to do for the dispatcher.
    expect((await poll()).json.items).toEqual([]);
  });

  it("failed → Retry (human) → pending again, with the attempt count kept", async () => {
    const id = await createLux(ctx);
    await giveTo(id, { note: "x" });
    await claim(id);
    expect((await failed(id, "sessions.py start exited 1: queue full")).json).toMatchObject({ state: "failed", error: "sessions.py start exited 1: queue full" });
    expect((await failed(id, "again")).json.error).toBe("sessions.py start exited 1: queue full");
    expect((await state(id)).dispatch).toMatchObject({ state: "failed", attempts: 1 });
    // Only Nikola retries; an agent cannot.
    expect((await ctx.call("claude", "POST", `/v1/projects/${id}/handoff/retry-dispatch`, {})).status).toBe(403);
    const r = await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff/retry-dispatch`, {});
    expect(r.json).toMatchObject({ state: "pending", attempts: 1, error: null });
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff/retry-dispatch`, {})).json.error.code).toBe("not-failed");
    expect((await claim(id)).json).toMatchObject({ state: "claimed", attempts: 2 });
    expect((await started(id, 77)).json.state).toBe("started");
  });

  it("take-back, a newer hand-off, a hand-back and archiving cancel what has not started", async () => {
    const id = await createLux(ctx);
    await giveTo(id, { note: "one" });
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff/take-back`, {});
    expect((await state(id))).toMatchObject({ turn: "human", dispatch: { state: "cancelled", error: "Nikola took it back" } });
    expect((await poll()).json.items).toEqual([]);
    expect((await claim(id)).json.error.code).toBe("not-pending");

    await giveTo(id, { note: "two" });
    await giveTo(id, { note: "three" }); // handed again before anything started
    const items = (await poll()).json.items;
    expect(items.map((i: any) => i.checkpoint)).toEqual(["handoff-3"]);

    // An agent started by hand finishes the turn first: the pending dispatch is cancelled.
    await ctx.call("claude", "POST", `/v1/projects/${id}/lease`, {});
    await ctx.call("claude", "POST", `/v1/projects/${id}/handoff/back`, { summary: "done by hand" });
    expect((await poll()).json.items).toEqual([]);

    await giveTo(id, { note: "four" });
    await ctx.call("nikola", "DELETE", `/v1/projects/${id}`);
    expect((await poll()).json.items).toEqual([]);
  });

  it("a claim is refused (and cancelled) when the hand-off is no longer current", async () => {
    const id = await createLux(ctx);
    await giveTo(id, { note: "x" });
    // An agent already holds the lease (started by hand from Telegram): no second worker.
    await ctx.call("claude", "POST", `/v1/projects/${id}/lease`, {});
    const c = await claim(id);
    expect(c.status).toBe(409);
    expect(c.json.error).toMatchObject({ code: "not-dispatchable", message: expect.stringContaining("agent:claude is already working") });
    expect((await state(id)).dispatch).toMatchObject({ state: "cancelled" });
  });

  it("a claim in flight survives take-back; its worker then finds the turn is his", async () => {
    const id = await createLux(ctx);
    await giveTo(id, { note: "x" });
    await claim(id);
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff/take-back`, {});
    expect((await started(id, 5)).json.state).toBe("started");
    expect((await state(id)).turn).toBe("human");
  });

  it("an orphaned claim stays claimed (with claimExpired) until the dispatcher recovers it", async () => {
    const id = await createLux(ctx);
    await giveTo(id, { note: "x" });
    await claim(id, "handoff-1", "crashed-instance");
    let item = (await poll(true, null, "new-instance")).json.items[0];
    expect(item).toMatchObject({ state: "claimed", claimedBy: "crashed-instance", claimExpired: false, attempts: 1 });
    now += DISPATCH_CLAIM_MS + 1;
    item = (await poll(true, null, "new-instance")).json.items[0];
    expect(item.claimExpired).toBe(true);
    // Recovery adopts the job the crashed attempt started (or marks it failed); never a second claim.
    expect((await claim(id, "handoff-1", "new-instance")).json.error.code).toBe("not-pending");
    expect((await started(id, 41)).json).toMatchObject({ state: "started", jobId: 41 });
  });

  it("hand-offs made before dispatch existed get no auto-start, but Retry can start one", async () => {
    const id = await createLux(ctx);
    await giveTo(id, { note: "old" });
    ctx.store.db.prepare(`DELETE FROM dispatches`).run(); // as if handed over before DB v4
    expect((await state(id)).dispatch).toBeNull();
    expect((await poll()).json.items).toEqual([]);
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff/retry-dispatch`, {})).json).toMatchObject({ checkpoint: "handoff-1", state: "pending" });
    expect((await poll()).json.items).toHaveLength(1);
  });

  it("the editor sees the dispatcher as offline, off or busy", async () => {
    const id = await createLux(ctx);
    await giveTo(id, { note: "x" });
    await poll(false);
    expect((await state(id)).dispatcher).toMatchObject({ online: true, enabled: false });
    await poll(true, "2 studio agent jobs are already running");
    expect((await state(id)).dispatcher).toMatchObject({ online: true, enabled: true, busy: "2 studio agent jobs are already running" });
    now += 3 * 60 * 1000;
    expect((await state(id)).dispatcher.online).toBe(false);
  });
});

describe("token boundaries", () => {
  it("the dispatcher token only drives dispatch; other tokens and the editor cannot", async () => {
    const id = await createLux(ctx);
    expect((await asDispatcher("GET", `/v1/projects/${id}`)).status).toBe(403);
    expect((await asDispatcher("POST", `/v1/projects/${id}/ops`, { base: 0, ops: [], message: "x" })).json.error.code).toBe("dispatcher-only");
    expect((await asDispatcher("GET", "/v1/whoami")).json).toMatchObject({ name: "studio-dispatcher" });
    for (const who of ["claude", "nikola"] as const) {
      expect((await ctx.call(who, "POST", "/v1/dispatch/poll", { instance: "x" })).status).toBe(403);
      expect((await ctx.call(who, "POST", "/v1/dispatch/claim", { project: id, checkpoint: "handoff-1", instance: "x" })).status).toBe(403);
    }
    // The editor session cannot either.
    ctx.store.auth.setPassword("correct horse battery");
    const login = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", headers: { "x-post-studio-editor": "1" }, payload: { password: "correct horse battery" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const res = await ctx.app.inject({ method: "POST", url: "/v1/dispatch/poll", headers: { cookie, "x-post-studio-editor": "1" }, payload: { instance: "x" } });
    expect(res.statusCode).toBe(403);
    // …while the editor itself can hand over with focus and retry.
    const give = await ctx.app.inject({ method: "POST", url: `/v1/projects/${id}/handoff`, headers: { cookie, "x-post-studio-editor": "1" }, payload: { note: "this", focus: ["sub"] } });
    expect(give.json()).toMatchObject({ checkpoint: "handoff-1", focus: [{ id: "sub" }] });
  });

  it("a differently named dispatcher token can be configured", async () => {
    const app = buildApp({ store: ctx.store, dispatcherTokens: ["other-dispatcher"] });
    const other = ctx.store.createToken("other-dispatcher", "agent").token;
    const r = await app.inject({ method: "POST", url: "/v1/dispatch/poll", headers: { authorization: `Bearer ${other}` }, payload: { instance: "x" } });
    expect(r.statusCode).toBe(200);
    const old = await app.inject({ method: "POST", url: "/v1/dispatch/poll", headers: { authorization: `Bearer ${dispatcher}` }, payload: { instance: "x" } });
    expect(old.statusCode).toBe(403);
    await app.close();
  });
});

describe("at: the moment he was looking at (motion projects, Motion Part 4)", () => {
  const addMotion = async (id: string) => {
    const head = (await state(id)).head;
    const r = await ctx.call("nikola", "POST", `/v1/projects/${id}/ops`, { base: head, ops: [{ op: "set", node: "$doc", path: "motion", value: { duration: 4000, fps: 30, loop: true } }], message: "add motion" });
    expect(r.status).toBe(200);
  };

  it("stores at with the hand-off; handoff show, checkpoints and the dispatcher's poll return it", async () => {
    const id = await createLux(ctx);
    await addMotion(id);
    const r = await giveTo(id, { note: "make the intro punchier here", focus: ["headline"], at: 1200.4 });
    expect(r.status).toBe(200);
    expect(r.json.at).toBe(1200);
    const h = await state(id);
    expect(h.handoff).toMatchObject({ name: "handoff-1", at: 1200, atText: "1.20 s" });
    const cps = (await ctx.call("nikola", "GET", `/v1/projects/${id}/checkpoints`)).json.checkpoints;
    expect(cps.find((c: any) => c.name === "handoff-1").at).toBe(1200);
    expect(cps.find((c: any) => c.name === "created").at).toBeNull();
    const items = (await poll()).json.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ project: id, checkpoint: "handoff-1", at: 1200, motion: true });
  });

  it("no at = null; a still project is marked motion: false in the poll", async () => {
    const id = await createLux(ctx);
    expect((await giveTo(id, { note: "x" })).json.at).toBeNull();
    expect((await state(id)).handoff).toMatchObject({ at: null, atText: null });
    expect((await poll()).json.items[0]).toMatchObject({ at: null, motion: false });
  });

  it("refuses a bad at (not a number, negative, after the end, a still project) and changes nothing", async () => {
    const id = await createLux(ctx);
    const still = await giveTo(id, { note: "x", at: 500 });
    expect(still.status).toBe(400);
    expect(still.json.error.code).toBe("bad-at");
    await addMotion(id);
    for (const at of ["1.2", -1, 4001, true, { ms: 5 }]) {
      const r = await giveTo(id, { note: "x", at });
      expect(r.status, String(at)).toBe(400);
      expect(r.json.error.code).toBe("bad-at");
    }
    expect((await state(id)).turn).toBe("human");
    expect((await state(id)).handoff).toBeNull();
    expect((await giveTo(id, { note: "the end", at: 4000 })).json.at).toBe(4000);
  });
});
