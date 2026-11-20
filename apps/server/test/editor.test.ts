// Editor-facing server surface (PLAN §3.8, Phase 3): password login → httpOnly session cookie,
// CSRF header on cookie writes, login back-off, author "human" for editor writes, the static
// editor shell (CSP, traversal guard) and the font endpoints the browser shapes text with.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EDITOR_HEADER, SESSION_COOKIE, hashPassword, verifyPassword } from "../src/auth.ts";
import { buildApp } from "../src/app.ts";
import { EDITOR_CSP } from "../src/editor.ts";
import { Store } from "../src/store.ts";
import { createLux, sharedFonts } from "./helpers.ts";

const PASSWORD = "correct horse battery";
let t = Date.parse("2026-11-09T12:00:00Z");
let dataDir: string;
let editorDir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  t = Date.parse("2026-11-09T12:00:00Z");
  dataDir = mkdtempSync(join(tmpdir(), "pstudio-editor-test-"));
  editorDir = mkdtempSync(join(tmpdir(), "pstudio-editor-dist-"));
  mkdirSync(join(editorDir, "static"));
  writeFileSync(join(editorDir, "index.html"), "<!doctype html><title>Post Studio</title><div id=root></div>");
  writeFileSync(join(editorDir, "static", "app.js"), "console.log(1)");
  writeFileSync(join(editorDir, "secret.txt"), "outside static");
  store = new Store({ dataDir, fonts: await sharedFonts(), clock: () => t });
  app = buildApp({ store, editorDir });
});
afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(editorDir, { recursive: true, force: true });
});

const H = { [EDITOR_HEADER]: "1" };
const login = (password: string, headers: Record<string, string> = H) => app.inject({ method: "POST", url: "/v1/auth/login", headers, payload: { password } });
const cookieOf = (res: { headers: Record<string, unknown> }) => {
  const raw = String(res.headers["set-cookie"] ?? "");
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(raw);
  return m ? `${SESSION_COOKIE}=${m[1]}` : "";
};

describe("password", () => {
  it("hashes with scrypt and a salt, verifies, and refuses short passwords", () => {
    const a = hashPassword(PASSWORD);
    expect(a).not.toContain(PASSWORD);
    expect(a).not.toBe(hashPassword(PASSWORD));
    expect(verifyPassword(PASSWORD, a)).toBe(true);
    expect(verifyPassword("wrong horse battery", a)).toBe(false);
    expect(() => store.auth.setPassword("short")).toThrow(/at least 10/);
  });

  it("refuses to log in before a password is set", async () => {
    const r = await login(PASSWORD);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("no-password");
    expect((await app.inject({ method: "GET", url: "/v1/auth/state" })).json()).toMatchObject({ passwordSet: false, loggedIn: false });
  });
});

