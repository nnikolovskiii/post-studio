/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Phase 8 extra: "Hand to agent" points at elements and starts an agent job by itself.
// Headless Chrome against an in-process server with the imported LUX-6. The host dispatcher is
// played through the server store (the same calls its /v1/dispatch/* routes make).
//
//   desktop (1440 × 900): select two layers → Hand to agent shows a chip per layer → ✕ drops one →
//   send → the server stores the focus → banner follows the dispatch (offline, starting, failed +
//   Retry, job #N started) → the lease banner takes over. Nothing selected → no chips.
//   phone (S24, touch): ◎ Point → tap the headline and a chart element (numbered outlines) → tap
//   again drops one → Hand to agent sheet with removable chips → send → banner; tap-to-edit text
//   still works outside point mode; Retry on the phone banner.
//
// HANDOFF_EVIDENCE=1 keeps the screenshots in test-artifacts/phase8-handoff/.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { importSocialPost } from "@post-studio/import";
import { chromeEnv, findChrome } from "@post-studio/render";
import { Store, buildApp } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { EDITOR_DIST, ensureEditorBuilt } from "../build-if-stale.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EVIDENCE = !!process.env.HANDOFF_EVIDENCE;
const PASSWORD = "handoff correct horse battery";
const chrome = findChrome();
// Same emulation as phone.e2e.test.ts (importing it would run that file's tests here too).
const S24 = { viewport: { width: 384, height: 854 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 16; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36" };
const AGENT = { author: "agent:claude" };
const HUMAN = { author: "human" };

let dataDir: string;
let outDir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
let url: string;
let browser: Browser;
let project: string;
const errors: string[] = [];

async function open(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${url}/p/${project}`);
  await page.waitForSelector('[data-testid="login-password"]');
  await page.fill('[data-testid="login-password"]', PASSWORD);
  await page.press('[data-testid="login-password"]', "Enter");
  return page;
}

const dispatchText = (page: Page) => page.textContent('[data-testid="dispatch-status"]');
const resetTurn = () => {
  const h = store.handoffState(project);
  if (h.lease) store.releaseLease(project, AGENT);
  if (h.turn === "agent") store.takeBack(project, HUMAN);
};

describe.skipIf(!chrome)("hand-off: pointing at elements and the auto-start banner", () => {
  beforeAll(async () => {
    ensureEditorBuilt(() => undefined);
    outDir = EVIDENCE ? join(ROOT, "test-artifacts/phase8-handoff") : mkdtempSync(join(tmpdir(), "pstudio-handoff-shots-"));
    mkdirSync(outDir, { recursive: true });
    dataDir = mkdtempSync(join(tmpdir(), "pstudio-handoff-"));
    store = new Store({ dataDir, fonts: await FontRegistry.load() });
    store.auth.setPassword(PASSWORD);
    const { doc } = await importSocialPost(join(ROOT, "fixtures/social-posts/lux-6-judge-compare"), {
      fonts: store.fonts,
      upload: async (b: Uint8Array, name: string) => store.addAsset(b, AGENT, name),
    });
    project = store.createProject(doc, AGENT, "import LUX-6").project;
    store.handBack(project, AGENT, "first draft");
    app = buildApp({ store, editorDir: EDITOR_DIST });
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: chrome, env: chromeEnv() as Record<string, string>, args: ["--no-sandbox", "--font-render-hinting=none"] });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    store?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (!EVIDENCE && outDir) rmSync(outDir, { recursive: true, force: true });
    expect(errors).toEqual([]);
  });

  it("desktop: the selection becomes removable chips, the focus is stored, the banner follows the dispatch", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await open(ctx);
    await page.waitForSelector('[data-testid="editor"]', { timeout: 30_000 });
    await page.waitForSelector('[data-testid="handoff"]');

    // Nothing selected → no chips (same dialog as before).
    await page.evaluate(() => (window as any).__postStudio.useEditor.setState({ selection: [] }));
    await page.click('[data-testid="handoff"]');
    await page.waitForSelector('[data-testid="handoff-dialog"]');
    expect(await page.locator('[data-testid="focus-chips"]').count()).toBe(0);
    await page.click('[data-testid="handoff-dialog"] >> text=Cancel');

    // Two layers selected → two chips; ✕ drops one.
    await page.evaluate(() => (window as any).__postStudio.useEditor.setState({ selection: ["headline", "sub"] }));
    await page.click('[data-testid="handoff"]');
    await page.waitForSelector('[data-testid="focus-chips"]');
    expect(await page.locator(".chip.focus").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.focus))).toEqual(["headline", "sub"]);
    expect(await page.textContent('[data-testid="focus-chips"]')).toMatch(/Pointing at:.*Исти/);
    await page.screenshot({ path: join(outDir, "01-desktop-chips.png") });
    await page.click('[data-testid="focus-remove-sub"]');
    expect(await page.locator(".chip.focus").count()).toBe(1);
    await page.fill('[data-testid="handoff-note"]', "make this one line");
    await page.click('[data-testid="handoff-send"]');
    await expect.poll(() => store.handoffState(project).turn, { timeout: 10_000 }).toBe("agent");
    const h = store.handoffState(project);
    expect(h.handoff).toMatchObject({ note: "make this one line", focus: [{ id: "headline", type: "text", frame: "square" }] });
    expect(h.dispatch).toMatchObject({ state: "pending" });

    // The dispatcher has never polled: the banner says auto-start is not running.
    await page.waitForSelector('[data-testid="banner"][data-dispatch="pending"]');
    expect(await page.textContent('[data-testid="banner"]')).toMatch(/pointing at 1 element/);
    expect(await dispatchText(page)).toMatch(/Auto-start is not running/);
    store.dispatchPoll({ enabled: true, instance: "e2e" });
    await expect.poll(() => dispatchText(page), { timeout: 10_000 }).toMatch(/Starting an agent job/);
    store.dispatchClaim(project, "handoff-1", "e2e");
    store.dispatchFailed(project, "handoff-1", "sessions.py start exited 1: queue database is locked");
    await page.waitForSelector('[data-testid="banner"][data-dispatch="failed"]', { timeout: 10_000 });
    expect(await dispatchText(page)).toMatch(/Couldn't start the agent: sessions\.py start exited 1/);
    await page.screenshot({ path: join(outDir, "02-desktop-failed.png") });
    await page.click('[data-testid="retry-dispatch"]');
    await expect.poll(() => store.handoffState(project).dispatch?.state, { timeout: 10_000 }).toBe("pending");
    store.dispatchPoll({ enabled: true, instance: "e2e" });
    store.dispatchClaim(project, "handoff-1", "e2e");
    store.dispatchStarted(project, "handoff-1", 901, "running");
    await expect.poll(() => dispatchText(page), { timeout: 10_000 }).toMatch(/Agent job #901 started/);
    await page.screenshot({ path: join(outDir, "03-desktop-started.png") });
    // The worker takes the lease: the existing lease banner takes over.
    store.takeLease(project, AGENT);
    await page.waitForSelector('[data-testid="banner"].lease', { timeout: 10_000 });
    store.handBack(project, AGENT, "headline on one line");
    await expect.poll(() => page.locator('[data-testid="banner"]').count(), { timeout: 10_000 }).toBe(0);
    await ctx.close();
  }, 120_000);

  it("phone: point mode picks elements, the sheet shows removable chips, text taps still edit", async () => {
    resetTurn();
    const ctx = await browser.newContext(S24);
    const page = await open(ctx);
    await page.waitForSelector('svg[data-phone-frame="square"] [data-frame="square"]', { timeout: 30_000 });
    await page.evaluate(() => scrollTo(0, 0));
    const centre = (id: string) =>
      page.evaluate((nid) => {
        const r = document.querySelector(`svg[data-phone-frame="square"] [id="${nid}"]`)!.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, id);

    // Outside point mode a tap on the headline still opens the text editor.
    let p = await centre("headline");
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForSelector('[data-testid="text-input"]');
    await page.tap('[data-testid="sheet-close"]');
    await expect.poll(() => page.locator('[data-testid="text-input"]').count()).toBe(0);

    await page.tap('[data-testid="point-mode"]');
    await page.waitForSelector('[data-testid="point-bar"]');
    expect(await page.getAttribute('[data-testid="point-mode"]', "aria-pressed")).toBe("true");
    p = await centre("headline");
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForSelector('[data-pointed="headline"]');
    expect(await page.locator('[data-testid="text-input"]').count()).toBe(0); // no text sheet in point mode
    // A non-text element inside a group (e.g. a chart bar): a visible, unlocked rect / ellipse leaf.
    const candidates: string[] = [];
    const walkNodes = (ns: any[], inGroup: boolean) => {
      for (const n of ns) {
        if (n.visible === false || n.locked) continue;
        if (n.type === "group") walkNodes(n.children, true);
        else if (inGroup && (n.type === "rect" || n.type === "ellipse") && n.w >= 10 && n.h >= 10 && n.w < 700) candidates.push(n.id);
      }
    };
    walkNodes(store.getProject(project).doc.frames[0].children, false);
    const chartLeaf = await page.evaluate((ids) => {
      for (const id of ids) {
        const el = document.querySelector(`svg[data-phone-frame="square"] [id="${id}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 2 && r.height > 2) return { id, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    }, candidates);
    expect(chartLeaf).toBeTruthy();
    await page.touchscreen.tap(chartLeaf!.x, chartLeaf!.y);
    await expect.poll(() => page.textContent('[data-testid="point-count"]')).toBe("2");
    const pointed = await page.locator("[data-pointed]").evaluateAll((els) => els.map((e) => (e as SVGElement).dataset.pointed));
    expect(pointed[0]).toBe("headline");
    expect(pointed).toHaveLength(2);
    // Tap again drops it; tap once more picks it again.
    await page.touchscreen.tap(chartLeaf!.x, chartLeaf!.y);
    await expect.poll(() => page.textContent('[data-testid="point-count"]')).toBe("1");
    await page.touchscreen.tap(chartLeaf!.x, chartLeaf!.y);
    await expect.poll(() => page.textContent('[data-testid="point-count"]')).toBe("2");
    const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(noScroll).toBe(true);
    await page.screenshot({ path: join(outDir, "04-phone-pointing.png") });

    await page.tap('[data-testid="point-hand"]');
    await page.waitForSelector('[data-testid="handoff-sheet"] [data-testid="focus-chips"]');
    expect(await page.locator(".chip.focus").count()).toBe(2);
    const x = await page.locator(`[data-testid="focus-remove-${pointed[1]}"]`).boundingBox();
    expect(x!.height).toBeGreaterThanOrEqual(32);
    await page.screenshot({ path: join(outDir, "05-phone-sheet.png") });
    await page.tap(`[data-testid="focus-remove-${pointed[1]}"]`);
    expect(await page.locator(".chip.focus").count()).toBe(1);
    await page.fill('[data-testid="handoff-note"]', "this: one line");
    await page.tap('[data-testid="handoff-send"]');
    await expect.poll(() => store.handoffState(project).turn, { timeout: 10_000 }).toBe("agent");
    expect(store.handoffState(project).handoff).toMatchObject({ name: "handoff-2", note: "this: one line", focus: [{ id: "headline" }] });
    await page.waitForSelector('[data-testid="banner"][data-dispatch="pending"]');
    expect(await page.textContent('[data-testid="banner"]')).toMatch(/pointing at 1 element/);
    // Point mode is off again and nothing stays pointed.
    expect(await page.locator('[data-testid="point-bar"]').count()).toBe(0);
    expect(await page.locator("[data-pointed]").count()).toBe(0);

    // A failed start shows Retry on the phone too.
    store.dispatchPoll({ enabled: true, instance: "e2e" });
    store.dispatchClaim(project, "handoff-2", "e2e");
    store.dispatchFailed(project, "handoff-2", "the session runner is not reachable");
    await page.waitForSelector('[data-testid="banner"][data-dispatch="failed"]', { timeout: 10_000 });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(outDir, "06-phone-failed.png") });
    await page.tap('[data-testid="retry-dispatch"]');
    await expect.poll(() => store.handoffState(project).dispatch?.state, { timeout: 10_000 }).toBe("pending");
    store.dispatchClaim(project, "handoff-2", "e2e");
    store.dispatchStarted(project, "handoff-2", 902, "queued");
    await expect.poll(() => dispatchText(page), { timeout: 10_000 }).toMatch(/Agent job #902 queued/);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(outDir, "07-phone-started.png") });
    await ctx.close();
  }, 120_000);
});
