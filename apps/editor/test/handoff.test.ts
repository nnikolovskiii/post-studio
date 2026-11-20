// Hand-off helpers shared by the desktop and phone views: chip labels for what he points at,
// toggling in point mode, and the auto-start banner wording for each dispatch state.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Document } from "@post-studio/schema";
import type { HandoffState } from "../src/api.ts";
import { waitingBanner } from "../src/model/dispatch.ts";
import { FOCUS_MAX, focusChips, togglePointed } from "../src/model/focus.ts";

const doc = JSON.parse(readFileSync(new URL("../../../fixtures/lux-6-square.hand.json", import.meta.url), "utf8")) as Document;

describe("focus chips", () => {
  it("labels text by its words, other layers by name / role / id, and drops ids that are gone", () => {
    const chips = focusChips(doc, ["headline", "chart", "row-1-a", "gone", "headline", "square"]);
    expect(chips.map((c) => c.id)).toEqual(["headline", "chart", "row-1-a", "square"]);
    expect(chips[0]).toMatchObject({ kind: "text", label: expect.stringMatching(/^headline: “.+”$/) });
    expect(chips[1]).toMatchObject({ kind: "group", label: "chart" });
    expect(chips[2]).toMatchObject({ kind: "rect", label: "row-1-a" });
    expect(chips[3]).toMatchObject({ kind: "frame" });
    expect(chips[0].label.length).toBeLessThan(45);
  });

  it("tap toggles, and the list stops at the cap", () => {
    expect(togglePointed(["a"], "b")).toEqual(["a", "b"]);
    expect(togglePointed(["a", "b"], "a")).toEqual(["b"]);
    const full = Array.from({ length: FOCUS_MAX }, (_, i) => `n${i}`);
    expect(togglePointed(full, "extra")).toEqual(full);
  });
});

describe("auto-start banner", () => {
  const base: HandoffState = { project: "p", turn: "agent", head: 3, lease: null, handoff: null, agent: null, approved: null, softPins: 0 };
  const d = (state: string, extra: Record<string, unknown> = {}) => ({ checkpoint: "handoff-1", state, attempts: 1, jobId: null, jobStatus: null, error: null, updatedAt: "", ...extra }) as HandoffState["dispatch"];
  const on = { online: true, enabled: true, busy: null, seenAt: "" };

  it("words each state", () => {
    expect(waitingBanner({ ...base, dispatch: null })).toMatchObject({ state: "none", retry: "Start agent" });
    expect(waitingBanner({ ...base, dispatch: d("pending"), dispatcher: on }).text).toBe("Starting an agent job…");
    expect(waitingBanner({ ...base, dispatch: d("claimed"), dispatcher: on }).text).toBe("Starting an agent job…");
    expect(waitingBanner({ ...base, dispatch: d("pending"), dispatcher: { ...on, online: false } }).text).toMatch(/not running right now/);
    expect(waitingBanner({ ...base, dispatch: d("pending"), dispatcher: { ...on, enabled: false } }).text).toMatch(/switched off.*Telegram/);
    expect(waitingBanner({ ...base, dispatch: d("pending"), dispatcher: { ...on, busy: "2 studio agent jobs are already running" } }).text).toMatch(/^Waiting to start: 2 studio/);
    expect(waitingBanner({ ...base, dispatch: d("started", { jobId: 12, jobStatus: "running" }) })).toMatchObject({ text: "Agent job #12 started. It takes the project in a moment." });
    expect(waitingBanner({ ...base, dispatch: d("started", { jobId: 12, jobStatus: "queued" }) }).text).toMatch(/#12 queued/);
    expect(waitingBanner({ ...base, dispatch: d("failed", { error: "boom" }) })).toMatchObject({ failed: true, retry: "Retry", text: "Couldn't start the agent: boom." });
    expect(waitingBanner({ ...base, dispatch: d("cancelled", { error: "superseded" }) })).toMatchObject({ retry: "Start agent" });
  });
});
