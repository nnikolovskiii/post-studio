import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDocument } from "@post-studio/ops";
import { comparePng, renderSvg } from "@post-studio/render";
import type { Document, Frame, Node, TextNode } from "@post-studio/schema";
import { prepareAsset } from "@post-studio/server";
import { FontRegistry, layoutNode, measureTextFor } from "@post-studio/text";
import { bakeMultiply, copyLines, importSocialPost, ImportError, pathBounds, resolveHref, RoleMatcher, textNodeFromSpec } from "../src/index.ts";

const fixtures = new URL("../../../fixtures/social-posts/", import.meta.url).pathname;
const LUX6 = join(fixtures, "lux-6-judge-compare");
const LUX1 = join(fixtures, "lux-1-leaderboard");
const DAILY = join(fixtures, "daily-2026-10-26-tochna-cena");

let fonts: FontRegistry;
/** The real upload path minus HTTP: sniff, limits, SVG sanitizer, content hash. */
const stored = new Map<string, { mime: string; bytes: Buffer; name: string }>();
const upload = async (bytes: Uint8Array, name: string) => {
  const p = prepareAsset(bytes);
  stored.set(p.sha256, { mime: p.mime, bytes: p.bytes, name });
  return { ref: `sha256:${p.sha256}`, mime: p.mime, bytes: p.bytes.length };
};
const assets = (sha: string) => stored.get(sha);

beforeAll(async () => {
  fonts = await FontRegistry.load();
});

function all(nodes: Node[]): Node[] {
  return nodes.flatMap((n) => (n.type === "group" ? [n, ...all(n.children)] : [n]));
}
const texts = (f: Frame) => all(f.children).filter((n): n is TextNode => n.type === "text");
const textOf = (n: TextNode) => n.spans.map((s) => s.text).join("");
const byRole = (f: Frame, role: string) => all(f.children).filter((n) => n.role === role);

function validates(doc: Document) {
  const v = validateDocument(doc, {
    checkFont: (f, w) => fonts.checkFont(f, w),
    assetExists: (ref) => stored.has(ref.slice(7)),
    measureText: measureTextFor(fonts),
  });
  expect(v.errors).toEqual([]);
  expect(v.ok).toBe(true);
}

describe("copy.json roles", () => {
  it("lists visible copy keys as role lines and matches each line once (exact, then prefix)", () => {
    const lines = copyLines({ kicker: "ГЕНЕРИРАЊЕ НА МАКЕДОНСКИ · ДВАЈЦА ОЦЕНУВАЧИ", headline: [{ spans: [{ text: "Исти " }, { text: "модели." }] }, { spans: [{ text: "Различни оценки." }] }], sub: null, source: ["Извор: demo.example"], language: "mk", in_art: ["x"] });
    expect(lines.map((l) => `${l.role}:${l.index}/${l.count}:${l.text}`)).toEqual([
      "kicker:0/1:ГЕНЕРИРАЊЕ НА МАКЕДОНСКИ · ДВАЈЦА ОЦЕНУВАЧИ",
      "headline:0/2:Исти модели.",
      "headline:1/2:Различни оценки.",
      "source:0/1:Извор: demo.example",
    ]);
    const m = new RoleMatcher(lines);
    expect(m.take("ГЕНЕРИРАЊЕ НА МАКЕДОНСКИ")?.role).toBe("kicker"); // shortened on the canvas
    expect(m.take("ГЕНЕРИРАЊЕ НА МАКЕДОНСКИ")).toBeUndefined(); // used once
    expect(m.take("  Исти   модели. ")?.index).toBe(0);
    expect(m.peek("Различни оценки.")?.index).toBe(1);
    expect(m.take("lux")).toBeUndefined(); // too short for a prefix match
  });
});

