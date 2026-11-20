import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_URL = "http://127.0.0.1:3472";
export const DEFAULT_TOKEN_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "post-studio", "token");

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function resolveToken(tokenFile?: string): string | undefined {
  if (process.env.PSTUDIO_TOKEN) return process.env.PSTUDIO_TOKEN.trim();
  const f = tokenFile ?? DEFAULT_TOKEN_FILE;
  return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
}

export class Client {
  constructor(
    public readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  /** Raw bytes plus response headers (render). */
  async raw(method: string, path: string): Promise<{ bytes: Uint8Array; headers: Headers }> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl.replace(/\/$/, "") + path, { method, headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    } catch (e) {
      throw new ApiError(0, "unreachable", `cannot reach ${this.baseUrl} (${(e as Error).cause ?? (e as Error).message}); is the server running? (pstudio serve)`);
    }
    if (!res.ok) {
      const type = res.headers.get("content-type") ?? "";
      const j = type.includes("json") ? ((await res.json()) as any) : { error: { code: "http", message: await res.text() } };
      throw new ApiError(res.status, j.error?.code ?? "http", j.error?.message ?? res.statusText, j.error?.details);
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
  }

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const isBytes = body instanceof Uint8Array;
    let res: Response;
    try {
      res = await fetch(this.baseUrl.replace(/\/$/, "") + path, {
        method,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined && !isBytes ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : isBytes ? (body as any) : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, "unreachable", `cannot reach ${this.baseUrl} (${(e as Error).cause ?? (e as Error).message}); is the server running? (pstudio serve)`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      const j = type.includes("json") ? ((await res.json()) as any) : { error: { code: "http", message: await res.text() } };
      throw new ApiError(res.status, j.error?.code ?? "http", j.error?.message ?? res.statusText, j.error?.details);
    }
    if (type.includes("json")) return (await res.json()) as T;
    if (type.startsWith("text/")) return (await res.text()) as T;
    return new Uint8Array(await res.arrayBuffer()) as T;
  }
}
