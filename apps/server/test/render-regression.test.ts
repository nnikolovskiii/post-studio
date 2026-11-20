// Motion Part 2: time support must leave still rendering byte-for-byte as it was. The golden
// hashes come from the renderer before motion (scripts/render-golden.ts on commit 2370597).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FontRegistry } from "@post-studio/text";
import { Store } from "../src/store.ts";
import { sharedFonts } from "./helpers.ts";
import { stillCases, stillHashes, type StillCase } from "./still-golden.ts";

const golden = JSON.parse(readFileSync(new URL("../../../fixtures/golden/still-render-hashes.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;

let fonts: FontRegistry;
let store: Store;
let dir: string;
let cases: StillCase[];
beforeAll(async () => {
  fonts = await sharedFonts();
  dir = mkdtempSync(join(tmpdir(), "pstudio-golden-"));
  store = new Store({ dataDir: dir, fonts });
  cases = await stillCases(fonts, store);
}, 60_000);
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("still documents render byte-identical to the pre-motion renderer", () => {
  it("covers the hand LUX-6, every lane template and the three social-posts imports", () => {
    expect(cases.map((c) => c.name).sort()).toEqual(Object.keys(golden).sort());
    expect(Object.keys(golden).length).toBeGreaterThanOrEqual(9);
  });

  it("live SVG, Figma SVG, outlined SVG and PNG of every frame: same sha256, with and without a time", async () => {
    for (const c of cases) {
      expect(c.doc.motion, c.name).toBeUndefined();
      expect(await stillHashes(c, fonts), c.name).toEqual(golden[c.name]);
      expect(await stillHashes(c, fonts, 1234), `${c.name} at 1.234 s`).toEqual(golden[c.name]);
    }
  }, 120_000);
});
