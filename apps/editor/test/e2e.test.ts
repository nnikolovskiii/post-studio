/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// End-to-end: the real editor in headless Chrome (Playwright, the installed headless shell) against
// an in-process server on a temp data dir with the imported LUX-6. Walks the Phase 3 done-when
// list: log in, select, move, resize, rotate, nudge, edit text with a bold span, change font and
// colour, add an image and an SVG, undo / redo, compare the canvas with `pstudio render` of the
// same revision, restore an old revision, hand to an agent (read-only lease banner) and see what
// the agent changed. Steps share one page and run in order.
//
// PHASE3_EVIDENCE=1 keeps the screenshots and numbers in test-artifacts/phase3/.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Document, Node } from "@post-studio/schema";
import { findItem } from "@post-studio/schema";
import { importSocialPost } from "@post-studio/import";
import { chromeEnv, chromeRenderSvg, comparePng, findChrome, type PixelDiff } from "@post-studio/render";
import { Store, buildApp } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { EDITOR_DIST, ensureEditorBuilt } from "../build-if-stale.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EVIDENCE = !!process.env.PHASE3_EVIDENCE;
const PASSWORD = "e2e correct horse battery";
const chrome = findChrome();

let dataDir: string;
let outDir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
let url: string;
let browser: Browser;
let page: Page;
let project: string;
let agentToken: string;
const errors: string[] = [];
const numbers: Record<string, unknown> = {};

const AGENT = { author: "agent:claude" };

// ---- helpers
const head = () => store.getProject(project).head as number;
const doc = (): Document => store.getProject(project).doc as Document;
const node = (id: string, d = doc()): Node => {
  const loc = findItem(d, id);
  if (!loc || loc.kind !== "node") throw new Error(`no node ${id}`);
  return loc.item as Node;
};
const shot = (name: string) => page.screenshot({ path: join(outDir, `${name}.png`) });

interface UiState {
  selection: string[];
  editing: string | null;
  undo: number;
  redo: number;
  save: { status: string; rev: number; pending: number };
  zoom: number;
  readOnly: boolean;
}
const ui = (): Promise<UiState> =>
  page.evaluate(() => {
    const s = (window as any).__postStudio.useEditor.getState();
    return { selection: s.selection, editing: s.editing?.id ?? null, undo: s.undo.length, redo: s.redo.length, save: s.save, zoom: s.view.zoom, readOnly: !!document.querySelector(".editor.read-only") };
  });
const setUi = (patch: Record<string, unknown>) => page.evaluate((p) => (window as any).__postStudio.useEditor.setState(p), patch);

/** Wait until every local change is on the server (autosave is debounced ~1 s). */
async function saved(minRev?: number) {
  await expect
    .poll(async () => {
      const s = (await ui()).save;
      return s.status === "saved" && s.pending === 0 && (minRev === undefined || s.rev >= minRev);
    }, { timeout: 15_000, interval: 100 })
    .toBe(true);
  return head();
}

/** Screen point of a frame coordinate. */
async function at(frame: string, x: number, y: number) {
  return page.evaluate(
    ([f, x, y]) => {
      const el = document.querySelector(`svg[data-frame="${f}"]`)!.getBoundingClientRect();
      const z = (window as any).__postStudio.useEditor.getState().view.zoom;
      return { x: el.left + (x as number) * z, y: el.top + (y as number) * z };
    },
    [frame, x, y] as const,
  );
}

