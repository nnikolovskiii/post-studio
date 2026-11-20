/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Editing several selected layers at once (Figma-style shared properties), headless Chrome against
// an in-process server:
//   Desktop: three labels → "3 layers", Size shows Mixed → 36 = one revision on all three (their
//   boxes follow), Ctrl+Z undoes all three in one step; text colour from the kit swatch; a bar →
//   "Select all: same type" → three bars, Fill Mixed → one colour for all; align right edges;
//   mixed text + bar → "Fill and text colour" and the type chips narrow the selection; read-only
//   while an agent holds the lease.
//   Phone (S24 emulation): "Edit several at once" → Point → tap two bars → Edit → Mixed fill →
//   "+ all of this type" → a kit colour and opacity → Apply = one revision on all three bars.
//
// MULTI_EVIDENCE=1 keeps the screenshots in test-artifacts/multi-select-edit/.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { chromeEnv, findChrome } from "@post-studio/render";
import { DocumentSchema, findItem, SCHEMA_VERSION, type Document, type Node } from "@post-studio/schema";
import { Store, buildApp } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { EDITOR_DIST, ensureEditorBuilt } from "../build-if-stale.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EVIDENCE = !!process.env.MULTI_EVIDENCE;
const PASSWORD = "multi correct horse battery";
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

function chart(): Document {
  const bar = (id: string, y: number, w: number, token: string): Node => ({ id, type: "rect", x: 345, y, w, h: 36, fill: { token } }) as Node;
  const label = (id: string, y: number, text: string, size = 28): Node => ({ id, type: "text", x: 135, y: y - 2, w: 10, h: 10, box: "auto-width", align: "left", style: { font: "IBM Plex Sans", weight: 500, size, fill: { token: "lux.muted" } }, spans: [{ text }] }) as Node;
  return DocumentSchema.parse({
    schema: SCHEMA_VERSION,
    id: "prj_multie2e",
    title: "Several at once",
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
          { id: "headline", type: "text", x: 135, y: 114, w: 10, h: 10, box: "auto-width", align: "left", style: { font: "IBM Plex Sans", weight: 600, size: 50, fill: { token: "lux.ink" } }, spans: [{ text: "Повеќе одеднаш" }] },
          label("sol-label", 300, "GPT-6.1 Sol"),
          bar("sol-bar", 300, 467, "lux.chart-green"),
          label("opus-label", 380, "Opus 5.5"),
          bar("opus-bar", 380, 285, "lux.chart-blue"),
          label("haiku-label", 460, "Haiku 5.5", 30),
          bar("haiku-bar", 460, 120, "lux.chart-blue"),
        ],
      },
    ],
  }) as Document;
}

const doc = () => store.getProject(project).doc;
const head = () => store.getProject(project).head;
const node = (id: string) => findItem(doc(), id)!.item as any;
const shot = async (name: string) => EVIDENCE && (await page.screenshot({ path: join(outDir, `${name}.png`) }));
const saved = () => expect.poll(() => page.evaluate(() => (window as any).__postStudio.useEditor.getState().save.pending as number), { timeout: 10_000 }).toBe(0);
const selection = () => page.evaluate(() => (window as any).__postStudio.useEditor.getState().selection as string[]);

async function login(path: string, ready: string) {
  await page.goto(`${url}${path}`);
  await page.waitForSelector(`[data-testid="login-password"], ${ready}`, { timeout: 30_000 });
  if (await page.locator('[data-testid="login-password"]').count()) {
    await page.fill('[data-testid="login-password"]', PASSWORD);
    await page.press('[data-testid="login-password"]', "Enter");
  }
  await page.waitForSelector(ready, { timeout: 30_000 });
}

async function pick(...ids: string[]) {
  await page.click(`[data-testid="layer-${ids[0]}"]`);
  for (const id of ids.slice(1)) await page.click(`[data-testid="layer-${id}"]`, { modifiers: ["Shift"] });
  await expect.poll(selection).toEqual(ids);
}

