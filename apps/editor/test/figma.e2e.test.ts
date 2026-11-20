/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Job 882 in headless Chrome against an in-process server:
//   1. Movable frames: drag a frame's name label → it moves, the position is saved as one
//      revision (no diff line, no soft pin), Ctrl+Z puts the row back; read-only → nothing.
//   2. Drag-select on a background: pressing on a layer that covers the frame and dragging
//      draws a selection box (selects what it touches, not the background); a click still
//      selects the background; a selected background or any other layer still drags.
//   3. Export → "SVG for Figma" per frame (live text, no embedded fonts) and for all frames.
//   4. Figma → Post Studio: pasting SVG markup (Figma's Copy as SVG), the SVG button and a drop
//      make editable layers in a group; Shift keeps one picture; our own copy / paste still works;
//      read-only refuses.
//
// FIGMA_EVIDENCE=1 keeps the screenshots in test-artifacts/frames-select-figma/.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { chromeEnv, findChrome } from "@post-studio/render";
import { findItem, walk, type Document, type GroupNode, type Node } from "@post-studio/schema";
import { Store, buildApp } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { EDITOR_DIST, ensureEditorBuilt } from "../build-if-stale.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EVIDENCE = !!process.env.FIGMA_EVIDENCE;
const PASSWORD = "figma correct horse battery";
const chrome = findChrome();
const AGENT = { author: "agent:claude" };
const HUMAN = { author: "human" };

/** What Figma's "Copy as SVG" gives for a small selection (text not outlined). */
const FIGMA_SVG = `<svg width="600" height="400" viewBox="0 0 600 400" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect id="Card" width="600" height="400" rx="24" fill="#FCFAF6"/>
<rect id="Badge" x="40" y="260" width="200" height="80" rx="12" fill="#AC1922"/>
<circle cx="480" cy="120" r="60" fill="#23487F"/>
<rect x="300" y="220" width="240" height="140" fill="url(#paint0_linear)"/>
<text fill="#190F0B" xml:space="preserve" style="white-space: pre" font-family="IBM Plex Sans" font-size="48" font-weight="600"><tspan x="40" y="96">Исти модели,</tspan><tspan x="40" y="153.6">различни резултати</tspan></text>
<defs><linearGradient id="paint0_linear" x1="300" y1="220" x2="540" y2="360" gradientUnits="userSpaceOnUse"><stop stop-color="#AC1922"/><stop offset="1" stop-color="#23487F"/></linearGradient></defs>
</svg>`;

let dataDir: string;
let outDir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
let url: string;
let browser: Browser;
let page: Page;
let project: string;
const errors: string[] = [];

function startDoc(): Document {
  const d = JSON.parse(readFileSync(join(ROOT, "fixtures/lux-6-square.hand.json"), "utf8")) as Document;
  const sq = { w: 1080, h: 1080, background: { color: "#FCFAF6" } };
  d.title = "Frames, select, Figma";
  d.frames = [
    {
      id: "s1",
      name: "1 · Насловна",
      ...sq,
      children: [
        { id: "bg", type: "rect", name: "Background", x: 0, y: 0, w: 1080, h: 1080, fill: "#F4EFE6" },
        { id: "a", type: "rect", x: 100, y: 100, w: 100, h: 100, fill: "#AC1922" },
        { id: "b", type: "rect", x: 300, y: 100, w: 100, h: 100, fill: "#23487F" },
        { id: "c", type: "rect", x: 700, y: 700, w: 100, h: 100, fill: "#190F0B" },
        { id: "title", type: "text", x: 100, y: 900, w: 0, h: 0, box: "auto-width", align: "left", style: { font: "IBM Plex Sans", weight: 600, size: 48, fill: "#190F0B" }, spans: [{ text: "Наслов" }] },
      ],
    },
    { id: "s2", name: "2 · Празно", ...sq, children: [] },
    { id: "s3", name: "3 · Крај", ...sq, children: [] },
  ];
  return d;
}

