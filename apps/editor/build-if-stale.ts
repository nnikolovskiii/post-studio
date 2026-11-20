// Build apps/editor/dist when any editor or package source is newer than it (Node only).
// Used by `pstudio serve` and by the end-to-end tests, so neither runs a stale bundle.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EDITOR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(EDITOR, "../..");
export const EDITOR_DIST = join(EDITOR, "dist");

function newest(p: string): number {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(0, ...readdirSync(p).filter((n) => n !== "node_modules" && n !== "dist").map((n) => newest(join(p, n))));
}

/** True when dist/index.html is older than some source. */
export function editorIsStale(): boolean {
  const dist = join(EDITOR_DIST, "index.html");
  const sources = [join(EDITOR, "src"), join(EDITOR, "index.html"), join(EDITOR, "vite.config.ts"), ...readdirSync(join(ROOT, "packages")).map((d) => join(ROOT, "packages", d, "src"))];
  return !existsSync(dist) || statSync(dist).mtimeMs < Math.max(...sources.map(newest));
}

export function ensureEditorBuilt(log: (s: string) => void = (s) => process.stderr.write(s)): boolean {
  if (!editorIsStale()) return false;
  log("building the editor (apps/editor → dist)…\n");
  execFileSync(join(EDITOR, "node_modules/.bin/vite"), ["build", "--config", join(EDITOR, "vite.config.ts")], { cwd: EDITOR, stdio: ["ignore", "ignore", "inherit"] });
  return true;
}
