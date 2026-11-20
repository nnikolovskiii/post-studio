/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Motion Part 3 (PLAN-motion.md §6.1, §8 Part 3): the desktop timeline in headless Chrome
// (Playwright, the installed headless shell) against an in-process server on a temp data dir.
//
//   add motion · a preset with stagger · scrub · drag a keyframe (one revision, soft pin) · the
//   keyframe popover (explicit pin) · drag a bar, Alt-drag its end · Animate on writes a keyframe
//   at the playhead, Animate off moves the layout · undo / redo of each step · playback writes
//   nothing · agent changes outlined on keyframes · canvas vs `render --at` at 5 moments ·
//   Download video · playback frame rate on LUX-6 (310 nodes, every layer animated).
//
// MOTION3_EVIDENCE=1 keeps screenshots and numbers in test-artifacts/motion-part3/.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Document, Node } from "@post-studio/schema";
import { findItem } from "@post-studio/schema";
import { apply, type Op } from "@post-studio/ops";
import { presetOps, readingOrder } from "@post-studio/motion";
import { importSocialPost } from "@post-studio/import";
import { chromeEnv, chromeRenderSvg, comparePng, findChrome, findFfmpeg, type PixelDiff } from "@post-studio/render";
import { Store, buildApp } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { EDITOR_DIST, ensureEditorBuilt } from "../build-if-stale.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EVIDENCE = !!process.env.MOTION3_EVIDENCE;
const PASSWORD = "e2e motion horse battery";
const chrome = findChrome();
const ffmpeg = findFfmpeg();

let dataDir: string;
let outDir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
let url: string;
let browser: Browser;
let page: Page;
let agentToken: string;
/** Imported LUX-6 (still): the editing steps. */
let project: string;
/** fixtures/lux-6-motion.json: pixel checks and the video. */
let fixture: string;
/** Imported LUX-6 with every layer animated: the playback measurement. */
let heavy: string;
const errors: string[] = [];
const numbers: Record<string, unknown> = {};
const AGENT = { author: "agent:claude" };

// ---- helpers
const head = (p = project) => store.getProject(p).head as number;
const doc = (p = project): Document => store.getProject(p).doc as Document;
const node = (id: string, d = doc()): Node => {
  const loc = findItem(d, id);
  if (!loc || loc.kind !== "node") throw new Error(`no node ${id}`);
  return loc.item as Node;
};
const kf = (id: string, track: string, key: string, d = doc()) => (node(id, d).anim?.tracks as any)?.[track]?.[key];
const shot = (name: string) => page.screenshot({ path: join(outDir, `${name}.png`) });
const ui = () =>
  page.evaluate(() => {
    const ps = (window as any).__postStudio;
    const s = ps.useEditor.getState();
    const t = ps.useTime.getState();
    return { selection: s.selection as string[], undo: s.undo.length as number, redo: s.redo.length as number, save: s.save, zoom: s.view.zoom as number, t: t.t as number, playing: t.playing as boolean, animate: t.animate as boolean, pins: s.pins };
  });
const setUi = (patch: Record<string, unknown>) => page.evaluate((p) => (window as any).__postStudio.useEditor.setState(p), patch);
const setTime = (patch: Record<string, unknown>) => page.evaluate((p) => (window as any).__postStudio.useTime.setState(p), patch);

async function saved(minRev?: number, p = project) {
  await expect
    .poll(
      async () => {
        const s = (await ui()).save;
        return s.status === "saved" && s.pending === 0 && (minRev === undefined || s.rev >= minRev);
      },
      { timeout: 15_000, interval: 100 },
    )
    .toBe(true);
  return head(p);
}

async function box(sel: string) {
  const r = await page.locator(sel).first().boundingBox();
  if (!r) throw new Error(`no element ${sel}`);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.x, right: r.x + r.width };
}

