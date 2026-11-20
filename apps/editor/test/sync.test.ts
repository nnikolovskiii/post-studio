// Autosave queue (apps/editor/src/sync.ts) with fake timers and a scripted server.
import { describe, expect, it } from "vitest";
import type { Op } from "@post-studio/ops";
import { Outbox, messageFor, type OutboxState, type SaveError, type SaveResult } from "../src/sync.ts";

function harness(rev = 0, debounceMs = 1000) {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const posts: Array<{ base: number; ops: Op[]; message: string; resolve: (r: SaveResult) => void; reject: (e: SaveError) => void }> = [];
  const states: OutboxState[] = [];
  const rejected: Array<{ err: SaveError; dropped: number }> = [];
  const box = new Outbox({
    rev,
    debounceMs,
    post: (base, ops, message) => new Promise((resolve, reject) => posts.push({ base, ops, message, resolve, reject })),
    onChange: (s) => states.push(s),
    onRejected: (err, dropped) => rejected.push({ err, dropped }),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (t) => timers.delete(t as number),
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
    await Promise.resolve();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { box, posts, states, rejected, advance, settle, last: () => states[states.length - 1] };
}

const op = (v: number): Op => ({ op: "set", node: "headline", path: "x", value: v });

describe("autosave outbox", () => {
  it("debounces edits into one revision against the last confirmed rev", async () => {
    const h = harness(3);
    h.box.enqueue([op(1)], "move headline");
    await h.advance(500);
    h.box.enqueue([op(2)], "move headline");
    h.box.enqueue([op(3)], "colour");
    expect(h.last()).toMatchObject({ status: "waiting", pending: 3 });
    await h.advance(999);
    expect(h.posts.length).toBe(0); // the timer restarts on every edit
    await h.advance(1);
    expect(h.posts.length).toBe(1);
    expect(h.posts[0]).toMatchObject({ base: 3, message: "move headline; colour" });
    expect(h.posts[0].ops.length).toBe(3);
    h.posts[0].resolve({ rev: 4, rebased: false });
    await h.settle();
    expect(h.last()).toMatchObject({ status: "saved", pending: 0, rev: 4 });
  });

  it("queues edits made while a save is in flight and sends them next, on the new base", async () => {
    const h = harness(0);
    h.box.enqueue([op(1)], "a");
    await h.advance(1000);
    h.box.enqueue([op(2)], "b");
    expect(h.last().status).toBe("saving");
    h.posts[0].resolve({ rev: 1, rebased: false });
    await h.settle();
    expect(h.posts.length).toBe(2);
    expect(h.posts[1]).toMatchObject({ base: 1, message: "b" });
    h.posts[1].resolve({ rev: 2, rebased: false });
    await h.settle();
    expect(h.last()).toMatchObject({ status: "saved", rev: 2, pending: 0 });
  });

  it("retries network / server errors with back-off and keeps the edits", async () => {
    const h = harness(0);
    h.box.enqueue([op(1)], "a");
    await h.advance(1000);
    h.posts[0].reject({ status: 0, code: "network", message: "offline", retryable: true });
    await h.settle();
    expect(h.last()).toMatchObject({ status: "retrying", retryInMs: 1000, pending: 1, error: "offline" });
    h.box.enqueue([op(2)], "b"); // a new edit joins the queue; the next attempt comes one debounce later
    await h.advance(1000);
    expect(h.posts.length).toBe(2);
    expect(h.posts[1].ops.length).toBe(2); // both edits, one revision
    h.posts[1].reject({ status: 503, code: "unavailable", message: "busy", retryable: true });
    await h.settle();
    expect(h.last()).toMatchObject({ status: "retrying", retryInMs: 2000 });
    await h.advance(1999);
    expect(h.posts.length).toBe(2);
    await h.advance(1);
    expect(h.posts.length).toBe(3);
    h.posts[2].resolve({ rev: 1, rebased: false });
    await h.settle();
    expect(h.last()).toMatchObject({ status: "saved", rev: 1, pending: 0 });
    expect(h.last().error).toBeUndefined();
  });

  it("drops rejected batches (conflict, invalid, leased) and reports them", async () => {
    const h = harness(5);
    h.box.enqueue([op(1)], "a");
    await h.advance(1000);
    h.box.enqueue([op(2)], "b");
    h.posts[0].reject({ status: 423, code: "leased", message: "agent:claude holds the lease", retryable: false });
    await h.settle();
    expect(h.rejected).toEqual([{ err: expect.objectContaining({ code: "leased" }), dropped: 2 }]);
    expect(h.last()).toMatchObject({ status: "error", pending: 0, rev: 5 });
  });

  it("flush sends at once and resolves when confirmed", async () => {
    const h = harness(0);
    h.box.enqueue([op(1)], "a");
    let done = false;
    const p = h.box.flush().then(() => (done = true));
    expect(h.posts.length).toBe(1);
    await h.settle();
    expect(done).toBe(false);
    h.posts[0].resolve({ rev: 1, rebased: false });
    await p;
    expect(done).toBe(true);
    await expect(h.box.flush()).resolves.toBeUndefined(); // idle
  });

  it("writes short revision messages", () => {
    expect(messageFor(["move a", "move a", "colour b"])).toBe("move a; colour b");
    expect(messageFor([])).toBe("edit");
    expect(messageFor(Array.from({ length: 40 }, (_, i) => `edit number ${i}`)).length).toBeLessThanOrEqual(180);
  });
});
