// Phase 4: the agent loop across more than one round. Turn rules, take-back, approve,
// per-revision revert, and the checkpoints each agent turn is compared against.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLux, setup } from "./helpers.ts";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => ctx.cleanup());

type Who = "claude" | "grok" | "nikola";
const ops = (project: string, who: Who, base: number, list: unknown[], extra: Record<string, unknown> = {}) =>
  ctx.call(who, "POST", `/v1/projects/${project}/ops`, { base, ops: list, message: "test edit", ...extra });
const head = async (id: string) => (await ctx.call("nikola", "GET", `/v1/projects/${id}`)).json.head as number;
const docOf = async (id: string, rev?: number | string) => (await ctx.call("nikola", "GET", `/v1/projects/${id}${rev === undefined ? "" : `?rev=${rev}`}`)).json.doc;
const node = (doc: any, id: string): any => {
  const walk = (list: any[]): any => {
    for (const n of list) {
      if (n.id === id) return n;
      const c = n.children ? walk(n.children) : undefined;
      if (c) return c;
    }
  };
  return walk(doc.frames);
};
const state = async (id: string) => (await ctx.call("claude", "GET", `/v1/projects/${id}/handoff`)).json;

describe("turns", () => {
  it("lets an agent polish its new project, then keeps out of Nikola's turn once he starts", async () => {
    const id = await createLux(ctx);
    // Right after creating: no human edit yet, so the agent may still fix its own draft and hand back.
    expect((await ops(id, "claude", 0, [{ op: "set", node: "sub", path: "x", value: 136 }])).status).toBe(200);
    expect((await ctx.call("claude", "POST", `/v1/projects/${id}/handoff/back`, { summary: "first draft" })).json).toMatchObject({ checkpoint: "agent-1", turn: "human" });
    // A lease is only for the agent's turn.
    const lease = await ctx.call("claude", "POST", `/v1/projects/${id}/lease`, {});
    expect(lease.status).toBe(409);
    expect(lease.json.error.code).toBe("not-your-turn");
    // He changes something: from now on the agent waits for his hand-off.
    expect((await ops(id, "nikola", 1, [{ op: "set", node: "headline", path: "y", value: 90 }])).status).toBe(200);
    const w = await ops(id, "claude", 2, [{ op: "set", node: "sub", path: "x", value: 140 }]);
    expect(w.status).toBe(409);
    expect(w.json.error.code).toBe("not-your-turn");
    expect((await ctx.call("claude", "POST", `/v1/projects/${id}/handoff/back`, { summary: "x" })).json.error.code).toBe("not-your-turn");
    expect((await ctx.call("claude", "POST", `/v1/projects/${id}/restore`, { rev: 0 })).json.error.code).toBe("not-your-turn");
    // His soft pin survived the refused hand-back.
    expect((await ctx.call("claude", "GET", `/v1/projects/${id}/pins`)).json.soft).toEqual([{ node: "headline", path: "y", source: "soft", rev: 2 }]);
    // After the hand-off everything works again.
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "go" });
    expect((await ctx.call("claude", "POST", `/v1/projects/${id}/lease`, {})).status).toBe(200);
    expect((await ops(id, "claude", 2, [{ op: "set", node: "sub", path: "x", value: 140 }])).status).toBe(200);
  });

  it("moving frames on the editor canvas is not a design change: no soft pin, no lost turn, no diff line", async () => {
    const id = await createLux(ctx);
    const frame = (await docOf(id)).frames[0].id as string;
    // He drags the frame somewhere else on the canvas (what the editor writes: one `canvas` set).
    expect((await ops(id, "nikola", 0, [{ op: "set", node: frame, path: "canvas", value: { x: 40, y: 2000 } }])).status).toBe(200);
    expect((await docOf(id)).frames[0].canvas).toEqual({ x: 40, y: 2000 });
    expect((await ctx.call("claude", "GET", `/v1/projects/${id}/pins`)).json.soft).toEqual([]);
    expect((await ctx.call("claude", "GET", `/v1/projects/${id}/diff?since=created`)).json.items).toEqual([]);
    // So the agent may still polish its fresh draft…
    expect((await ops(id, "claude", 1, [{ op: "set", node: "sub", path: "x", value: 136 }])).status).toBe(200);
    // …until he changes the design itself.
    expect((await ops(id, "nikola", 2, [{ op: "set", node: "headline", path: "y", value: 90 }])).status).toBe(200);
    expect((await ops(id, "claude", 3, [{ op: "set", node: "sub", path: "x", value: 140 }])).json.error.code).toBe("not-your-turn");
    // The position is validated like any field.
    expect((await ops(id, "nikola", 3, [{ op: "set", node: frame, path: "canvas", value: { x: "far" } }])).status).toBe(422);
  });

  it("lets Nikola take a hand-off back, but not from under a live lease", async () => {
    const id = await createLux(ctx);
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "shorter headline" });
    expect((await ctx.call("claude", "POST", `/v1/projects/${id}/handoff/take-back`, {})).status).toBe(403);
    await ctx.call("claude", "POST", `/v1/projects/${id}/lease`, {});
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff/take-back`, {})).status).toBe(423);
    await ctx.call("claude", "DELETE", `/v1/projects/${id}/lease`);
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff/take-back`, {})).json).toEqual({ rev: 0, turn: "human", changed: true });
    expect((await state(id)).turn).toBe("human");
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff/take-back`, {})).json.changed).toBe(false);
  });
});

describe("approve", () => {
  it("is human only, needs his turn, and approves each head once", async () => {
    const id = await createLux(ctx);
    expect((await ctx.call("claude", "POST", `/v1/projects/${id}/approve`, {})).status).toBe(403);
    const a1 = await ctx.call("nikola", "POST", `/v1/projects/${id}/approve`, { note: "ship it" });
    expect(a1.json).toEqual({ checkpoint: "approved", rev: 0, note: "ship it" });
    expect((await state(id)).approved).toMatchObject({ name: "approved", rev: 0, current: true, note: "ship it" });
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/approve`, {})).json.error.code).toBe("already-approved");
    // A later change: the approval is no longer current; approving again makes approved-2.
    await ops(id, "nikola", 0, [{ op: "set", node: "sub", path: "x", value: 137 }]);
    expect((await state(id)).approved.current).toBe(false);
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/approve`, {})).json).toMatchObject({ checkpoint: "approved-2", rev: 1, note: "approved" });
    // Not while it is the agent's turn, not while leased, and the name cannot be faked.
    await ops(id, "nikola", 1, [{ op: "set", node: "sub", path: "x", value: 138 }]);
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "" });
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/approve`, {})).json.error.code).toBe("not-your-turn");
    await ctx.call("claude", "POST", `/v1/projects/${id}/lease`, {});
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/approve`, {})).status).toBe(423);
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/checkpoints`, { name: "approved-9" })).json.error.code).toBe("reserved");
  });

  it("resolves 'approved' and 'last-approved' for get, render and export", async () => {
    const id = await createLux(ctx);
    await ops(id, "nikola", 0, [{ op: "set", node: "sub", path: "x", value: 137 }]);
    await ctx.call("nikola", "POST", `/v1/projects/${id}/approve`, {});
    await ops(id, "nikola", 1, [{ op: "set", node: "sub", path: "x", value: 150 }]);
    expect(node(await docOf(id, "last-approved"), "sub").x).toBe(137);
    expect(node(await docOf(id, "approved"), "sub").x).toBe(137);
    expect((await ctx.call("nikola", "GET", `/v1/projects/${id}?rev=nope`)).status).toBe(404);
    const r = await ctx.call("claude", "GET", `/v1/projects/${id}/render?format=svg&rev=last-approved`);
    expect(r.headers["x-post-studio-rev"]).toBe("1");
    const ex = await ctx.call("claude", "POST", `/v1/projects/${id}/export`, { rev: "approved", frames: ["square"] });
    expect(ex.json.rev).toBe(1);
  });
});