async function centre(id: string) {
  return page.evaluate((id) => {
    const r = document.querySelector(`[data-testid="canvas"] #${CSS.escape(id)}`)!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }, mods: Array<"Shift" | "Alt" | "Control"> = []) {
  await page.mouse.move(from.x, from.y);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
}

/** px per ms of the timeline (ruler width / duration). */
async function pxPerMs() {
  const r = await box('[data-testid="tl-ruler"]');
  return (r.right - r.left) / doc().motion!.duration;
}

const fmt = (d: PixelDiff) => ({
  meanChannelError: +d.meanChannelError.toFixed(5),
  pixelsOver16: `${(d.pixelsOverFraction * 100).toFixed(3)} %`,
  blurredPixelsOver16: `${(d.blurredPixelsOverFraction * 100).toFixed(3)} %`,
  shiftTolerantPixelsOver16: `${(d.shiftTolerantPixelsOverFraction * 100).toFixed(3)} %`,
});

/** Frames + motion: what undo / redo must bring back exactly. */
const content = (d: Document) => JSON.stringify({ frames: d.frames, motion: d.motion ?? null });

describe.skipIf(!chrome)("motion timeline end to end (headless Chrome)", () => {
  /** Document content after each editing step, for the undo / redo walk. */
  const steps: Array<{ label: string; content: string }> = [];

  beforeAll(async () => {
    ensureEditorBuilt(() => undefined);
    outDir = EVIDENCE ? join(ROOT, "test-artifacts/motion-part3") : mkdtempSync(join(tmpdir(), "pstudio-motion3-shots-"));
    mkdirSync(outDir, { recursive: true });
    dataDir = mkdtempSync(join(tmpdir(), "pstudio-motion3-"));
    store = new Store({ dataDir, fonts: await FontRegistry.load() });
    store.auth.setPassword(PASSWORD);
    agentToken = store.createToken("claude", "agent").token;
    const upload = async (b: Uint8Array, name: string) => store.addAsset(b, AGENT, name);
    const { doc: imported } = await importSocialPost(join(ROOT, "fixtures/social-posts/lux-6-judge-compare"), { fonts: store.fonts, upload });
    project = store.createProject(imported, AGENT, "import LUX-6").project;
    // The motion fixture refers to the hand LUX-6 logo.
    store.addAsset(readFileSync(join(ROOT, "fixtures/assets/logo-on-paper.png")), AGENT, "logo-on-paper.png");
    fixture = store.createProject(JSON.parse(readFileSync(join(ROOT, "fixtures/lux-6-motion.json"), "utf8")), AGENT, "motion fixture").project;
    // Every layer of both frames animated: top-level layers slide up in reading order, the
    // chart's children grow / pop inside the group (nested wrappers), the status fades out.
    let h = imported;
    const step = (ops: unknown[]) => (h = apply(h, ops as Op[]).doc);
    for (const f of imported.frames) {
      const top = f.children.map((c) => c.id);
      step(presetOps(h, readingOrder(h, top), "slide-up-in", { at: 0, dur: 600, stagger: 60 }));
      const chart = f.children.find((c) => c.type === "group") as Extract<Node, { type: "group" }>;
      step(presetOps(h, readingOrder(h, chart.children.map((c) => c.id)), "pop", { at: 900, dur: 500, stagger: 40 }));
      step(presetOps(h, [f.children.at(-1)!.id], "fade-out", { at: 5000, dur: 500 }));
    }
    heavy = store.createProject({ ...h, title: "LUX-6 every layer animated" }, AGENT, "motion perf fixture").project;
    app = buildApp({ store, editorDir: EDITOR_DIST });
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: chrome, env: chromeEnv() as Record<string, string>, args: ["--no-sandbox", "--font-render-hinting=none"] });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    page.on("dialog", (d) => void d.accept());
  }, 180_000);

  afterAll(async () => {
    if (EVIDENCE) writeFileSync(join(outDir, "motion-part3-numbers.json"), JSON.stringify({ when: new Date().toISOString(), ...numbers }, null, 2) + "\n");
    await browser?.close();
    await app?.close();
    store?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (!EVIDENCE && outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("logs in and adds motion to a still post (one revision, the timeline opens)", async () => {
    await page.goto(url + "/");
    await page.fill('[data-testid="login-password"]', PASSWORD);
    await page.click('[data-testid="login-submit"]');
    await page.goto(`${url}/p/${project}`);
    await page.waitForSelector('svg[data-frame="square"]', { timeout: 30_000 });
    expect(await page.locator('[data-testid="timeline"]').count()).toBe(0);
    expect(await page.locator('[data-testid="download-video"]').count()).toBe(0);
    steps.push({ label: "start", content: content(doc()) });
    const before = head();
    await page.click('[data-testid="add-motion"]');
    await saved(before + 1);
    expect(head()).toBe(before + 1);
    expect(doc().motion).toEqual({ duration: 6000, fps: 30, loop: true });
    await page.waitForSelector('[data-testid="timeline"]');
    expect(await page.locator('[data-testid="add-motion"]').count()).toBe(0);
    expect(await page.textContent('[data-testid="tl-time"]')).toMatch(/0\.00 s \/ 6\.00 s/);
    steps.push({ label: "add motion", content: content(doc()) });
    await shot("01-motion-added");
  }, 90_000);

  it("puts a preset on three layers with a stagger, in reading order, at the playhead", async () => {
    const before = head();
    const order = readingOrder(doc(), ["headline", "sub", "kicker"]);
    await setUi({ selection: ["headline", "sub", "kicker"] });
    await page.click('[data-testid="tl-add"]');
    await page.fill('[data-testid="preset-stagger"]', "0.1");
    await page.click('[data-testid="preset-slide-up-in"]');
    await saved(before + 1);
    expect(head()).toBe(before + 1);
    order.forEach((id, i) => {
      expect(kf(id, "dy", "in1")).toEqual({ t: i * 100, v: 40, ease: "out" });
      expect(kf(id, "dy", "in2")).toEqual({ t: i * 100 + 600, v: 0 });
      expect(kf(id, "opacity", "in1")).toEqual({ t: i * 100, v: 0, ease: "out" });
    });
    for (const id of order) await page.waitForSelector(`[data-testid="tl-bar-${id}"]`);
    numbers.presetOrder = order;
    steps.push({ label: "preset with stagger", content: content(doc()) });
    await shot("02-preset-stagger");
  }, 60_000);

  it("scrubs: the canvas draws that moment, nothing is written", async () => {
    const before = head();
    const k = await pxPerMs();
    const r = await box('[data-testid="tl-ruler"]');
    // Drag the playhead to about 0.35 s: the headline is half way up.
    await drag({ x: r.left + 2, y: r.y }, { x: r.left + 350 * k, y: r.y });
    const t = (await ui()).t;
    expect(Math.abs(t - 350)).toBeLessThanOrEqual(40);
    expect(Math.round((Math.round((t * 30) / 1000) * 1000) / 30)).toBe(t); // a frame time
    const g = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="canvas"] svg[data-frame="square"] [data-anim="headline"]')!;
      return { transform: el.getAttribute("transform"), opacity: Number(el.getAttribute("opacity")) };
    });
    expect(g.transform).toMatch(/^translate\(0 [\d.]+\)$/);
    expect(g.opacity).toBeGreaterThan(0);
    expect(g.opacity).toBeLessThan(1);
    // Step one frame with "." and back with ","; Home goes to 0.
    await page.mouse.click(5, 995);
    await page.keyboard.press(".");
    expect((await ui()).t).toBe(Math.round(((Math.round((t * 30) / 1000) + 1) * 1000) / 30));
    await page.keyboard.press(",");
    expect((await ui()).t).toBe(t);
    await page.keyboard.press("Home");
    expect((await ui()).t).toBe(0);
    await page.waitForTimeout(1200);
    expect(head()).toBe(before);
    await setTime({ t });
    await shot("03-scrub");
  }, 60_000);

  it("drags a keyframe: one revision, the time snaps, a soft pin appears; the popover pins it", async () => {
    // An agent turn first (no changes): his earlier work is no longer soft-pinned after it.
    store.handoff(project, { author: "human" }, "look at the timing");
    store.handBack(project, AGENT, "looked at the timing; nothing changed");
    await expect.poll(async () => (await ui()).pins?.since, { timeout: 10_000 }).toBe("agent-1");
    await page.waitForSelector('[data-testid="agent-changes"]', { timeout: 10_000 });
    await page.click('[data-testid="agent-changes"] .agent-card-head button');
    const before = head();
    await page.click('[data-testid="tl-expand-headline"]');
    const sel = '[data-testid="kf-headline-dy-in2"]';
    await page.waitForSelector(sel);
    expect(await page.getAttribute(sel, "data-pin")).toBe("");
    const t0 = kf("headline", "dy", "in2").t;
    const a = await box(sel);
    const k = await pxPerMs();
    await drag(a, { x: a.x + 300 * k, y: a.y });
    await saved(before + 1);
    expect(head()).toBe(before + 1);
    const t1 = kf("headline", "dy", "in2").t;
    expect(Math.abs(t1 - (t0 + 300))).toBeLessThanOrEqual(6 / k + 17);
    expect(kf("headline", "dy", "in2").v).toBe(0);
    expect(kf("headline", "opacity", "in2").t).toBe(t0); // only the dragged keyframe moved
    expect(kf("headline", "dy", "in1").t).toBe(kf("headline", "opacity", "in1").t);
    const rev = store.revisions(project, { withOps: true }).at(-1)!;
    expect(rev.ops).toEqual([{ op: "set", node: "headline", path: "anim.tracks.dy.in2.t", value: t1 }]);
    // The server's soft pins come back: dashed pin on that keyframe only.
    await expect.poll(() => page.getAttribute(sel, "data-pin"), { timeout: 10_000 }).toBe("soft");
    expect(await page.getAttribute('[data-testid="kf-headline-opacity-in2"]', "data-pin")).toBe("");
    numbers.keyframeDrag = { from: t0, to: t1, pxPerMs: +k.toFixed(4) };
    steps.push({ label: "drag keyframe", content: content(doc()) });
    // Click (no drag) opens the popover; "Pin keyframe" writes an explicit pin.
    const b = await box(sel);
    await page.mouse.click(b.x, b.y);
    await page.waitForSelector('[data-testid="kf-popover"]');
    expect(await page.inputValue('[data-testid="kf-time"]')).toBe(String(t1 / 1000));
    await page.click('[data-testid="kf-pin"]');
    await saved(before + 2);
    expect(node("headline").pins).toEqual(["anim.tracks.dy.in2"]);
    await expect.poll(() => page.getAttribute(sel, "data-pin")).toBe("explicit");
    steps.push({ label: "pin keyframe", content: content(doc()) });
    // Ease from the popover (one revision).
    await page.click('[data-testid="kf-ease-in-out"]');
    await saved(before + 3);
    expect(kf("headline", "dy", "in2").ease).toBe("in-out");
    steps.push({ label: "ease", content: content(doc()) });
    await shot("04-keyframe-popover");
    await page.keyboard.press("Escape");
    expect(await page.locator('[data-testid="kf-popover"]').count()).toBe(0);
  }, 60_000);

  it("Shift-selects keyframes on two tracks and drags them together", async () => {
    const before = head();
    const a = await box('[data-testid="kf-headline-dy-in1"]');
    await page.mouse.click(a.x, a.y);
    const b = await box('[data-testid="kf-headline-opacity-in1"]');
    await page.keyboard.down("Shift");
    await page.mouse.click(b.x, b.y);
    await page.keyboard.up("Shift");
    expect(await page.evaluate(() => (window as any).__postStudio.useTime.getState().selectedKeys.length)).toBe(2);
    const t0 = kf("headline", "dy", "in1").t;
    const k = await pxPerMs();
    await drag(a, { x: a.x + 200 * k, y: a.y });
    await saved(before + 1);
    expect(head()).toBe(before + 1);
    const t1 = kf("headline", "dy", "in1").t;
    expect(t1).toBeGreaterThan(t0);
    expect(kf("headline", "opacity", "in1").t).toBe(t1);
    steps.push({ label: "drag two keyframes", content: content(doc()) });
  }, 60_000);

  it("drags a bar to shift a layer's motion, Alt-drags its end to stretch it", async () => {
    const id = numbersOrder()[2];
    const before = head();
    const times = () => Object.values(node(id).anim!.tracks!).flatMap((t) => Object.values(t!).map((x) => x.t));
    const t0 = times();
    const bar = await box(`[data-testid="tl-bar-${id}"]`);
    const k = await pxPerMs();
    await drag({ x: bar.x, y: bar.y }, { x: bar.x + 500 * k, y: bar.y });
    await saved(before + 1);
    expect(head()).toBe(before + 1);
    const t1 = times();
    const delta = t1[0] - t0[0];
    expect(Math.abs(delta - 500)).toBeLessThanOrEqual(6 / k + 17);
    expect(t1).toEqual(t0.map((t) => t + delta));
    steps.push({ label: "shift bar", content: content(doc()) });
    // Alt-drag the right end: the start stays, the length doubles (about).
    const [s0, e0] = [Math.min(...t1), Math.max(...t1)];
    const end = await box(`[data-testid="tl-bar-end-${id}"]`);
    await drag(end, { x: end.x + (e0 - s0) * k, y: end.y }, ["Alt"]);
    await saved(before + 2);
    const t2 = times();
    expect(Math.min(...t2)).toBe(s0);
    expect(Math.abs(Math.max(...t2) - (s0 + 2 * (e0 - s0)))).toBeLessThanOrEqual(6 / k + 17);
    steps.push({ label: "stretch bar", content: content(doc()) });
    await shot("05-bar");
  }, 60_000);

  it("Animate on: dragging a layer writes keyframes at the playhead; Animate off moves the layout", async () => {
    await setTime({ t: 2000 });
    await page.click('[data-testid="tl-animate"]');
    expect((await ui()).animate).toBe(true);
    const x0 = node("logo").x;
    let before = head();
    const c = await centre("logo");
    const z = (await ui()).zoom;
    // To the left: to the right the moved logo would end up under the footer text.
    await drag(c, { x: c.x - 30, y: c.y });
    await saved(before + 1);
    expect(head()).toBe(before + 1);
    expect(node("logo").x).toBe(x0); // the layout did not move
    const dx = node("logo").anim!.tracks!.dx!;
    expect(Object.keys(dx).sort()).toEqual(["k1", "k2"]);
    expect(dx.k1).toEqual({ t: 0, v: 0 }); // neutral keyframe where the motion starts
    expect(dx.k2.t).toBe(2000);
    expect(Math.abs(dx.k2.v - -30 / z)).toBeLessThanOrEqual(1 / z + 0.01);
    expect(node("logo").anim!.tracks!.dy).toBeUndefined(); // a horizontal drag writes no dy
    // The canvas shows it at the playhead, with a ghost at its rest pose.
    await expect.poll(() => page.locator('[data-testid="ghost-logo"]').count()).toBe(1);
    steps.push({ label: "animate move", content: content(doc()) });
    // The opacity field writes an opacity keyframe at the playhead.
    await page.fill('[data-testid="prop-anim-opacity"]', "50");
    await page.keyboard.press("Enter");
    before = head();
    await saved(before + 1);
    expect(Object.values(node("logo").anim!.tracks!.opacity!).map((x) => [x.t, x.v]).sort()).toEqual([[0, 1], [2000, 0.5]]);
    steps.push({ label: "animate opacity", content: content(doc()) });
    await shot("06-animate-on");
    // Animate off: the same gesture moves the layout; keyframes stay as they were.
    await page.click('[data-testid="tl-animate"]');
    expect((await ui()).animate).toBe(false);
    const anim = JSON.stringify(node("logo").anim);
    before = head();
    const c2 = await centre("logo");
    await drag(c2, { x: c2.x - 20, y: c2.y });
    await saved(before + 1);
    expect(Math.abs(node("logo").x - (x0 - 20 / z))).toBeLessThanOrEqual(7 / z); // snapping may pull it a few px
    expect(JSON.stringify(node("logo").anim)).toBe(anim);
    steps.push({ label: "layout move", content: content(doc()) });
  }, 60_000);

  it("playback writes nothing (no revision, no undo step, no autosave)", async () => {
    const before = { head: head(), undo: (await ui()).undo };
    await setTime({ t: 0 });
    await page.mouse.click(5, 995);
    await page.keyboard.press("k");
    await expect.poll(async () => (await ui()).playing).toBe(true);
    await page.waitForTimeout(1500);
    await page.keyboard.press("k");
    const s = await ui();
    expect(s.playing).toBe(false);
    expect(s.t).toBeGreaterThan(600);
    expect(s.undo).toBe(before.undo);
    expect(s.save).toMatchObject({ status: "saved", pending: 0 });
    await page.waitForTimeout(1500);
    expect(head()).toBe(before.head);
  }, 30_000);

  it("undo and redo walk back and forward through every motion step", async () => {
    const states = steps.slice(1);
    // Undo each step (newest first): the document matches the state before it.
    for (let i = states.length - 1; i >= 0; i--) {
      const rev = head();
      await page.mouse.click(5, 995);
      await page.keyboard.press("Control+z");
      await saved(rev + 1);
      expect(content(doc()), `undo ${states[i].label}`).toBe(steps[i].content);
    }
    expect(doc().motion).toBeUndefined();
    await page.waitForSelector('[data-testid="add-motion"]');
    for (let i = 0; i < states.length; i++) {
      const rev = head();
      await page.keyboard.press("Control+Shift+z");
      await saved(rev + 1);
      expect(content(doc()), `redo ${states[i].label}`).toBe(states[i].content);
    }
    await page.waitForSelector('[data-testid="timeline"]');
    numbers.undoRedoSteps = states.map((s) => s.label);
  }, 120_000);

  it("outlines keyframes the agent changed after its hand-back", async () => {
    await page.click('[data-testid="handoff"]');
    await page.fill('[data-testid="handoff-note"]', "make the intro punchier");
    await page.click('[data-testid="handoff-send"]');
    await expect.poll(() => store.handoffState(project).turn, { timeout: 10_000 }).toBe("agent");
    store.takeLease(project, AGENT);
    // His layers' motion is soft-pinned (he redid it), so the agent animates the rule under the
    // header and leaves his timing alone. A write to his headline motion is refused.
    expect(() => store.applyOps(project, { base: head(), ops: [{ op: "set", node: "headline", path: "anim.tracks.dy.in2.t", value: 300 }], message: "x" }, AGENT)).toThrow(/pinned/);
    store.applyOps(
      project,
      {
        base: head(),
        ops: [
          { op: "set", node: "line-03", path: "anim.origin", value: "left" },
          { op: "set", node: "line-03", path: "anim.tracks.scaleX.a1", value: { t: 100, v: 0, ease: "back-out" } },
          { op: "set", node: "line-03", path: "anim.tracks.scaleX.a2", value: { t: 700, v: 1 } },
        ],
        message: "punchier: the rule grows in",
      },
      AGENT,
    );
    store.handBack(project, AGENT, "punchier headline fade");
    await page.waitForSelector('[data-testid="agent-changes"]', { timeout: 10_000 });
    await expect.poll(() => page.textContent('[data-testid="agent-changes"]'), { timeout: 10_000 }).toMatch(/line-03/);
    await page.click('[data-testid="tl-expand-line-03"]');
    await expect.poll(() => page.locator('[data-testid="kf-line-03-scaleX-a1"].agent-changed').count(), { timeout: 10_000 }).toBe(1);
    expect(await page.locator('[data-testid="kf-line-03-scaleX-a2"].agent-changed').count()).toBe(1);
    expect(await page.locator('[data-testid="tl-bar-line-03"].agent-changed').count()).toBe(1);
    // His timing is shown pinned (dashed: changed since the agent's last turn, or solid).
    expect(await page.getAttribute('[data-testid="kf-headline-dy-in2"]', "data-pin")).toBe("explicit");
    expect(await page.locator('[data-testid="kf-headline-dy-in1"].agent-changed').count()).toBe(0);
    expect(await page.locator('[data-testid="tl-bar-headline"].agent-changed').count()).toBe(0);
    await shot("07-agent-changes");
  }, 60_000);

  it("draws exactly what `render --at` exports, at 5 moments", async () => {
    await page.goto(`${url}/p/${fixture}`);
    await page.waitForSelector('svg[data-frame="square"]', { timeout: 30_000 });
    await page.waitForSelector('[data-testid="timeline"]');
    await page.setViewportSize({ width: 2400, height: 1700 });
    await page.click('[data-testid="tl-collapse"]');
    await setUi({ showGuides: false, hover: null, selection: [], snapLines: [], view: { zoom: 1, x: 40, y: 40 } });
    await page.mouse.move(1200, 10);
    const rev = head(fixture);
    const f = doc(fixture).frames[0];
    const results: Record<string, unknown> = {};
    // Mid-fade headline, the typewriter half way, the pops overshooting, the end.
    for (const t of [0, 400, 1000, 1567, 5400]) {
      await setTime({ t });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(250);
      const clip = await page.evaluate(() => {
        const r = document.querySelector('svg[data-frame="square"]')!.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      });
      expect(clip).toEqual({ x: Math.round(clip.x), y: Math.round(clip.y), width: f.w, height: f.h });
      expect(await page.getAttribute('svg[data-frame="square"]', "data-time")).toBe(String(t));
      const canvas = await page.screenshot({ clip });
      const get = (fmt: string) => app.inject({ method: "GET", url: `/v1/projects/${fixture}/render?frame=square&format=${fmt}&rev=${rev}&t=${t}`, headers: { authorization: `Bearer ${agentToken}` } });
      const png = await get("png");
      expect(png.statusCode).toBe(200);
      expect(png.headers["x-post-studio-time"]).toBe(String(t));
      const chromeSvg = await chromeRenderSvg((await get("svg")).body, f.w, f.h, { hinting: false });
      const vsSvg = await comparePng(canvas, chromeSvg);
      const vsPng = await comparePng(canvas, png.rawPayload);
      writeFileSync(join(outDir, `08-canvas-${t}.png`), canvas);
      writeFileSync(join(outDir, `08-render-${t}.png`), png.rawPayload);
      results[`${t} ms`] = { canvasVsRenderAtPng: fmt(vsPng), canvasVsRenderAtSvgInChrome: fmt(vsSvg) };
      // Same markup in the same engine: pixel for pixel (the Phase 3 tolerance).
      expect(vsSvg.meanChannelError).toBeLessThan(0.0005);
      expect(vsSvg.pixelsOverFraction).toBeLessThan(0.0005);
      expect(vsSvg.shiftTolerantPixelsOverFraction).toBeLessThan(0.0002);
      // Against resvg's PNG: the Phase 3 renderer gap (text hinting / edges), nothing more.
      expect(vsPng.meanChannelError).toBeLessThan(0.006);
      expect(vsPng.pixelsOverFraction).toBeLessThan(0.026);
      expect(vsPng.blurredPixelsOverFraction).toBeLessThan(0.026);
    }
    numbers.canvasVsRenderAt = results;
    // A wrong moment is caught: 1000 ms on the canvas against the export at 1100 ms.
    await setTime({ t: 1000 });
    await page.waitForTimeout(250);
    const clip = await page.evaluate(() => {
      const r = document.querySelector('svg[data-frame="square"]')!.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    const canvas = await page.screenshot({ clip });
    const other = await app.inject({ method: "GET", url: `/v1/projects/${fixture}/render?frame=square&format=svg&rev=${rev}&t=1100`, headers: { authorization: `Bearer ${agentToken}` } });
    const wrong = await comparePng(canvas, await chromeRenderSvg(other.body, f.w, f.h, { hinting: false }));
    numbers.wrongMomentSensitivity = { "canvas 1000 ms vs export 1100 ms": fmt(wrong) };
    expect(wrong.pixelsOverFraction).toBeGreaterThan(0.002);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.click('[data-testid="tl-collapse"]');
  }, 120_000);

  it.skipIf(!ffmpeg)("Download video: the MP4 of the saved revision, with progress", async () => {
    const download = page.waitForEvent("download", { timeout: 120_000 });
    await page.click('[data-testid="download-video"]');
    await expect.poll(() => page.getAttribute('[data-testid="download-video"]', "data-status"), { timeout: 120_000, interval: 200 }).toBe("done");
    const d = await download;
    expect(d.suggestedFilename()).toMatch(/\.mp4$/);
    const path = join(outDir, "09-video.mp4");
    await d.saveAs(path);
    const bytes = readFileSync(path);
    expect(bytes.subarray(4, 8).toString()).toBe("ftyp");
    const job = await page.getAttribute('[data-testid="download-video"]', "data-job");
    const res = await app.inject({ method: "GET", url: `/v1/video-jobs/${job}`, headers: { authorization: `Bearer ${agentToken}` } });
    expect(res.json().job).toMatchObject({ status: "done", frames: 180, rev: head(fixture), frame: "square" });
    numbers.video = { bytes: bytes.length, ms: res.json().job.ms };
    if (!EVIDENCE) rmSync(path);
  }, 150_000);

  it("plays LUX-6 with every layer animated (310 nodes): frame rate measured", async () => {
    await page.goto(`${url}/p/${heavy}`);
    await page.waitForSelector('svg[data-frame="li"]', { timeout: 30_000 });
    await page.waitForSelector('[data-testid="timeline"]');
    await page.mouse.click(5, 995);
    const before = head(heavy);
    const animated = await page.evaluate(() => document.querySelectorAll("[data-anim]").length);
    const measure = async (seconds: number) =>
      page.evaluate(async (ms) => {
        const ps = (window as any).__postStudio;
        const paints0 = ps.perf.paints.square ?? 0;
        const gaps: number[] = [];
        let last = performance.now();
        let running = true;
        const tick = (now: number) => {
          gaps.push(now - last);
          last = now;
          if (running) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const t0 = performance.now();
        await new Promise((r) => setTimeout(r, ms));
        running = false;
        const elapsed = performance.now() - t0;
        const painted = (ps.perf.paints.square ?? 0) - paints0;
        gaps.sort((a, b) => a - b);
        return { painted, expected: Math.floor((elapsed * 30) / 1000), elapsedMs: Math.round(elapsed), fps: +(painted / (elapsed / 1000)).toFixed(1), rafFps: +(gaps.length / (elapsed / 1000)).toFixed(1), p95FrameMs: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1), maxFrameMs: +gaps[gaps.length - 1].toFixed(1) };
      }, seconds * 1000);
    await page.keyboard.press("k");
    await page.waitForTimeout(300);
    const r = await measure(4);
    await page.keyboard.press("k");
    numbers.playback = { project: "LUX-6 imported, 2 frames, 310 nodes, every layer animated (incl. 24 nested chart children per frame)", animatedWrappersInDom: animated, motionFps: 30, ...r };
    // The preview changes the picture once per motion frame (30 fps at most). Measured alone on
    // the server: 29.5 (118 of 120 frames). Inside `pnpm check` the other test process encodes
    // videos on the same cores (measured 23.6 there); playback is clocked, so under load it skips
    // frames instead of drifting. The floor catches a real regression (a full re-render per
    // frame), not machine load.
    expect(r.fps).toBeGreaterThanOrEqual(20);
    expect(head(heavy)).toBe(before);
    await shot("10-heavy-playback");
  }, 60_000);

  it("produced no browser errors", () => {
    expect(errors).toEqual([]);
  });

  function numbersOrder(): string[] {
    return numbers.presetOrder as string[];
  }
});