describe("baseline text → text boxes", () => {
  const spec = (over: object) => ({ id: "t", lines: [[{ text: "Исти модели." }]], font: "IBM Plex Sans", weight: 600, size: 50, fill: "#190f0b", anchor: "start" as const, x: 135, baseline: 144, ...over });
  const place = (n: TextNode) => {
    const L = layoutNode(fonts, n, "mk");
    return { left: n.x + L.lines[0].x, right: n.x + L.lines[0].x + L.lines[0].width, baseline: Math.round(n.y + L.lines[0].baseline) };
  };

  it("start / end / middle anchors land on the same glyph positions and baseline", () => {
    const s = textNodeFromSpec({ fonts, lang: "mk", frameW: 1080 }, spec({}));
    expect([s.box, s.align, s.style.fill]).toEqual(["auto-width", "left", "#190F0B"]);
    expect(place(s).left).toBeCloseTo(135, 3);
    expect(place(s).baseline).toBe(144);
    const e = textNodeFromSpec({ fonts, lang: "mk", frameW: 1080 }, spec({ anchor: "end", x: 945 }));
    expect([e.box, e.align]).toEqual(["auto-width", "right"]);
    expect(place(e).right).toBeCloseTo(945, 3);
    const m = textNodeFromSpec({ fonts, lang: "mk", frameW: 1080 }, spec({ anchor: "middle", x: 540 }));
    expect([m.box, m.align, m.x, m.w]).toEqual(["fixed-width", "center", 135, 810]); // stays centred when edited
    expect((place(m).left + place(m).right) / 2).toBeCloseTo(540, 3);
    const off = textNodeFromSpec({ fonts, lang: "mk", frameW: 1080 }, spec({ anchor: "middle", x: 500, lines: [[{ text: "0" }]] }));
    expect([off.box, off.align]).toEqual(["auto-width", "center"]); // a chart label is not widened to the column
    expect((place(off).left + place(off).right) / 2).toBeCloseTo(500, 3);
  });

  it("multi-line specs keep the leading as lineHeight; spans keep their own weight and fill", () => {
    const n = textNodeFromSpec({ fonts, lang: "mk", frameW: 1080 }, spec({ lines: [[{ text: "Исти " }, { text: "модели.", fill: "#AC1922", weight: 500 }], [{ text: "Различни оценки." }]], leading: 56 }));
    expect(n.style.lineHeight).toBeCloseTo(1.12, 10);
    expect(n.spans).toEqual([{ text: "Исти " }, { text: "модели.", fill: "#AC1922", weight: 500 }, { text: "\nРазлични оценки." }]);
    const L = layoutNode(fonts, n, "mk");
    expect(L.lines.map((l) => Math.round(n.y + l.baseline))).toEqual([144, 200]);
  });
});

describe("helpers", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("resolves file:// paths from the other machine under the workspace root, then by name in the post folder", () => {
    const ws = mkdtempSync(join(tmpdir(), "pstudio-ws-"));
    dirs.push(ws);
    const post = join(ws, "social-posts", "posts", "p1");
    mkdirSync(join(post, "art"), { recursive: true });
    mkdirSync(join(ws, "lux-all", "public"), { recursive: true });
    writeFileSync(join(ws, "lux-all", "public", "logo.png"), "x");
    writeFileSync(join(post, "art", "render.png"), "y");
    expect(resolveHref("file:///home/someone/personal/workspace/lux-all/public/logo.png", post)).toBe(join(ws, "lux-all", "public", "logo.png"));
    expect(resolveHref("file:///elsewhere/social-posts/posts/p1/art/render.png", post)).toBe(join(post, "art", "render.png"));
    expect(resolveHref("file:///nowhere/at/all/render.png", post)).toBe(join(post, "art", "render.png"));
    expect(resolveHref("art/render.png", post)).toBe(join(post, "art", "render.png"));
    expect(resolveHref("https://example.com/a.png", post)).toBeUndefined();
    expect(resolveHref("file:///nowhere/missing.png", post)).toBeUndefined();
  });

  it("bakes multiply-on-paper like the LUX Figma pack's logo-on-paper.png", async () => {
    const baked = await bakeMultiply(readFileSync(join(LUX1, "source/logo-light.png")), "#FCFAF6");
    const pack = readFileSync(join(LUX6, "figma/assets/logo-on-paper.png"));
    const [a, b] = await Promise.all([sharp(baked).metadata(), sharp(pack).metadata()]);
    expect([a.width, a.height]).toEqual([b.width, b.height]);
    // Same pixels up to rounding (compared over paper, where they are both shown).
    const onPaper = async (x: Buffer) => sharp(x).flatten({ background: "#FCFAF6" }).png().toBuffer();
    const d = await comparePng(await onPaper(baked), await onPaper(pack));
    expect(d.meanChannelError).toBeLessThan(0.002);
    expect(d.maxChannelError).toBeLessThanOrEqual(2);
  });

  it("measures path bounds with resvg", () => {
    expect(pathBounds("M352 120H728A4 4 0 0 1 732 124V156A4 4 0 0 1 728 160H352Z")).toEqual({ x: 352, y: 120, w: 380, h: 40 });
  });
});

