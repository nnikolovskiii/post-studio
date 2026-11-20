import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { DocumentSchema, SCHEMA_VERSION, type Document, type Node } from "@post-studio/schema";
import { FontRegistry, layoutNode } from "@post-studio/text";
import {
  chromeRenderSvg,
  comparePng,
  exportProject,
  findChrome,
  frameStems,
  imageSize,
  inlineSvgAsset,
  pngToJpeg,
  recolorText,
  renderPng,
  renderSvg,
  unicodeRange,
  type AssetData,
} from "../src/index.ts";
import { resvgFontFiles } from "../src/raster.ts";

const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/lux-6-square.hand.json", import.meta.url), "utf8")) as Document;
const logo = readFileSync(new URL("../../../fixtures/assets/logo-on-paper.png", import.meta.url));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let fonts: FontRegistry;
const store = new Map<string, AssetData>();
const assets = (s: string) => store.get(s);
const add = (mime: string, bytes: Uint8Array) => {
  const h = sha(bytes);
  store.set(h, { mime, bytes });
  return `sha256:${h}`;
};

beforeAll(async () => {
  fonts = await FontRegistry.load();
  add("image/png", logo);
});

function doc(children: Node[], extra: Partial<Document> = {}): Document {
  const d = { schema: SCHEMA_VERSION, id: "prj_test1", title: "Test", lang: "mk", frames: [{ id: "f", name: "F", w: 400, h: 300, background: { color: "#FCFAF6" }, children }], ...extra };
  return DocumentSchema.parse(d) as Document;
}

const text = (over: Partial<Extract<Node, { type: "text" }>> = {}): Node =>
  ({
    id: "t",
    type: "text",
    x: 20,
    y: 30,
    w: 300,
    h: 40,
    box: "auto-width",
    align: "left",
    style: { font: "IBM Plex Sans", weight: 500, size: 24, fill: "#190F0B" },
    spans: [{ text: "Исти модели." }],
    ...over,
  }) as Node;

