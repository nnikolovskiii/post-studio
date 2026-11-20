import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import * as hb from "harfbuzzjs";
import { FontRegistry, MACEDONIAN_LETTERS, layout, measureAdvance, type LayoutInput } from "../src/index.ts";

let reg: FontRegistry;
beforeAll(async () => {
  reg = await FontRegistry.load();
});

const golden = JSON.parse(readFileSync(new URL("../../../fixtures/golden/lux6-chrome-advances.json", import.meta.url), "utf8"));
const MK_SAMPLE = "ѓ ќ ѕ џ љ њ Ѓ Ќ Ѕ Џ Љ Њ — Ѓорѓи, ќерка, ѕвезда, џемпер, љубов, њива.";

const box = (text: string, over: Partial<LayoutInput> = {}): LayoutInput => ({
  spans: [{ text }],
  style: { font: "IBM Plex Sans", weight: 500, size: 24 },
  box: "fixed-width",
  align: "left",
  w: 300,
  h: 0,
  ...over,
});

describe("font registry", () => {
  it("has the social-posts families, each passing the 62-letter Macedonian check", () => {
    expect(MACEDONIAN_LETTERS.length).toBe(62);
    const faces = reg.describe();
    expect(reg.families().sort()).toEqual(["Alegreya", "Alegreya Sans", "Bitter", "IBM Plex Mono", "IBM Plex Sans", "Rubik", "Source Sans 3"]);
    for (const f of faces) expect({ face: `${f.family} ${f.weightMin}`, missing: f.missingMacedonian }).toEqual({ face: `${f.family} ${f.weightMin}`, missing: [] });
    expect(faces.every((f) => f.files.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)))).toBe(true);
  });

  it("rejects unknown families and unregistered weights with a readable message", () => {
    expect(reg.checkFont("IBM Plex Sans", 500)).toBeUndefined();
    expect(reg.checkFont("Comic Sans", 400)).toMatch(/not registered/);
    expect(reg.checkFont("Bitter", 400)).toBe("'Bitter' has no weight 400 (available: 600, 700)");
  });
});

describe("font bytes (served to the browser editor)", () => {
  it("keeps every decompressed sfnt intact, so a registry rebuilt from them (the browser path) has the same coverage", async () => {
    const magic = (b: Uint8Array) => String.fromCharCode(...b.slice(0, 4));
    for (const f of reg.allFiles()) expect({ file: f.file, magic: ["\0\x01\0\0", "OTTO", "true"].includes(magic(f.sfnt)) }).toEqual({ file: f.file, magic: true });
    const byFile = new Map(reg.allFiles().map((f) => [f.file, f]));
    const rebuilt = await FontRegistry.fromSources(reg.manifest(), async (file) => {
      const f = byFile.get(file)!;
      return { sfnt: f.sfnt, sha256: f.sha256, bytes: f.bytes };
    });
    for (const f of rebuilt.allFiles()) expect({ file: f.file, n: f.unicodes.size }).toEqual({ file: f.file, n: byFile.get(f.file)!.unicodes.size });
    expect(rebuilt.describe().every((x) => x.missingMacedonian.length === 0)).toBe(true);
  });
});

describe("shaping matches Chrome", () => {
  it("every LUX-6 string is within 0.25 px of Chrome's measured advance", () => {
    const diffs = golden.items.map((it: any) => ({
      text: it.text,
      diff: Math.abs(measureAdvance(reg, it.text, { font: it.font, weight: it.weight, size: it.size }, "mk") - it.advance),
    }));
    expect(diffs.length).toBe(66);
    expect(diffs.filter((d: any) => d.diff > 0.25)).toEqual([]);
  });
});