describe("(a) LUX-6 figma/editable-layout.json", () => {
  let doc: Document;
  let report: Awaited<ReturnType<typeof importSocialPost>>["report"];
  const layout = JSON.parse(readFileSync(join(LUX6, "figma/editable-layout.json"), "utf8"));
  beforeAll(async () => {
    ({ doc, report } = await importSocialPost(LUX6, { fonts, upload }));
  });

  it("imports both frames with roles from copy.json and validates", () => {
    expect(report.mode).toBe("layout");
    expect(doc.frames.map((f) => [f.id, f.name, f.w, f.h, f.background?.color])).toEqual([
      ["square", "Square", 1080, 1080, "#FCFAF6"],
      ["li", "LinkedIn", 1080, 1350, "#FCFAF6"],
    ]);
    expect(doc.lang).toBe("mk");
    expect(doc.title).toBe("Исти модели. Различни оценки.");
    for (const f of doc.frames) {
      const sfx = f.id === "square" ? "" : "-li";
      for (const role of ["kicker", "headline", "sub", "source", "footer", "status", "logo"]) expect(byRole(f, role).map((n) => n.id)).toEqual([role + sfx]);
      const h = byRole(f, "headline")[0] as TextNode;
      expect(textOf(h)).toBe("Исти модели.\nРазлични оценки.");
      expect([h.box, h.align]).toEqual(["fixed-width", "center"]);
    }
    validates(doc);
    expect(report.maxAdvanceDelta).toBeLessThan(0.25); // our widths vs Chrome's, all 144 text items
  });

  it("keeps every layout item (72 texts → 71 boxes, headline merged; 64 shapes; the logo)", () => {
    doc.frames.forEach((f, i) => {
      const items = layout[i].items;
      expect(texts(f).length).toBe(items.filter((x: any) => x.kind === "text").length - 1);
      const shapes = all(f.children).filter((n) => ["rect", "ellipse", "line"].includes(n.type));
      expect(shapes.length).toBe(items.filter((x: any) => ["rect", "circle", "line"].includes(x.kind)).length - 1); // paper rect → frame background
      const words = (s: string) => s.replace(/\s+/g, " ").trim();
      expect(texts(f).map((t) => words(textOf(t))).join(" | ")).toBe(
        items
          .filter((x: any) => x.kind === "text")
          .map((x: any) => x.text)
          .join(" | ")
          .replace("Исти модели. | Различни оценки.", "Исти модели. Различни оценки."),
      );
    });
  });

  it("groups the chart: 19 rows with both judges' scores in meta, matching the data-score attributes", () => {
    for (const f of doc.frames) {
      const chart = byRole(f, "chart");
      expect(chart.length).toBe(1);
      const rows = byRole(f, "chart-row");
      expect(rows.length).toBe(19);
      const scores = byRole(f, "score") as TextNode[];
      expect(scores.length).toBe(38);
      for (const s of scores) expect(textOf(s)).toBe(String(s.meta!.score));
      const src = layout[0].items.filter((x: any) => x.attrs["data-score"]).map((x: any) => `${x.attrs["data-model"]}/${x.attrs["data-judge"]}=${Number(x.attrs["data-score"])}`);
      expect(rows.flatMap((r) => Object.entries(r.meta!.scores as Record<string, number>).map(([j, v]) => `${r.meta!.model}/${j}=${v}`)).sort()).toEqual(src.sort());
      expect((chart[0].meta!.rows as unknown[]).length).toBe(19);
      expect(byRole(f, "label").length).toBe(19);
    }
  });

  it("uses readable, unique ids without dots", () => {
    const ids = doc.frames.flatMap((f) => all(f.children).map((n) => n.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id))).toBe(true);
    expect(ids).toContain("row-gpt-5-5");
    expect(ids).toContain("score-gpt-5-5-gpt_6_luna");
    expect(ids).toContain("label-gpt-5-5-li");
  });

  it("uses the pack's pre-blended logo (no blend modes in post-studio/1)", () => {
    expect(report.assets).toHaveLength(1);
    const logo = stored.get(report.assets[0].ref.slice(7))!;
    expect(logo.bytes.equals(readFileSync(join(LUX6, "figma/assets/logo-on-paper.png")))).toBe(true);
  });
});

