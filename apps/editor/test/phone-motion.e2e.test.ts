/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Motion Part 4 (PLAN-motion.md §6.2, §8 Part 4): the phone view of a motion post, in headless
// Chrome with Galaxy S24 emulation (384 × 854 CSS px, touch, isMobile), against an in-process
// server on a temp data dir.
//
//   opens at rest (the layout as designed) · play / pause (nothing written) · touch scrub (tap
//   and a raw touch drag) · tap a text where it is drawn at that moment · the zoom viewer plays
//   and scrubs · Download video (progress → a real MP4) · Hand to agent offers "At 1.20 s" when
//   paused away from the start (removable; none while playing) → stored as `at`.
//
// MOTION4_EVIDENCE=1 keeps screenshots and numbers in test-artifacts/motion-part4/.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { chromeEnv, findChrome, findFfmpeg } from "@post-studio/render";
import { Store, buildApp } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { EDITOR_DIST, ensureEditorBuilt } from "../build-if-stale.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EVIDENCE = !!process.env.MOTION4_EVIDENCE;
const PASSWORD = "phone motion horse battery";
const chrome = findChrome();
const ffmpeg = findFfmpeg();
const AGENT = { author: "agent:claude" };
// Galaxy S24 (the same emulation as phone.e2e.test.ts; not imported, which would run its tests here).
const S24 = { viewport: { width: 384, height: 854 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 16; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36" };

let dataDir: string;
let outDir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
let url: string;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let project: string;
let agentToken: string;
const errors: string[] = [];
const numbers: Record<string, unknown> = {};

const head = () => store.getProject(project).head as number;
const shot = (name: string, fullPage = false) => page.screenshot({ path: join(outDir, `${name}.png`), fullPage });
const playhead = () => page.evaluate(() => (window as any).__postStudio.useTime.getState() as { t: number; playing: boolean });
const frameTime = (sel = 'svg[data-phone-frame="square"] svg[data-frame="square"]') => page.getAttribute(sel, "data-time");
const isFrameTime = (t: number) => Math.round((Math.round((t * 30) / 1000) * 1000) / 30) === t;

async function scrubBox(prefix: string) {
  // The page may be scrolled down (a tap on the bottom bar scrolls); the preview is at the top.
  if (prefix === "ph") await page.evaluate(() => scrollTo(0, 0));
  const b = (await page.locator(`[data-testid="${prefix}-scrub"]`).boundingBox())!;
  return { left: b.x, width: b.width, y: b.y + b.height / 2, height: b.height };
}

async function layoutOk() {
  const r = await page.evaluate(() => {
    const small = [...document.querySelectorAll<HTMLElement>(".ph-btn, .ph-scrub")]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ t: el.dataset.testid ?? el.textContent?.trim().slice(0, 20), r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && (x.r.height < 40 || x.r.width < 40))
      .map((x) => `${x.t} ${Math.round(x.r.width)}×${Math.round(x.r.height)}`);
    return { scrollW: document.documentElement.scrollWidth, w: innerWidth, small };
  });
  expect(r.scrollW, "horizontal page scroll").toBeLessThanOrEqual(r.w);
  expect(r.small, "touch targets under 40 px").toEqual([]);
}

describe.skipIf(!chrome)("motion on the phone (headless Chrome, S24 emulation, touch)", () => {
  beforeAll(async () => {
    ensureEditorBuilt(() => undefined);
    outDir = EVIDENCE ? join(ROOT, "test-artifacts/motion-part4") : mkdtempSync(join(tmpdir(), "pstudio-phone-motion-shots-"));
    mkdirSync(outDir, { recursive: true });
    dataDir = mkdtempSync(join(tmpdir(), "pstudio-phone-motion-"));
    store = new Store({ dataDir, fonts: await FontRegistry.load() });
    store.auth.setPassword(PASSWORD);
    agentToken = store.createToken("claude", "agent").token;
    store.addAsset(readFileSync(join(ROOT, "fixtures/assets/logo-on-paper.png")), AGENT, "logo-on-paper.png");
    project = store.createProject(JSON.parse(readFileSync(join(ROOT, "fixtures/lux-6-motion.json"), "utf8")), AGENT, "motion fixture").project;
    app = buildApp({ store, editorDir: EDITOR_DIST });
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: chrome, env: chromeEnv() as Record<string, string>, args: ["--no-sandbox", "--font-render-hinting=none"] });
    ctx = await browser.newContext({ ...S24, acceptDownloads: true });
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
  }, 180_000);

  afterAll(async () => {
    if (EVIDENCE) writeFileSync(join(outDir, "phone-motion-numbers.json"), JSON.stringify({ when: new Date().toISOString(), ...numbers }, null, 2) + "\n");
    await browser?.close();
    await app?.close();
    store?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (!EVIDENCE && outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("opens the agent's link on the phone at rest: the layout as designed, with play / scrub / time and a video card", async () => {
    await page.goto(`${url}/p/${project}`);
    await page.fill('[data-testid="login-password"]', PASSWORD);
    await page.tap('[data-testid="login-submit"]');
    await page.waitForSelector('[data-testid="phone-project"]', { timeout: 30_000 });
    await page.waitForSelector('svg[data-phone-frame="square"] svg[data-frame="square"]');
    await page.waitForSelector('[data-testid="ph-transport"]');
    // Poster "rest": the frame is drawn without a time (every layer visible, as post.png).
    expect(await frameTime()).toBeNull();
    expect(await page.textContent('[data-testid="ph-time"]')).toMatch(/^Layout \/ 6\.00 s$/);
    expect(await page.locator('svg[data-phone-frame="square"] [data-anim]').count()).toBe(0);
    await page.waitForSelector('[data-testid="phone-video-make"]');
    await layoutOk();
    await shot("01-phone-at-rest");
  }, 60_000);

  it("play and pause: the preview moves through frame times, nothing is written", async () => {
    const before = head();
    await page.tap('[data-testid="ph-play"]');
    await expect.poll(async () => (await playhead()).t, { timeout: 5_000 }).toBeGreaterThan(300);
    expect((await playhead()).playing).toBe(true);
    expect(await page.getAttribute('[data-testid="ph-play"]', "data-playing")).toBe("1");
    // The drawn moment follows the playhead: a frame time, with motion wrappers.
    await expect.poll(async () => Number(await frameTime()), { timeout: 5_000 }).toBeGreaterThan(0);
    expect(isFrameTime(Number(await frameTime()))).toBe(true);
    expect(await page.locator('svg[data-phone-frame="square"] [data-anim="headline"]').count()).toBe(1);
    // Count distinct moments drawn in one second of playing.
    const seen = await page.evaluate(async () => {
      const el = document.querySelector('svg[data-phone-frame="square"] svg[data-frame="square"]')!;
      const ts = new Set<string>();
      const t0 = performance.now();
      while (performance.now() - t0 < 1000) {
        ts.add(el.getAttribute("data-time") ?? "");
        await new Promise((r) => requestAnimationFrame(r));
      }
      return ts.size;
    });
    numbers.phonePlaybackMomentsPerSecond = seen;
    expect(seen).toBeGreaterThan(10);
    await shot("02-playing");
    await page.tap('[data-testid="ph-play"]');
    await expect.poll(async () => (await playhead()).playing).toBe(false);
    const paused = (await playhead()).t;
    await page.waitForTimeout(400);
    expect((await playhead()).t).toBe(paused);
    expect(isFrameTime(paused)).toBe(true);
    await page.waitForTimeout(1200);
    expect(head()).toBe(before);
    expect(await page.evaluate(() => (window as any).__postStudio.useEditor.getState().save.pending)).toBe(0);
  }, 60_000);

  it("scrubs with touch: a tap seeks, a finger drag follows, the time and the drawing follow", async () => {
    const s = await scrubBox("ph");
    await page.touchscreen.tap(s.left + s.width * 0.2, s.y);
    const t1 = (await playhead()).t;
    expect(Math.abs(t1 - 1200)).toBeLessThanOrEqual(70);
    expect(isFrameTime(t1)).toBe(true);
    await expect.poll(() => frameTime()).toBe(String(t1));
    expect(await page.textContent('[data-testid="ph-time"]')).toBe(`${(t1 / 1000).toFixed(2)} / 6.00 s`);
    // A raw finger drag across the scrubber (CDP touch events) from 10 % to 50 %.
    const cdp = await ctx.newCDPSession(page);
    const pt = (f: number) => [{ x: s.left + s.width * f, y: s.y, id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(0.1) });
    const during: number[] = [];
    for (let f = 0.15; f <= 0.5001; f += 0.05) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(f) });
      during.push((await playhead()).t);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const t2 = (await playhead()).t;
    expect(Math.abs(t2 - 3000)).toBeLessThanOrEqual(70);
    // The playhead followed the finger the whole way (monotonic), and the page did not scroll sideways.
    expect(during.every((t, i) => i === 0 || t >= during[i - 1])).toBe(true);
    expect(during[0]).toBeLessThan(during.at(-1)!);
    await layoutOk();
    numbers.scrub = { tap20pct: t1, drag10to50pct: t2, during };
    await shot("03-scrubbed");
  }, 60_000);

  it("a tap on a text hits it where it is drawn at that moment", async () => {
    // At 0.5 s the headline is still sliding up: tap the drawn headline, not its layout box.
    const s = await scrubBox("ph");
    await page.touchscreen.tap(s.left + s.width * (500 / 6000), s.y);
    const t = (await playhead()).t;
    const drawn = (await page.locator('svg[data-phone-frame="square"] [data-anim="headline"]').boundingBox())!;
    await page.touchscreen.tap(drawn.x + drawn.width / 2, drawn.y + drawn.height * 0.6);
    await page.waitForSelector('[data-testid="text-input"]');
    const headline = (store.getProject(project).doc.frames[0].children.find((n: any) => n.id === "headline") as any).spans.map((x: any) => x.text).join("");
    expect(await page.inputValue('[data-testid="text-input"]')).toBe(headline);
    // Opening a sheet keeps the moment (and would pause playback).
    expect((await playhead()).t).toBe(t);
    await page.tap('[data-testid="sheet-close"]');
  }, 60_000);

  it("the zoom viewer plays and scrubs the same moment", async () => {
    const t0 = (await playhead()).t;
    await page.tap('[data-testid="zoom-open"]');
    await page.waitForSelector('[data-testid="zoom-viewer"]');
    await page.waitForSelector('[data-testid="zoom-transport"]');
    const zsel = '.ph-zoom-frame svg[data-frame="square"]';
    expect(await frameTime(zsel)).toBe(String(t0));
    await page.tap('[data-testid="zoom-play"]');
    await expect.poll(async () => Number(await frameTime(zsel)), { timeout: 5_000 }).not.toBe(t0);
    await page.tap('[data-testid="zoom-play"]');
    await expect.poll(async () => (await playhead()).playing).toBe(false);
    const s = await scrubBox("zoom");
    await page.touchscreen.tap(s.left + s.width * 0.75, s.y);
    const t = (await playhead()).t;
    expect(Math.abs(t - 4500)).toBeLessThanOrEqual(70);
    await expect.poll(() => frameTime(zsel)).toBe(String(t));
    await layoutOk();
    await shot("04-zoom-scrubbed");
    await page.tap('[data-testid="zoom-close"]');
    await expect.poll(() => page.locator('[data-testid="zoom-viewer"]').count()).toBe(0);
    // Back on the preview: the same moment.
    expect(await frameTime()).toBe(String(t));
  }, 60_000);

  it.skipIf(!ffmpeg)("Download video: progress, then a real MP4 of the saved revision (Download, Play inline)", async () => {
    const t0 = Date.now();
    await page.tap('[data-testid="phone-video-make"]');
    await page.waitForSelector('[data-testid="phone-video-progress"]', { timeout: 10_000 });
    await shot("05-video-progress");
    await page.waitForSelector('[data-testid="phone-video-ready"]', { timeout: 150_000 });
    const encodeMs = Date.now() - t0;
    const href = (await page.getAttribute('[data-testid="phone-video-download"]', "href"))!;
    expect(href).toMatch(/^\/v1\/video-jobs\/[^/]+\/file$/);
    expect(await page.getAttribute('[data-testid="phone-video-play"]', "href")).toBe(`${href}?inline=1`);
    await layoutOk();
    await shot("06-video-ready");
    const download = page.waitForEvent("download", { timeout: 30_000 });
    await page.tap('[data-testid="phone-video-download"]');
    const d = await download;
    expect(d.suggestedFilename()).toMatch(new RegExp(`^${project}-rev${head()}-square\\.mp4$`));
    const path = join(outDir, "phone-video.mp4");
    await d.saveAs(path);
    const bytes = readFileSync(path);
    expect(bytes.subarray(4, 8).toString()).toBe("ftyp");
    const job = href.split("/")[3];
    const res = await app.inject({ method: "GET", url: `/v1/video-jobs/${job}`, headers: { authorization: `Bearer ${agentToken}` } });
    expect(res.json().job).toMatchObject({ status: "done", frames: 180, rev: head(), frame: "square" });
    const inline = await app.inject({ method: "GET", url: `${href}?inline=1`, headers: { authorization: `Bearer ${agentToken}` } });
    expect(inline.headers["content-disposition"]).toMatch(/^inline;/);
    numbers.video = { bytes: bytes.length, frames: 180, encodeMsWithPolling: encodeMs, share: await page.locator('[data-testid="phone-video-share"]').count() };
    if (!EVIDENCE) rmSync(path);
  }, 180_000);

  it("Hand to agent while playing offers no moment (and pauses)", async () => {
    await page.tap('[data-testid="ph-play"]');
    await expect.poll(async () => (await playhead()).playing).toBe(true);
    await page.tap('[data-testid="handoff"]');
    await page.waitForSelector('[data-testid="handoff-sheet"]');
    expect(await page.locator('[data-testid="at-chip"]').count()).toBe(0);
    await expect.poll(async () => (await playhead()).playing).toBe(false);
    await page.tap('[data-testid="sheet-close"]');
  }, 60_000);

  it("Hand to agent paused at a moment: the 'At 1.20 s' chip is stored as `at`; removing it sends none", async () => {
    const s = await scrubBox("ph");
    await page.touchscreen.tap(s.left + s.width * 0.2, s.y);
    const t = (await playhead()).t;
    expect(Math.abs(t - 1200)).toBeLessThanOrEqual(70);
    await page.tap('[data-testid="handoff"]');
    await page.waitForSelector('[data-testid="at-chip"]');
    expect(await page.textContent('[data-testid="at-chip"]')).toBe(`At ${(t / 1000).toFixed(2)} s`);
    expect(Number(await page.getAttribute('[data-testid="at-chip"]', "data-at"))).toBe(t);
    await page.fill('[data-testid="handoff-note"]', "make the intro punchier here");
    await layoutOk();
    await shot("07-handoff-at-chip");
    await page.tap('[data-testid="handoff-send"]');
    await expect.poll(() => store.handoffState(project).turn, { timeout: 10_000 }).toBe("agent");
    expect(store.handoffState(project).handoff).toMatchObject({ name: "handoff-1", at: t, atText: `${(t / 1000).toFixed(2)} s`, note: "make the intro punchier here" });
    await page.waitForSelector('[data-testid="handoff-at"]');
    expect(await page.textContent('[data-testid="handoff-at"]')).toBe(`, at ${(t / 1000).toFixed(2)} s`);
    await page.evaluate(() => scrollTo(0, 0));
    await shot("08-handed-over-at");
    // The dispatcher's poll carries it (motion: true) for the worker prompt.
    expect(store.dispatchPoll({ enabled: true, instance: "t" }).items[0]).toMatchObject({ checkpoint: "handoff-1", at: t, motion: true });
    // Take it back, hand over again without the moment.
    await page.tap('[data-testid="take-back"]');
    await expect.poll(() => store.handoffState(project).turn, { timeout: 10_000 }).toBe("human");
    await page.tap('[data-testid="handoff"]');
    await page.waitForSelector('[data-testid="at-chip"]');
    await page.tap('[data-testid="at-remove"]');
    expect(await page.locator('[data-testid="at-chip"]').count()).toBe(0);
    await page.fill('[data-testid="handoff-note"]', "the whole thing");
    await page.tap('[data-testid="handoff-send"]');
    await expect.poll(() => store.handoffState(project).handoff?.name, { timeout: 10_000 }).toBe("handoff-2");
    expect(store.handoffState(project).handoff).toMatchObject({ at: null, atText: null });
    numbers.handoffAt = t;
  }, 60_000);

  it("produced no browser errors", () => {
    expect(errors).toEqual([]);
  });
});