describe.skipIf(!chrome)("editing several selected layers at once", () => {
  beforeAll(async () => {
    ensureEditorBuilt(() => undefined);
    outDir = EVIDENCE ? join(ROOT, "test-artifacts/multi-select-edit") : mkdtempSync(join(tmpdir(), "pstudio-multi-shots-"));
    mkdirSync(outDir, { recursive: true });
    dataDir = mkdtempSync(join(tmpdir(), "pstudio-multi-"));
    fonts = await FontRegistry.load();
    store = new Store({ dataDir, fonts });
    store.auth.setPassword(PASSWORD);
    project = store.createProject(chart(), AGENT, "chart").project;
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

  it("desktop: three labels → Size Mixed → one value for all = one revision, one Ctrl+Z", async () => {
    await pick("sol-label", "opus-label", "haiku-label");
    await page.waitForSelector('[data-testid="multi-text"]');
    expect(await page.textContent('[data-testid="multi-title"]')).toBe("3 layers");
    expect(await page.getAttribute('[data-testid="multi-size"]', "data-mixed")).toBe("true");
    expect(await page.getAttribute('[data-testid="multi-size"]', "placeholder")).toBe("Mixed");
    expect(await page.inputValue('[data-testid="multi-font"]')).toBe("IBM Plex Sans"); // same font: no Mixed
    await shot("01-desktop-three-labels");
    const widths = ["sol-label", "opus-label", "haiku-label"].map((id) => node(id).w);
    const rev = head();
    await page.fill('[data-testid="multi-size"]', "36");
    await page.press('[data-testid="multi-size"]', "Enter");
    await saved();
    expect(head()).toBe(rev + 1);
    expect(["sol-label", "opus-label", "haiku-label"].map((id) => node(id).style.size)).toEqual([36, 36, 36]);
    ["sol-label", "opus-label", "haiku-label"].forEach((id, i) => expect(node(id).w).toBeGreaterThan(widths[i])); // boxes follow the text
    await expect.poll(() => page.getAttribute('[data-testid="multi-size"]', "data-mixed")).toBe(null);
    expect(await page.inputValue('[data-testid="multi-size"]')).toBe("36");

    // One Ctrl+Z puts all three back (each to its own size).
    await page.click('[data-testid="canvas"]', { position: { x: 5, y: 5 } }).catch(() => undefined);
    await pick("sol-label", "opus-label", "haiku-label");
    await page.keyboard.press("Control+z");
    await saved();
    expect(["sol-label", "opus-label", "haiku-label"].map((id) => node(id).style.size)).toEqual([28, 28, 30]);

    // Text colour from the kit swatch: one revision on all three.
    const r2 = head();
    await page.click('[data-testid="multi-text-fill-kit"] [data-token="lux.ink"]');
    await saved();
    expect(head()).toBe(r2 + 1);
    for (const id of ["sol-label", "opus-label", "haiku-label"]) expect(node(id).style.fill).toEqual({ token: "lux.ink" });
    expect(errors).toEqual([]);
  }, 90_000);

  it("desktop: Select all → same type, Fill Mixed → one colour on all bars, align right edges", async () => {
    await page.click('[data-testid="layer-opus-bar"]');
    await page.waitForSelector('[data-testid="match-type"]');
    expect(await page.textContent('[data-testid="match-type"]')).toBe("same type (3)");
    expect(await page.textContent('[data-testid="match-fill"]')).toBe("same colour (2)"); // opus + haiku are chart-blue
    await page.click('[data-testid="match-type"]');
    await expect.poll(selection).toEqual(["opus-bar", "sol-bar", "haiku-bar"]);
    expect(await page.getAttribute('[data-testid="multi-fill"]', "data-testid")).toBe("multi-fill");
    expect(await page.locator('.color-block[data-mixed="true"] [data-testid="multi-fill"]').count()).toBe(1);
    expect(await page.locator('[data-testid="mixed-swatches"] .kit-swatch').count()).toBe(2);
    await shot("02-desktop-bars-mixed-fill");
    const rev = head();
    await page.click('[data-testid="multi-fill-kit"] [data-token="lux.mark"]');
    await saved();
    expect(head()).toBe(rev + 1);
    for (const id of ["sol-bar", "opus-bar", "haiku-bar"]) expect(node(id).fill).toEqual({ token: "lux.mark" });

    await page.click('[data-testid="align-obj-right"]');
    await saved();
    const right = ["sol-bar", "opus-bar", "haiku-bar"].map((id) => node(id).x + node(id).w);
    expect(new Set(right).size).toBe(1);
    expect(head()).toBe(rev + 2);
    await shot("03-desktop-aligned");
    expect(errors).toEqual([]);
  }, 60_000);

  it("desktop: a label and a bar share 'Fill and text colour'; the type chip narrows the selection", async () => {
    await pick("sol-label", "sol-bar");
    await page.waitForSelector('[data-testid="multi-types"]');
    expect(await page.locator('[data-testid="multi-text"]').count()).toBe(0); // not all texts: no text section
    expect(await page.textContent('[data-testid="props"]')).toMatch(/Fill and text colour/);
    const rev = head();
    await page.fill('[data-testid="multi-fill-text"]', "#190F0B");
    await page.press('[data-testid="multi-fill-text"]', "Enter");
    await saved();
    expect(head()).toBe(rev + 1);
    expect([node("sol-label").style.fill, node("sol-bar").fill]).toEqual(["#190F0B", "#190F0B"]);
    await page.click('[data-testid="select-type-text"]');
    await expect.poll(selection).toEqual(["sol-label"]);
    expect(errors).toEqual([]);
  }, 60_000);

  it("desktop: read-only while an agent holds the lease", async () => {
    store.handoff(project, { author: "human" }, "check the chart");
    store.takeLease(project, AGENT);
    await expect.poll(() => page.locator('[data-testid="banner"].lease').count(), { timeout: 10_000 }).toBe(1);
    await pick("sol-label", "opus-label");
    expect(await page.locator('[data-testid="multi-size"]').isDisabled()).toBe(true);
    expect(await page.locator('[data-testid="align-obj-left"]').isDisabled()).toBe(true);
    store.handBack(project, AGENT, "nothing changed");
    await expect.poll(() => page.locator('[data-testid="banner"].lease').count(), { timeout: 10_000 }).toBe(0);
  }, 60_000);

  it("phone: Point → two bars → Edit → + all of this type → colour and opacity → Apply = one revision", async () => {
    await ctx.close();
    ctx = await browser.newContext(S24);
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await login(`/p/${project}`, '[data-testid="phone-project"]');
    // Start from different colours again so the sheet shows Mixed.
    store.applyOps(project, { base: head(), ops: [{ op: "set", node: "sol-bar", path: "fill", value: { token: "lux.chart-green" } }], message: "green again" }, { author: "human" });
    await page.reload();
    await page.waitForSelector('[data-testid="phone-together"]');
    await page.tap('[data-testid="together-open"]');
    await page.waitForSelector('[data-testid="point-bar"]');
    const centre = (id: string) =>
      page.evaluate((nid) => {
        const r = document.querySelector(`svg[data-phone-frame="square"] [id="${nid}"]`)!.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, id);
    await page.evaluate(() => scrollTo(0, 0));
    for (const id of ["sol-bar", "opus-bar"]) {
      const p = await centre(id);
      await page.touchscreen.tap(p.x, p.y);
      await page.waitForSelector(`[data-pointed="${id}"]`);
    }
    await shot("04-phone-picked");
    await page.tap('[data-testid="point-edit"]');
    await page.waitForSelector('[data-testid="together-sheet"]');
    expect(await page.textContent('[data-testid="together-fill-value"]')).toBe("Mixed");
    expect(await page.textContent('[data-testid="together-types"]')).toMatch(/^2 rectangles\./);
    await page.tap('[data-testid="together-match-type"]');
    await expect.poll(() => page.textContent('[data-testid="together-types"]')).toMatch(/^3 rectangles\./);
    await page.tap('[data-testid="together-fill"] [data-token="lux.ink"]');
    expect(await page.textContent('[data-testid="together-fill-value"]')).toBe("lux.ink");
    await page.locator('[data-testid="together-opacity"]').fill("60");
    await shot("05-phone-sheet");
    const rev = head();
    await page.tap('[data-testid="together-apply"]');
    await page.waitForSelector('[data-testid="together-sheet"]', { state: "detached" });
    await saved();
    expect(head()).toBe(rev + 1);
    for (const id of ["sol-bar", "opus-bar", "haiku-bar"]) expect([node(id).fill, node(id).opacity]).toEqual([{ token: "lux.ink" }, 0.6]);
    expect(store.revisions(project).at(-1)?.message).toMatch(/fill lux\.ink, opacity 60% on 3 layers/);
    await shot("06-phone-applied");
    expect(errors).toEqual([]);
  }, 90_000);

  it("phone: two labels → Edit → Size Mixed → 34 and weight → Apply = one revision, boxes follow", async () => {
    await page.tap('[data-testid="point-clear"]');
    const centre = (id: string) =>
      page.evaluate((nid) => {
        const r = document.querySelector(`svg[data-phone-frame="square"] [id="${nid}"]`)!.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, id);
    await page.evaluate(() => scrollTo(0, 0));
    for (const id of ["opus-label", "haiku-label"]) {
      const p = await centre(id);
      await page.touchscreen.tap(p.x, p.y);
      await page.waitForSelector(`[data-pointed="${id}"]`);
    }
    await page.tap('[data-testid="point-edit"]');
    await page.waitForSelector('[data-testid="together-sheet"]');
    expect(await page.textContent('[data-testid="together-types"]')).toMatch(/^2 texts\./);
    expect(await page.getAttribute('[data-testid="together-size-input"]', "placeholder")).toBe("Mixed");
    expect(await page.locator('[data-testid="together-size-up"]').isDisabled()).toBe(true); // nothing to step from while Mixed
    await page.fill('[data-testid="together-size-input"]', "34");
    await page.tap('[data-testid="together-size-up"]'); // 36
    await page.selectOption('[data-testid="together-weight"]', "600");
    await page.tap('[data-testid="together-align-right"]');
    await shot("07-phone-texts");
    const w = node("opus-label").w;
    const rev = head();
    await page.tap('[data-testid="together-apply"]');
    await page.waitForSelector('[data-testid="together-sheet"]', { state: "detached" });
    await saved();
    expect(head()).toBe(rev + 1);
    for (const id of ["opus-label", "haiku-label"]) expect([node(id).style.size, node(id).style.weight, node(id).align]).toEqual([36, 600, "right"]);
    expect(node("opus-label").w).toBeGreaterThan(w);
    expect(node("sol-label").style.size).toBe(28); // not picked
    expect(errors).toEqual([]);
  }, 90_000);
});
