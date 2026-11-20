/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Hand-drawn shapes in the editor, headless Chrome against an in-process server:
//   Desktop: select two bars → Properties → Hand-drawn on = one revision, the canvas draws the
//   sketch paths (the export's markup), Fill / Rough / Tint / Redraw write sketch options, undo
//   takes it off again; while an agent holds the lease the section is disabled.
//   Phone (S24 emulation): "Hand-drawn shapes" card → sheet → pick fill and roughness → Apply =
//   one revision on the picked shapes; the preview shows it; "plain again" removes it.
//
// SKETCH_EVIDENCE=1 keeps the screenshots in test-artifacts/bar-texture/.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { chromeEnv, findChrome, renderSvg } from "@post-studio/render";
import { DocumentSchema, findItem, SCHEMA_VERSION, type Document, type Node } from "@post-studio/schema";
import { Store, buildApp } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { EDITOR_DIST, ensureEditorBuilt } from "../build-if-stale.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EVIDENCE = !!process.env.SKETCH_EVIDENCE;
const PASSWORD = "sketch correct horse battery";
const chrome = findChrome();
const AGENT = { author: "agent:claude" };
// Same emulation as phone.e2e.test.ts (importing it would run that file's tests here too).
const S24 = { viewport: { width: 384, height: 854 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 16; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36" };

let dataDir: string;
let outDir: string;
let store: Store;
let fonts: FontRegistry;
let app: ReturnType<typeof buildApp>;
let url: string;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let project: string;
const errors: string[] = [];

function bars(): Document {
  const bar = (id: string, y: number, w: number, token: string): Node => ({ id, type: "rect", x: 345, y, w, h: 24, fill: { token } }) as Node;
  const label = (id: string, y: number, text: string): Node => ({ id, type: "text", x: 135, y: y - 6, w: 10, h: 10, box: "auto-width", align: "left", style: { font: "IBM Plex Sans", weight: 500, size: 28, fill: { token: "lux.muted" } }, spans: [{ text }] }) as Node;
  return DocumentSchema.parse({
    schema: SCHEMA_VERSION,
    id: "prj_sketche2e",
    title: "Bars",
    lang: "mk",
    brandKit: "lux",
    frames: [
      {
        id: "square",
        name: "Square",
        w: 1080,
        h: 1080,
        background: { color: { token: "lux.paper" } },
        children: [
          { id: "headline", type: "text", x: 135, y: 114, w: 10, h: 10, box: "auto-width", align: "left", style: { font: "IBM Plex Sans", weight: 600, size: 50, fill: { token: "lux.ink" } }, spans: [{ text: "Рачно нацртани столбови" }] },
          label("sol-label", 290, "GPT-6.1 Sol"),
          bar("sol-bar", 290, 467, "lux.chart-green"),
          label("opus-label", 340, "Opus 5.5"),
          bar("opus-bar", 340, 285, "lux.chart-blue"),
          label("haiku-label", 390, "Haiku 5.5"),
          bar("haiku-bar", 390, 80, "lux.chart-blue"),
        ],
      },
    ],
  }) as Document;
}

const doc = () => store.getProject(project).doc;
const head = () => store.getProject(project).head;
const sk = (id: string) => (findItem(doc(), id)!.item as any).sketch;
const shot = async (name: string) => EVIDENCE && (await page.screenshot({ path: join(outDir, `${name}.png`) }));
const saved = () => expect.poll(() => page.evaluate(() => (window as any).__postStudio.useEditor.getState().save.pending as number), { timeout: 10_000 }).toBe(0);

async function login(path: string, ready: string) {
  await page.goto(`${url}${path}`);
  await page.waitForSelector(`[data-testid="login-password"], ${ready}`, { timeout: 30_000 });
  if (await page.locator('[data-testid="login-password"]').count()) {
    await page.fill('[data-testid="login-password"]', PASSWORD);
    await page.press('[data-testid="login-password"]', "Enter");
  }
  await page.waitForSelector(ready, { timeout: 30_000 });
}

describe.skipIf(!chrome)("hand-drawn shapes in the editor", () => {
  beforeAll(async () => {
    ensureEditorBuilt(() => undefined);
    outDir = EVIDENCE ? join(ROOT, "test-artifacts/bar-texture") : mkdtempSync(join(tmpdir(), "pstudio-sketch-shots-"));
    mkdirSync(outDir, { recursive: true });
    dataDir = mkdtempSync(join(tmpdir(), "pstudio-sketch-"));
    fonts = await FontRegistry.load();
    store = new Store({ dataDir, fonts });
    store.auth.setPassword(PASSWORD);
    project = store.createProject(bars(), AGENT, "bars").project;
    app = buildApp({ store, editorDir: EDITOR_DIST });
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: chrome, env: chromeEnv() as Record<string, string>, args: ["--no-sandbox", "--font-render-hinting=none"] });
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    await login(`/p/${project}?view=desktop`, '[data-testid="editor"]');
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    store?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (!EVIDENCE && outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("desktop: two bars → Hand-drawn on is one revision, the canvas draws the export's sketch, undo removes it", async () => {
    await page.click('[data-testid="layer-sol-bar"]');
    await page.click('[data-testid="layer-opus-bar"]', { modifiers: ["Shift"] });
    await page.waitForSelector('[data-testid="sketch-section"]');
    expect(await page.textContent('[data-testid="sketch-section"]')).toMatch(/Hand-drawn \(0 of 2\)/);
    const rev = head();
    await page.check('[data-testid="prop-sketch"]');
    await saved();
    expect(head()).toBe(rev + 1);
    expect(sk("sol-bar")).toEqual({ fill: "hachure" });
    expect(sk("opus-bar")).toEqual({ fill: "hachure" });
    expect(sk("haiku-bar")).toBeUndefined();
    // The canvas shows exactly the renderer's markup for that layer (same as the export).
    const want = renderSvg(doc(), { fonts, assets: () => undefined }).svg;
    const onCanvas = await page.evaluate(() => document.querySelector('[data-frame="square"] g#sol-bar')?.outerHTML ?? "");
    expect(onCanvas).toMatch(/^<g id="sol-bar"><path d="M/);
    const ds = (markup: string) => [...markup.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    const exported = /<g id="sol-bar">.*?<\/g>/s.exec(want)![0];
    expect(ds(onCanvas).length).toBeGreaterThanOrEqual(3); // tint, hatch, edge
    expect(ds(onCanvas)).toEqual(ds(exported));
    await shot("01-desktop-on");

    // Options: cross-hatch, rougher, no tint, redraw.
    await page.click('[data-testid="sketch-fill-cross-hatch"]');
    await saved();
    expect(sk("sol-bar").fill).toBe("cross-hatch");
    await page.fill('[data-testid="sketch-tint"]', "0");
    await page.press('[data-testid="sketch-tint"]', "Enter");
    await saved();
    expect(sk("opus-bar").tint).toBe(0);
    await page.locator('[data-testid="sketch-roughness"]').fill("2.5");
    await saved();
    expect(sk("sol-bar").roughness).toBe(2.5);
    const before = await page.evaluate(() => document.querySelector('[data-frame="square"] g#sol-bar')?.outerHTML);
    await page.click('[data-testid="sketch-reseed"]');
    await saved();
    expect(typeof sk("sol-bar").seed).toBe("number");
    await expect.poll(() => page.evaluate(() => document.querySelector('[data-frame="square"] g#sol-bar')?.outerHTML)).not.toBe(before);
    await shot("02-desktop-options");

    // Undo back to before "on" (one step per change), then redo once.
    for (let i = 0; i < 5; i++) await page.keyboard.press("Control+z");
    await saved();
    expect(sk("sol-bar")).toBeUndefined();
    expect(await page.evaluate(() => document.querySelector('[data-frame="square"] rect#sol-bar') !== null)).toBe(true);
    await page.keyboard.press("Control+Shift+z");
    await saved();
    expect(sk("sol-bar")).toEqual({ fill: "hachure" });
    expect(errors).toEqual([]);
  }, 90_000);

  it("desktop: while an agent holds the lease the section is read-only", async () => {
    store.handoff(project, { author: "human" }, "check the bars");
    store.takeLease(project, AGENT);
    await expect.poll(() => page.locator('[data-testid="banner"].lease').count(), { timeout: 10_000 }).toBe(1);
    await page.click('[data-testid="layer-haiku-bar"]');
    await page.waitForSelector('[data-testid="sketch-section"]');
    expect(await page.locator('[data-testid="prop-sketch"]').isDisabled()).toBe(true);
    store.handBack(project, AGENT, "nothing changed");
    await expect.poll(() => page.locator('[data-testid="banner"].lease').count(), { timeout: 10_000 }).toBe(0);
  }, 60_000);

  it("phone: the card opens the sheet; Apply makes the picked shapes hand-drawn in one revision; plain again removes it", async () => {
    await ctx.close();
    ctx = await browser.newContext(S24);
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await login(`/p/${project}`, '[data-testid="phone-project"]');
    await page.waitForSelector('[data-testid="phone-sketch"]');
    expect(await page.textContent('[data-testid="sketch-count"]')).toMatch(/2 of 3 shapes on Square are hand-drawn/); // both bars again after the redo
    await page.tap('[data-testid="sketch-open"]');
    await page.waitForSelector('[data-testid="sketch-sheet"]');
    // Starts with the hand-drawn ones picked: pick all.
    await page.tap('[data-testid="sketch-pick-all"]');
    await page.tap('[data-testid="sketch-fill-solid"]');
    await page.locator('[data-testid="sketch-roughness"]').fill("2");
    await shot("03-phone-sheet");
    const rev = head();
    await page.tap('[data-testid="sketch-apply"]');
    await page.waitForSelector('[data-testid="sketch-sheet"]', { state: "detached" });
    await saved();
    expect(head()).toBe(rev + 1);
    for (const id of ["sol-bar", "opus-bar", "haiku-bar"]) expect(sk(id)).toMatchObject({ fill: "solid", roughness: 2 });
    await expect.poll(() => page.evaluate(() => !!document.querySelector('svg[data-phone-frame="square"] g#haiku-bar path'))).toBe(true);
    expect(await page.textContent('[data-testid="sketch-count"]')).toMatch(/3 of 3/);
    await shot("04-phone-applied");

    await page.tap('[data-testid="sketch-open"]');
    await page.waitForSelector('[data-testid="sketch-sheet"]');
    await page.tap('[data-testid="sketch-off"]');
    await page.waitForSelector('[data-testid="sketch-sheet"]', { state: "detached" });
    await saved();
    for (const id of ["sol-bar", "opus-bar", "haiku-bar"]) expect(sk(id)).toBeUndefined();
    expect(errors).toEqual([]);
  }, 90_000);
});