describe("live SVG", () => {
  it("places one tspan per line at the packages/text layout position, baselines snapped to whole px", () => {
    const n = text({ box: "fixed-width", w: 120, align: "center", spans: [{ text: "Различни оценки за ѓ ќ ѕ" }] }) as Extract<Node, { type: "text" }>;
    const r = renderSvg(doc([n]), { fonts, assets, positioning: "line" });
    const L = layoutNode(fonts, n, "mk");
    expect(L.lines.length).toBeGreaterThan(1);
    const tspans = [...r.svg.matchAll(/<tspan x="([^"]+)" y="([^"]+)">([^<]*)<\/tspan>/g)];
    expect(tspans.map((m) => m[3])).toEqual(L.lines.map((l) => l.text));
    tspans.forEach((m, i) => {
      expect(Number(m[1])).toBeCloseTo(n.x + L.lines[i].x, 2);
      expect(Number(m[2])).toBe(Math.round(n.y + L.lines[i].baseline));
    });
    expect(r.svg).toContain(`font-family="'IBM Plex Sans'"`);
    expect(r.svg).toContain('xml:lang="mk"');
  });

  it("embeds the used faces as @font-face with unicode-range, first lookup file declared last", () => {
    const r = renderSvg(doc([text({ spans: [{ text: "LUX · ГЕНЕРИРАЊЕ ѓ" }] })]), { fonts, assets });
    const faces = [...r.svg.matchAll(/@font-face\{font-family:'([^']+)';font-style:normal;font-weight:([^;]+);[^}]*unicode-range:([^}]+)\}/g)];
    expect(faces.length).toBe(3); // IBM Plex Sans latin, cyrillic, cyrillic-ext
    expect(faces.every((f) => f[1] === "IBM Plex Sans" && f[2] === "400 600")).toBe(true);
    expect(faces[2][3]).toMatch(/^U\+20-7E,/); // latin last = tried first by the browser
    expect(renderSvg(doc([text()]), { fonts, assets, embedFonts: false }).svg).not.toContain("@font-face");
  });

  it("splits a line into positioned runs for spans with their own weight and fill", () => {
    const n = text({ spans: [{ text: "Исти " }, { text: "модели", weight: 600, fill: "#AC1922" }, { text: "." }] }) as Extract<Node, { type: "text" }>;
    const r = renderSvg(doc([n]), { fonts, assets, positioning: "line" });
    const L = layoutNode(fonts, n, "mk");
    const runs = [...r.svg.matchAll(/<tspan([^>]*)>([^<]*)<\/tspan>/g)];
    expect(runs.map((m) => m[2])).toEqual(["Исти ", "модели", "."]);
    expect(runs[1][1]).toContain('font-weight="600"');
    expect(runs[1][1]).toContain('fill="#AC1922"');
    const g = L.lines[0].glyphs.find((x) => x.cluster >= 5)!;
    expect(Number(/x="([^"]+)"/.exec(runs[1][1])![1])).toBeCloseTo(n.x + g.x, 2);
  });

  it("by default gives every character its HarfBuzz x, so browsers can't drift from the outlined export", () => {
    const n = text({ style: { font: "IBM Plex Mono", weight: 500, size: 26, letterSpacing: 1.56, fill: "#655B56" }, spans: [{ text: "LUX · " }, { text: "ГЕН", fill: "#AC1922" }] }) as Extract<Node, { type: "text" }>;
    const r = renderSvg(doc([n]), { fonts, assets });
    const L = layoutNode(fonts, n, "mk");
    const runs = [...r.svg.matchAll(/<tspan x="([^"]+)" y="([^"]+)"[^>]*>([^<]*)<\/tspan>/g)];
    expect(runs.map((m) => m[3])).toEqual(["LUX · ", "ГЕН"]);
    const xs = runs.flatMap((m) => m[1].split(" ").map(Number));
    expect(xs.length).toBe(9); // one per character, spaces included
    const glyphX = new Map(L.lines[0].glyphs.map((g) => [g.cluster, g.x]));
    xs.forEach((x, i) => expect(x).toBeCloseTo(n.x + glyphX.get(i)!, 2));
    expect(xs[1] - xs[0]).toBeCloseTo(26 * 0.6 + 1.56, 2); // Plex Mono advance + letter spacing
  });

  it("falls back to one x per run when a character has no glyph of its own (combining marks)", () => {
    const r = renderSvg(doc([text({ spans: [{ text: "е\u0301 и" }] })]), { fonts, assets });
    expect(/<tspan x="([^"]+)"/.exec(r.svg)![1]).not.toContain(" ");
  });

  it("keeps letter spacing, escapes text and preserves inner spaces", () => {
    const r = renderSvg(doc([text({ style: { font: "IBM Plex Mono", weight: 500, size: 20, letterSpacing: 1.2, fill: "#655B56" }, spans: [{ text: "A  <b> & \"c\"" }] })]), { fonts, assets });
    expect(r.svg).toContain('letter-spacing="1.2"');
    expect(r.svg).toContain("A  &lt;b&gt; &amp; &quot;c&quot;");
    expect(r.svg).toContain('xml:space="preserve"');
  });
});

describe("outlined SVG", () => {
  it("has no <text> and no fonts; one path per text node and fill, positioned like the live tspans", () => {
    const d = doc([text({ spans: [{ text: "Исти " }, { text: "модели", fill: "#AC1922" }] }), text({ id: "u", y: 120, spans: [{ text: "ѓ ќ ѕ џ љ њ" }] })]);
    const r = renderSvg(d, { fonts, assets, text: "outlined" });
    expect(r.svg).not.toContain("<text");
    expect(r.svg).not.toContain("@font-face");
    expect(r.svg).toMatch(/<g id="t"[^>]*><path d="M[^"]+" fill="#190F0B"\/><path d="M[^"]+" fill="#AC1922"\/><\/g>/);
    expect(r.svg).toMatch(/<path id="u" aria-label="ѓ ќ ѕ џ љ њ" d="M/);
    expect(r.fontsUsed.map((f) => f.file).sort()).toEqual(["IBMPlexSans-400-600-cyrillic.woff2", "IBMPlexSans-400-600-latin.woff2"]); // spaces come from latin
  });

  it("outlines the glyphs the document language selects (locl): Serbian б differs, Macedonian keeps the default", () => {
    // Bitter's Macedonian ѓ is a separate glyph id with the same drawing, so б (Serbian locl) is the visible case.
    const n = text({ style: { font: "Bitter", weight: 700, size: 40, fill: "#000000" }, spans: [{ text: "б" }] });
    const d = (lang: string) => / d="([^"]+)"/.exec(renderSvg(doc([n], { lang }), { fonts, assets, text: "outlined" }).svg)![1];
    expect(d("mk")).toBe(d("ru"));
    expect(d("sr")).not.toBe(d("mk"));
  });
});