const doc = () => store.getProject(project).doc;
const head = () => store.getProject(project).head;
const node = (id: string) => findItem(doc(), id)?.item as Node | undefined;
const shot = async (name: string) => EVIDENCE && (await page.screenshot({ path: join(outDir, `${name}.png`) }));
const ui = () =>
  page.evaluate(() => {
    const s = (window as any).__postStudio.useEditor.getState();
    return { selection: s.selection as string[], activeFrame: s.activeFrame as string, pending: s.save.pending as number, status: s.save.status as string, rev: s.save.rev as number, toasts: s.toasts.map((t: any) => t.text) as string[] };
  });
async function saved(minRev?: number) {
  await expect.poll(async () => {
    const s = await ui();
    return s.status === "saved" && s.pending === 0 && (minRev === undefined || s.rev >= minRev);
  }, { timeout: 15_000, interval: 100 }).toBe(true);
  return head();
}
/** Screen point of a frame point. */
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
async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}
const frameRect = (f: string) => page.evaluate((f) => document.querySelector(`svg[data-frame="${f}"]`)!.getBoundingClientRect().toJSON(), f);
const zoom = () => page.evaluate(() => (window as any).__postStudio.useEditor.getState().view.zoom as number);
const fit = () => page.keyboard.press("Shift+Digit1");
/** A paste event like the browser sends for Ctrl+V, with this text on the clipboard. */
const paste = (text: string) =>
  page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
const groupsIn = (f: number) => doc().frames[f].children.filter((n): n is GroupNode => n.type === "group");
const flat = (ns: Node[]): Node[] => ns.flatMap((n) => (n.type === "group" ? [n, ...flat(n.children)] : [n]));

async function openProject(id: string) {
  await page.goto(`${url}/p/${id}`);
  await page.waitForSelector('[data-testid="login-password"], [data-testid="editor"]', { timeout: 30_000 });
  if (await page.locator('[data-testid="login-password"]').count()) {
    await page.fill('[data-testid="login-password"]', PASSWORD);
    await page.press('[data-testid="login-password"]', "Enter");
  }
  await page.waitForSelector('[data-testid="editor"]', { timeout: 30_000 });
  await page.waitForSelector('svg[data-frame="s3"]');
}

