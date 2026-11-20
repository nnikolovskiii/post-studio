import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FontRegistry } from "@post-studio/text";
import { buildApp } from "../src/app.ts";
import { Store } from "../src/store.ts";

let fonts: Promise<FontRegistry> | undefined;
export const sharedFonts = () => (fonts ??= FontRegistry.load());

export const fixturePath = (name: string) => new URL(`../../../fixtures/${name}`, import.meta.url);
export const loadFixture = (name = "lux-6-square.hand.json") => JSON.parse(readFileSync(fixturePath(name), "utf8"));
export const LOGO = () => readFileSync(fixturePath("assets/logo-on-paper.png"));

export async function setup(clock?: () => number) {
  const dataDir = mkdtempSync(join(tmpdir(), "pstudio-test-"));
  const store = new Store({ dataDir, fonts: await sharedFonts(), clock });
  const app = buildApp({ store });
  const tokens = {
    claude: store.createToken("claude", "agent").token,
    grok: store.createToken("grok", "agent").token,
    nikola: store.createToken("nikola", "human").token,
  };
  type Who = keyof typeof tokens;
  const call = async (who: Who | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: method as any,
      url,
      headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...headers },
      ...(body === undefined ? {} : Buffer.isBuffer(body) ? { payload: body } : { payload: body as any }),
    });
    const json = res.headers["content-type"]?.toString().includes("json") ? res.json() : undefined;
    return { status: res.statusCode, json, body: res.body, headers: res.headers };
  };
  const cleanup = async () => {
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { dataDir, store, app, tokens, call, cleanup };
}

/** Upload the logo and create the hand-written LUX-6 project. */
export async function createLux(ctx: Awaited<ReturnType<typeof setup>>, who: "claude" | "nikola" = "claude") {
  const up = await ctx.call(who, "POST", "/v1/assets", LOGO(), { "content-type": "application/octet-stream" });
  if (up.status !== 201) throw new Error(JSON.stringify(up.json));
  const res = await ctx.call(who, "POST", "/v1/projects", loadFixture());
  if (res.status !== 201) throw new Error(JSON.stringify(res.json));
  return res.json.project as string;
}
