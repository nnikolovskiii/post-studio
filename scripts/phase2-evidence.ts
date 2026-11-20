// Phase 2 evidence: import the social-posts fixtures through a real Store (asset upload with the
// sanitizer, document validation), export them, and pixel-compare against the original post.png
// files and against headless Chrome rendering the exported post.svg.
// Run: pnpm exec tsx scripts/phase2-evidence.ts [out-dir]   (default test-artifacts/phase2)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSocialPost } from "@post-studio/import";
import { chromeRenderSvg, comparePng, diffImage, exportProject, findChrome, renderSvg } from "@post-studio/render";
import { assetResolver, Store } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";

const root = new URL("..", import.meta.url).pathname;
const outDir = process.argv[2] ?? join(root, "test-artifacts/phase2");
const posts = ["lux-6-judge-compare", "lux-1-leaderboard", "daily-2026-10-26-tochna-cena"];

const fonts = await FontRegistry.load();
const data = mkdtempSync(join(tmpdir(), "pstudio-evidence-"));
const store = new Store({ dataDir: data, fonts });
const actor = { author: "agent:evidence" };
const results: any[] = [];
try {
  for (const slug of posts) {
    const dir = join(root, "fixtures/social-posts", slug);
    const t0 = Date.now();
    const { doc, report } = await importSocialPost(dir, { fonts, upload: async (bytes, name) => store.addAsset(bytes, actor, name) });
    const created = store.createProject(doc, actor, `import ${slug}`);
    const stored = store.getProject(created.project).doc;
    const exp = await exportProject(stored, { fonts, assets: assetResolver(store), project: created.project, rev: 0 });
    const target = join(outDir, slug);
    mkdirSync(join(target, "figma"), { recursive: true });
    for (const f of exp.files) writeFileSync(join(target, f.path), f.bytes);
    writeFileSync(join(target, "import-report.json"), JSON.stringify(report, null, 2) + "\n");
    const frames: any[] = [];
    for (const fr of exp.frames) {
      const ours = exp.files.find((f) => f.path === `${fr.stem}.png`)!.bytes;
      const orig = readFileSync(join(dir, `${fr.stem}.png`));
      const vsOriginal = await comparePng(ours, orig);
      writeFileSync(join(target, `${fr.stem}.diff-vs-original.png`), await diffImage(ours, orig));
      let vsChrome, vsChromeNoHint, lineChromeVsOriginal, lineChromeVsOriginalSvg;
      if (findChrome()) {
        // post.svg exactly as exported, rendered the way social-posts/tools/render.sh does (default hinting) …
        const svg = exp.files.find((f) => f.path === `${fr.stem}.svg`)!.bytes.toString("utf8");
        const chrome = await chromeRenderSvg(svg, fr.w, fr.h, { lang: stored.lang });
        writeFileSync(join(target, `${fr.stem}.chrome.png`), chrome);
        vsChrome = await comparePng(ours, chrome);
        writeFileSync(join(target, `${fr.stem}.diff-vs-chrome.png`), await diffImage(ours, chrome));
        // … and without hinting (fractional glyph positions, like Figma / macOS).
        vsChromeNoHint = await comparePng(ours, await chromeRenderSvg(svg, fr.w, fr.h, { lang: stored.lang, hinting: false }));
        // Imported document with one x per line (the browser lays out each line itself, like the
        // original post.svg did): rendered by Chrome it should reproduce a Chrome-made post.png.
        const line = renderSvg(stored, { fonts, assets: assetResolver(store), frame: fr.id, positioning: "line" });
        const lineChrome = await chromeRenderSvg(line.svg, fr.w, fr.h, { lang: stored.lang });
        lineChromeVsOriginal = await comparePng(lineChrome, orig);
        // The original post.svg in the same Chrome, when it is self-contained (embedded fonts):
        // LUX-6's post.png was drawn by Pillow, so this is its like-for-like check.
        const origSvg = join(dir, `${fr.stem}.svg`);
        if (existsSync(origSvg) && readFileSync(origSvg, "utf8").includes("@font-face")) lineChromeVsOriginalSvg = await comparePng(lineChrome, await chromeRenderSvg(readFileSync(origSvg, "utf8"), fr.w, fr.h, { lang: stored.lang }));
      }
      frames.push({ frame: fr.id, stem: fr.stem, vsOriginal, vsChrome, vsChromeNoHint, lineChromeVsOriginal, lineChromeVsOriginalSvg });
    }
    results.push({ slug, mode: report.mode, why: report.why, warnings: [...created.warnings.map((w) => `${w.path}: ${w.message}`), ...report.warnings, ...exp.warnings], frames: report.frames, maxAdvanceDelta: report.maxAdvanceDelta, assets: report.assets, skipped: report.skipped, compare: frames, ms: Date.now() - t0 });
  }
} finally {
  store.close();
  rmSync(data, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "evidence.json"), JSON.stringify(results, null, 2) + "\n");
for (const r of results) {
  console.log(`\n${r.slug}: mode ${r.mode}${r.maxAdvanceDelta !== undefined ? `, max advance Δ ${r.maxAdvanceDelta} px` : ""}, ${r.ms} ms`);
  for (const f of r.frames) console.log(`  frame ${f.id}: ${f.nodes} nodes, ${f.texts} texts, roles ${Object.keys(f.roles).join(",")}`);
  for (const c of r.compare) {
    const s = (d: any) => (d ? `mean ${d.meanChannelError.toExponential(2)} max ${d.maxChannelError} over16 ${(d.pixelsOverFraction * 100).toFixed(3)}% shift-tolerant ${(d.shiftTolerantPixelsOverFraction * 100).toFixed(4)}%` : "n/a");
    console.log(`  ${c.stem}\n    png vs original post.png        ${s(c.vsOriginal)}\n    png vs chrome(post.svg)         ${s(c.vsChrome)}\n    png vs chrome(post.svg, nohint) ${s(c.vsChromeNoHint)}\n    chrome(line svg) vs original    ${s(c.lineChromeVsOriginal)}\n    chrome(line svg) vs chrome(original post.svg) ${s(c.lineChromeVsOriginalSvg)}`);
  }
  for (const w of r.warnings) console.log(`  warning: ${w}`);
}