describe.skipIf(!chrome)("movable frames, drag-select on a background, Figma both ways", () => {
  beforeAll(async () => {
    ensureEditorBuilt(() => undefined);
    outDir = EVIDENCE ? join(ROOT, "test-artifacts/frames-select-figma") : mkdtempSync(join(tmpdir(), "pstudio-figma-shots-"));
    mkdirSync(outDir, { recursive: true });
    dataDir = mkdtempSync(join(tmpdir(), "pstudio-figma-"));
    store = new Store({ dataDir, fonts: await FontRegistry.load() });
    store.auth.setPassword(PASSWORD);
    project = store.createProject(startDoc(), AGENT, "frames, select, figma").project;
    app = buildApp({ store, editorDir: EDITOR_DIST });
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: chrome, env: chromeEnv() as Record<string, string>, args: ["--no-sandbox", "--font-render-hinting=none"] });
    page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    await openProject(project);
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    store?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (!EVIDENCE && outDir) rmSync(outDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ 2. drag-select

  it("dragging from the background layer draws a selection box inside that frame", async () => {
    await shot("01-start");
    const rev = head();
    // Press on the background (an unselected full-frame rect) and drag around a and b.
    await drag(await at("s1", 50, 50), await at("s1", 450, 250));
    expect((await ui()).selection.sort()).toEqual(["a", "b"]);
    // Nothing moved, nothing was written.
    expect(node("bg")).toMatchObject({ x: 0, y: 0 });
    await page.waitForTimeout(300);
    expect(head()).toBe(rev);
    await shot("02-drag-select");
    // A box that crosses into the next frame still only picks layers of the frame it started in.
    await drag(await at("s1", 650, 650), await at("s2", 200, 850));
    expect((await ui()).selection).toEqual(["c"]);
    // A click (no drag) on the background still selects it…
    await page.mouse.click(...(Object.values(await at("s1", 600, 500)) as [number, number]));
    expect((await ui()).selection).toEqual(["bg"]);
    // …and once selected it drags like any layer (one revision); undo puts it back.
    await drag(await at("s1", 600, 500), await at("s1", 650, 520));
    let r = await saved(rev + 1);
    expect(node("bg")!.x).toBeGreaterThan(40);
    await page.keyboard.press("Control+z");
    r = await saved(r + 1);
    expect(node("bg")).toMatchObject({ x: 0, y: 0 });
    // Dragging an unselected ordinary layer still moves it straight away.
    await page.keyboard.press("Escape");
    await drag(await at("s1", 750, 750), await at("s1", 800, 750));
    r = await saved(r + 1);
    expect(node("c")!.x).toBeGreaterThan(740);
    expect(node("bg")).toMatchObject({ x: 0, y: 0 });
    await page.keyboard.press("Control+z");
    await saved(r + 1);
    expect(node("c")!.x).toBe(700);
  }, 60_000);

  it("a locked background works the same (it cannot be hit at all)", async () => {
    store.applyOps(project, { base: head(), ops: [{ op: "set", node: "bg", path: "locked", value: true }], message: "lock bg" }, HUMAN);
    await expect.poll(async () => page.evaluate(() => !!(window as any).__postStudio.useEditor.getState().doc.frames[0].children[0].locked), { timeout: 10_000 }).toBe(true);
    await page.keyboard.press("Escape");
    await drag(await at("s1", 50, 50), await at("s1", 450, 250));
    expect((await ui()).selection.sort()).toEqual(["a", "b"]);
    store.applyOps(project, { base: head(), ops: [{ op: "unset", node: "bg", path: "locked" }], message: "unlock bg" }, HUMAN);
    await expect.poll(async () => page.evaluate(() => !!(window as any).__postStudio.useEditor.getState().doc.frames[0].children[0].locked), { timeout: 10_000 }).toBe(false);
  }, 60_000);

  // ------------------------------------------------------------------ 1. movable frames

  it("dragging a frame's name label moves the frame; one revision, no diff noise; undo restores the row", async () => {
    await page.keyboard.press("Escape");
    await fit();
    const before = { s1: await frameRect("s1"), s2: await frameRect("s2"), s3: await frameRect("s3") };
    const z = await zoom();
    const rev = await saved();
    const label = (await page.locator('[data-testid="frame-label-s2"]').boundingBox())!;
    const from = { x: label.x + 10, y: label.y + label.height / 2 };
    // Down under s1: left edge on s1's, 300 px below it.
    const to = { x: from.x - (1080 + 160) * z, y: from.y + (1080 + 300) * z };
    await drag(from, to);
    const r = await saved(rev + 1);
    expect(r).toBe(rev + 1);
    const fr = doc().frames;
    expect(fr[1].canvas!.x).toBe(0); // snapped to s1's left edge
    expect(Math.abs(fr[1].canvas!.y - 1380)).toBeLessThanOrEqual(2);
    // The others got their current spot written down, so nothing else moved.
    expect(fr[0].canvas).toEqual({ x: 0, y: 0 });
    expect(fr[2].canvas).toEqual({ x: 2480, y: 0 });
    const after = { s1: await frameRect("s1"), s2: await frameRect("s2"), s3: await frameRect("s3") };
    expect(after.s1.left).toBeCloseTo(before.s1.left, 0);
    expect(after.s3.left).toBeCloseTo(before.s3.left, 0);
    expect(after.s2.top).toBeGreaterThan(after.s1.bottom);
    expect(after.s2.left).toBeCloseTo(after.s1.left, 0);
    // Not a design change: the agent's diff and pins do not see it.
    expect(store.diff(project, "created").items.filter((i) => i.itemKind === "frame")).toEqual([]);
    expect(store.softPins(project).filter((p) => p.path.startsWith("canvas"))).toEqual([]);
    await shot("03-frame-moved");
    // Fit all now includes the moved frame.
    await fit();
    const fitted = await frameRect("s2");
    expect(fitted.bottom).toBeLessThanOrEqual(900);
    // Undo: the automatic row is back.
    await page.keyboard.press("Control+z");
    await saved(r + 1);
    expect(doc().frames.map((f) => f.canvas)).toEqual([undefined, undefined, undefined]);
  }, 60_000);

  it("while an agent holds the lease the label only selects; nothing moves or is written", async () => {
    store.handoff(project, HUMAN, "look at the slides");
    store.takeLease(project, AGENT);
    await expect.poll(() => page.locator('[data-testid="banner"].lease').count(), { timeout: 10_000 }).toBe(1);
    const rev = head();
    const label = (await page.locator('[data-testid="frame-label-s3"]').boundingBox())!;
    await drag({ x: label.x + 10, y: label.y + 5 }, { x: label.x + 10, y: label.y + 400 });
    // Paste is refused too.
    await paste(FIGMA_SVG);
    await page.waitForTimeout(600);
    expect(head()).toBe(rev);
    expect(doc().frames[2].canvas).toBeUndefined();
    expect((await ui()).toasts.some((t) => /Read-only/.test(t))).toBe(true);
    store.handBack(project, AGENT, "nothing changed");
    await expect.poll(() => page.locator('[data-testid="banner"].lease').count(), { timeout: 10_000 }).toBe(0);
  }, 60_000);

  // ------------------------------------------------------------------ 3. export for Figma

  it("Export offers 'SVG for Figma' per frame (live text, no embedded fonts) and for all frames", async () => {
    await page.click('[data-testid="export"]');
    const href = (await page.getAttribute('[data-testid="export-figma-s1"]', "href"))!;
    expect(href).toMatch(/format=figma/);
    expect(await page.getAttribute('[data-testid="export-figma-s1"]', "download")).toMatch(/^s1-rev\d+\.figma\.svg$/);
    expect(await page.locator('[data-testid="export-figma-all"]').count()).toBe(1);
    await shot("04-export-menu");
    const [figma, plain] = await page.evaluate(async (h) => Promise.all([fetch(h).then((r) => r.text()), fetch(h.replace("format=figma", "format=svg")).then((r) => r.text())]), href);
    expect(figma).toContain("<text");
    expect(figma).toContain("Наслов");
    expect(figma).not.toContain("@font-face");
    expect(plain).toContain("@font-face");
    // "All frames" downloads one file per frame.
    const downloads: string[] = [];
    page.on("download", (d) => downloads.push(d.suggestedFilename()));
    await page.click('[data-testid="export-figma-all"]');
    await expect.poll(() => downloads.length, { timeout: 10_000 }).toBe(3);
    expect(downloads.sort()).toEqual(["s1", "s2", "s3"].map((f) => `${f}-rev${head()}.figma.svg`));
  }, 60_000);

  // ------------------------------------------------------------------ 4. Figma → Post Studio

  it("pasting Figma's Copy as SVG adds editable layers in a group in the active frame", async () => {
    await page.keyboard.press("Escape");
    await page.click('[data-testid="frame-label-s2"]');
    expect((await ui()).activeFrame).toBe("s2");
    const rev = await saved();
    await paste(FIGMA_SVG);
    await expect.poll(() => groupsIn(1).length, { timeout: 15_000 }).toBe(1);
    const r = await saved(rev + 1);
    expect(r).toBe(rev + 1);
    const g = groupsIn(1)[0];
    // Centred in the 1080 frame (the selection was 600 × 400).
    expect(g).toMatchObject({ x: 240, y: 340, w: 600, h: 400, meta: { insertedFrom: "svg" } });
    const kids = flat(g.children);
    expect(kids.find((n) => n.name === "Badge")).toMatchObject({ type: "rect", x: 40, y: 260, radius: 12, fill: "#AC1922" });
    expect(kids.find((n) => n.name === "Card")).toMatchObject({ type: "rect", radius: 24 });
    expect(kids.find((n) => n.type === "ellipse")).toMatchObject({ x: 420, y: 60, w: 120, h: 120 });
    const t = kids.find((n) => n.type === "text") as Extract<Node, { type: "text" }>;
    expect(t.spans.map((s) => s.text).join("")).toBe("Исти модели,\nразлични резултати");
    expect(t.style).toMatchObject({ font: "IBM Plex Sans", weight: 600, size: 48 });
    // The gradient stayed a picture, uploaded through /v1/assets (so it was sanitized).
    const pic = kids.find((n) => n.type === "svg") as Extract<Node, { type: "svg" }>;
    expect(pic).toMatchObject({ x: 299, y: 219 });
    expect(store.hasAsset(pic.asset.slice(7))).toBe(true);
    expect((await ui()).selection).toEqual([g.id]);
    expect((await ui()).toasts.some((x) => /editable text/.test(x) && /Kept as picture: 1 × gradient/.test(x))).toBe(true);
    expect(store.revisions(project).at(-1)!.author).toBe("human");
    await shot("05-pasted-svg");
    // The text is a real text layer: double-click into the group, then into the text, and type.
    await page.keyboard.press("Control+z");
    await saved(r + 1);
    expect(groupsIn(1).length).toBe(0);
  }, 60_000);

  it("the SVG button and a drop make layers too; Shift keeps one picture", async () => {
    let rev = await saved();
    // SVG button → layers.
    await page.setInputFiles('[data-testid="svg-input"]', { name: "badge.svg", mimeType: "image/svg+xml", buffer: Buffer.from(FIGMA_SVG) });
    await expect.poll(() => groupsIn(1).length, { timeout: 15_000 }).toBe(1);
    rev = await saved(rev + 1);
    expect(groupsIn(1)[0].name).toBe("badge");
    // Shift+click the SVG button → one picture, as before.
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-testid="add-svg"]', { modifiers: ["Shift"] })]);
    await chooser.setFiles({ name: "whole.svg", mimeType: "image/svg+xml", buffer: Buffer.from(FIGMA_SVG) });
    await expect.poll(() => doc().frames[1].children.filter((n) => n.type === "svg").length, { timeout: 15_000 }).toBe(1);
    rev = await saved(rev + 1);
    // A drop → layers; Shift while dropping → one picture.
    const drop = (shift: boolean) =>
      page.evaluate(
        ([svg, shift]) => {
          const dt = new DataTransfer();
          dt.items.add(new File([svg as string], "dropped.svg", { type: "image/svg+xml" }));
          document.querySelector("section.center")!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, shiftKey: shift as boolean }));
        },
        [FIGMA_SVG, shift] as const,
      );
    await drop(false);
    await expect.poll(() => groupsIn(1).length, { timeout: 15_000 }).toBe(2);
    rev = await saved(rev + 1);
    await drop(true);
    await expect.poll(() => doc().frames[1].children.filter((n) => n.type === "svg").length, { timeout: 15_000 }).toBe(2);
    rev = await saved(rev + 1);
    await shot("06-button-drop");
    // Clean up the frame for the next test (four undo steps).
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Control+z");
      rev = await saved(rev + 1);
    }
    expect(doc().frames[1].children).toEqual([]);
  }, 90_000);

  it("our own copy / paste of layers still works, also when the clipboard says it is ours", async () => {
    await page.mouse.click(...(Object.values(await at("s1", 150, 150)) as [number, number]));
    expect((await ui()).selection).toEqual(["a"]);
    const rects = () => doc().frames[0].children.filter((n) => n.type === "rect").length;
    const n0 = rects();
    let rev = await saved();
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    await expect.poll(rects, { timeout: 10_000 }).toBe(n0 + 1);
    rev = await saved(rev + 1);
    // A paste event carrying our own marker pastes the layers, not text or SVG.
    await paste("post-studio/layers 1");
    await expect.poll(rects, { timeout: 10_000 }).toBe(n0 + 2);
    rev = await saved(rev + 1);
    // Text that is not SVG (and no layers marker) falls back to our layers too, never inserts text.
    await paste("just some words <svg");
    await expect.poll(rects, { timeout: 10_000 }).toBe(n0 + 3);
    await saved(rev + 1);
    expect([...walk(doc())].some((l) => (l.item as Node).type === "text" && JSON.stringify(l.item).includes("just some words"))).toBe(false);
    rev = head();
    // A PNG on the clipboard (Figma's Copy as PNG) pastes as an image layer.
    const png = readFileSync(join(ROOT, "fixtures/assets/logo-on-paper.png")).toString("base64");
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, png);
    await expect.poll(() => doc().frames[0].children.filter((n) => n.type === "image").length, { timeout: 10_000 }).toBe(1);
    await saved(rev + 1);
  }, 60_000);

  it("no browser errors", () => {
    expect(errors).toEqual([]);
  });
});
