// Motion Part 2: rendering with time support must not change a single byte for still posts.
// These are the documents and outputs the regression test hashes. The golden file
// fixtures/golden/still-render-hashes.json was written by scripts/render-golden.ts with the
// renderer as it was before motion (commit 2370597), and the test compares against it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listTemplates, templateDoc } from "@post-studio/brand";
import { importSocialPost } from "@post-studio/import";
import { renderPng, renderSvg, type AssetResolver } from "@post-studio/render";
import type { Document } from "@post-studio/schema";
import type { FontRegistry } from "@post-studio/text";
import { assetResolver, BRAND_KITS_DIR, type Store } from "../src/index.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export interface StillCase {
  name: string;
  doc: Document;
  assets: AssetResolver;
}

/** The hand LUX-6, every lane template and the three imported social-posts fixtures. */
export async function stillCases(fonts: FontRegistry, store: Store): Promise<StillCase[]> {
  const cases: StillCase[] = [];
  const logo = readFileSync(join(ROOT, "fixtures/assets/logo-on-paper.png"));
  const logoSha = sha(logo);
  cases.push({
    name: "lux-6-square.hand",
    doc: JSON.parse(readFileSync(join(ROOT, "fixtures/lux-6-square.hand.json"), "utf8")),
    assets: (s) => (s === logoSha ? { mime: "image/png", bytes: logo } : undefined),
  });
  for (const t of listTemplates()) {
    const r = templateDoc(t.id)!;
    const files = new Map(Object.entries(r.assets).map(([ref, file]) => [ref.slice(7), file]));
    cases.push({
      name: `template:${t.id}`,
      doc: { ...r.doc, id: "prj_golden000000" },
      assets: (s) => {
        const f = files.get(s);
        if (!f) return undefined;
        return { mime: f.endsWith(".svg") ? "image/svg+xml" : f.endsWith(".jpg") ? "image/jpeg" : "image/png", bytes: readFileSync(join(BRAND_KITS_DIR, f)) };
      },
    });
  }
  for (const slug of ["lux-6-judge-compare", "lux-1-leaderboard", "daily-2026-10-26-tochna-cena"]) {
    const { doc } = await importSocialPost(join(ROOT, "fixtures/social-posts", slug), { fonts, upload: async (b, name) => store.addAsset(b, { author: "agent:golden" }, name) });
    cases.push({ name: `import:${slug}`, doc: { ...doc, id: "prj_golden000000" }, assets: assetResolver(store) });
  }
  return cases;
}

/** sha256 of every output of every frame: live SVG, Figma SVG, outlined SVG and PNG. */
export async function stillHashes(c: StillCase, fonts: FontRegistry, time?: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const base = { fonts, assets: c.assets, ...(time !== undefined ? { time } : {}) };
  for (const f of c.doc.frames) {
    out[`${f.id}.svg`] = sha(renderSvg(c.doc, { ...base, frame: f.id }).svg);
    out[`${f.id}.figma.svg`] = sha(renderSvg(c.doc, { ...base, frame: f.id, embedFonts: false, positioning: "line" }).svg);
    out[`${f.id}.outlined.svg`] = sha(renderSvg(c.doc, { ...base, frame: f.id, text: "outlined" }).svg);
    out[`${f.id}.png`] = sha((await renderPng(c.doc, { ...base, frame: f.id })).png);
  }
  return out;
}
