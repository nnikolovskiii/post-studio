// Phase 5 done-when: "checked by the same palette rules as check_palette.py". On every real post
// in the fixtures: check_palette.py's verdict on the source post.svg = Post Studio's verdict on the
// imported document = check_palette.py's verdict on the post.svg Post Studio exports.
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { checkSvgPalette, getKit, paletteLane } from "@post-studio/brand";
import { validateDocument } from "@post-studio/ops";
import { renderSvg } from "@post-studio/render";
import { prepareAsset } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { importSocialPost } from "../src/index.ts";
import { hasPython, ROOT, runPythonBatch } from "../../brand/test/palette-fixtures.ts";

// Two Python batches over 23 real frames (some ~470 kB): seconds alone, much longer when pnpm check runs every suite at once.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let fonts: FontRegistry;
const stored = new Map<string, { mime: string; bytes: Buffer }>();
const upload = async (bytes: Uint8Array) => {
  const p = prepareAsset(bytes);
  stored.set(p.sha256, { mime: p.mime, bytes: p.bytes });
  return { ref: `sha256:${p.sha256}`, mime: p.mime, bytes: p.bytes.length };
};
const svgAsset = (ref: string) => {
  const a = stored.get(ref.slice(7));
  return a?.mime === "image/svg+xml" ? a.bytes.toString("utf8") : undefined;
};

const POSTS = [
  ...readdirSync(join(ROOT, "fixtures/palette/posts")).map((s) => join(ROOT, "fixtures/palette/posts", s)),
  ...["lux-1-leaderboard", "lux-6-judge-compare", "daily-2026-10-26-tochna-cena"].map((s) => join(ROOT, "fixtures/social-posts", s)),
].sort();

interface Row {
  post: string;
  mode: string;
  frame: string;
  kit: string;
  source: string[];
  docOk: boolean;
  docIssues: string[];
  exported: string;
  exportTs: string[];
}
const rows: Row[] = [];

beforeAll(async () => {
  fonts = await FontRegistry.load();
  const out = mkdtempSync(join(tmpdir(), "ps-parity-"));
  for (const dir of POSTS) {
    const { doc, report } = await importSocialPost(dir, { fonts, upload });
    const kit = getKit(doc.brandKit)!;
    const v = validateDocument(doc, { svgAsset, checkFont: (f, w) => fonts.checkFont(f, w) });
    for (const f of doc.frames) {
      const src = relative(ROOT, join(dir, f.id === "li" ? "post-li.svg" : "post.svg"));
      const r = renderSvg(doc, { fonts, assets: (s) => stored.get(s), frame: f.id });
      const exported = join(out, `${doc.meta!.source!.toString().split("/").pop()}-${f.id}.svg`);
      writeFileSync(exported, r.svg);
      const frameNodes = JSON.stringify(f);
      rows.push({
        post: dir.split("/").pop()!,
        mode: report.mode,
        frame: f.id,
        kit: kit.id,
        source: [src],
        docOk: v.palette!.frames.find((x) => x.frame === f.id)!.ok,
        docIssues: v.palette!.issues.filter((i) => i.node === f.id || frameNodes.includes(`"id":"${i.node}"`)).map((i) => `${i.code}: ${i.message}`),
        exported,
        exportTs: checkSvgPalette(r.svg, paletteLane(kit), { path: exported }).errors,
      });
    }
  }
}, 120_000);

describe("palette parity with check_palette.py on real posts", () => {
  it("imports every fixture post with its lane's brand kit", () => {
    expect(rows.length).toBeGreaterThanOrEqual(23);
    expect(new Set(rows.map((r) => r.kit))).toEqual(new Set(["lux", "kites", "studio", "mosaic"]));
    expect(new Set(rows.map((r) => r.mode))).toEqual(new Set(["layout", "template", "fallback"]));
  });

  it.runIf(hasPython)("same verdict: source post.svg (Python) = imported document (Post Studio) = exported post.svg (Python)", () => {
    const src = runPythonBatch(rows.map((r) => [r.kit, r.source[0], false]));
    const exp = runPythonBatch(rows.map((r) => [r.kit, r.exported, false]));
    const table = rows.map((r, i) => ({ post: `${r.post} ${r.frame}`, mode: r.mode, source: src[i].length ? "FAIL" : "OK", doc: r.docOk ? "OK" : "FAIL", exported: exp[i].length ? "FAIL" : "OK" }));
    if (process.env.PHASE5_EVIDENCE) writeFileSync(join(ROOT, "test-artifacts/phase5/palette-parity.json"), JSON.stringify(table, null, 1) + "\n");
    for (const [i, t] of table.entries()) {
      expect(t.doc, `${t.post}: doc vs source; doc issues: ${rows[i].docIssues.slice(0, 3).join(" | ")}`).toBe(t.source);
      expect(t.exported, `${t.post}: export vs doc; python: ${exp[i].slice(0, 3).join(" | ")}`).toBe(t.doc);
      // The port gives Python's exact messages on the exported file too.
      expect(rows[i].exportTs).toEqual(exp[i]);
    }
    expect(table.filter((t) => t.source === "OK").length).toBeGreaterThanOrEqual(12);
    expect(table.filter((t) => t.source === "FAIL").length).toBeGreaterThanOrEqual(6);
  });

  it("without Python: the exported post.svg passes the port exactly when the document passes", () => {
    for (const r of rows) expect(r.exportTs.length === 0, `${r.post} ${r.frame}: ${r.exportTs.slice(0, 2).join(" | ")}`).toBe(r.docOk);
  });

  it("names the problem the way an agent can act on it", () => {
    const lux5 = rows.find((r) => r.post === "lux-5-luna-benchmarks" && r.frame === "square")!;
    expect(lux5.docIssues.some((m) => m.startsWith("svg-art: SVG art line") && m.includes("lane accent outside"))).toBe(true);
    const kites4 = rows.find((r) => r.post === "kites-4-choose-speak")!;
    expect(kites4.docIssues.some((m) => /<filter> is not allowed/.test(m))).toBe(true);
    const daily = rows.find((r) => r.post.startsWith("daily-"))!;
    expect(daily.kit).toBe("mosaic");
    expect(daily.docOk).toBe(false);
  });
});