describe("(b) LUX-1 template post.svg", () => {
  let doc: Document;
  let report: Awaited<ReturnType<typeof importSocialPost>>["report"];
  beforeAll(async () => {
    ({ doc, report } = await importSocialPost(LUX1, { fonts, upload }));
  });

  it("converts to real nodes with template + copy roles", () => {
    expect(report.mode).toBe("template");
    expect(report.why).toEqual(["layout: no figma/editable-layout.json"]);
    expect(doc.lang).toBe("en");
    for (const f of doc.frames) {
      const sfx = f.id === "square" ? "" : "-li";
      for (const role of ["kicker", "headline", "source", "footer", "logo", "art", "accent"]) expect(byRole(f, role).map((n) => n.id)).toEqual([role + sfx]);
      expect(textOf(byRole(f, "headline")[0] as TextNode)).toBe("Only 4 of 44 models clear\n80% at writing Macedonian.");
      expect((byRole(f, "kicker")[0] as TextNode).style.letterSpacing).toBeCloseTo(26 * 0.06, 3);
      expect(byRole(f, "label").length).toBe(7);
      expect(byRole(f, "value").length).toBe(7);
      expect(all(f.children).filter((n) => n.type === "path").length).toBe(14);
      expect(all(f.children).some((n) => n.type === "svg")).toBe(false);
    }
    validates(doc);
  });

  it("puts the chart numbers in the art group's meta", () => {
    const art = byRole(doc.frames[0], "art")[0];
    expect(art.meta!.rows).toEqual([
      { label: "Gemini 3 Flash Preview", value: "90%", number: 90 },
      { label: "GPT-5.5", value: "89%", number: 89 },
      { label: "GPT-5.4 mini", value: "84%", number: 84 },
      { label: "Gemini 3.5 Flash", value: "83%", number: 83 },
      { label: "GPT-5.2", value: "79%", number: 79 },
      { label: "DeepSeek V4 Pro", value: "77%", number: 77 },
      { label: "Qwen3.6-Max-Preview", value: "77%", number: 77 },
    ]);
  });

  it("bakes the multiply-blended logo on paper and records the hidden guide overlay as skipped", () => {
    expect(report.assets).toHaveLength(1);
    expect(report.assets[0].note).toMatch(/multiply onto #FCFAF6/);
    expect(report.skipped).toEqual(["post.svg <g id=guides> (display:none, template guide overlay)", "post-li.svg <g id=guides> (display:none, template guide overlay)"]);
    expect((doc.meta!.import as any).skipped).toHaveLength(2);
  });

  it("refuses non-template SVG in template mode, with every reason", async () => {
    const err = await importSocialPost(DAILY, { fonts, upload, mode: "template" }).catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.reasons.join("\n")).toMatch(/url\(#window\)/);
    expect(err.reasons.join("\n")).toMatch(/filter/);
    expect(err.reasons.join("\n")).toMatch(/mix-blend-mode multiply/);
  });
});

describe("(c) fallback: daily-2026-10-26-tochna-cena (raster art, gradient, grain filter, blend)", () => {
  let doc: Document;
  let report: Awaited<ReturnType<typeof importSocialPost>>["report"];
  const copy = JSON.parse(readFileSync(join(DAILY, "copy.json"), "utf8"));
  beforeAll(async () => {
    ({ doc, report } = await importSocialPost(DAILY, { fonts, upload }));
  });

  it("falls back after explaining why template mode can't express it", () => {
    expect(report.mode).toBe("fallback");
    expect(report.why[1]).toMatch(/^template: post.svg is not plain template SVG/);
    validates(doc);
  });

  it("keeps the raster art as an image node with the original bytes", () => {
    const f = doc.frames[0];
    expect(f.background).toEqual({ color: "#F6F2EA" });
    expect(f.children.map((n) => `${n.type}:${n.id}`)).toEqual(["image:art", "svg:layer-1", "text:headline"]);
    const art = f.children[0] as Extract<Node, { type: "image" }>;
    expect([art.x, art.y, art.w, art.h, art.fit, art.role]).toEqual([0, 0, 1080, 1080, "fill", "art"]);
    const bytes = stored.get(art.asset.slice(7))!.bytes;
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(createHash("sha256").update(readFileSync(join(DAILY, "art/render-mid.png"))).digest("hex"));
  });

  it("keeps the light fall-off gradient, grain filter and multiply blend in an SVG layer (survives the sanitizer)", () => {
    const layer = doc.frames[0].children[1] as Extract<Node, { type: "svg" }>;
    const svg = stored.get(layer.asset.slice(7))!.bytes.toString("utf8");
    for (const s of ["<radialGradient", 'id="window"', "<filter", "<feTurbulence", 'baseFrequency="0.9"', "<feColorMatrix", 'fill="url(#window)"', 'filter="url(#grain)"', "mix-blend-mode:multiply", 'opacity="0.05"']) expect(svg).toContain(s);
    expect(svg).not.toContain("<image"); // the art is its own node
    expect(svg).not.toContain("<text"); // the headline is editable text
  });

  it("makes the headline editable text in the registered Alegreya 700, two lines 92 px apart", () => {
    const h = doc.frames[0].children[2] as TextNode;
    expect(textOf(h)).toBe("Цената ја знаете\nпред да почнеме.");
    expect(h.style).toMatchObject({ font: "Alegreya", weight: 700, size: 84, fill: "#1D2129" });
    expect(h.style.lineHeight! * 84).toBeCloseTo(92, 6);
    const L = layoutNode(fonts, h, "mk");
    expect(L.lines.map((l) => Math.round(h.y + l.baseline))).toEqual([148, 240]);
    expect(h.x).toBe(135);
    expect(h.meta!.fontFeatureSettings).toBe('"lnum" 1');
  });

  it("keeps the whole copy.json (in-art text, lane, layout) in the document meta", () => {
    expect(doc.meta!.copy).toEqual(copy);
    expect((doc.meta!.copy as any).in_art).toHaveLength(16);
  });

  it("renders: art below the layer, headline on top", () => {
    const r = renderSvg(doc, { fonts, assets });
    expect(r.svg.indexOf('id="art"')).toBeLessThan(r.svg.indexOf('id="layer-1"'));
    expect(r.svg.indexOf('id="layer-1"')).toBeLessThan(r.svg.indexOf('id="headline"'));
    expect(r.svg).toContain('filter="url(#layer-1--grain)"');
  });
});
