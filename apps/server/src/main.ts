import { buildApp } from "./app.ts";
import { DEFAULT_HOST, DEFAULT_PORT, defaultDataDir } from "./config.ts";
import { Store } from "./store.ts";

/** "a, b" → ["a", "b"]; "true" → true; unset → undefined. */
function trustProxyFromEnv(v: string | undefined): boolean | string[] | undefined {
  if (!v || !v.trim()) return undefined;
  if (v.trim() === "true") return true;
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

/**
 * Start the API. Defaults to 127.0.0.1 (laptop). Deployed (Phase 6, deploy/compose.yaml) it runs in a
 * container behind Traefik with POST_STUDIO_HOST=0.0.0.0, POST_STUDIO_PUBLIC_URL, POST_STUDIO_TRUST_PROXY
 * and POST_STUDIO_SECURE_COOKIES=always.
 */
export async function serve(opts: { dataDir?: string; port?: number; host?: string; logger?: boolean } = {}) {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const port = opts.port ?? Number(process.env.POST_STUDIO_PORT ?? DEFAULT_PORT);
  const host = opts.host ?? process.env.POST_STUDIO_HOST ?? DEFAULT_HOST;
  const publicUrl = (process.env.POST_STUDIO_PUBLIC_URL || `http://${host}:${port}`).replace(/\/$/, "");
  const secureCookies = process.env.POST_STUDIO_SECURE_COOKIES === "always" ? "always" : "auto";
  const store = await Store.open(dataDir);
  const app = buildApp({ store, logger: opts.logger ?? true, publicUrl, trustProxy: trustProxyFromEnv(process.env.POST_STUDIO_TRUST_PROXY), secureCookies });
  app.addHook("onClose", async () => store.close());
  await app.listen({ port, host });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void app.close().then(() => process.exit(0)));
  return { app, store, dataDir, port, host, publicUrl };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  serve().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
