// HTTP client for the Post Studio API. The editor authenticates with its session cookie and
// marks every request with the editor header (the server's CSRF guard for cookie writes).
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: any,
  ) {
    super(message);
  }
  /** Network down or server error: worth retrying. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

export const EDITOR_HEADER = "x-post-studio-editor";

let onUnauthorized: (() => void) | undefined;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  const isBytes = body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { [EDITOR_HEADER]: "1", ...(body !== undefined && !isBytes ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : isBytes ? (body as BodyInit) : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, "network", `server unreachable (${(e as Error).message})`);
  }
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json().catch(() => undefined) : undefined;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/v1/auth/")) onUnauthorized?.();
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "error", err.message ?? `${res.status} ${res.statusText}`, err.details);
  }
  return (data ?? (await res.arrayBuffer())) as T;
}

export interface ProjectSummary {
  id: string;
  title: string;
  head_rev: number;
  turn: "human" | "agent";
  created_by: string;
  created_at: string;
  updated_at: string;
  lease: Lease | null;
  /** Revision of the newest approval, if any. */
  approved_rev: number | null;
}

export interface Lease {
  holder: string;
  expiresAt: string;
  secondsLeft: number;
}

export interface Checkpoint {
  name: string;
  rev: number;
  author: string;
  note: string | null;
  created_at: string;
}

/** What he pointed at when he handed over: the server's snapshot of each node at that moment. */
export interface FocusItem {
  id: string;
  type: string;
  frame: string;
  name?: string;
  role?: string;
  text?: string;
}

/** The auto-start of the latest hand-off by the host dispatcher. */
export interface DispatchInfo {
  checkpoint: string;
  state: "pending" | "claimed" | "started" | "failed" | "cancelled";
  attempts: number;
  jobId: number | null;
  jobStatus: string | null;
  error: string | null;
  updatedAt: string;
}

export interface HandoffState {
  project: string;
  turn: "human" | "agent";
  head: number;
  lease: Lease | null;
  /** `at`: motion projects, the playhead moment (ms) he was looking at when he handed over. */
  handoff: (Checkpoint & { focus?: FocusItem[]; focusText?: string | null; at?: number | null; atText?: string | null }) | null;
  /** null for hand-offs made before auto-start existed. */
  dispatch?: DispatchInfo | null;
  dispatcher?: { online: boolean; enabled: boolean; busy: string | null; seenAt: string | null };
  /** The latest agent-N, with the checkpoint its turn started from (what "What the agent changed" compares with). */
  agent: (Checkpoint & { since: { name: string; rev: number } | null }) | null;
  approved: (Checkpoint & { current: boolean }) | null;
  softPins: number;
}

export interface RevisionInfo {
  rev: number;
  base: number | null;
  kind: "create" | "ops" | "restore" | "revert";
  author: string;
  message: string;
  opCount: number;
  rebased: boolean;
  reverts?: number;
  overrides: Array<{ key: string; reason: string }>;
  warnings: number;
  createdAt: string;
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  if (s < 90) return "a minute ago";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export const authorLabel = (a: string) => (a === "human" ? "Nikola" : a.replace(/^agent:/, "agent · "));
