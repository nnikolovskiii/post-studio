/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// "+ Frame" and "Duplicate frame" in the Layers panel (job 881). Headless Chrome against an
// in-process server with a three-frame carousel like his ("1 · Насловна", "2 · Разликата",
// "3 · Грешки"):
//   + Frame (Layers header) → "4 · Frame 4" at the end, same size / background / guides as the
//   active frame, active and on screen, saved as one revision; Ctrl+Z removes it (server too).
//   Right-click a frame row → Duplicate frame → a copy right after it, all layers, fresh ids;
//   ⋯ on the row opens the same menu; undo removes it.
//   Agent lease → the button and the menu are disabled and nothing is written.
//   Motion project → + Frame works, motion stays, the new frame has no keyframes.
//
// FRAMES_EVIDENCE=1 keeps the screenshots in test-artifacts/add-frame/.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { chromeEnv, findChrome } from "@post-studio/render";
import { walk, type Document } from "@post-studio/schema";
import { Store, buildApp } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { EDITOR_DIST, ensureEditorBuilt } from "../build-if-stale.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EVIDENCE = !!process.env.FRAMES_EVIDENCE;
const PASSWORD = "frames correct horse battery";
const chrome = findChrome();
const AGENT = { author: "agent:claude" };

let dataDir: string;
let outDir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
let url: string;
let browser: Browser;
let page: Page;
let project: string;
const errors: string[] = [];

function carousel(): Document {
  const d = JSON.parse(readFileSync(join(ROOT, "fixtures/lux-6-square.hand.json"), "utf8")) as Document;
  const li = { w: 1080, h: 1350, background: { color: "#84A493" }, guides: "lane/li-1350" };
  d.title = "Carousel";
  d.frames = [
    { id: "s1", name: "1 · Насловна", ...li, children: d.frames[0].children.filter((n) => n.type !== "image" && n.type !== "svg") },
    { id: "s2", name: "2 · Разликата", ...li, children: [] },
    { id: "s3", name: "3 · Грешки", ...li, children: [] },
  ];
  return d;
}

const doc = () => store.getProject(project).doc;
const head = () => store.getProject(project).head;
const frameIds = () => doc().frames.map((f) => f.id);
const shot = async (name: string) => EVIDENCE && (await page.screenshot({ path: join(outDir, `${name}.png`) }));
const state = () =>
  page.evaluate(() => {
    const s = (window as any).__postStudio.useEditor.getState();
    return { activeFrame: s.activeFrame as string, frames: s.doc.frames.map((f: any) => f.id) as string[], pending: s.save.pending as number, status: s.save.status as string };
  });
const saved = () => expect.poll(async () => (await state()).pending, { timeout: 10_000 }).toBe(0);

async function openProject(id: string) {
  await page.goto(`${url}/p/${id}`);
  await page.waitForSelector('[data-testid="login-password"], [data-testid="editor"]', { timeout: 30_000 });
  if (await page.locator('[data-testid="login-password"]').count()) {
    await page.fill('[data-testid="login-password"]', PASSWORD);
    await page.press('[data-testid="login-password"]', "Enter");
  }
  await page.waitForSelector('[data-testid="editor"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="add-frame"]');
}

