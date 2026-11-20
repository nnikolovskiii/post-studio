// Writes fixtures/golden/still-render-hashes.json: the sha256 of every still output (live SVG,
// Figma SVG, outlined SVG, PNG per frame) of the hand LUX-6, every lane template and the three
// imported social-posts fixtures. Run it with the renderer you want as the reference (Motion
// Part 2 ran it on the pre-motion renderer of commit 2370597); apps/server/test/
// render-regression.test.ts then proves the current renderer gives the same bytes.
//   pnpm exec tsx scripts/render-golden.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { stillCases, stillHashes } from "../apps/server/test/still-golden.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const fonts = await FontRegistry.load();
const dir = mkdtempSync(join(tmpdir(), "pstudio-golden-"));
const store = new Store({ dataDir: dir, fonts });
try {
  const out: Record<string, Record<string, string>> = {};
  for (const c of await stillCases(fonts, store)) out[c.name] = await stillHashes(c, fonts);
  writeFileSync(join(ROOT, "fixtures/golden/still-render-hashes.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote fixtures/golden/still-render-hashes.json: ${Object.keys(out).length} documents, ${Object.values(out).reduce((n, h) => n + Object.keys(h).length, 0)} outputs`);
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
