// The "handed to the agent" banner in both views: what the host dispatcher did with the hand-off.
import type { HandoffState } from "../api.ts";

export interface WaitingBanner {
  /** pending | claimed | started | failed | cancelled | none (a hand-off from before auto-start). */
  state: string;
  text: string;
  /** Show a Retry / Start agent button. */
  retry?: string;
  failed?: boolean;
}

/** Only for the agent's turn while no agent holds the lease (the lease banner takes over then). */
export function waitingBanner(h: HandoffState): WaitingBanner {
  const d = h.dispatch;
  const disp = h.dispatcher;
  const manual = "send OptiBot a message on Telegram to pick it up";
  if (!d) return { state: "none", text: `Auto-start was not set up for this hand-off: ${manual}, or start it here.`, retry: "Start agent" };
  if (d.state === "started") {
    return {
      state: "started",
      text: d.jobStatus === "queued" ? `Agent job #${d.jobId} queued: it starts when a slot is free.` : `Agent job #${d.jobId} started. It takes the project in a moment.`,
    };
  }
  if (d.state === "failed") return { state: "failed", failed: true, text: `Couldn't start the agent: ${d.error ?? "unknown error"}.`, retry: "Retry" };
  if (d.state === "cancelled") return { state: "cancelled", text: `Auto-start stopped${d.error ? ` (${d.error})` : ""}.`, retry: "Start agent" };
  if (!disp?.online) return { state: d.state, text: `Auto-start is not running right now. The agent starts when it is back, or ${manual}.` };
  if (!disp.enabled) return { state: d.state, text: `Auto-start is switched off: ${manual}.` };
  if (disp.busy) return { state: d.state, text: `Waiting to start: ${disp.busy}.` };
  return { state: d.state, text: "Starting an agent job…" };
}
