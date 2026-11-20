/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Motion Part 4 done-when (PLAN-motion.md §7, §8 Part 4): the agent loop with time, end to end.
//
//   agent (the real `pstudio` CLI) creates a motion post from the LUX template with presets →
//   Nikola (Playwright in the desktop editor) retimes the headline's intro keyframes, moves the
//   logo, parks the playhead at 1.20 s and hands over "make the intro punchier" (At 1.20 s,
//   pointing at the headline) → the agent reads handoff show / diff / pins / timeline: his timing
//   is there and pinned; moving his keyframe time is refused (exit 4); it makes the intro faster
//   on the unpinned parts, looks at the contact sheet and hands back → he sees timing lines in
//   "What the agent changed" → approves → `export --rev last-approved` writes post.mp4 + poster.
//
// The server is in-process on a temp data dir; the agent runs as separate CLI processes with an
// agent token. Live data is never touched.
//
// MOTION4_EVIDENCE=1 keeps screenshots, the agent's contact sheets and a step-by-step write-up
// (motion-loop-steps.md, motion-loop.json) in test-artifacts/motion-part4/.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Document, Node } from "@post-studio/schema";
import { findItem } from "@post-studio/schema";
import { chromeEnv, findChrome, findFfmpeg } from "@post-studio/render";
import { Store, buildApp } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { EDITOR_DIST, ensureEditorBuilt } from "../build-if-stale.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const BIN = join(ROOT, "apps/cli/bin/pstudio");
const EVIDENCE = !!process.env.MOTION4_EVIDENCE;
const PASSWORD = "motion loop horse battery";
const chrome = findChrome();
const ffmpeg = findFfmpeg();

let dir: string;
let outDir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
let url: string;
let tokenFile: string;
let browser: Browser;
let page: Page;
let project: string;
const errors: string[] = [];

const steps: string[] = [];
const record: Record<string, unknown> = {};
const note = (md: string) => steps.push(md);

// ---- server-side truth
const head = () => store.getProject(project).head as number;
const doc = (rev?: number): Document => (rev === undefined ? store.getProject(project).doc : store.docAt(project, rev)) as Document;
const node = (id: string, d = doc()): Node => {
  const loc = findItem(d, id);
  if (!loc || loc.kind !== "node") throw new Error(`no node ${id}`);
  return loc.item as Node;
};
const kf = (id: string, track: string, key: string, d = doc()) => (node(id, d).anim?.tracks as any)?.[track]?.[key] as { t: number; v: number; ease?: string } | undefined;
const shot = (name: string) => page.screenshot({ path: join(outDir, `${name}.png`) });

// ---- the agent: the real CLI, one process per call
interface Run {
  code: number | null;
  json: any;
  stdout: string;
  cmd: string;
}
function pstudio(args: string[], opts: { json?: boolean } = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(BIN, [...(opts.json === false ? [] : ["--json"]), "--url", url, "--token-file", tokenFile, ...args], { env: { ...process.env, PSTUDIO_TOKEN: "" } });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", () => undefined);
    child.on("error", fail);
    child.on("close", (code) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      const shown = args.map((a) => (a.startsWith(dir) ? a.replace(dir, "$TMP") : a.startsWith(ROOT) ? a.replace(ROOT + "/", "") : /\s/.test(a) ? JSON.stringify(a) : a));
      done({ code, json, stdout, cmd: `pstudio ${shown.join(" ")}` });
    });
    child.stdin.end("");
  });
}
let opsN = 0;
async function applyOps(base: number, ops: unknown[], message: string, extra: string[] = []) {
  const f = join(dir, `ops-${++opsN}.json`);
  writeFileSync(f, JSON.stringify(ops, null, 2));
  return pstudio(["apply", project, "--base", String(base), "--ops", f, "-m", message, ...extra]);
}
/** pstudio anim preset … --out f, then apply f with --base (what §7 tells agents to do). */
async function preset(args: string[], message: string) {
  const f = join(dir, `preset-${++opsN}.json`);
  const w = await pstudio(["anim", "preset", project, ...args, "--out", f]);
  expect(w.code, w.stdout).toBe(0);
  const a = await pstudio(["apply", project, "--base", String(w.json.base), "--ops", f, "-m", message]);
  expect(a.code, a.stdout).toBe(0);
  return { w, a, ops: JSON.parse(readFileSync(f, "utf8")) as Array<{ path: string }> };
}
const cmdLine = (r: Run) => `\`${r.cmd}\` → exit ${r.code}`;