/** Centre of a rendered node on screen (its SVG element). */
async function centre(id: string) {
  return page.evaluate((id) => {
    const r = document.querySelector(`[data-testid="canvas"] #${CSS.escape(id)}`)!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }, opts: { shift?: boolean } = {}) {
  await page.mouse.move(from.x, from.y);
  if (opts.shift) await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up("Shift");
}

/** The eye / lock / pin buttons show on row hover, like Figma. */
async function layerTool(kind: "eye" | "lock" | "pin", id: string) {
  await page.hover(`[data-testid="layer-${id}"]`);
  await page.click(`[data-testid="${kind}-${id}"]`);
}

async function handle(name: string) {
  const r = await page.locator(`[data-handle="${name}"]`).first().boundingBox();
  if (!r) throw new Error(`no handle ${name}`);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

const SVG_ART = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="40" fill="#305880"/><path d="M20 80 L80 20" stroke="#AC1922" stroke-width="8"/></svg>`;

describe.skipIf(!chrome)("editor end to end (headless Chrome)", () => {
  beforeAll(async () => {
    ensureEditorBuilt(() => undefined);
    outDir = EVIDENCE ? join(ROOT, "test-artifacts/phase3") : mkdtempSync(join(tmpdir(), "pstudio-e2e-shots-"));
    mkdirSync(outDir, { recursive: true });
    dataDir = mkdtempSync(join(tmpdir(), "pstudio-e2e-"));
    store = new Store({ dataDir, fonts: await FontRegistry.load() });
    store.auth.setPassword(PASSWORD);
    agentToken = store.createToken("claude", "agent").token;
    const { doc: imported } = await importSocialPost(join(ROOT, "fixtures/social-posts/lux-6-judge-compare"), {
      fonts: store.fonts,
      upload: async (b: Uint8Array, name: string) => store.addAsset(b, AGENT, name),
    });
    project = store.createProject(imported, AGENT, "import LUX-6").project;
    app = buildApp({ store, editorDir: EDITOR_DIST });
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: chrome, env: chromeEnv() as Record<string, string>, args: ["--no-sandbox", "--font-render-hinting=none"] });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      // A wrong password is a 401 on purpose; Chrome logs every failed fetch.
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
  }, 180_000);

  afterAll(async () => {
    if (EVIDENCE) writeFileSync(join(outDir, "e2e-numbers.json"), JSON.stringify({ when: new Date().toISOString(), project: "LUX-6 (fixture import, temp data dir)", ...numbers }, null, 2) + "\n");
    await browser?.close();
    await app?.close();
    store?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (!EVIDENCE && outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("logs in (wrong password refused) and lists the project with a thumbnail", async () => {
    await page.goto(url + "/");
    await page.fill('[data-testid="login-password"]', "not the password");
    await page.click('[data-testid="login-submit"]');
    await expect.poll(() => page.textContent('[data-testid="login-error"]').catch(() => "")).toMatch(/wrong password/);
    await page.fill('[data-testid="login-password"]', PASSWORD);
    await page.click('[data-testid="login-submit"]');
    await page.waitForSelector(`[data-testid="project-${project}"]`);
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('[data-testid="projects"] img')].map((i) => i.naturalWidth)), { timeout: 15_000 }).toEqual([324]);
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "pst_session")).toMatchObject({ httpOnly: true, sameSite: "Strict" });
    await shot("01-projects");
  }, 60_000);

  it("opens LUX-6: both frames drawn with the registered fonts, no missing glyphs", async () => {
    await page.click(`[data-testid="project-${project}"]`);
    await page.waitForSelector('svg[data-frame="square"]', { timeout: 30_000 });
    await page.waitForSelector('svg[data-frame="li"]');
    // Every Cyrillic headline glyph comes from IBM Plex Sans (the browser registry has full coverage).
    const coverage = await page.evaluate(() => {
      const reg = (window as any).__postStudio.useEditor.getState().fonts;
      return reg.describe().map((f: any) => f.missingMacedonian.length);
    });
    expect(coverage.every((n: number) => n === 0)).toBe(true);
    await page.mouse.click(5, 990); // nothing
    await shot("02-editor");
  }, 60_000);

  it("selects: click, shift-click, marquee, Escape", async () => {
    await page.mouse.click(...Object.values(await centre("headline")) as [number, number]);
    expect((await ui()).selection).toEqual(["headline"]);
    await expect.poll(() => page.locator('[data-handle]').count()).toBe(9); // 8 resize + rotate
    await page.keyboard.down("Shift");
    await page.mouse.click(...Object.values(await centre("sub")) as [number, number]);
    await page.keyboard.up("Shift");
    expect((await ui()).selection.sort()).toEqual(["headline", "sub"]);
    await page.keyboard.press("Escape");
    expect((await ui()).selection).toEqual([]);
    // Marquee from the empty canvas left of the square frame around the kicker / footer row.
    const a = await at("square", -30, 20);
    const b = await at("square", 1060, 75);
    await drag(a, b);
    const sel = (await ui()).selection.sort();
    expect(sel).toEqual(expect.arrayContaining(["footer", "kicker"]));
    expect(sel).not.toContain("headline");
    await shot("03-marquee");
    await page.keyboard.press("Escape");
  }, 60_000);

  it("moves by drag (autosaved as Nikola), then nudges with the arrows", async () => {
    await setUi({ snapping: false });
    const before = node("headline") as Extract<Node, { type: "text" }>;
    const z = (await ui()).zoom;
    const c = await centre("headline");
    await drag(c, { x: c.x + 40 * z, y: c.y + 30 * z });
    const rev = await saved(1);
    const moved = node("headline");
    expect(moved.x).toBeCloseTo(before.x + 40, 0);
    expect(moved.y).toBeCloseTo(before.y + 30, 0);
    const last = store.revisions(project).at(-1)!;
    expect(last).toMatchObject({ rev, author: "human" });
    expect(last.message).toMatch(/move/);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await saved(rev + 1);
    expect(node("headline").x).toBeCloseTo(moved.x + 1, 5);
    expect(node("headline").y).toBeCloseTo(moved.y + 10, 5);
    await shot("04-moved");
  }, 60_000);

  it("resizes with a handle (shift keeps aspect) and rotates", async () => {
    // A rectangle: the legend swatch rect-04.
    await page.keyboard.press("Escape");
    const r0 = node("rect-04") as Extract<Node, { type: "rect" }>;
    const z = (await ui()).zoom;
    // Zoom in so the small swatch has usable handles.
    await page.evaluate(() => (window as any).__postStudio.useEditor.setState({ selection: ["rect-04"] }));
    await page.click('[data-testid="zoom-100"]');
    const z1 = (await ui()).zoom;
    expect(z1).toBe(1);
    void z;
    const se = await handle("se");
    await drag(se, { x: se.x + 30, y: se.y + 10 }, { shift: true });
    let rev = await saved();
    const r1 = node("rect-04") as typeof r0;
    expect(r1.w).toBeGreaterThan(r0.w + 20);
    expect(r1.w / r1.h).toBeCloseTo(r0.w / r0.h, 1); // aspect kept
    expect(r1.x).toBeCloseTo(r0.x, 3); // anchored at the opposite (nw) corner
    // Plain east handle: only the width changes.
    const e = await handle("e");
    await drag(e, { x: e.x + 25, y: e.y + 40 });
    rev = await saved(rev + 1);
    const r2 = node("rect-04") as typeof r0;
    expect(r2.w).toBeCloseTo(r1.w + 25, 0);
    expect(r2.h).toBeCloseTo(r1.h, 3);
    // Rotate the headline by dragging the rotate handle (shift snaps to 15°).
    await page.evaluate(() => (window as any).__postStudio.useEditor.setState({ selection: ["headline"] }));
    await page.click('[data-testid="zoom"]'); // fit
    const h = await handle("rotate");
    const cc = await centre("headline");
    // Drag from the top handle to the right of the centre: +90°, shift snaps to an exact multiple of 15.
    await drag(h, { x: cc.x + 200, y: cc.y + 30 }, { shift: true });
    rev = await saved(rev + 1);
    const rot = node("headline").rotation ?? 0;
    expect(Math.abs(rot % 15)).toBeLessThan(1e-6);
    expect(rot).toBeGreaterThan(45);
    numbers.rotateDegrees = rot;
    await shot("05-rotated");
    // Back to level with the rotate field for the rest of the run.
    await page.fill('[data-testid="prop-rotation"]', "0");
    await page.keyboard.press("Enter");
    await saved(rev + 1);
    expect(node("headline").rotation ?? 0).toBe(0);
  }, 90_000);

  it("changes font and colour from the properties panel", async () => {
    await page.selectOption('[data-testid="prop-font"]', "Rubik");
    const rev = await saved();
    const h = node("headline") as Extract<Node, { type: "text" }>;
    expect(h.style.font).toBe("Rubik");
    expect(h.style.weight).toBeGreaterThanOrEqual(500); // Rubik 500–700 holds the old 600
    await page.locator('[data-testid="prop-text-fill"]').fill("#ac1922");
    await saved(rev + 1);
    expect((node("headline") as typeof h).style.fill).toBe("#AC1922");
    await shot("06-font-colour");
  }, 60_000);

  it("edits text in place with a bold span (Ctrl+B)", async () => {
    const c = await centre("headline");
    await page.mouse.dblclick(c.x, c.y);
    expect((await ui()).editing).toBe("headline");
    const ta = page.locator('[data-testid="text-input"]');
    await ta.press("Control+a");
    await ta.pressSequentially("Нов наслов. Само тест.", { delay: 10 });
    // Select "Само" (chars 12–16) with Shift+Arrow from the end of "Нов наслов. ".
    await ta.press("Home");
    for (let i = 0; i < 12; i++) await ta.press("ArrowRight");
    for (let i = 0; i < 4; i++) await ta.press("Shift+ArrowRight");
    await ta.press("Control+b");
    await shot("07-editing");
    await ta.press("Escape");
    expect((await ui()).editing).toBe(null);
    await saved();
    const h = node("headline") as Extract<Node, { type: "text" }>;
    expect(h.spans.map((s) => s.text).join("")).toBe("Нов наслов. Само тест.");
    const boldSpan = h.spans.find((s) => s.text === "Само");
    expect(boldSpan?.weight).toBe(700);
    expect(store.revisions(project).at(-1)!.author).toBe("human");
    await shot("08-text-edited");
  }, 60_000);

  it("adds an image and an SVG", async () => {
    const before = doc().frames[0].children.length;
    const known = new Set(doc().frames.flatMap((f) => f.children.map((n) => n.id)));
    const added = async () => (await ui()).selection.find((id) => !known.has(id));
    await page.keyboard.press("Escape");
    await page.setInputFiles('[data-testid="image-input"]', join(ROOT, "fixtures/assets/logo-on-paper.png"));
    await expect.poll(added, { timeout: 10_000 }).toBeTruthy();
    const rev = await saved();
    const img = node((await added())!);
    expect(img.type).toBe("image");
    await page.setInputFiles('[data-testid="svg-input"]', { name: "art.svg", mimeType: "image/svg+xml", buffer: Buffer.from(SVG_ART) });
    known.add(img.id);
    await expect.poll(added, { timeout: 10_000 }).toBeTruthy();
    await saved(rev + 1);
    // The SVG button makes editable layers in a group (job 882): the circle and the stroke.
    const art = node((await added())!);
    expect(art.type).toBe("group");
    expect((art as Extract<Node, { type: "group" }>).children.map((c) => c.type)).toEqual(["ellipse", "path"]);
    expect(doc().frames[0].children.length).toBe(before + 2);
    numbers.added = { image: img.id, svg: art.id };
    await shot("09-image-svg");
  }, 60_000);

  it("undoes and redoes as new revisions", async () => {
    const art = (numbers.added as { svg: string }).svg;
    const revBefore = head();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+z");
    await saved(revBefore + 1);
    expect(findItem(doc(), art)).toBeUndefined();
    expect(store.revisions(project).at(-1)!.message).toMatch(/^undo/);
    await page.keyboard.press("Control+Shift+z");
    await saved(revBefore + 2);
    expect(findItem(doc(), art)).toBeDefined();
    // The toolbar buttons do the same.
    await page.click('[data-testid="undo"]');
    await saved(revBefore + 3);
    expect(findItem(doc(), art)).toBeUndefined();
    await page.click('[data-testid="redo"]');
    await saved(revBefore + 4);
    expect(findItem(doc(), art)).toBeDefined();
    expect(store.revisions(project).slice(-4).every((r) => r.author === "human")).toBe(true);
  }, 60_000);

  it("creates shapes and text; duplicates, copies, groups, z-orders and deletes; layer toggles and drag", async () => {
    await page.keyboard.press("Escape");
    const kids = () => doc().frames[0].children.map((n) => n.id);
    const newest = async () => (await ui()).selection[0];
    // Rectangle tool (R): drag a 150 × 100 box.
    await page.keyboard.press("r");
    await drag(await at("square", 700, 700), await at("square", 850, 800));
    let rev = await saved();
    const rect = node(await newest());
    expect(rect).toMatchObject({ type: "rect" });
    expect(rect.w).toBeCloseTo(150, -1);
    expect(rect.h).toBeCloseTo(100, -1);
    // Text tool (T): click, type, Escape.
    await page.keyboard.press("t");
    const tp = await at("square", 160, 240);
    await page.mouse.click(tp.x, tp.y);
    await expect.poll(async () => (await ui()).editing).toBeTruthy();
    await page.locator('[data-testid="text-input"]').pressSequentially("Ново поле", { delay: 10 });
    await page.keyboard.press("Escape");
    rev = await saved(rev + 1);
    const text = node(await newest()) as Extract<Node, { type: "text" }>;
    expect(text.type).toBe("text");
    expect(text.spans.map((x) => x.text).join("")).toBe("Ново поле");
    // Duplicate (Ctrl+D) offsets by 20.
    await setUi({ selection: [rect.id] });
    await page.keyboard.press("Control+d");
    rev = await saved(rev + 1);
    const dup = node(await newest());
    expect(dup.id).not.toBe(rect.id);
    expect([dup.x - rect.x, dup.y - rect.y]).toEqual([20, 20]);
    // Copy / paste.
    await setUi({ selection: [rect.id] });
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    rev = await saved(rev + 1);
    const pasted = await newest();
    expect(pasted).not.toBe(rect.id);
    expect(node(pasted).type).toBe("rect");
    // Group (Ctrl+G) and ungroup (Ctrl+Shift+G).
    await setUi({ selection: [rect.id, dup.id] });
    await page.keyboard.press("Control+g");
    rev = await saved(rev + 1);
    const group = node(await newest()) as Extract<Node, { type: "group" }>;
    expect(group.type).toBe("group");
    expect(group.children.map((c) => c.id).sort()).toEqual([rect.id, dup.id].sort());
    expect(node(rect.id).x).toBeCloseTo(rect.x - group.x, 3); // children are in group space
    await page.keyboard.press("Control+Shift+g");
    rev = await saved(rev + 1);
    expect(findItem(doc(), group.id)).toBeUndefined();
    expect(node(rect.id).x).toBeCloseTo(rect.x, 3); // back where it was on the frame
    // Z-order: to front (Ctrl+Shift+]) and to back (Ctrl+Shift+[).
    await setUi({ selection: [rect.id] });
    await page.keyboard.press("Control+Shift+BracketRight");
    rev = await saved(rev + 1);
    expect(kids().at(-1)).toBe(rect.id);
    await page.keyboard.press("Control+Shift+BracketLeft");
    rev = await saved(rev + 1);
    expect(kids()[0]).toBe(rect.id);
    // Delete.
    await setUi({ selection: [pasted] });
    await page.keyboard.press("Delete");
    rev = await saved(rev + 1);
    expect(findItem(doc(), pasted)).toBeUndefined();
    // Layers panel: hide / show, lock, pin, rename, drag to reorder.
    await layerTool("eye", dup.id);
    rev = await saved(rev + 1);
    expect(node(dup.id).visible).toBe(false);
    await layerTool("eye", dup.id);
    rev = await saved(rev + 1);
    expect(node(dup.id).visible).toBeUndefined();
    await layerTool("lock", dup.id);
    rev = await saved(rev + 1);
    expect(node(dup.id).locked).toBe(true);
    await layerTool("pin", dup.id);
    rev = await saved(rev + 1);
    expect(node(dup.id).pins).toEqual(["*"]);
    await page.dblclick(`[data-testid="layer-${dup.id}"] .layer-name`);
    await page.locator(`[data-testid="layer-${dup.id}"] input.rename`).fill("Swatch copy");
    await page.keyboard.press("Enter");
    rev = await saved(rev + 1);
    expect(node(dup.id).name).toBe("Swatch copy");
    // Drag the rect layer (now at the back) onto the top half of the headline row: above it in the list = in front of it.
    const target = page.locator('[data-testid="layer-headline"]');
    const tb = (await target.boundingBox())!;
    await page.locator(`[data-testid="layer-${rect.id}"]`).dragTo(target, { targetPosition: { x: tb.width / 2, y: 3 } });
    rev = await saved(rev + 1);
    expect(kids().indexOf(rect.id)).toBe(kids().indexOf("headline") + 1);
    numbers.structure = { rect: rect.id, text: text.id, duplicate: dup.id, pasted, group: group.id, rev };
    await shot("09b-structure");
  }, 90_000);

  it("draws exactly what `pstudio render` exports for the same revision", async () => {
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 2400, height: 1700 });
    await setUi({ showGuides: false, hover: null, selection: [], snapLines: [] });
    await page.mouse.move(1200, 10); // over the top bar: no hover outline
    const rev = await saved();
    const results: Record<string, unknown> = {};
    for (const frame of ["square", "li"]) {
      const offset = await page.evaluate((f) => {
        const s = (window as any).__postStudio.useEditor.getState();
        let x = 0;
        for (const fr of s.doc.frames) {
          if (fr.id === f) return x;
          x += fr.w + 160;
        }
        return 0;
      }, frame);
      await setUi({ view: { zoom: 1, x: 40 - offset, y: 40 } });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(300);
      const box = await page.evaluate((f) => {
        const r = document.querySelector(`svg[data-frame="${f}"]`)!.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }, frame);
      const f = doc().frames.find((x) => x.id === frame)!;
      expect(box).toEqual({ x: Math.round(box.x), y: Math.round(box.y), width: f.w, height: f.h });
      const canvas = await page.screenshot({ clip: box });
      const res = await app.inject({ method: "GET", url: `/v1/projects/${project}/render?frame=${frame}&format=png&rev=${rev}`, headers: { authorization: `Bearer ${agentToken}` } });
      expect(res.statusCode).toBe(200);
      const exported = res.rawPayload;
      writeFileSync(join(outDir, `10-canvas-${frame}.png`), canvas);
      writeFileSync(join(outDir, `10-render-${frame}.png`), exported);
      // The same revision as an SVG with live text, opened in Chrome: what a browser shows of the export.
      const svgRes = await app.inject({ method: "GET", url: `/v1/projects/${project}/render?frame=${frame}&format=svg&rev=${rev}`, headers: { authorization: `Bearer ${agentToken}` } });
      const chromeSvg = await chromeRenderSvg(svgRes.body, f.w, f.h, { hinting: false });
      writeFileSync(join(outDir, `10-chrome-svg-${frame}.png`), chromeSvg);
      const vsPng = await comparePng(canvas, exported);
      const vsSvg = await comparePng(canvas, chromeSvg);
      const fmt = (d: PixelDiff) => ({
        meanChannelError: +d.meanChannelError.toFixed(5),
        pixelsOver16: `${(d.pixelsOverFraction * 100).toFixed(3)} %`,
        blurredPixelsOver16: `${(d.blurredPixelsOverFraction * 100).toFixed(3)} %`,
        shiftTolerantPixelsOver16: `${(d.shiftTolerantPixelsOverFraction * 100).toFixed(3)} %`,
      });
      results[frame] = { rev, canvasVsExportedPng: fmt(vsPng), canvasVsExportedSvgInChrome: fmt(vsSvg) };
      // 1. The canvas is the export: the same SVG markup in the same engine, pixel for pixel
      //    (measured 2026-11-09: 0.000 % for both frames).
      expect(vsSvg.meanChannelError).toBeLessThan(0.0005);
      expect(vsSvg.pixelsOverFraction).toBeLessThan(0.0005);
      expect(vsSvg.shiftTolerantPixelsOverFraction).toBeLessThan(0.0002);
      // 2. Against the resvg PNG the gap is the renderer difference Phase 2 documented (Chrome
      //    snaps text baselines to whole pixels and darkens glyph edges; resvg does neither).
      //    Measured 2026-11-09: square 0.0032 · 1.55 % (blurred 1.11 %), li 0.0039 · 1.72 % (1.75 %).
      //    A moved headline or a missing image costs several times this.
      expect(vsPng.meanChannelError).toBeLessThan(0.006);
      expect(vsPng.pixelsOverFraction).toBeLessThan(0.026);
      expect(vsPng.blurredPixelsOverFraction).toBeLessThan(0.026);
    }
    numbers.canvasVsRender = results;
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.click('[data-testid="zoom"]');
  }, 90_000);

  it("previews and restores an old revision from the History panel", async () => {
    const before = head();
    await page.click('[data-testid="history-toggle"]');
    await page.click('[data-testid="rev-1"]');
    await page.waitForSelector('[data-testid="banner"]');
    expect((await ui()).readOnly).toBe(true); // previewing is read-only
    await shot("11-history-preview");
    await page.click('[data-testid="restore"]');
    await expect.poll(() => head(), { timeout: 10_000 }).toBe(before + 1);
    const last = store.revisions(project).at(-1)!;
    expect(last).toMatchObject({ kind: "restore", author: "human" });
    expect(doc().frames).toEqual(store.docAt(project, 1).frames);
    await expect.poll(async () => (await ui()).save.rev, { timeout: 10_000 }).toBe(before + 1);
    expect((await ui()).readOnly).toBe(false);
    await page.click('[data-testid="history-toggle"]');
    await shot("12-restored");
  }, 60_000);

  it("hands to the agent: read-only while it holds the lease, then highlights what it changed", async () => {
    await page.click('[data-testid="handoff"]');
    await page.fill('[data-testid="handoff-note"]', "Make the LinkedIn sub line shorter. Keep my layout.");
    await page.click('[data-testid="handoff-send"]');
    await expect.poll(() => store.handoffState(project).turn, { timeout: 10_000 }).toBe("agent");
    // The agent takes the lease: the editor goes read-only with a banner (poll every 2 s).
    store.takeLease(project, AGENT);
    await expect.poll(() => page.locator('[data-testid="banner"].lease').count(), { timeout: 10_000 }).toBe(1);
    expect((await ui()).readOnly).toBe(true);
    await shot("13-agent-lease");
    // Typing / dragging does nothing while read-only.
    const revLeased = head();
    const c = await centre("sub");
    await drag(c, { x: c.x + 50, y: c.y + 50 });
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(1500);
    expect(head()).toBe(revLeased);
    // The agent edits and hands back.
    store.applyOps(project, { base: head(), ops: [{ op: "set", node: "sub-li", path: "spans", value: [{ text: "% добри одговори" }] }, { op: "set", node: "status", path: "x", value: 700 }], message: "shorter sub line, move status" }, AGENT);
    store.handBack(project, AGENT, "shortened the LinkedIn sub line");
    await page.waitForSelector('[data-testid="agent-changes"]', { timeout: 10_000 });
    expect((await ui()).readOnly).toBe(false);
    const card = await page.textContent('[data-testid="agent-changes"]');
    expect(card).toMatch(/sub-li/);
    expect(card).toMatch(/status/);
    expect(await page.locator('[data-testid="layer-status"].agent-changed').count()).toBe(1);
    await shot("14-agent-changes");
  }, 60_000);

  it("produced no browser errors", () => {
    expect(errors).toEqual([]);
  });
});

