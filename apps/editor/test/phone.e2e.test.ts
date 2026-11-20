/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Phase 8 phone review view, end to end in headless Chrome with phone emulation (Galaxy S24
// size: 384 × 854 CSS px, touch, isMobile) against an in-process server on a temp data dir with
// the imported LUX-6. The agent is played through the server store (same rules as the API).
//
//   agent link /p/<id> → login → phone view opens by itself → project list → preview, swipe to
//   the LinkedIn frame, zoom (double-tap, pinch) → edit text (emphasis kept, saved as human,
//   soft-pinned against the agent) → hand to agent → take it back → hand again → agent lease
//   (read-only) → agent hands back → "what the agent changed" → undo last change → history
//   restore → approve → switch to the desktop editor and back (remembered) → a laptop still gets
//   the unchanged desktop editor.
//
// PHASE8_EVIDENCE=1 keeps the screenshots in test-artifacts/phase8/.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { Document, Node } from "@post-studio/schema";
import { findItem } from "@post-studio/schema";
import { importSocialPost } from "@post-studio/import";
import { chromeEnv, findChrome } from "@post-studio/render";
import { Store, buildApp } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { EDITOR_DIST, ensureEditorBuilt } from "../build-if-stale.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EVIDENCE = !!process.env.PHASE8_EVIDENCE;
const PASSWORD = "phone correct horse battery";
const chrome = findChrome();
const AGENT = { author: "agent:claude" };
export const S24 = { viewport: { width: 384, height: 854 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 16; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36" };

let dataDir: string;
let outDir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
let url: string;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let project: string;
const errors: string[] = [];

const head = () => store.getProject(project).head as number;
const doc = (): Document => store.getProject(project).doc as Document;
const node = (id: string): Node => {
  const loc = findItem(doc(), id);
  if (!loc || loc.kind !== "node") throw new Error(`no node ${id}`);
  return loc.item as Node;
};
const spans = (id: string) => (node(id) as Extract<Node, { type: "text" }>).spans;
const shot = (name: string, fullPage = false) => page.screenshot({ path: join(outDir, `${name}.png`), fullPage });
const saved = () =>
  expect
    .poll(() => page.evaluate(() => { const s = (window as any).__postStudio.useEditor.getState().save; return s.status === "saved" && s.pending === 0; }), { timeout: 15_000, interval: 100 })
    .toBe(true);

/** No horizontal page scroll, and every visible phone button is a real touch target. */
async function layoutOk() {
  const r = await page.evaluate(() => {
    const small = [...document.querySelectorAll<HTMLElement>(".ph-btn, .ph-text-row, .ph-row, .ph-rev-head, .ph-tab")]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ t: el.dataset.testid ?? el.textContent?.trim().slice(0, 20), r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && (x.r.height < 40 || x.r.width < 40))
      .map((x) => `${x.t} ${Math.round(x.r.width)}×${Math.round(x.r.height)}`);
    return { scrollW: document.documentElement.scrollWidth, w: innerWidth, small };
  });
  expect(r.scrollW, "horizontal page scroll").toBeLessThanOrEqual(r.w);
  expect(r.small, "touch targets under 40 px").toEqual([]);
}

describe.skipIf(!chrome)("phone review view (headless Chrome, S24 emulation)", () => {
  beforeAll(async () => {
    ensureEditorBuilt(() => undefined);
    outDir = EVIDENCE ? join(ROOT, "test-artifacts/phase8") : mkdtempSync(join(tmpdir(), "pstudio-phone-shots-"));
    mkdirSync(outDir, { recursive: true });
    dataDir = mkdtempSync(join(tmpdir(), "pstudio-phone-"));
    store = new Store({ dataDir, fonts: await FontRegistry.load() });
    store.auth.setPassword(PASSWORD);
    const { doc: imported } = await importSocialPost(join(ROOT, "fixtures/social-posts/lux-6-judge-compare"), {
      fonts: store.fonts,
      upload: async (b: Uint8Array, name: string) => store.addAsset(b, AGENT, name),
    });
    project = store.createProject(imported, AGENT, "import LUX-6").project;
    // A coloured word in the headline, so the phone has emphasis to keep.
    store.applyOps(project, { base: head(), ops: [{ op: "set", node: "headline", path: "spans", value: [{ text: "Исти " }, { text: "модели", fill: "#AC1922" }, { text: ".\nРазлични оценки." }] }], message: "colour 'модели'" }, AGENT);
    store.handBack(project, AGENT, "first draft: LUX-6 with a coloured word");
    app = buildApp({ store, editorDir: EDITOR_DIST });
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: chrome, env: chromeEnv() as Record<string, string>, args: ["--no-sandbox", "--font-render-hinting=none"] });
    ctx = await browser.newContext(S24);
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    store?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (!EVIDENCE && outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("the agent's link asks for the password on a phone-sized login, then opens the phone view by itself", async () => {
    await page.goto(`${url}/p/${project}`);
    await page.waitForSelector('[data-testid="login-password"]');
    const box = await page.locator('[data-testid="login-form"]').boundingBox();
    expect(box!.width).toBeGreaterThan(330); // full width, not a 320 px desktop card
    expect((await page.locator('[data-testid="login-password"]').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await page.locator('[data-testid="login-submit"]').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot("01-login");
    await page.fill('[data-testid="login-password"]', PASSWORD);
    await page.tap('[data-testid="login-submit"]');
    await page.waitForSelector('[data-testid="phone-project"]', { timeout: 30_000 });
    await page.waitForSelector('svg[data-phone-frame="square"] [data-frame="square"]');
    expect(await page.locator('[data-testid="editor"]').count()).toBe(0);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  }, 60_000);

  it("project list: one column of big rows", async () => {
    await page.tap('[data-testid="phone-back"]');
    await page.waitForSelector(`[data-testid="phone-project-${project}"]`);
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>(".ph-thumb img")].every((i) => i.complete && i.naturalWidth > 0)), { timeout: 15_000 }).toBe(true);
    await layoutOk();
    expect(await page.textContent(`[data-testid="phone-project-${project}"]`)).toMatch(/Your turn/);
    await shot("02-projects");
    await page.tap(`[data-testid="phone-project-${project}"]`);
    await page.waitForSelector('svg[data-phone-frame="li"] [data-frame="li"]');
  }, 60_000);

  it("preview: fit to width, status, what the agent changed, swipe to the LinkedIn frame", async () => {
    const sq = (await page.locator('svg[data-phone-frame="square"]').boundingBox())!;
    expect(sq.width).toBeGreaterThan(340);
    expect(sq.width).toBeLessThanOrEqual(384);
    await page.waitForSelector('[data-testid="agent-changes"]');
    expect(await page.textContent('[data-testid="agent-changes"]')).toMatch(/headline/);
    expect(await page.textContent('[data-testid="phone-turn"]')).toBe("Your turn");
    expect(await page.textContent('[data-testid="phone-last"]')).toMatch(/rev 1/);
    await layoutOk();
    await shot("03-preview");
    await shot("03b-preview-full", true);
    await page.tap('[data-testid="agent-changes-ok"]');
    await expect.poll(() => page.locator('[data-testid="agent-changes"]').count()).toBe(0);
    await page.evaluate(() => scrollTo(0, 0));
    // A real touch swipe on the preview strip.
    const cdp = await ctx.newCDPSession(page);
    const y0 = Math.round(sq.y + sq.height / 2);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 300, y: y0, id: 1 }] });
    for (let x = 290; x >= 40; x -= 25) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0, id: 1 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => page.getAttribute('[data-testid="frame-tab-li"]', "aria-selected"), { timeout: 5000 }).toBe("true");
    expect(await page.textContent('[data-testid="phone-texts"] h2')).toMatch(/LinkedIn|li/i);
    await shot("04-swiped-linkedin");
    await page.tap('[data-testid="frame-tab-square"]');
    await expect.poll(() => page.getAttribute('[data-testid="frame-tab-square"]', "aria-selected")).toBe("true");
    await page.waitForTimeout(500);
  }, 60_000);

  it("zoom: tap outside text opens it, double-tap zooms, two fingers pinch", async () => {
    await page.tap('[data-testid="zoom-open"]');
    await page.waitForSelector('[data-testid="zoom-viewer"]');
    const st = (await page.locator(".ph-zoom-stage").boundingBox())!;
    const cx = st.x + st.width / 2;
    const cy = st.y + st.height / 2;
    await page.touchscreen.tap(cx, cy);
    await page.waitForTimeout(80);
    await page.touchscreen.tap(cx, cy);
    await expect.poll(() => page.textContent('[data-testid="zoom-level"]')).toBe("250 %");
    await shot("05-zoom");
    // Pinch in back toward 1× with raw touch points.
    const cdp = await ctx.newCDPSession(page);
    const pts = (d: number) => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(120) });
    for (let d = 110; d >= 40; d -= 10) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => parseInt((await page.textContent('[data-testid="zoom-level"]'))!)).toBeLessThan(150);
    await page.tap('[data-testid="zoom-close"]');
    await expect.poll(() => page.locator('[data-testid="zoom-viewer"]').count()).toBe(0);
  }, 60_000);

  it("edit text: tap the headline, change a plain word, the coloured word stays coloured, saved as Nikola", async () => {
    const before = head();
    await page.evaluate(() => scrollTo(0, 0));
    const hl = await page.evaluate(() => {
      const r = document.querySelector('svg[data-phone-frame="square"] #headline')!.getBoundingClientRect();
      return { x: r.left + 10, y: r.top + r.height * 0.75 };
    });
    await page.touchscreen.tap(hl.x, hl.y);
    await page.waitForSelector('[data-testid="text-input"]');
    expect(await page.inputValue('[data-testid="text-input"]')).toBe("Исти модели.\nРазлични оценки.");
    await page.fill('[data-testid="text-input"]', "Исти модели.\nСосема различни оценки.");
    await shot("06-edit-text");
    await page.tap('[data-testid="text-save"]');
    await expect.poll(() => page.locator('[data-testid="text-input"]').count(), { timeout: 15_000 }).toBe(0);
    await saved();
    expect(head()).toBe(before + 1);
    expect(spans("headline")).toEqual([{ text: "Исти " }, { text: "модели", fill: "#AC1922" }, { text: ".\nСосема различни оценки." }]);
    expect(store.revisions(project).at(-1)).toMatchObject({ author: "human" });
    // Pins work as on desktop: the agent may not change his text on its next turn.
    expect(store.softPins(project).some((p) => p.node === "headline" && p.path === "spans")).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    await shot("07-text-saved");
  }, 60_000);

  it("a retype across the coloured word warns before the emphasis goes; a locked layer says so", async () => {
    await page.tap('[data-testid="text-headline"]');
    await page.fill('[data-testid="text-input"]', "Сè е исто.");
    await page.tap('[data-testid="text-save"]');
    await page.waitForSelector('[data-testid="emphasis-warning"]');
    expect(await page.textContent('[data-testid="emphasis-warning"]')).toMatch(/модели/);
    await shot("08-emphasis-warning");
    await page.tap('[data-testid="sheet-close"]');
    expect(spans("headline")[1]).toEqual({ text: "модели", fill: "#AC1922" });
    // Lock the footer from the server side (as Nikola would on desktop): the phone refuses with a reason.
    store.applyOps(project, { base: head(), ops: [{ op: "set", node: "footer", path: "locked", value: true }], message: "lock footer" }, { author: "human" });
    await expect.poll(() => page.evaluate(() => (window as any).__postStudio.useEditor.getState().save.rev), { timeout: 10_000 }).toBe(head());
    await page.tap('[data-testid="text-footer"]');
    await page.waitForSelector('[data-testid="text-blocked"]');
    expect(await page.locator('[data-testid="text-save"]').count()).toBe(0);
    await page.tap('[data-testid="sheet-close"]');
  }, 60_000);

  it("undo last change reverts the newest revision", async () => {
    const before = head();
    await page.tap('[data-testid="undo-last"]');
    await page.tap('[data-testid="undo-last-confirm"]');
    await expect.poll(() => head(), { timeout: 10_000 }).toBe(before + 1);
    expect(store.revisions(project).at(-1)).toMatchObject({ kind: "revert", author: "human" });
    expect((node("footer") as { locked?: boolean }).locked).toBeFalsy();
  }, 60_000);

  it("hand to agent with a note, take it back, hand again; read-only while the agent works; then what it changed", async () => {
    await page.tap('[data-testid="handoff"]');
    await page.waitForSelector('[data-testid="handoff-note"]');
    await page.fill('[data-testid="handoff-note"]', "Shorter sub line please. Keep my headline.");
    await shot("09-handoff");
    await page.tap('[data-testid="handoff-send"]');
    await expect.poll(() => store.handoffState(project).turn, { timeout: 10_000 }).toBe("agent");
    await page.waitForSelector('[data-testid="banner"]');
    await page.waitForSelector('[data-testid="take-back"]');
    await page.evaluate(() => scrollTo(0, 0));
    await shot("10-handed-over");
    await page.tap('[data-testid="take-back"]');
    await expect.poll(() => store.handoffState(project).turn, { timeout: 10_000 }).toBe("human");
    await page.tap('[data-testid="handoff"]');
    await page.fill('[data-testid="handoff-note"]', "Shorter sub line please. Keep my headline.");
    await page.tap('[data-testid="handoff-send"]');
    await expect.poll(() => store.handoffState(project).turn, { timeout: 10_000 }).toBe("agent");
    // The agent takes the lease → the phone is read-only with a banner.
    store.takeLease(project, AGENT);
    await page.waitForSelector('[data-testid="banner"].lease', { timeout: 10_000 });
    expect(await page.locator('[data-testid="take-back"]').isDisabled()).toBe(true);
    await page.tap('[data-testid="text-sub"]');
    expect(await page.locator('[data-testid="text-save"]').isDisabled()).toBe(true);
    await page.tap('[data-testid="sheet-close"]');
    await page.evaluate(() => scrollTo(0, 0));
    await shot("11-agent-working");
    // The agent cannot undo his headline edit (soft pin), edits on top and hands back.
    expect(() => store.applyOps(project, { base: head(), ops: [{ op: "set", node: "headline", path: "spans", value: [{ text: "x" }] }], message: "try" }, AGENT)).toThrow(/pinned/);
    store.applyOps(project, { base: head(), ops: [{ op: "set", node: "sub", path: "spans", value: [{ text: "% добри одговори" }] }], message: "shorter sub line" }, AGENT);
    store.handBack(project, AGENT, "shortened the sub line, kept your headline");
    await page.waitForSelector('[data-testid="agent-changes"]', { timeout: 10_000 });
    expect(await page.textContent('[data-testid="agent-changes"]')).toMatch(/sub/);
    expect(await page.locator('[data-testid="banner"]').count()).toBe(0);
    await expect.poll(() => page.locator('svg[data-phone-frame="square"] rect.agent-change').count()).toBeGreaterThan(0);
    await page.evaluate(() => scrollTo(0, 0));
    await shot("12-agent-changed");
  }, 90_000);

  it("history: newest first, open a revision, restore it", async () => {
    await page.tap('[data-testid="agent-changes-ok"]');
    await page.tap('[data-testid="history-open"]');
    await page.waitForSelector('[data-testid="history-sheet"]');
    const top = head();
    await page.waitForSelector(`[data-testid="rev-${top}"]`);
    await layoutOk();
    await page.tap(`[data-testid="rev-1"] .ph-rev-head`);
    await expect.poll(() => page.evaluate(() => { const i = document.querySelector<HTMLImageElement>('[data-testid="rev-1"] img'); return !!i && i.complete && i.naturalWidth > 0; }), { timeout: 15_000 }).toBe(true);
    await shot("13-history");
    await page.tap('[data-testid="rev-1"] [data-testid="restore"]');
    await expect.poll(() => head(), { timeout: 10_000 }).toBe(top + 1);
    expect(store.revisions(project).at(-1)).toMatchObject({ kind: "restore", author: "human" });
    expect(spans("headline")).toEqual([{ text: "Исти " }, { text: "модели", fill: "#AC1922" }, { text: ".\nРазлични оценки." }]);
  }, 60_000);

  it("approve the current revision", async () => {
    await saved();
    await page.tap('[data-testid="approve"]');
    await page.waitForSelector('[data-testid="approve-sheet"]');
    await page.fill('[data-testid="approve-note"]', "ok from the phone");
    await page.tap('[data-testid="approve-send"]');
    await expect.poll(() => store.handoffState(project).approved?.rev, { timeout: 10_000 }).toBe(head());
    await page.waitForSelector('[data-testid="approved-chip"]');
    expect(await page.locator('[data-testid="approve"]').isDisabled()).toBe(true);
    await layoutOk();
    await page.evaluate(() => scrollTo(0, 0));
    await shot("14-approved");
  }, 60_000);

  it("switches to the desktop editor and back; the choice is remembered", async () => {
    await page.tap('[data-testid="to-desktop"]');
    await page.waitForSelector('[data-testid="editor"]', { timeout: 30_000 });
    await shot("15-desktop-on-phone");
    await page.reload();
    await page.waitForSelector('[data-testid="editor"]', { timeout: 30_000 });
    await page.tap('[data-testid="to-phone"]');
    await page.waitForSelector('[data-testid="phone-project"]');
    await page.reload();
    await page.waitForSelector('[data-testid="phone-project"]', { timeout: 30_000 });
  }, 90_000);

  it("a laptop still gets the unchanged desktop editor (no phone button), even with ?view links remembered per device", async () => {
    const desk = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const p = await desk.newPage();
    p.on("pageerror", (e) => errors.push(`desktop pageerror: ${e.message}`));
    await p.goto(`${url}/p/${project}`);
    await p.fill('[data-testid="login-password"]', PASSWORD);
    await p.click('[data-testid="login-submit"]');
    await p.waitForSelector('svg[data-frame="square"]', { timeout: 30_000 });
    expect(await p.locator('[data-testid="phone-project"]').count()).toBe(0);
    expect(await p.locator('[data-testid="to-phone"]').count()).toBe(0);
    expect((await p.locator('[data-testid="login-form"]').count())).toBe(0);
    await p.waitForTimeout(800);
    await p.screenshot({ path: join(outDir, "16-desktop-laptop.png") });
    // ?view=phone opens the phone view on a laptop too (for checking), and is remembered.
    await p.goto(`${url}/?view=phone`);
    await p.waitForSelector('[data-testid="phone-projects"]');
    expect(p.url()).toBe(`${url}/`);
    await p.goto(`${url}/?view=desktop`);
    await p.waitForSelector('[data-testid="projects"]');
    await desk.close();
  }, 90_000);

  it("produced no browser errors", () => {
    expect(errors).toEqual([]);
  });
});