// ---- the editor as Nikola
const ui = () =>
  page.evaluate(() => {
    const ps = (window as any).__postStudio;
    const s = ps.useEditor.getState();
    return { save: s.save as { status: string; rev: number; pending: number }, t: ps.useTime.getState().t as number, selection: s.selection as string[] };
  });
async function saved(minRev?: number) {
  await expect
    .poll(
      async () => {
        const s = (await ui()).save;
        return s.status === "saved" && s.pending === 0 && (minRev === undefined || s.rev >= minRev);
      },
      { timeout: 15_000, interval: 100 },
    )
    .toBe(true);
  return head();
}
async function box(sel: string) {
  const r = await page.locator(sel).first().boundingBox();
  if (!r) throw new Error(`no element ${sel}`);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x, right: r.x + r.width };
}
async function centre(id: string) {
  return page.evaluate((id) => {
    const r = document.querySelector(`[data-testid="canvas"] svg[data-frame="square"] #${CSS.escape(id)}`)!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);
}
async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}
async function pxPerMs() {
  const r = await box('[data-testid="tl-ruler"]');
  return (r.right - r.left) / doc().motion!.duration;
}

describe.skipIf(!chrome)("the motion loop end to end (Motion Part 4 done-when)", () => {
  let agent1Rev: number;
  let hisIn1: number;
  let logoMoved: { x: number; y: number };
  let handoffRev: number;
  const intro = ["kicker", "source", "footer"];

  beforeAll(async () => {
    ensureEditorBuilt(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "pstudio-motion-loop-"));
    outDir = EVIDENCE ? join(ROOT, "test-artifacts/motion-part4") : join(dir, "shots");
    mkdirSync(outDir, { recursive: true });
    store = new Store({ dataDir: join(dir, "data"), fonts: await FontRegistry.load() });
    store.auth.setPassword(PASSWORD);
    tokenFile = join(dir, "agent.token");
    writeFileSync(tokenFile, store.createToken("optibot-claude", "agent").token + "\n");
    chmodSync(tokenFile, 0o600);
    app = buildApp({ store, editorDir: EDITOR_DIST });
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: chrome, env: chromeEnv() as Record<string, string>, args: ["--no-sandbox", "--font-render-hinting=none"] });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
  }, 180_000);

  afterAll(async () => {
    if (EVIDENCE) {
      const md = [
        "# Post Studio Motion Part 4: the motion loop, step by step",
        "",
        `Generated by \`apps/editor/test/motion-loop.e2e.test.ts\` on ${new Date().toISOString()} (MOTION4_EVIDENCE=1).`,
        "Nikola is played by Playwright in the real desktop editor (headless Chrome); the agent is the real `pstudio` CLI with an agent token. Temp data dir; `$TMP` is the test's temp folder.",
        "",
        ...steps,
        "",
      ].join("\n");
      writeFileSync(join(outDir, "motion-loop-steps.md"), md);
      writeFileSync(join(outDir, "motion-loop.json"), JSON.stringify({ when: new Date().toISOString(), ...record }, null, 2) + "\n");
    }
    await browser?.close();
    await app?.close();
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("1. the agent creates a motion post from the LUX template with presets (CLI only) and hands over a first draft", async () => {
    const c = await pstudio(["create", "--template", "lux/post", "--title", "Motion loop: LUX intro", "--lang", "mk"]);
    expect(c.code, c.stdout).toBe(0);
    project = c.json.project;
    expect(doc().motion).toBeUndefined();
    // The headline slides up (fade-up = slide-up-in), the small texts fade in staggered, the logo pops.
    const h = await preset(["--node", "headline", "--preset", "fade-up", "--at", "0.4", "--dur", "0.6"], "intro: headline slides up");
    expect(h.w.json.addsMotion).toBe(true);
    const k = await preset(["--node", ...intro, "--preset", "fade-in", "--at", "0.2", "--dur", "0.6", "--stagger", "0.08"], "intro: small texts fade in");
    const l = await preset(["--node", "logo", "--preset", "pop", "--at", "1.0", "--dur", "0.5"], "logo pops");
    expect(doc().motion).toMatchObject({ duration: 6000, fps: 30 });
    expect(kf("headline", "dy", "in1")).toEqual({ t: 400, v: 40, ease: "out" });
    expect(kf("headline", "dy", "in2")).toEqual({ t: 1000, v: 0 });
    expect(kf("footer", "opacity", "in1")?.t).toBe(360);
    expect(kf("logo", "scale", "in1")).toEqual({ t: 1000, v: 0.8, ease: "back-out" });
    const tl = await pstudio(["timeline", project], { json: false });
    expect(tl.code).toBe(0);
    expect(tl.stdout).toMatch(/headline/);
    const contact = join(outDir, "agent-contact-1.png");
    const cs = await pstudio(["render", project, "--frame", "square", "--contact", "--out", contact]);
    expect(cs.code, cs.stdout).toBe(0);
    expect(readFileSync(contact).subarray(1, 4).toString()).toBe("PNG");
    expect(cs.json.times).toHaveLength(12);
    const back = await pstudio(["handoff", "back", project, "--summary", "first draft: headline slides up, small texts fade in, logo pops"]);
    expect(back.code).toBe(0);
    agent1Rev = head();
    record.created = { project, rev: agent1Rev, presets: [h.ops.length, k.ops.length, l.ops.length] };
    note(
      [
        "## 1. The agent makes a motion post (CLI only)",
        "",
        `- ${cmdLine(c)}: project \`${project}\` from the \`lux/post\` template, a still post.`,
        `- ${cmdLine(h.w)} then ${cmdLine(h.a)}: ${h.ops.length} ops (also turns motion on: 6 s @ 30 fps).`,
        `- ${cmdLine(k.w)} then apply: ${k.ops.length} ops, staggered 0.08 s.`,
        `- ${cmdLine(l.w)} then apply: ${l.ops.length} ops.`,
        `- ${cmdLine(tl)}: a text timeline; ${cmdLine(cs)}: contact sheet with 12 moments (\`agent-contact-1.png\`).`,
        `- ${cmdLine(back)}: \`agent-1\` at rev ${agent1Rev}.`,
        "",
        "```",
        tl.stdout.trim(),
        "```",
      ].join("\n"),
    );
  }, 120_000);

  it("2. Nikola retimes the headline's intro, moves the logo and hands over at 1.20 s, pointing at the headline", async () => {
    await page.goto(`${url}/p/${project}`);
    await page.fill('[data-testid="login-password"]', PASSWORD);
    await page.click('[data-testid="login-submit"]');
    await page.waitForSelector('svg[data-frame="square"]', { timeout: 30_000 });
    await page.waitForSelector('[data-testid="timeline"]');
    await page.waitForSelector('[data-testid="agent-changes"]', { timeout: 10_000 });
    await page.click('[data-testid="agent-changes"] .agent-card-head button');
    // (a) Retime: Shift-select the headline's two in-keyframes and drag them 0.3 s later.
    await page.click('[data-testid="tl-expand-headline"]');
    const a = await box('[data-testid="kf-headline-dy-in1"]');
    await page.mouse.click(a.x, a.y);
    const b = await box('[data-testid="kf-headline-opacity-in1"]');
    await page.keyboard.down("Shift");
    await page.mouse.click(b.x, b.y);
    await page.keyboard.up("Shift");
    expect(await page.evaluate(() => (window as any).__postStudio.useTime.getState().selectedKeys.length)).toBe(2);
    const before = head();
    const k = await pxPerMs();
    await drag(a, { x: a.x + 300 * k, y: a.y });
    let rev = await saved(before + 1);
    expect(rev).toBe(before + 1);
    hisIn1 = kf("headline", "dy", "in1")!.t;
    expect(Math.abs(hisIn1 - 700)).toBeLessThanOrEqual(40);
    expect(kf("headline", "opacity", "in1")!.t).toBe(hisIn1);
    expect(kf("headline", "dy", "in2")!.t).toBe(1000); // only the in-keyframes moved
    const retime = store.revisions(project, { withOps: true }).at(-1)!;
    expect(retime.ops).toEqual([
      { op: "set", node: "headline", path: "anim.tracks.dy.in1.t", value: hisIn1 },
      { op: "set", node: "headline", path: "anim.tracks.opacity.in1.t", value: hisIn1 },
    ]);
    // (b) Move the logo (Animate off = the layout), with the playhead where the logo is fully in.
    await page.mouse.click(5, 995);
    await page.keyboard.press("End");
    const logo0 = { x: node("logo").x, y: node("logo").y };
    const c = await centre("logo");
    const z = await page.evaluate(() => (window as any).__postStudio.useEditor.getState().view.zoom as number);
    await drag(c, { x: c.x + 40 * z, y: c.y - 20 * z });
    rev = await saved(rev + 1);
    logoMoved = { x: node("logo").x, y: node("logo").y };
    expect(logoMoved.x).toBeGreaterThan(logo0.x + 20);
    expect(logoMoved.y).toBeLessThan(logo0.y - 5);
    expect(node("logo").anim).toEqual(node("logo", doc(agent1Rev)).anim); // the pop came along untouched
    // (c) Park the playhead at 1.20 s with the keyboard (Home, 3 × ten frames, 6 × one frame).
    await page.keyboard.press("Home");
    for (let i = 0; i < 3; i++) await page.keyboard.press(">");
    for (let i = 0; i < 6; i++) await page.keyboard.press(".");
    expect((await ui()).t).toBe(1200);
    // (d) Select the headline, Hand to agent: chips for the headline and "At 1.20 s".
    await page.click('[data-testid="layer-headline"]');
    await page.click('[data-testid="handoff"]');
    await page.waitForSelector('[data-testid="handoff-dialog"]');
    expect(await page.textContent('[data-testid="at-chip"]')).toBe("At 1.20 s");
    await page.waitForSelector('[data-testid="focus-chips"] [data-focus="headline"]');
    await page.fill('[data-testid="handoff-note"]', "make the intro punchier");
    await shot("loop-01-handoff-dialog-at");
    await page.click('[data-testid="handoff-send"]');
    await expect.poll(() => store.handoffState(project).turn, { timeout: 10_000 }).toBe("agent");
    handoffRev = head();
    expect(store.handoffState(project).handoff).toMatchObject({ name: "handoff-1", note: "make the intro punchier", at: 1200, atText: "1.20 s", focus: [{ id: "headline" }] });
    await page.waitForSelector('[data-testid="handoff-at"]');
    await shot("loop-02-handed-over");
    record.nikola = { retime: { from: 400, to: hisIn1 }, logo: { from: logo0, to: logoMoved }, at: 1200 };
    note(
      [
        "## 2. Nikola's turn (desktop editor)",
        "",
        `- Shift-selects the headline's \`dy in1\` and \`opacity in1\` diamonds and drags them: one revision (rev ${before + 1}), both times 0.40 s → ${(hisIn1 / 1000).toFixed(2)} s, \`in2\` untouched.`,
        `- Moves the logo with Animate off: x ${logo0.x} → ${logoMoved.x}, y ${logo0.y} → ${logoMoved.y}; its pop keyframes come along unchanged.`,
        "- Home, `>` ×3, `.` ×6 → playhead 1.20 s. Selects the headline, presses Hand to agent: the dialog shows the chip “At 1.20 s” and a “headline” chip (`loop-01-handoff-dialog-at.png`).",
        `- Note “make the intro punchier” → \`handoff-1\` at rev ${handoffRev}, \`at\` = 1200 ms, focus \`headline\`; the banner says “, at 1.20 s” (\`loop-02-handed-over.png\`).`,
      ].join("\n"),
    );
  }, 120_000);

  it("3. the agent reads the hand-off: the moment, his timing in diff / pins / timeline; moving his keyframe time is refused", async () => {
    const show = await pstudio(["handoff", "show", project]);
    expect(show.json).toMatchObject({ turn: "agent", handoff: { name: "handoff-1", at: 1200, atText: "1.20 s", note: "make the intro punchier" } });
    const showText = await pstudio(["handoff", "show", project], { json: false });
    expect(showText.stdout).toMatch(/at: 1\.20 s \(the moment he was looking at on the timeline\)/);
    expect(showText.stdout).toMatch(/Nikola pointed at: headline/);
    const lease = await pstudio(["lease", "take", project]);
    expect(lease.code).toBe(0);
    const diff = await pstudio(["diff", project]);
    expect(diff.code).toBe(0);
    const text: string = diff.json.text;
    const sec = (hisIn1 / 1000).toFixed(2);
    expect(text).toMatch(new RegExp(`headline:.*in1 0\\.40 s → ${sec.replace(".", "\\.")} s.*\\(human`));
    expect(text).toMatch(/logo:.*moved/);
    const pins = await pstudio(["pins", project]);
    const soft = (pins.json.effective as Array<{ node: string; path: string; source: string }>).filter((p) => p.source === "soft").map((p) => `${p.node}.${p.path}`);
    expect(soft).toEqual(expect.arrayContaining(["headline.anim.tracks.dy.in1.t", "headline.anim.tracks.opacity.in1.t", "logo.x", "logo.y"]));
    expect(soft).not.toContain("headline.anim.tracks.dy.in2.t");
    const tl = await pstudio(["timeline", project], { json: false });
    expect(tl.stdout).toMatch(/in1[^\n]*📌/);
    const at = join(outDir, "agent-at-1.2.png");
    const still = await pstudio(["render", project, "--frame", "square", "--at", "1.2", "--out", at]);
    expect(still.code, still.stdout).toBe(0);
    // Moving his keyframe back is refused, nothing written.
    const h0 = head();
    const refused = await applyOps(h0, [{ op: "set", node: "headline", path: "anim.tracks.dy.in1.t", value: 400 }], "earlier headline start");
    expect(refused.code).toBe(4);
    expect(refused.json.error.code).toBe("pinned");
    expect(JSON.stringify(refused.json.error.details)).toMatch(/headline.*anim\.tracks\.dy\.in1\.t/);
    expect(head()).toBe(h0);
    // So is deleting his keyframe (unset touches the pinned time).
    const del = await applyOps(h0, [{ op: "unset", node: "headline", path: "anim.tracks.opacity.in1" }], "drop the fade");
    expect(del.code).toBe(4);
    record.agentRead = { diff: text, softPins: soft, refused: refused.json.error.message };
    note(
      [
        "## 3. The agent reads his turn",
        "",
        `- ${cmdLine(show)}: \`handoff.at\` = 1200, \`atText\` “1.20 s”. The human output says:`,
        "",
        "```",
        showText.stdout.trim(),
        "```",
        "",
        `- ${cmdLine(lease)}.`,
        `- ${cmdLine(diff)}:`,
        "",
        "```",
        text.trim(),
        "```",
        "",
        `- ${cmdLine(pins)}: soft pins ${soft.map((s) => `\`${s}\``).join(", ")}.`,
        `- ${cmdLine(tl)}:`,
        "",
        "```",
        tl.stdout.trim(),
        "```",
        "",
        `- ${cmdLine(still)}: the moment he meant (\`agent-at-1.2.png\`).`,
        `- Moving his keyframe back (\`set headline anim.tracks.dy.in1.t 400\`): ${cmdLine(refused)}, \`pinned\`: “${refused.json.error.message}”. Deleting his opacity keyframe: exit ${del.code}. Nothing written.`,
      ].join("\n"),
    );
  }, 120_000);

  it("4. the agent makes the intro faster on the unpinned parts, checks the contact sheet and hands back", async () => {
    const base = head();
    const in1 = hisIn1;
    const ops = [
      // Headline: his start stays; it lands sooner, with a bigger move and an overshoot.
      { op: "set", node: "headline", path: "anim.tracks.dy.in1.v", value: 80 },
      { op: "set", node: "headline", path: "anim.tracks.dy.in1.ease", value: "back-out" },
      { op: "set", node: "headline", path: "anim.tracks.dy.in2.t", value: in1 + 250 },
      { op: "set", node: "headline", path: "anim.tracks.opacity.in2.t", value: in1 + 150 },
      // The small texts: 0.6 s fades become 0.3 s.
      ...intro.map((id) => ({ op: "set", node: id, path: "anim.tracks.opacity.in2.t", value: kf(id, "opacity", "in1")!.t + 300 })),
      // The logo pops sooner (its position is his, its motion is not pinned).
      { op: "set", node: "logo", path: "anim.tracks.scale.in1.t", value: 700 },
      { op: "set", node: "logo", path: "anim.tracks.opacity.in1.t", value: 700 },
      { op: "set", node: "logo", path: "anim.tracks.scale.in2.t", value: 1000 },
      { op: "set", node: "logo", path: "anim.tracks.opacity.in2.t", value: 1000 },
    ];
    const dry = await applyOps(base, ops, "punchier intro", ["--dry-run"]);
    expect(dry.code, dry.stdout).toBe(0);
    expect(dry.json.dryRun).toBe(true);
    expect(head()).toBe(base);
    const ap = await applyOps(base, ops, "punchier intro: headline lands in 0.25 s with a bigger move and overshoot, small texts fade in 0.3 s, logo pops at 0.7 s; kept his headline start and logo position");
    expect(ap.code, ap.stdout).toBe(0);
    const contact = join(outDir, "agent-contact-2.png");
    const cs = await pstudio(["render", project, "--frame", "square", "--contact", "--out", contact]);
    expect(cs.code).toBe(0);
    const tl = await pstudio(["timeline", project], { json: false });
    const back = await pstudio(["handoff", "back", project, "--summary", "punchier intro: faster landings and a bigger headline move; kept your headline start time and logo position"]);
    expect(back.code).toBe(0);
    expect(store.handoffState(project)).toMatchObject({ turn: "human", lease: null, agent: { name: "agent-2" } });
    // His timing and his logo position survived.
    expect(kf("headline", "dy", "in1")).toEqual({ t: hisIn1, v: 80, ease: "back-out" });
    expect(kf("headline", "opacity", "in1")!.t).toBe(hisIn1);
    expect({ x: node("logo").x, y: node("logo").y }).toEqual(logoMoved);
    // The intro is faster: the headline now lands 0.25 s after his start (before: at 1.00 s).
    expect(kf("headline", "dy", "in2")!.t - kf("headline", "dy", "in1")!.t).toBe(250);
    expect(kf("headline", "dy", "in2")!.t).toBeLessThan(1000);
    record.agentTurn = { ops, rev: head() };
    note(
      [
        "## 4. The agent's changes (unpinned parts only)",
        "",
        `- ${cmdLine(dry)} (dry run), then ${cmdLine(ap)}: ${ops.length} ops. Headline: \`dy in1\` value 40 → 80 with \`back-out\`, lands at ${((hisIn1 + 250) / 1000).toFixed(2)} s (was 1.00 s); his start ${(hisIn1 / 1000).toFixed(2)} s untouched. Small texts fade in 0.3 s (was 0.6 s). Logo pops 0.70–1.00 s (was 1.00–1.50 s); his position untouched.`,
        `- ${cmdLine(cs)}: contact sheet (\`agent-contact-2.png\`). ${cmdLine(tl)}:`,
        "",
        "```",
        tl.stdout.trim(),
        "```",
        "",
        `- ${cmdLine(back)}: \`agent-2\`, turn back to Nikola.`,
      ].join("\n"),
    );
  }, 120_000);

  it("5. Nikola sees timing lines in What the agent changed, approves; the agent exports post.mp4 + the poster", async () => {
    await page.waitForSelector('[data-testid="agent-changes"]', { timeout: 15_000 });
    const card = (await page.textContent('[data-testid="agent-changes"]'))!;
    expect(card).toMatch(/headline/);
    expect(card).toMatch(/\d\.\d\d s → \d\.\d\d s/);
    expect(card).toMatch(/logo/);
    // The headline row is still open from his retime; open it only if it was closed.
    if (!(await page.locator('[data-testid="kf-headline-dy-in2"]').count())) await page.click('[data-testid="tl-expand-headline"]');
    await expect.poll(() => page.locator('[data-testid="kf-headline-dy-in2"].agent-changed').count(), { timeout: 10_000 }).toBe(1);
    await shot("loop-03-agent-changes");
    record.card = card;
    await page.click('[data-testid="approve"]');
    await page.fill('[data-testid="approve-note"]', "Punchy. Ready.");
    await page.click('[data-testid="approve-send"]');
    await page.waitForSelector('[data-testid="approved-chip"]', { timeout: 10_000 });
    expect(store.handoffState(project).approved).toMatchObject({ name: "approved", rev: head(), current: true });
    await shot("loop-04-approved");
    let exportNote = "- ffmpeg not found: export of post.mp4 skipped.";
    if (ffmpeg) {
      const to = join(dir, "export-approved");
      const ex = await pstudio(["export", project, "--rev", "last-approved", "--to", to]);
      expect(ex.code, ex.stdout).toBe(0);
      for (const f of ["post.mp4", "post-li.mp4", "post.png", "post.jpg", "post.svg", "post-studio.json", "export.json"]) expect(existsSync(join(to, f)), f).toBe(true);
      const mp4 = readFileSync(join(to, "post.mp4"));
      expect(mp4.subarray(4, 8).toString()).toBe("ftyp");
      const manifest = JSON.parse(readFileSync(join(to, "export.json"), "utf8"));
      expect(manifest.rev).toBe(head());
      if (EVIDENCE) {
        copyFileSync(join(to, "post.mp4"), join(outDir, "loop-post.mp4"));
        copyFileSync(join(to, "post.png"), join(outDir, "loop-post-poster.png"));
      }
      record.export = { rev: head(), mp4Bytes: mp4.length, files: Object.keys(manifest.files ?? {}).length || manifest.files?.length };
      exportNote = `- ${cmdLine(ex)}: post.mp4 (${mp4.length} bytes, \`ftyp\`), post-li.mp4, the poster stills post.png / .jpg / .svg, post-studio.json and export.json of rev ${head()}.`;
    }
    record.checkpoints = store.checkpoints(project).map((c) => `${c.name}@${c.rev}${c.at != null ? ` (at ${c.at} ms)` : ""}`);
    note(
      [
        "## 5. He sees it, approves, the agent exports",
        "",
        "- “What the agent changed” (`loop-03-agent-changes.png`):",
        "",
        "```",
        card.trim(),
        "```",
        "",
        `- Approve → \`approved\` at rev ${head()} (\`loop-04-approved.png\`).`,
        exportNote,
        "",
        `Checkpoints: ${(record.checkpoints as string[]).map((c) => `\`${c}\``).join(" → ")}.`,
        "",
        "| Rev | Author | Message |",
        "|---|---|---|",
        ...store.revisions(project).map((r) => `| ${r.rev} | ${r.author} | ${r.message.replace(/\|/g, "\\|")} |`),
      ].join("\n"),
    );
  }, 240_000);

  it("produced no browser errors", () => {
    expect(errors).toEqual([]);
  });
});
