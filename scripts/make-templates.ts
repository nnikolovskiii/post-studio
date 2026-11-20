// Generates brand-kits/templates/*.json ("New from template", Phase 5) from the social-posts lane
// templates copied into brand-kits/templates/source/ (read-only copies, 2026-11-09). Each template
// is imported with the normal template importer, then every colour becomes a brand token, the
// frames get the kit's guide sets, and the placeholder copy keeps its roles.
//   pnpm exec tsx scripts/make-templates.ts
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKit, guidesFor, tokenFor, type BrandKit } from "@post-studio/brand";
import { importSocialPost } from "@post-studio/import";
import type { Document, Node } from "@post-studio/schema";
import { prepareAsset } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";

const ROOT = new URL("../", import.meta.url).pathname;
const SRC = join(ROOT, "brand-kits/templates/source");
const OUT = join(ROOT, "brand-kits/templates");
const ASSETS = join(ROOT, "brand-kits/assets");
const LUX_LOGO = join(ROOT, "fixtures/social-posts/lux-1-leaderboard/source/logo-light.png");

interface Spec {
  id: string;
  kit: string;
  name: string;
  description: string;
  lang: string;
  square: string;
  li?: string;
  /** Edits on the template SVG text before import. */
  edit?: (svg: string) => string;
}

// Mosaic has no template SVG in social-posts yet: this one follows PLAN-DAILY §7 and the
// 2026-10-26 daily post (headline Alegreya 700 84/92 at x 135, first baseline 148; no footer).
const MOSAIC = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
<rect id="paper" width="1080" height="1080" fill="#F6F2EA"/>
<g id="art" transform="translate(72 380)">
</g>
<g id="type">
  <text id="headline-1" x="135" y="148" font-family="'Alegreya'" font-weight="700" font-size="84" fill="#1D2129">Цената ја знаете</text>
  <text id="headline-2" x="135" y="240" font-family="'Alegreya'" font-weight="700" font-size="84" fill="#1D2129">пред да почнеме.</text>