describe.skipIf(!chrome)("Layers panel: + Frame and Duplicate frame", () => {
  beforeAll(async () => {
    ensureEditorBuilt(() => undefined);
    outDir = EVIDENCE ? join(ROOT, "test-artifacts/add-frame") : mkdtempSync(join(tmpdir(), "pstudio-frames-shots-"));
    mkdirSync(outDir, { recursive: true });
    dataDir = mkdtempSync(join(tmpdir(), "pstudio-frames-"));
    store = new Store({ dataDir, fonts: await FontRegistry.load() });
    store.auth.setPassword(PASSWORD);
    project = store.createProject(carousel(), AGENT, "carousel").project;
    app = buildApp({ store, editorDir: EDITOR_DIST });
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: chrome, env: chromeEnv() as Record<string, string>, args: ["--no-sandbox", "--font-render-hinting=none"] });
    page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    page.on("dialog", (d) => void d.accept());
    await openProject(project);
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    store?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (!EVIDENCE && outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("+ Frame adds '4 · Frame 4' like the active frame, activates and shows it; undo removes it", async () => {
    await shot("01-before");
    // Make the last frame active by clicking its row, then add.
    await page.click('[data-testid="frame-row-s3"]');
    const rev0 = head();
    await page.click('[data-testid="add-frame"]');
    await saved();
    expect(frameIds()).toEqual(["s1", "s2", "s3", "s4"]);
    expect(head()).toBe(rev0 + 1);
    expect(doc().frames[3]).toEqual({ id: "s4", name: "4 · Frame 4", w: 1080, h: 1350, background: { color: "#84A493" }, guides: "lane/li-1350", children: [] });
    expect((await state()).activeFrame).toBe("s4");
    expect(await page.locator('[data-testid="frame-row-s4"].selected').count()).toBe(1);
    expect(await page.textContent('[data-testid="frame-row-s4"]')).toMatch(/4 · Frame 4\s*1080×1350/);
    // The new frame is on screen: its frame element lies inside the canvas.
    const box = await page.evaluate(() => {
      const c = document.querySelector(".canvas")!.getBoundingClientRect();
      const s = (window as any).__postStudio.useEditor.getState();
      let x = 0;
      for (const f of s.doc.frames) {
        if (f.id === "s4") break;
        x += f.w + 160;
      }
      const v = s.view;
      return { left: v.x + x * v.zoom, top: v.y, right: v.x + (x + 1080) * v.zoom, bottom: v.y + 1350 * v.zoom, w: c.width, h: c.height };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.w);
    expect(box.bottom).toBeLessThanOrEqual(box.h);
    await shot("02-added");
    // Undo = one step = the frame is gone, locally and on the server.
    await page.keyboard.press("Control+z");
    await saved();
    expect(frameIds()).toEqual(["s1", "s2", "s3"]);
    expect((await state()).frames).toEqual(["s1", "s2", "s3"]);
    // Redo brings it back; undo again for a clean slate.
    await page.keyboard.press("Control+Shift+z");
    await saved();
    expect(frameIds()).toEqual(["s1", "s2", "s3", "s4"]);
    await page.keyboard.press("Control+z");
    await saved();
    expect(frameIds()).toEqual(["s1", "s2", "s3"]);
  }, 60_000);

  it("Right-click → Duplicate frame copies all layers right after it with fresh ids; ⋯ opens the same menu; undo removes it", async () => {
    await page.click('[data-testid="frame-row-s1"]', { button: "right" });
    await page.waitForSelector('[data-testid="frame-menu"]');
    await shot("03-menu");
    await page.click('[data-testid="frame-duplicate"]');
    await saved();
    expect(await page.locator('[data-testid="frame-menu"]').count()).toBe(0);
    expect(frameIds()).toEqual(["s1", "s1-copy", "s2", "s3"]);
    const d = doc();
    const src = d.frames[0];
    const copy = d.frames[1];
    expect(copy).toMatchObject({ name: "1 · Насловна (copy)", w: 1080, h: 1350, background: { color: "#84A493" } });
    expect(copy.children.length).toBe(src.children.length);
    expect(copy.children.length).toBeGreaterThan(3);
    const all = [...walk(d)].map((l) => l.id);
    expect(new Set(all).size).toBe(all.length);
    expect((await state()).activeFrame).toBe("s1-copy");
    // The copy's text reads the same as the original.
    const texts = (f: typeof src) => f.children.flatMap((n) => (n.type === "text" ? [n.spans.map((s) => s.text).join("")] : []));
    expect(texts(copy)).toEqual(texts(src));
    await shot("04-duplicated");
    await page.keyboard.press("Control+z");
    await saved();
    expect(frameIds()).toEqual(["s1", "s2", "s3"]);

    // The ⋯ button on the row opens the same menu; Escape closes it.
    await page.hover('[data-testid="frame-row-s2"]');
    await page.click('[data-testid="frame-menu-s2"]');
    await page.waitForSelector('[data-testid="frame-menu"]');
    await page.keyboard.press("Escape");
    expect(await page.locator('[data-testid="frame-menu"]').count()).toBe(0);
    expect(frameIds()).toEqual(["s1", "s2", "s3"]);
  }, 60_000);

  it("while an agent holds the lease: + Frame and the menu are disabled, nothing is written", async () => {
    store.handoff(project, { author: "human" }, "check the slides");
    store.takeLease(project, AGENT);
    await expect.poll(() => page.locator('[data-testid="banner"].lease').count(), { timeout: 10_000 }).toBe(1);
    const rev = head();
    expect(await page.locator('[data-testid="add-frame"]').isDisabled()).toBe(true);
    await page.click('[data-testid="frame-row-s1"]', { button: "right" });
    await page.waitForSelector('[data-testid="frame-menu"]');
    expect(await page.locator('[data-testid="frame-duplicate"]').isDisabled()).toBe(true);
    expect(await page.locator('[data-testid="frame-remove"]').isDisabled()).toBe(true);
    await shot("05-read-only");
    await page.keyboard.press("Escape");
    // Even if called directly, the store refuses (same read-only rule as every edit).
    expect(await page.evaluate(() => (window as any).__postStudio.useEditor.getState().doc.frames.length)).toBe(3);
    await page.waitForTimeout(500);
    expect(head()).toBe(rev);
    store.handBack(project, AGENT, "nothing changed");
    await expect.poll(() => page.locator('[data-testid="banner"].lease').count(), { timeout: 10_000 }).toBe(0);
    expect(await page.locator('[data-testid="add-frame"]').isDisabled()).toBe(false);
  }, 60_000);

  it("motion project: + Frame keeps the motion, the new frame has no keyframes", async () => {
    store.applyOps(project, { base: head(), ops: [{ op: "set", node: "$doc", path: "motion", value: { duration: 3000, fps: 30 } }], message: "add motion" }, { author: "human" });
    await openProject(project);
    await page.click('[data-testid="frame-row-s2"]');
    await page.click('[data-testid="add-frame"]');
    await saved();
    const d = doc();
    expect(d.motion).toEqual({ duration: 3000, fps: 30 });
    expect(d.frames.map((f) => f.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(d.frames[3]).toMatchObject({ name: "4 · Frame 4", children: [] });
    await shot("06-motion");
  }, 60_000);

  it("produced no browser errors", () => {
    expect(errors).toEqual([]);
  });
});