describe("login and session cookie", () => {
  beforeEach(() => store.auth.setPassword(PASSWORD));

  it("sets an httpOnly SameSite=Strict cookie, and editor writes are authored by human", async () => {
    const r = await login(PASSWORD);
    expect(r.statusCode).toBe(200);
    const raw = String(r.headers["set-cookie"]);
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Strict/);
    expect(raw).toMatch(/Path=\//);
    expect(raw).not.toMatch(/Secure/); // plain http on 127.0.0.1
    const cookie = cookieOf(r);
    // The raw token is never stored, only its hash.
    const rows = store.db.prepare("SELECT id_hash FROM sessions").all() as Array<{ id_hash: string }>;
    expect(rows.length).toBe(1);
    expect(cookie).not.toContain(rows[0].id_hash);

    expect((await app.inject({ method: "GET", url: "/v1/auth/state", headers: { cookie } })).json()).toMatchObject({ passwordSet: true, loggedIn: true, username: "nikola" });
    expect((await app.inject({ method: "GET", url: "/v1/whoami", headers: { cookie } })).json()).toEqual({ name: "editor", kind: "session", author: "human" });

    // An agent creates the project, the editor edits it: the revision is Nikola's.
    const agent = store.createToken("claude", "agent").token;
    const project = await createLux({ call: async (_who: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.inject({ method: method as "POST", url, headers: { authorization: `Bearer ${agent}`, ...headers }, payload: body as any });
      return { status: res.statusCode, json: res.json() };
    } } as any);
    const w = await app.inject({ method: "POST", url: `/v1/projects/${project}/ops`, headers: { cookie, ...H }, payload: { base: 0, ops: [{ op: "set", node: "headline", path: "x", value: 140 }], message: "move headline" } });
    expect(w.statusCode).toBe(200);
    const revs = (await app.inject({ method: "GET", url: `/v1/projects/${project}/revisions`, headers: { cookie } })).json().revisions;
    expect(revs.at(-1)).toMatchObject({ rev: 1, author: "human", message: "move headline" });
  });

  it("needs the editor header on login and on cookie writes (CSRF), not on reads", async () => {
    expect((await login(PASSWORD, {})).statusCode).toBe(403);
    const cookie = cookieOf(await login(PASSWORD));
    expect((await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie } })).statusCode).toBe(200);
    const noHeader = await app.inject({ method: "POST", url: "/v1/projects", headers: { cookie }, payload: {} });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json().error.code).toBe("csrf");
    // Bearer tokens (CLI / agents) are not affected.
    const tok = store.createToken("cli", "agent").token;
    expect((await app.inject({ method: "POST", url: "/v1/validate", headers: { authorization: `Bearer ${tok}` }, payload: {} })).statusCode).toBe(200);
  });

  it("rejects wrong passwords and backs off after 5 failures a minute", async () => {
    for (let i = 0; i < 5; i++) expect((await login("wrong password!")).statusCode).toBe(401);
    const blocked = await login(PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    t += 61_000;
    expect((await login(PASSWORD)).statusCode).toBe(200);
  });

  it("backs off per client IP, so one noisy client does not lock out another", async () => {
    const from = (ip: string, password: string) => app.inject({ method: "POST", url: "/v1/auth/login", headers: H, payload: { password }, remoteAddress: ip });
    for (let i = 0; i < 5; i++) expect((await from("203.0.113.9", "wrong password!")).statusCode).toBe(401);
    expect((await from("203.0.113.9", PASSWORD)).statusCode).toBe(429);
    expect((await from("198.51.100.4", PASSWORD)).statusCode).toBe(200);
  });

  it("behind a trusted proxy: the client IP comes from X-Forwarded-For, and cookies are Secure", async () => {
    const proxied = buildApp({ store, editorDir, trustProxy: ["172.18.0.0/16"], secureCookies: "always" });
    try {
      const via = (xff: string, password: string, remoteAddress = "172.18.0.15") =>
        proxied.inject({ method: "POST", url: "/v1/auth/login", headers: { ...H, "x-forwarded-for": xff, "x-forwarded-proto": "https" }, payload: { password }, remoteAddress });
      for (let i = 0; i < 5; i++) expect((await via("203.0.113.9", "wrong password!")).statusCode).toBe(401);
      expect((await via("203.0.113.9", PASSWORD)).statusCode).toBe(429);
      const ok = await via("198.51.100.4", PASSWORD);
      expect(ok.statusCode).toBe(200);
      expect(String(ok.headers["set-cookie"])).toMatch(/; Secure/);
      // An untrusted peer cannot pick its own IP by sending the header: it is keyed on its real address.
      for (let i = 0; i < 5; i++) expect((await via(`192.0.2.${i}`, "wrong password!", "203.0.113.50")).statusCode).toBe(401);
      expect((await via("192.0.2.99", PASSWORD, "203.0.113.50")).statusCode).toBe(429);
    } finally {
      await proxied.close();
    }
  });

  it("logs out, expires after 30 days, and set-password signs every session out", async () => {
    const a = cookieOf(await login(PASSWORD));
    const b = cookieOf(await login(PASSWORD));
    const out = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie: a, ...H } });
    expect(String(out.headers["set-cookie"])).toMatch(/Max-Age=0/);
    expect((await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie: a } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie: b } })).statusCode).toBe(200);
    t += 31 * 86_400_000;
    expect((await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie: b } })).statusCode).toBe(401);
    const c = cookieOf(await login(PASSWORD));
    store.auth.setPassword("another long password");
    expect((await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie: c } })).statusCode).toBe(401);
    expect(store.auth.sessionCount()).toBe(0);
  });

  it("ignores forged or garbage cookies", async () => {
    for (const cookie of [`${SESSION_COOKIE}=pss_forged`, `${SESSION_COOKIE}=`, "other=1"]) {
      expect((await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie } })).statusCode).toBe(401);
    }
  });
});

describe("static editor shell", () => {
  it("serves index.html for /, /login and /p/:id with the CSP, and assets from /static", async () => {
    for (const url of ["/", "/login", "/p/prj_abc"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain("<div id=root>");
      expect(r.headers["content-security-policy"]).toBe(EDITOR_CSP);
      expect(r.headers["x-frame-options"]).toBe("DENY");
    }
    const js = await app.inject({ method: "GET", url: "/static/app.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect(js.headers["cache-control"]).toMatch(/immutable/);
  });

  it("does not serve files outside static/", async () => {
    for (const url of ["/static/../secret.txt", "/static/%2e%2e/secret.txt", "/static/..%2fsecret.txt", "/static/nope.js", "/static/"]) {
      const r = await app.inject({ method: "GET", url });
      expect({ url, status: r.statusCode }).toEqual({ url, status: 404 });
      expect(r.body).not.toContain("outside static");
    }
  });

  it("says how to build the editor when dist is missing", async () => {
    const bare = buildApp({ store, editorDir: join(editorDir, "missing") });
    const r = await bare.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain("pnpm build:editor");
    await bare.close();
  });
});

describe("fonts for the browser", () => {
  it("lists the manifest and serves woff2 and sfnt bytes behind auth", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/fonts/manifest" })).statusCode).toBe(401);
    const tok = store.createToken("cli", "agent").token;
    const auth = { authorization: `Bearer ${tok}` };
    const m = (await app.inject({ method: "GET", url: "/v1/fonts/manifest", headers: auth })).json();
    expect(m.manifest.families.map((f: { family: string }) => f.family)).toContain("IBM Plex Sans");
    const f = m.files[0];
    const woff = await app.inject({ method: "GET", url: `/v1/fonts/files/${f.file}`, headers: auth });
    expect(woff.statusCode).toBe(200);
    expect(woff.rawPayload.length).toBe(f.bytes);
    expect(woff.rawPayload.subarray(0, 4).toString("latin1")).toBe("wOF2");
    const sfnt = await app.inject({ method: "GET", url: `/v1/fonts/sfnt/${f.file}`, headers: auth });
    expect(["\0\x01\0\0", "OTTO", "true"]).toContain(sfnt.rawPayload.subarray(0, 4).toString("latin1"));
    expect((await app.inject({ method: "GET", url: "/v1/fonts/sfnt/..%2Fregistry.json", headers: auth })).statusCode).toBe(404);
  });
});