describe("shapes, images, svg art", () => {
  it("renders rect / ellipse / line / path with strokes, dashes, radius, rotation, opacity and hidden nodes", () => {
    const r = renderSvg(
      doc([
        { id: "r", type: "rect", x: 10, y: 10, w: 100, h: 50, radius: 80, fill: "#AC192280", stroke: { color: "#190F0B", width: 2, dash: [6, 3], cap: "round" }, rotation: 15, opacity: 0.5 },
        { id: "e", type: "ellipse", x: 0, y: 0, w: 20, h: 10, fill: null, stroke: { color: "#305880", width: 1 } },
        { id: "l", type: "line", x: 5, y: 6, w: -5, h: 10, stroke: { color: "#E2DDD5", width: 5 } },
        { id: "p", type: "path", x: 100, y: 100, w: 20, h: 40, d: "M0 0H10V10Z", viewBox: [0, 0, 10, 10], fill: "#000000", stroke: { color: "#FF0000", width: 4 } },
        { id: "hid", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: "#000000", visible: false },
      ]),
      { fonts, assets },
    );
    expect(r.svg).toContain('<rect id="r" transform="rotate(15 60 35)" opacity="0.5" x="10" y="10" width="100" height="50" rx="25" fill="#AC1922" fill-opacity="0.502" stroke="#190F0B" stroke-width="2" stroke-dasharray="6 3" stroke-linecap="round"/>');
    expect(r.svg).toContain('<ellipse id="e" cx="10" cy="5" rx="10" ry="5" fill="none" stroke="#305880" stroke-width="1"/>');
    expect(r.svg).toContain('<line id="l" x1="5" y1="6" x2="0" y2="16" fill="none" stroke="#E2DDD5" stroke-width="5"/>');
    expect(r.svg).toContain('<g id="p"><path transform="translate(100 100) scale(2 4) translate(0 0)" d="M0 0H10V10Z" fill="#000000" stroke="#FF0000" stroke-width="1.333"/></g>');
    expect(r.svg).not.toContain('id="hid"');
  });

  it("resolves brand-kit tokens, draws unknown tokens magenta and reports them", () => {
    const r = renderSvg(doc([{ id: "r", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: { token: "lux.nope" } }]), { fonts, assets });
    expect(r.svg).toContain('fill="#FF00FF"');
    expect(r.warnings.join()).toContain("lux.nope");
    const kit = renderSvg(doc([{ id: "r", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: { token: "lux.accent" }, stroke: { color: { token: "kites.ink" }, width: 2 } }]), { fonts, assets });
    expect(kit.svg).toContain('fill="#AC1922"');
    expect(kit.svg).toContain('stroke="#3E3655"');
    expect(kit.warnings).toEqual([]);
    const ok = renderSvg(doc([{ id: "r", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: { token: "x.y" } }]), { fonts, assets, resolveToken: () => "#AC1922" });
    expect(ok.svg).toContain('fill="#AC1922"');
    expect(ok.warnings).toEqual([]);
  });

  it("wraps the accent object in <g id=\"accent\"> and keeps an SVG art's own accent group only outside it", () => {
    const art = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g id="accent"><rect width="10" height="10" fill="#AC1922"/></g><g id="other"/></svg>');
    const ref = `sha256:${sha(art)}`;
    const extra = new Map([[sha(art), { mime: "image/svg+xml", bytes: art }]]);
    const look = (s: string) => extra.get(s) ?? assets(s);
    const r = renderSvg(
      doc([
        { id: "t", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: "#AC1922", accent: true },
        { id: "a", type: "svg", asset: ref, x: 0, y: 0, w: 10, h: 10 },
        { id: "accent", type: "group", x: 0, y: 0, w: 1, h: 1, children: [{ id: "b", type: "svg", asset: ref, x: 0, y: 0, w: 10, h: 10 }] },
      ]),
      { fonts, assets: look },
    );
    expect(r.svg).toContain('<g id="accent"><rect id="t"');
    expect(r.svg).toContain('<g id="accent"><rect width="10" height="10" fill="#AC1922"/></g><g id="a--other"/>');
    // Inside the accent group the art's own accent group is prefixed like any id: one group, not two.
    expect(r.svg).toContain('<g id="b--accent">');
    expect(r.svg.match(/<g id="accent"/g)!.length).toBe(3);
  });

  it("embeds images as data URIs with fit → preserveAspectRatio, and crops through a nested viewport", () => {
    const ref = `sha256:${sha(logo)}`;
    const r = renderSvg(
      doc([
        { id: "a", type: "image", asset: ref, x: 0, y: 0, w: 72, h: 72, fit: "contain" },
        { id: "b", type: "image", asset: ref, x: 0, y: 0, w: 72, h: 40, fit: "cover" },
        { id: "c", type: "image", asset: ref, x: 0, y: 0, w: 50, h: 50, fit: "fill", crop: [100, 100, 500, 500] },
        { id: "m", type: "image", asset: `sha256:${"0".repeat(64)}`, x: 0, y: 0, w: 10, h: 10, fit: "fill" },
      ]),
      { fonts, assets },
    );
    expect(r.svg).toMatch(/<image id="a" x="0" y="0" width="72" height="72" preserveAspectRatio="xMidYMid meet" href="data:image\/png;base64,iVBOR/);
    expect(r.svg).toContain('id="b" x="0" y="0" width="72" height="40" preserveAspectRatio="xMidYMid slice"');
    expect(r.svg).toContain('<g id="c"><svg x="0" y="0" width="50" height="50" viewBox="100 100 500 500" preserveAspectRatio="none"><image x="0" y="0" width="1676" height="1670"');
    expect(r.warnings.join()).toContain("m: asset sha256:0000");
  });

  it("inlines svg art with prefixed ids, scoped classes and the recolor map", () => {
    const art = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" fill="#ac1922"><defs><linearGradient id="g"><stop stop-color="#AC1922"/></linearGradient><style>.a{fill:#AC1922}</style></defs><rect class="a" width="10" height="10"/><rect fill="url(#g)" width="5" height="5"/><use href="#g"/><circle r="3" style="fill:#AC1922" stroke="#f00"/></svg>`;
    const ref = add("image/svg+xml", Buffer.from(art));
    const r = renderSvg(doc([{ id: "art", type: "svg", asset: ref, x: 10, y: 20, w: 200, h: 200, recolor: { "#AC1922": "#305880", "#FF0000": "#00FF00" } }]), { fonts, assets });
    expect(r.svg).toContain('<g id="art"><g transform="translate(10 70) scale(2)" fill="#305880">');
    expect(r.svg).toContain('id="art--g"');
    expect(r.svg).toContain('fill="url(#art--g)"');
    expect(r.svg).toContain('href="#art--g"');
    expect(r.svg).toContain(".art--a{fill:#305880}");
    expect(r.svg).toContain('class="art--a"');
    expect(r.svg).toContain('style="fill:#305880"');
    expect(r.svg).toContain('stroke="#00FF00"');
    expect(r.svg).not.toMatch(/#AC1922/i);
  });

  it("isolates svg art that carries global CSS (@font-face, element selectors) as an <image>", () => {
    const out = inlineSvgAsset({ svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@font-face{font-family:X;src:url(data:font/ttf;base64,AA)} text{fill:#AC1922}</style><text>x</text></svg>`, prefix: "n--", x: 0, y: 0, w: 10, h: 10, recolor: { "#AC1922": "#000000" } });
    expect(out.mode).toBe("image");
    const b64 = /base64,([^"]+)"/.exec(out.markup)![1];
    expect(Buffer.from(b64, "base64").toString()).toContain("fill:#000000");
  });

  it("recolors 3-, 6- and 8-digit hex, case-insensitively, and leaves other colors", () => {
    const m = new Map([["#AABBCC", "#112233"]]);
    expect(recolorText("#abc #AABBCC #aabbccdd #AABBCD", m)).toBe("#112233 #112233 #112233dd #AABBCD");
  });

  it("groups translate their children and rotate around their own center", () => {
    const r = renderSvg(doc([{ id: "g", type: "group", x: 100, y: 50, w: 40, h: 20, rotation: 90, opacity: 0.8, children: [{ id: "k", type: "rect", x: 1, y: 2, w: 3, h: 4, fill: "#000000" }] } as Node]), { fonts, assets });
    expect(r.svg).toContain('<g id="g" transform="translate(100 50) rotate(90 20 10)" opacity="0.8"><rect id="k" x="1" y="2" width="3" height="4" fill="#000000"/></g>');
  });

  it("refuses an unknown frame", () => {
    expect(() => renderSvg(fixture, { fonts, assets, frame: "nope" })).toThrow(/frame 'nope' not found/);
  });
});

describe("helpers", () => {
  it("unicodeRange compacts runs", () => {
    expect(unicodeRange([0x41, 0x42, 0x43, 0x45, 0x400, 0x401])).toBe("U+41-43,U+45,U+400-401");
  });

  it("imageSize reads PNG, JPEG and WebP headers", async () => {
    const base = sharp({ create: { width: 37, height: 19, channels: 3, background: "#ff0000" } });
    expect(imageSize(await base.clone().png().toBuffer())).toEqual({ w: 37, h: 19 });
    expect(imageSize(await base.clone().jpeg().toBuffer())).toEqual({ w: 37, h: 19 });
    expect(imageSize(await base.clone().webp().toBuffer())).toEqual({ w: 37, h: 19 });
    expect(imageSize(await base.clone().webp({ lossless: true }).toBuffer())).toEqual({ w: 37, h: 19 });
    expect(imageSize(Buffer.from("nope"))).toBeUndefined();
  });
});

describe("PNG and JPEG", () => {
  it("rasterizes the outlined SVG at frame size (and scaled), JPEG decodes at the same size", async () => {
    const r = await renderPng(fixture, { fonts, assets });
    expect([r.width, r.height]).toEqual([1080, 1080]);
    expect(r.svg).not.toContain("<text");
    const meta = await sharp(r.png).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([1080, 1080, "png"]);
    const half = await renderPng(fixture, { fonts, assets, scale: 0.5 });
    expect([half.width, half.height]).toEqual([540, 540]);
    const jpg = await pngToJpeg(r.png);
    const jm = await sharp(jpg).metadata();
    expect([jm.format, jm.width, jm.height, jm.chromaSubsampling]).toEqual(["jpeg", 1080, 1080, "4:4:4"]);
    const d = await comparePng(r.png, jpg);
    expect(d.meanChannelError).toBeLessThan(0.003);
  });

  it("draws text inside SVG art with the registered fonts (resvg reads intact TTF copies)", async () => {
    for (const file of resvgFontFiles(fonts)) expect(["\0\x01\0\0", "OTTO", "true"]).toContain(readFileSync(file).subarray(0, 4).toString("latin1"));
    const art = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300"><text x="20" y="200" font-family="IBM Plex Sans" font-weight="600" font-size="160" fill="#190F0B">Ѓиж</text></svg>`;
    const ref = add("image/svg+xml", new TextEncoder().encode(art));
    const r = await renderPng(doc([{ id: "art", type: "svg", asset: ref, x: 0, y: 0, w: 400, h: 300 }]), { fonts, assets });
    const { data } = await sharp(r.png).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    const ink = data.filter((v) => v < 100).length;
    expect(ink).toBeGreaterThan(5000); // three 160 px glyphs, not an empty box
  });

  it("converts WebP assets so resvg can draw them", async () => {
    const webp = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#305880" } }).webp({ lossless: true }).toBuffer();
    const ref = add("image/webp", webp);
    const d = doc([{ id: "w", type: "image", asset: ref, x: 0, y: 0, w: 400, h: 300, fit: "fill" }]);
    const r = await renderPng(d, { fonts, assets });
    const { data } = await sharp(r.png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([0x30, 0x58, 0x80]);
  });
});

describe("export", () => {
  it("names frame files like social-posts: post, post-li (by id, name or 1080×1350), then post-<id>", () => {
    const f = (id: string, name: string, w = 1080, h = 1080) => ({ id, name, w, h, children: [] });
    const d = (frames: any[]) => ({ ...fixture, frames }) as Document;
    expect([...frameStems(d([f("square", "Square"), f("li", "LinkedIn", 1080, 1350)])).values()]).toEqual(["post", "post-li"]);
    expect([...frameStems(d([f("a", "Feed"), f("story", "Story", 1080, 1920), f("p", "Portrait", 1080, 1350)])).entries()]).toEqual([["a", "post"], ["p", "post-li"], ["story", "post-story"]]);
    expect([...frameStems(d([f("a", "A"), f("b", "B", 1080, 1350)])).values()]).toEqual(["post", "post-li"]);
  });

  it("writes svg / png / jpg per frame, both Figma variants, the document and a manifest", async () => {
    const two = { ...fixture, frames: [fixture.frames[0], { ...fixture.frames[0], id: "li", name: "LinkedIn", h: 1350, children: [] }] } as Document;
    const r = await exportProject(DocumentSchema.parse(two) as Document, { fonts, assets, project: "prj_test1", rev: 7, now: () => new Date("2026-11-09T00:00:00Z") });
    expect(r.files.map((x) => x.path)).toEqual([
      "post.svg", "post.png", "post.jpg", "figma/post.figma-ready.svg", "figma/post.outlined.svg",
      "post-li.svg", "post-li.png", "post-li.jpg", "figma/post-li.figma-ready.svg", "figma/post-li.outlined.svg",
      "post-studio.json", "export.json",
    ]);
    const file = (p: string) => r.files.find((x) => x.path === p)!.bytes;
    expect(file("post.svg").toString()).toContain("@font-face");
    expect(file("figma/post.figma-ready.svg").toString()).not.toContain("@font-face");
    expect(file("figma/post.figma-ready.svg").toString()).toContain("<text");
    expect(file("figma/post.outlined.svg").toString()).not.toContain("<text");
    expect(JSON.parse(file("post-studio.json").toString())).toEqual(JSON.parse(JSON.stringify(two)));
    const m = JSON.parse(file("export.json").toString());
    expect([m.project, m.rev, m.exportedAt, m.frames.map((x: any) => x.stem)]).toEqual(["prj_test1", 7, "2026-11-09T00:00:00.000Z", ["post", "post-li"]]);
    expect(m.files.find((x: any) => x.path === "post.png").sha256).toBe(sha(file("post.png")));
    expect((await sharp(file("post-li.jpg")).metadata()).height).toBe(1350);
    await expect(exportProject(fixture, { fonts, assets, frames: ["nope"] })).rejects.toThrow(/frame\(s\) not found: nope/);
  });
});

describe("pixel comparison", () => {
  const img = (draw: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#fff"/>${draw}</svg>`)).png().toBuffer();
  it("reports job 239's numbers, and a shift-tolerant count that ignores 1 px moves but not real changes", async () => {
    const a = await img('<rect x="10" y="5" width="10" height="10" fill="#000"/>');
    const moved = await img('<rect x="11" y="5" width="10" height="10" fill="#000"/>');
    const gone = await img("");
    const same = await comparePng(a, a);
    expect([same.meanChannelError, same.pixelsOver, same.shiftTolerantPixelsOver]).toEqual([0, 0, 0]);
    const m = await comparePng(a, moved);
    expect(m.pixelsOver).toBe(20);
    expect(m.shiftTolerantPixelsOver).toBe(0);
    const g = await comparePng(a, gone);
    expect([g.pixelsOver, g.shiftTolerantPixelsOver, g.maxChannelError]).toEqual([100, 100, 255]); // a missing square is not a 1 px shift
    expect(g.meanChannelError).toBeCloseTo(100 / 800, 6);
  });
});

// Reference check: the live SVG in headless Chrome against our resvg PNG of the outlined SVG.
describe.skipIf(!findChrome())("headless Chrome cross-check", () => {
  it("live SVG in Chrome matches the resvg PNG (hand-written LUX-6 fixture)", async () => {
    const png = await renderPng(fixture, { fonts, assets });
    const live = renderSvg(fixture, { fonts, assets });
    const chrome = await chromeRenderSvg(live.svg, 1080, 1080, { hinting: false });
    const d = await comparePng(png.png, chrome);
    // Measured 2026-10-30: mean 0.00062, over-16 0.35 %, blurred 0.06 %. The floor is Chrome's
    // glyph gamma and image resampling (outlined SVG in Chrome vs resvg: 0.24 %).
    expect(d.meanChannelError).toBeLessThan(0.0015);
    expect(d.pixelsOverFraction).toBeLessThan(0.006);
    expect(d.blurredPixelsOverFraction).toBeLessThan(0.002);
  });
});
