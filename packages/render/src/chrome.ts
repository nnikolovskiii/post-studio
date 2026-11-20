// Reference renderer: headless Chrome screenshot of an SVG, the social-posts/tools/render.sh
// approach. Used by tests to catch drift between live <text> and the outlined export.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Newest Playwright headless shell, or $CHROME. Undefined when none is installed. */
export function findChrome(): string | undefined {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const base = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(base)) return undefined;
  const dirs = readdirSync(base)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    const p = join(base, d, "chrome-headless-shell-linux64/chrome-headless-shell");
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Some machines lack libraries the headless shell needs (libatk, libgbm, …). They can be extracted
 * without root (apt-get download + dpkg-deb -x) under $CHROME_LIBS, as social-posts/tools/render.sh
 * does on a minimal server. Default places: ~/.cache/post-studio/chromelibs/root, /tmp/chromelibs/root.
 */
export function chromeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Minimal hosts have no fontconfig setup at all; Chrome aborts without one. Our SVGs embed
  // their fonts, so a config that only lists the registered fonts (as TTF, see resvgFontFiles) is enough.
  if (!env.FONTCONFIG_FILE && !existsSync("/etc/fonts/fonts.conf")) {
    const dir = join(tmpdir(), "post-studio-fontconfig");
    mkdirSync(dir, { recursive: true });
    const conf = join(dir, "fonts.conf");
    writeFileSync(conf, `<?xml version="1.0"?>\n<fontconfig><dir>${join(tmpdir(), "post-studio-fonts")}</dir><cachedir>${join(dir, "cache")}</cachedir></fontconfig>\n`);
    env.FONTCONFIG_FILE = conf;
  }
  const candidates = [process.env.CHROME_LIBS, join(homedir(), ".cache/post-studio/chromelibs/root"), "/tmp/chromelibs/root"].filter(Boolean) as string[];
  const root = candidates.find((d) => existsSync(join(d, "usr/lib/x86_64-linux-gnu")));
  if (!root) return env;
  const libs = [join(root, "usr/lib/x86_64-linux-gnu"), join(root, "lib/x86_64-linux-gnu")].filter((d) => existsSync(d));
  return { ...env, LD_LIBRARY_PATH: [...libs, env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
}

export async function chromeRenderSvg(svg: string, w: number, h: number, opts: { lang?: string; chrome?: string; /** false: --font-render-hinting=none (subpixel glyph positions, closer to resvg) */ hinting?: boolean } = {}): Promise<Buffer> {
  const chrome = opts.chrome ?? findChrome();
  if (!chrome) throw new Error("headless Chrome not found (set CHROME or install the Playwright headless shell)");
  const dir = mkdtempSync(join(tmpdir(), "pstudio-chrome-"));
  try {
    const html = join(dir, "wrap.html");
    const out = join(dir, "out.png");
    const body = svg.replace(/^<\?xml[^>]*>\s*/, "").replace(/<!DOCTYPE[^>]*>\s*/i, "");
    writeFileSync(
      html,
      `<!doctype html>\n<html lang="${opts.lang ?? "mk"}"><head><meta charset="utf-8">\n<style>html,body{margin:0;background:transparent}svg{display:block}</style>\n</head><body>\n${body}\n</body></html>\n`,
    );
    await run(
      chrome,
      [
        "--headless",
        "--no-sandbox",
        "--hide-scrollbars",
        "--allow-file-access-from-files",
        "--force-device-scale-factor=1",
        ...(opts.hinting === false ? ["--font-render-hinting=none"] : []),
        "--virtual-time-budget=4000",
        "--default-background-color=00000000",
        `--window-size=${w},${h}`,
        `--screenshot=${out}`,
        `file://${html}`,
      ],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: chromeEnv() },
    );
    if (!existsSync(out)) throw new Error("chrome wrote no screenshot");
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