</g>
<g id="accent">
</g>
</svg>
`;

const SPECS: Spec[] = [
  { id: "lux/post", kit: "lux", name: "LUX post · square + LinkedIn", description: "templates/lux/ig-1080.svg + li-1080x1350.svg: kicker, 2–3 line headline, chart well (empty), source line, logo + footer.", lang: "en", square: "lux/ig-1080.svg", li: "lux/li-1080x1350.svg" },
  { id: "lux/square", kit: "lux", name: "LUX post · square only", description: "templates/lux/ig-1080.svg.", lang: "en", square: "lux/ig-1080.svg" },
  {
    id: "kites/square",
    kit: "kites",
    name: "Kites post · square",
    description: "templates/kites/ig-1080.svg, wordmark-only footer (the Kites logo's licence is unverified, TYPE-SCALE.md).",
    lang: "mk",
    square: "kites/ig-1080.svg",
    edit: (s) => s.replace(/\s*<image id="logo"[^>]*\/>/, "").replace('<text id="footer" x="152"', '<text id="footer" x="72"'),
  },
  { id: "studio/square", kit: "studio", name: "Web shop post · square (old pack)", description: "templates/studio/ig-1080.svg: the old brick + Bitter pack.", lang: "mk", square: "studio/ig-1080.svg" },
  { id: "mosaic/square", kit: "mosaic", name: "Mosaic post · square", description: "PLAN-DAILY §7: paper, Alegreya headline on top, no footer; the art goes below.", lang: "mk", square: "" },
];

function textById(svg: string, id: string): string | undefined {
  const m = new RegExp(`<text id="${id}"[^>]*>([^<]*)</text>`).exec(svg);
  return m?.[1];
}

/** copy.json for the importer's role matcher, from the template's own text ids. */
function copyFor(svgs: string[], lang: string) {
  const headline: Array<{ spans: Array<{ text: string }> }> = [];
  const lines = new Set<string>();
  for (const svg of svgs) for (let i = 1; i <= 3; i++) {
    const t = textById(svg, `headline-${i}`);
    if (t && !lines.has(t)) {
      lines.add(t);
      headline.push({ spans: [{ text: t }] });
    }
  }
  const first = (id: string) => svgs.map((s) => textById(s, id)).find((t) => t !== undefined);
  return { language: lang, kicker: first("kicker") ?? "", headline, sub: first("sub") ?? null, source: first("source") ?? null, footer: first("footer") ?? null };
}

function tokenize(doc: Document, kit: BrandKit): void {
  const tok = (c: unknown) => {
    if (typeof c !== "string") return c;
    const t = tokenFor(kit, c);
    if (!t) throw new Error(`${c} is not in the ${kit.id} kit`);
    return c.length === 9 ? c : { token: t };
  };
  const visit = (nodes: Node[]) => {
    for (const n of nodes) {
      const it = n as Node & Record<string, any>;
      if (n.type === "text") {
        n.style.fill = tok(n.style.fill) as any;
        for (const s of n.spans) if (s.fill !== undefined) s.fill = tok(s.fill) as any;
      }
      if (it.fill) it.fill = tok(it.fill);
      if (it.stroke?.color) it.stroke.color = tok(it.stroke.color);
      if (n.type === "group") visit(n.children);
    }
  };
  for (const f of doc.frames) {
    if (f.background) f.background.color = tok(f.background.color) as any;
    f.guides = kit.guides[`${f.w}x${f.h}`];
    visit(f.children);
    // The empty art group sits on the lane's art / chart well, so new art goes straight into it
    // (group children are relative to the group's x / y).
    const well = guidesFor(f)?.zones.find((z) => z.kind === "well");
    for (const n of f.children) {
      if (n.type === "group" && n.role === "art" && !n.children.length && well) Object.assign(n, { x: well.x, y: well.y, w: well.w, h: well.h, name: well.label ?? "art" });
      if (n.type === "group" && n.role === "accent" && !n.children.length) n.name = "Accent (put the one accent object here)";
    }
  }
}

const fonts = await FontRegistry.load();
mkdirSync(ASSETS, { recursive: true });
const index: Array<{ id: string; kit: string; name: string; file: string }> = [];
for (const spec of SPECS) {
  const kit = getKit(spec.kit)!;
  const dir = mkdtempSync(join(tmpdir(), "ps-template-"));
  mkdirSync(join(dir, "source"));
  copyFileSync(LUX_LOGO, join(dir, "source/logo-light.png"));
  const edit = spec.edit ?? ((s: string) => s);
  const square = edit(spec.square ? readFileSync(join(SRC, spec.square), "utf8") : MOSAIC);
  const li = spec.li ? edit(readFileSync(join(SRC, spec.li), "utf8")) : undefined;
  writeFileSync(join(dir, "post.svg"), square);
  if (li) writeFileSync(join(dir, "post-li.svg"), li);
  writeFileSync(join(dir, "copy.json"), JSON.stringify(copyFor(li ? [square, li] : [square], spec.lang)));
  const assets: Record<string, string> = {};
  const upload = async (bytes: Uint8Array, name: string) => {
    const p = prepareAsset(bytes);
    const file = `assets/${p.sha256.slice(0, 16)}${p.mime === "image/png" ? ".png" : p.mime === "image/svg+xml" ? ".svg" : ".bin"}`;
    writeFileSync(join(ROOT, "brand-kits", file), p.bytes);
    assets[`sha256:${p.sha256}`] = file;
    void name;
    return { ref: `sha256:${p.sha256}`, mime: p.mime, bytes: p.bytes.length };
  };
  const { doc, report } = await importSocialPost(dir, { fonts, upload, mode: "template", kit: spec.kit, title: spec.name });
  if (report.mode !== "template") throw new Error(`${spec.id}: imported as ${report.mode}`);
  tokenize(doc, kit);
  doc.lang = spec.lang;
  doc.meta = { template: { id: spec.id, source: spec.square ? `social-posts/templates/${spec.square}${spec.li ? ` + ${spec.li}` : ""}` : "PLAN-DAILY §7 (no social-posts template yet)" } };
  const file = `${spec.id.replace("/", "-")}.json`;
  const out = { id: spec.id, kit: spec.kit, name: spec.name, description: spec.description, assets, doc };
  writeFileSync(join(OUT, file), JSON.stringify(out, null, 1) + "\n");
  index.push({ id: spec.id, kit: spec.kit, name: spec.name, file });
  const roles = report.frames.map((f) => `${f.id}: ${Object.keys(f.roles).join(" ")}`).join(" · ");
  console.log(`${spec.id} → ${file} (${roles}; ${Object.keys(assets).length} asset(s); ${createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 8)})`);
  if (report.warnings.length) console.log("  warnings:", report.warnings.join(" | "));
}
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 1) + "\n");