describe("per-revision revert", () => {
  it("undoes one past revision as a new revision and keeps later changes", async () => {
    const id = await createLux(ctx);
    await ops(id, "nikola", 0, [{ op: "set", node: "headline", path: "y", value: 80 }]); // 1
    await ops(id, "nikola", 1, [{ op: "set", node: "sub", path: "style.size", value: 30 }]); // 2
    await ops(id, "nikola", 2, [{ op: "insert", parent: "square", node: { id: "sticker", type: "ellipse", x: 900, y: 120, w: 40, h: 40, fill: "#AC1922" } }]); // 3
    const r = await ctx.call("nikola", "POST", `/v1/projects/${id}/revert`, { rev: 1 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ rev: 4, base: 1, rebased: true });
    const d = await docOf(id);
    expect(node(d, "headline").y).toBe(node(await docOf(id, 0), "headline").y);
    expect(node(d, "sub").style.size).toBe(30);
    expect(node(d, "sticker")).toBeDefined();
    const rev = (await ctx.call("nikola", "GET", `/v1/projects/${id}/revisions/4`)).json;
    expect(rev).toMatchObject({ kind: "revert", reverts: 1, author: "human", message: "revert rev 1 (“test edit”)" });
    // Reverting the insert removes only the sticker.
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/revert`, { rev: 3, message: "no sticker" })).json.rev).toBe(5);
    expect(node(await docOf(id), "sticker")).toBeUndefined();
    expect(node(await docOf(id), "sub").style.size).toBe(30);
    // And the revert itself can be reverted.
    await ctx.call("nikola", "POST", `/v1/projects/${id}/revert`, { rev: 5 });
    expect(node(await docOf(id), "sticker")).toMatchObject({ fill: "#AC1922" });
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/revert`, { rev: 0 })).status).toBe(400);
  });

  it("refuses with a clear message when a later revision changed the same thing", async () => {
    const id = await createLux(ctx);
    await ops(id, "nikola", 0, [{ op: "set", node: "headline", path: "y", value: 80 }]); // 1
    await ops(id, "nikola", 1, [{ op: "set", node: "headline", path: "y", value: 70 }]); // 2
    await ops(id, "nikola", 2, [{ op: "insert", parent: "square", node: { id: "sticker", type: "ellipse", x: 900, y: 120, w: 40, h: 40, fill: "#AC1922" } }]); // 3
    await ops(id, "nikola", 3, [{ op: "set", node: "sticker", path: "fill", value: "#305880" }]); // 4
    const before = await head(id);
    const c = await ctx.call("nikola", "POST", `/v1/projects/${id}/revert`, { rev: 1 });
    expect(c.status).toBe(409);
    expect(c.json.error.code).toBe("conflict");
    expect(c.json.error.message).toBe("rev 1 can't be reverted on its own: later changes touch the same things: headline.y (rev 2). Revert rev 2 first, or restore an older version.");
    expect(c.json.error.details).toMatchObject({ revert: 1, later: [2] });
    const c2 = await ctx.call("nikola", "POST", `/v1/projects/${id}/revert`, { rev: 3 });
    expect(c2.json.error.message).toMatch(/^rev 3 can't be reverted on its own: later changes touch the same things: sticker\.fill \(rev 4\)/);
    expect(await head(id)).toBe(before); // nothing written
  });

  it("goes through pins: an agent cannot revert his tweak; his revert of the agent's edit pins it", async () => {
    const id = await createLux(ctx);
    await ops(id, "nikola", 0, [{ op: "set", node: "headline", path: "y", value: 80 }]); // 1
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "" });
    const p = await ctx.call("claude", "POST", `/v1/projects/${id}/revert`, { rev: 1 });
    expect(p.status).toBe(422);
    expect(p.json.error.code).toBe("pinned");
    await ops(id, "claude", 1, [{ op: "set", node: "sub", path: "x", value: 160 }]); // 2
    await ctx.call("claude", "POST", `/v1/projects/${id}/handoff/back`, { summary: "moved the sub" });
    // He reverts the agent's move; next turn the agent may not move it again.
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/revert`, { rev: 2 })).json.rev).toBe(3);
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "keep the sub where it was" });
    expect((await ops(id, "claude", 3, [{ op: "set", node: "sub", path: "x", value: 160 }])).json.error.details.blocked[0]).toMatchObject({ key: "sub.x", source: "soft" });
  });
});

describe("two full rounds", () => {
  it("compares each agent turn with its own hand-off and pins only the latest round", async () => {
    const id = await createLux(ctx);
    // Round 1: he moves the headline and adds a sticker; the agent rewrites the headline.
    await ops(id, "nikola", 0, [{ op: "set", node: "headline", path: "x", value: 140 }]); // 1
    await ops(id, "nikola", 1, [{ op: "insert", parent: "square", node: { id: "sticker", type: "ellipse", x: 900, y: 120, w: 40, h: 40, fill: "#AC1922" } }]); // 2
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "shorter headline" });
    await ctx.call("claude", "POST", `/v1/projects/${id}/lease`, {});
    expect((await ctx.call("claude", "GET", `/v1/projects/${id}/diff`)).json.from).toBe(0);
    await ops(id, "claude", 2, [{ op: "set", node: "headline", path: "spans", value: [{ text: "Исти модели." }] }]); // 3
    await ctx.call("claude", "POST", `/v1/projects/${id}/handoff/back`, { summary: "shorter headline" });
    let s = await state(id);
    expect(s.agent).toMatchObject({ name: "agent-1", rev: 3, since: { name: "handoff-1", rev: 2 } });

    // Round 2: he recolours the sticker and moves the sub; only these are pinned now.
    await ops(id, "nikola", 3, [{ op: "set", node: "sticker", path: "fill", value: "#305880" }]); // 4
    await ops(id, "nikola", 4, [{ op: "set", node: "sub", path: "y", value: 300 }]); // 5
    const pins = (await ctx.call("claude", "GET", `/v1/projects/${id}/pins`)).json;
    expect(pins.since).toBe("agent-1");
    expect(pins.soft.map((p: any) => `${p.node}.${p.path}`).sort()).toEqual(["sticker.fill", "sub.y"]);
    expect((await state(id)).softPins).toBe(2);
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "sub in one line" });
    await ctx.call("claude", "POST", `/v1/projects/${id}/lease`, {});
    // The agent's default diff starts at its last checkpoint: only round 2.
    const d = (await ctx.call("claude", "GET", `/v1/projects/${id}/diff`)).json;
    expect(d.from).toBe(3);
    expect(d.items.map((i: any) => i.id).sort()).toEqual(["sticker", "sub"]);
    expect((await ops(id, "claude", 5, [{ op: "set", node: "sub", path: "y", value: 320 }])).json.error.code).toBe("pinned");
    await ops(id, "claude", 5, [{ op: "set", node: "sub", path: "spans", value: [{ text: "Две судии, 19 модели." }] }]); // 6
    await ctx.call("claude", "POST", `/v1/projects/${id}/handoff/back`, { summary: "sub in one line" });
    s = await state(id);
    expect(s.agent).toMatchObject({ name: "agent-2", rev: 6, since: { name: "handoff-2", rev: 5 } });
    // "What the agent changed" for agent-2 lists only the sub, not the first turn's headline.
    const turn2 = (await ctx.call("nikola", "GET", `/v1/projects/${id}/diff?since=${s.agent.since.name}&to=agent-2`)).json;
    expect(turn2.items.map((i: any) => [i.id, i.authors])).toEqual([["sub", ["agent:claude"]]]);
    // Round 1 tweaks are no longer soft pins, round 2's are gone too after agent-2.
    expect((await ctx.call("claude", "GET", `/v1/projects/${id}/pins`)).json.soft).toEqual([]);
    // He approves the result.
    expect((await ctx.call("nikola", "POST", `/v1/projects/${id}/approve`, { note: "done" })).json).toMatchObject({ checkpoint: "approved", rev: 6 });
    const cps = (await ctx.call("nikola", "GET", `/v1/projects/${id}/checkpoints`)).json.checkpoints.map((c: any) => `${c.name}@${c.rev}`);
    expect(cps).toEqual(["created@0", "handoff-1@2", "agent-1@3", "handoff-2@5", "agent-2@6", "approved@6"]);
  });

  it("an agent turn after a take-back still starts at the newest hand-off", async () => {
    const id = await createLux(ctx);
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "first try" });
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff/take-back`, {});
    await ops(id, "nikola", 0, [{ op: "set", node: "sub", path: "x", value: 137 }]); // 1
    await ctx.call("nikola", "POST", `/v1/projects/${id}/handoff`, { note: "second try" });
    await ctx.call("claude", "POST", `/v1/projects/${id}/lease`, {});
    expect((await state(id)).handoff).toMatchObject({ name: "handoff-2", note: "second try" });
    await ops(id, "claude", 1, [{ op: "set", node: "kicker", path: "x", value: 136 }]);
    await ctx.call("claude", "POST", `/v1/projects/${id}/handoff/back`, { summary: "kicker" });
    expect((await state(id)).agent.since).toEqual({ name: "handoff-2", rev: 1 });
  });
});
