// Autosave (PLAN §3.2, §3.5): local edits are applied at once and queued as op batches. After
// ~1 s without new edits the queue is sent as one revision against the last confirmed rev.
// Network / server errors keep the queue and retry with back-off; a rejection (conflict,
// invalid, leased) drops the rejected batches and tells the store to reload.
import type { Op } from "@post-studio/ops";

export interface SaveResult {
  rev: number;
  rebased: boolean;
}

export interface SaveError {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
}

export type SaveStatus = "saved" | "waiting" | "saving" | "retrying" | "error";

export interface OutboxState {
  status: SaveStatus;
  /** Batches not yet confirmed (queued + in flight). */
  pending: number;
  /** Last confirmed revision. */
  rev: number;
  error?: string;
  retryInMs?: number;
}

export interface OutboxOptions {
  post: (base: number, ops: Op[], message: string) => Promise<SaveResult>;
  rev: number;
  debounceMs?: number;
  onChange?: (s: OutboxState) => void;
  onSaved?: (r: SaveResult) => void;
  onRejected?: (err: SaveError, dropped: number) => void;
  /** Timer functions (tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  toError?: (e: unknown) => SaveError;
}

interface Entry {
  ops: Op[];
  label: string;
}

const MAX_OPS = 4000;

export function messageFor(labels: string[]): string {
  const uniq: string[] = [];
  for (const l of labels) if (l && uniq[uniq.length - 1] !== l) uniq.push(l);
  let m = uniq.join("; ");
  if (m.length > 180) m = m.slice(0, 177) + "…";
  return m || "edit";
}

export class Outbox {
  private queue: Entry[] = [];
  private inflight: Entry[] = [];
  private timer: unknown;
  private attempts = 0;
  private flushWaiters: Array<() => void> = [];
  private state: OutboxState;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private stopped = false;

  constructor(private readonly opts: OutboxOptions) {
    this.state = { status: "saved", pending: 0, rev: opts.rev };
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  get rev(): number {
    return this.state.rev;
  }

  /** The server moved on without us (reload after someone else's revision). */
  resetRev(rev: number): void {
    this.state = { ...this.state, rev };
    this.emit({});
  }

  get idle(): boolean {
    return !this.queue.length && !this.inflight.length;
  }

  snapshot(): OutboxState {
    return { ...this.state };
  }

  enqueue(ops: Op[], label: string): void {
    if (!ops.length || this.stopped) return;
    this.queue.push({ ops, label });
    if (!this.inflight.length) this.schedule(this.opts.debounceMs ?? 1000);
    this.emit({ status: this.inflight.length ? "saving" : "waiting" });
  }

  /** Send now and resolve when everything queued so far is confirmed (or dropped). */
  flush(): Promise<void> {
    if (this.idle) return Promise.resolve();
    const p = new Promise<void>((resolve) => this.flushWaiters.push(resolve));
    if (!this.inflight.length) {
      if (this.timer) this.clearTimer(this.timer);
      this.timer = undefined;
      void this.send();
    }
    return p;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
  }

  private schedule(ms: number) {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.send();
    }, ms);
  }

  private emit(patch: Partial<OutboxState>) {
    this.state = { ...this.state, ...patch, pending: this.queue.length + this.inflight.length };
    if (!patch.error && patch.status && patch.status !== "error" && patch.status !== "retrying") delete this.state.error;
    if (patch.status !== "retrying") delete this.state.retryInMs;
    this.opts.onChange?.(this.snapshot());
  }

  private async send(): Promise<void> {
    if (this.inflight.length || !this.queue.length || this.stopped) return;
    // Coalesce queued batches (bounded by MAX_OPS) into one revision.
    let count = 0;
    while (this.queue.length && (count === 0 || count + this.queue[0].ops.length <= MAX_OPS)) {
      const e = this.queue.shift()!;
      count += e.ops.length;
      this.inflight.push(e);
    }
    this.emit({ status: "saving" });
    const ops = this.inflight.flatMap((e) => e.ops);
    const message = messageFor(this.inflight.map((e) => e.label));
    try {
      const r = await this.opts.post(this.state.rev, ops, message);
      this.inflight = [];
      this.attempts = 0;
      this.state.rev = r.rev;
      this.opts.onSaved?.(r);
      if (this.queue.length) {
        this.emit({ status: "saving" });
        void this.send();
      } else {
        this.emit({ status: "saved" });
        this.resolveWaiters();
      }
    } catch (e) {
      const err = this.opts.toError ? this.opts.toError(e) : (e as SaveError);
      if (err.retryable) {
        // Put the batches back in front and retry: 1 s, 2 s, 4 s … up to 15 s.
        this.queue.unshift(...this.inflight);
        this.inflight = [];
        const wait = Math.min(15_000, 1000 * 2 ** this.attempts++);
        this.emit({ status: "retrying", error: err.message, retryInMs: wait });
        this.schedule(wait);
      } else {
        const dropped = this.inflight.length + this.queue.length;
        this.inflight = [];
        this.queue = [];
        this.attempts = 0;
        this.emit({ status: "error", error: err.message });
        this.opts.onRejected?.(err, dropped);
        this.resolveWaiters();
      }
    }
  }

  private resolveWaiters() {
    const w = this.flushWaiters;
    this.flushWaiters = [];
    for (const f of w) f();
  }
}