describe("Macedonian golden tests", () => {
  it("shapes ѓ ќ ѕ џ љ њ in every registered face without missing glyphs", () => {
    const widths: Record<string, number> = {};
    for (const f of reg.describe()) {
      const style = { font: f.family, weight: f.weightMin, size: 40 };
      const l = layout(reg, box(MK_SAMPLE, { style, box: "auto-width" }), "mk");
      expect(l.missingGlyphs).toEqual([]);
      expect(l.lines[0].glyphs.every((g) => g.gid !== 0)).toBe(true);
      widths[`${f.family} ${f.weightMin}`] = Math.round(l.width * 100) / 100;
    }
    expect(widths).toMatchSnapshot();
  });

  it("uses the Macedonian (MKD locl) form of ѓ in Bitter when lang is mk", () => {
    const style = { font: "Bitter", weight: 700, size: 40 };
    const gid = (lang: string) => layout(reg, box("ѓ", { style, box: "auto-width" }), lang).lines[0].glyphs[0].gid;
    expect(gid("mk")).not.toBe(gid("ru"));
    // Cross-check with raw HarfBuzz: language 'mk' maps to OpenType 'MKD '.
    expect(hb.otTagsFromScriptAndLanguage("Cyrl", "mk").languageTags).toEqual(["MKD "]);
  });

  it("keeps Serbian / Bulgarian forms out of Macedonian text", () => {
    const style = { font: "Bitter", weight: 700, size: 40 };
    const ids = (lang: string) => layout(reg, box("бгдпт", { style, box: "auto-width" }), lang).lines[0].glyphs.map((g) => g.gid);
    expect(ids("mk")).toEqual(ids("ru"));
    expect(ids("sr")).not.toEqual(ids("mk"));
  });

  it("splits text across subset files (Latin + Cyrillic) like CSS unicode-range", () => {
    const l = layout(reg, box("GPT-5.2 · Исти", { box: "auto-width" }), "mk");
    const files = new Set(l.lines[0].glyphs.map((g) => g.file));
    expect(files).toEqual(new Set(["IBMPlexSans-400-600-latin.woff2", "IBMPlexSans-400-600-cyrillic.woff2"]));
  });

  it("reports characters no registered file covers", () => {
    expect(layout(reg, box("Здраво 中文", { box: "auto-width" }), "mk").missingGlyphs).toEqual(["中", "文"]);
  });
});

describe("line breaking and boxes", () => {
  const sentence = "Истите модели добиваат многу различни оценки зависно од тоа кој оценувач ги проверува одговорите.";

  it("wraps fixed-width text greedily without exceeding the width", () => {
    const l = layout(reg, box(sentence), "mk");
    expect(l.lines.length).toBeGreaterThan(3);
    for (const line of l.lines) {
      expect(line.width).toBeLessThanOrEqual(300 + 0.01);
      expect(line.text).toBe(line.text.trim());
    }
    expect(l.lines.map((x) => x.text).join(" ")).toBe(sentence);
    expect(l.overflowX).toBe(0);
    expect(l.height).toBeCloseTo(l.lines.length * 24 * 1.2, 6);
  });

  it("keeps explicit line breaks and blank lines", () => {
    const l = layout(reg, box("Исти модели.\n\nРазлични оценки.", { box: "auto-width" }), "mk");
    expect(l.lines.map((x) => x.text)).toEqual(["Исти модели.", "", "Различни оценки."]);
  });

  it("reports horizontal overflow for a word that cannot fit", () => {
    const l = layout(reg, box("Најнепредвидливиот", { w: 100 }), "mk");
    expect(l.lines.length).toBe(1);
    expect(l.overflowX).toBeGreaterThan(50);
  });

  it("reports vertical overflow for fixed boxes only", () => {
    const fixed = layout(reg, box(sentence, { box: "fixed", h: 60 }), "mk");
    expect(fixed.overflowY).toBeCloseTo(fixed.height - 60, 6);
    expect(layout(reg, box(sentence, { h: 60 }), "mk").overflowY).toBe(0);
  });

  it("aligns lines inside the box and places baselines with half-leading", () => {
    const c = layout(reg, box("Исти\nмодели", { align: "center" }), "mk");
    expect(c.lines[0].x).toBeCloseTo((300 - c.lines[0].width) / 2, 6);
    const r = layout(reg, box("Исти", { align: "right" }), "mk");
    expect(r.lines[0].x + r.lines[0].width).toBeCloseTo(300, 6);
    expect(c.lines[1].baseline - c.lines[0].baseline).toBeCloseTo(24 * 1.2, 6);
    expect(c.lines[0].baseline).toBeCloseTo((c.lineHeight - c.ascent - c.descent) / 2 + c.ascent, 6);
  });

  it("applies per-span weight and letter spacing", () => {
    const plain = layout(reg, box("DRAFT необјавено", { box: "auto-width" }), "mk").width;
    const bold = layout(reg, box("", { box: "auto-width", spans: [{ text: "DRAFT " }, { text: "необјавено", weight: 600 }] }), "mk");
    expect(bold.width).toBeGreaterThan(plain);
    expect(new Set(bold.lines[0].glyphs.map((g) => g.span))).toEqual(new Set([0, 1]));
    const spaced = layout(reg, box("ABCD", { box: "auto-width", style: { font: "IBM Plex Sans", weight: 500, size: 24, letterSpacing: 2 } }), "mk").width;
    const tight = layout(reg, box("ABCD", { box: "auto-width" }), "mk").width;
    expect(spaced - tight).toBeCloseTo(8, 6);
  });

  it("breaks after hyphens between letters", () => {
    const l = layout(reg, box("Qwen3.5-397B-A17B Qwen3.6-Max-Preview-Long", { w: 160 }), "mk");
    expect(l.lines.length).toBeGreaterThan(1);
    expect(l.lines.some((x) => x.text.endsWith("-"))).toBe(true);
  });
});
