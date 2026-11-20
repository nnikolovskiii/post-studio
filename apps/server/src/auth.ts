// Editor login (PLAN §3.8): one admin user, a password set with `pstudio admin set-password`,
// and an httpOnly session cookie. Agents keep using bearer tokens; the editor writes as 'human'.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";

export const SESSION_COOKIE = "pst_session";
/** Header the editor sends on every write. Cross-site pages cannot set it without a CORS preflight. */
export const EDITOR_HEADER = "x-post-studio-editor";
export const SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const nowIso = () => new Date().toISOString();

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export function hashPassword(password: string, salt = randomBytes(16)): string {
  const key = scryptSync(password.normalize("NFC"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64");
  const want = Buffer.from(parts[5], "base64");
  const got = scryptSync(password.normalize("NFC"), salt, want.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Parse a Cookie header into name → value (first one wins). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function sessionCookie(token: string, opts: { secure: boolean; maxAgeSeconds: number }): string {
  return [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${opts.maxAgeSeconds}`, ...(opts.secure ? ["Secure"] : [])].join("; ");
}

export const clearedCookie = (secure: boolean) => sessionCookie("", { secure, maxAgeSeconds: 0 });

export interface Session {
  id: string;
  createdAt: string;
  expiresAt: number;
}

/** Password, sessions and a login back-off. Lives on the same SQLite file as everything else. */
export class EditorAuth {
  /** Recent wrong-password times per client (the client IP; behind Traefik it comes from trusted proxy headers). */
  private failures = new Map<string, number[]>();

  constructor(
    private readonly db: DB,
    private readonly clock: () => number = Date.now,
    private readonly limits = { failures: 5, windowMs: 60_000 },
  ) {}

  hasPassword(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM admin_user WHERE id = 1`).get();
  }

  username(): string | undefined {
    return (this.db.prepare(`SELECT username FROM admin_user WHERE id = 1`).get() as { username: string } | undefined)?.username;
  }

  /** Set (or replace) the admin password. Every existing session is signed out. */
  setPassword(password: string, username = "nikola"): void {
    if (typeof password !== "string" || [...password].length < MIN_PASSWORD) {
      throw new AuthError(400, "weak-password", `the password needs at least ${MIN_PASSWORD} characters`);
    }
    const hash = hashPassword(password);
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO admin_user (id, username, password_hash, updated_at) VALUES (1, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash, updated_at = excluded.updated_at`)
        .run(username, hash, nowIso());
      this.db.prepare(`DELETE FROM sessions`).run();
    })();
  }

  /** Check the password and open a session. Returns the raw token for the cookie (never stored). */
  login(password: unknown, userAgent?: string, client = "local"): { token: string; session: Session } {
    const t = this.clock();
    // Per client, so a stranger hammering the public login cannot lock Nikola out from his own IP.
    for (const [k, v] of this.failures) {
      const recent = v.filter((f) => t - f < this.limits.windowMs);
      if (recent.length) this.failures.set(k, recent);
      else this.failures.delete(k);
    }
    const mine = this.failures.get(client) ?? [];
    if (mine.length >= this.limits.failures) {
      const retry = Math.ceil((mine[0] + this.limits.windowMs - t) / 1000);
      throw new AuthError(429, "too-many-attempts", `too many wrong passwords; try again in ${retry}s`, retry);
    }
    const row = this.db.prepare(`SELECT password_hash FROM admin_user WHERE id = 1`).get() as { password_hash: string } | undefined;
    if (!row) throw new AuthError(409, "no-password", "no editor password is set yet: run `pstudio admin set-password` on the server");
    if (typeof password !== "string" || !password || !verifyPassword(password, row.password_hash)) {
      this.failures.set(client, [...mine, t]);
      throw new AuthError(401, "bad-password", "wrong password");
    }
    this.failures.delete(client);
    const token = "pss_" + randomBytes(32).toString("base64url");
    const session: Session = { id: sha(token), createdAt: new Date(t).toISOString(), expiresAt: t + SESSION_DAYS * 86_400_000 };
    this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(t);
    this.db
      .prepare(`INSERT INTO sessions (id_hash, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?)`)
      .run(session.id, session.createdAt, session.expiresAt, session.createdAt, (userAgent ?? "").slice(0, 200));
    return { token, session };
  }

  /** Cookie token → session, or undefined when unknown / expired. */
  session(token: string | undefined): Session | undefined {
    if (!token || !token.startsWith("pss_")) return undefined;
    const row = this.db.prepare(`SELECT id_hash, created_at, expires_at, last_seen_at FROM sessions WHERE id_hash = ?`).get(sha(token)) as
      | { id_hash: string; created_at: string; expires_at: number; last_seen_at: string | null }
      | undefined;
    const t = this.clock();
    if (!row || row.expires_at <= t) return undefined;
    // last_seen is informational; write it at most once a minute.
    if (!row.last_seen_at || t - Date.parse(row.last_seen_at) > 60_000) {
      this.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?`).run(new Date(t).toISOString(), row.id_hash);
    }
    return { id: row.id_hash, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  logout(token: string | undefined): boolean {
    if (!token) return false;
    return this.db.prepare(`DELETE FROM sessions WHERE id_hash = ?`).run(sha(token)).changes > 0;
  }

  logoutAll(): number {
    return this.db.prepare(`DELETE FROM sessions`).run().changes;
  }

  sessionCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?`).get(this.clock()) as { n: number }).n;
  }
}
