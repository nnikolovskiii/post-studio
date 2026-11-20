/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Phase 4 done-when, simulated end to end: the agent loop on a Lux Index post.
//
//   agent creates (pstudio import) → Nikola tweaks in the real editor → hands over with a note →
//   agent edits on top through pstudio only (pinned edits exit 4) → render → hand back →
//   he sees what the agent changed → tweaks again → second hand-off and agent turn (compared
//   with the right checkpoints) → he reverts one revision (and gets a clear refusal for one that
//   later changes overlap) → he approves → the agent exports the approved revision.
//
// Nikola is played by Playwright driving the editor in the installed headless Chrome; the agent
// is the real `pstudio` CLI (separate processes, bearer token) against an in-process server on
// a temp data dir. Live data is never touched.
//
// PHASE4_EVIDENCE=1 keeps screenshots, the agent's PNG renders and a step-by-step write-up
// (loop-steps.md, loop.json) in test-artifacts/phase4/.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Document, Node } from "@post-studio/schema";
import { findItem } from "@post-studio/schema";
import { chromeEnv, findChrome } from "@post-studio/render";
import { Store, buildApp } from "@post-studio/server";
import { FontRegistry } from "@post-studio/text";
import { EDITOR_DIST, ensureEditorBuilt } from "../build-if-stale.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const BIN = join(ROOT, "apps/cli/bin/pstudio");
const POST = join(ROOT, "fixtures/social-posts/lux-6-judge-compare");
const EVIDENCE = !!process.env.PHASE4_EVIDENCE;
const PASSWORD = "loop correct horse battery";
const chrome = findChrome();

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

// ---- the write-up: every step, command, exit code and what it proved
const steps: string[] = [];
const record: Record<string, unknown> = {};
const shots: string[] = [];
const note = (md: string) => steps.push(md);

// ---- helpers: server-side truth
const head = () => store.getProject(project).head as number;
const doc = (rev?: number): Document => (rev === undefined ? store.getProject(project).doc : store.docAt(project, rev)) as Document;
const node = (id: string, d = doc()): Node | undefined => {
  const loc = findItem(d, id);
  return loc?.kind === "node" ? (loc.item as Node) : undefined;
};
const text = (n: Node | undefined) => (n && n.type === "text" ? n.spans.map((s) => s.text).join("") : undefined);
const getPath = (obj: unknown, path: string): unknown => path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);

async function shot(name: string) {
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  shots.push(`${name}.png`);
}

// ---- the agent: the real CLI, one process per call (never blocks the in-process server)
interface Run {
  code: number | null;
  json: any;
  cmd: string;
}
function pstudio(args: string[], input?: string): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(BIN, ["--json", "--url", url, "--token-file", tokenFile, ...args], { env: { ...process.env, PSTUDIO_TOKEN: "" } });
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
      done({ code, json, cmd: `pstudio ${shown.join(" ")}` });
    });
    child.stdin.end(input ?? "");
  });
}
/** Write an op batch to a file the way an agent would, then apply it. */
async function applyOps(base: number, ops: unknown[], message: string, extra: string[] = []) {
  const f = join(dir, `ops-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  writeFileSync(f, JSON.stringify(ops, null, 2));
  return pstudio(["apply", project, "--base", String(base), "--ops", f, "-m", message, ...extra]);
}
const cmdLine = (r: Run) => `\`${r.cmd}\` → exit ${r.code}`;

// ---- helpers: the editor as Nikola
const ui = () =>
  page.evaluate(() => {
    const s = (window as any).__postStudio.useEditor.getState();
    return { selection: s.selection as string[], save: s.save as { status: string; rev: number; pending: number }, readOnly: !!document.querySelector(".editor.read-only"), soft: (s.pins?.soft ?? []) as Array<{ node: string; path: string }> };
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
async function centre(id: string) {
  return page.evaluate((id) => {
    const r = document.querySelector(`[data-testid="canvas"] #${CSS.escape(id)}`)!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);
}
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
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}
const selectLayer = (id: string) => page.click(`[data-testid="layer-${id}"]`);
async function setField(testid: string, value: string) {
  await page.fill(`[data-testid="${testid}"]`, value);
  await page.keyboard.press("Enter");
}
const softPaths = async (id: string) => ((await page.getAttribute(`[data-testid="softpin-${id}"]`, "data-paths").catch(() => null)) ?? "").split(" ").filter(Boolean);

/** Every pin the agent saw at the start of its turn still holds the same value afterwards. */
function survival(pins: Array<{ node: string; path: string; source: string }>, before: number, after: number) {
  const a = doc(before);
  const b = doc(after);
  return pins.map((p) => {
    const na = findItem(a, p.node);
    const nb = findItem(b, p.node);
    let kept: boolean;
    let shown: string;
    if (p.path === "#exists") {
      kept = !!nb;
      shown = nb ? "still there" : "GONE";
    } else if (p.path === "#parent") {
      kept = !!nb && !!na && na.parent === nb.parent;
      shown = `parent ${nb?.parent}`;
    } else if (p.path === "*") {
      kept = JSON.stringify(na?.item) === JSON.stringify(nb?.item);
      shown = kept ? "whole layer unchanged" : "CHANGED";
    } else {
      const va = getPath(na?.item, p.path);
      const vb = getPath(nb?.item, p.path);
      kept = JSON.stringify(va) === JSON.stringify(vb);
      shown = `${JSON.stringify(va)} → ${JSON.stringify(vb)}`;
    }
    return { pin: `${p.node}.${p.path}`, source: p.source, kept, shown };
  });
}
const survivalTable = (rows: ReturnType<typeof survival>) =>
  ["| Pin | Kind | At hand-off → after the agent | Kept |", "|---|---|---|---|", ...rows.map((r) => `| \`${r.pin}\` | ${r.source} | ${r.shown.replace(/\|/g, "\\|")} | ${r.kept ? "yes" : "**NO**"} |`)].join("\n");

describe.skipIf(!chrome)("the agent loop end to end (Phase 4 done-when, simulated)", () => {
  // Round state shared by the ordered steps.
  let original: Document;
  let handoff1Rev: number;
  let pins1: Array<{ node: string; path: string; source: string }> = [];
  let agent1Rev: number;
  let badge: string;
  let subSizeRev: number;
  let handoff2Rev: number;
  let pins2: Array<{ node: string; path: string; source: string }> = [];
  let agent2Rev: number;
  let agent2OpsRev: number;

  beforeAll(async () => {
    ensureEditorBuilt(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "pstudio-loop-"));
    outDir = EVIDENCE ? join(ROOT, "test-artifacts/phase4") : join(dir, "shots");
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
      // Refused requests (a pinned revert, a 409) are expected; Chrome logs each failed fetch.
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
  }, 180_000);

  afterAll(async () => {
    if (EVIDENCE) {
      const md = [
        "# Post Studio Phase 4: the simulated agent loop, step by step",
        "",
        `Generated by \`apps/editor/test/loop.e2e.test.ts\` on ${new Date().toISOString()} (PHASE4_EVIDENCE=1).`,
        "Nikola is played by Playwright in the real editor (headless Chrome); the agent is the real `pstudio` CLI with an agent token.",
        "Temp data dir; the post is the LUX-6 fixture copied from social-posts (`lux-6-judge-compare`). `$TMP` is the test's temp folder.",
        "",
        ...steps,
        "",
        "## Screenshots",
        "",
        ...shots.map((s) => `- \`${s}\``),
        "",
      ].join("\n");
      writeFileSync(join(outDir, "loop-steps.md"), md);
      writeFileSync(join(outDir, "loop.json"), JSON.stringify({ when: new Date().toISOString(), ...record }, null, 2) + "\n");
    }
    await browser?.close();
    await app?.close();
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("1. the agent creates the LUX post with pstudio (import from social-posts)", async () => {
    const r = await pstudio(["import", "social-posts", POST]);
    expect(r.code).toBe(0);
    project = r.json.project;
    expect(r.json.rev).toBe(0);
    const h = await pstudio(["handoff", "show", project]);
    expect(h.json).toMatchObject({ turn: "human", head: 0, handoff: null, agent: null, approved: null, softPins: 0 });
    original = doc(0);
    expect(store.revisions(project)[0]).toMatchObject({ author: "agent:optibot-claude", kind: "create" });
    note(
      [
        "## 1. The agent creates the post",
        "",
        `- ${cmdLine(r)}: project \`${project}\`, rev 0, mode \`${r.json.report.mode}\`, ${r.json.report.frames.map((f: any) => `${f.id} ${f.nodes} nodes`).join(", ")}.`,
        `- ${cmdLine(h)}: turn \`human\`, nothing handed over yet. The agent would now send Nikola the editor link \`/p/${project}\`.`,
      ].join("\n"),
    );
  }, 120_000);

  it("2. Nikola logs in, opens it and tweaks: move, font size, colour, a new layer, a pin", async () => {
    await page.goto(url + "/");
    await page.fill('[data-testid="login-password"]', PASSWORD);
    await page.click('[data-testid="login-submit"]');
    await page.click(`[data-testid="project-${project}"]`);
    await page.waitForSelector('svg[data-frame="square"]', { timeout: 30_000 });
    await page.click('[data-testid="zoom"]');
    // (a) drag the headline down
    const c = await centre("headline");
    await drag(c, { x: c.x, y: c.y + 14 });
    let rev = await saved(1);
    // (b) the sub line one size up, from the properties panel
    await selectLayer("sub");
    await setField("prop-size", "30");
    rev = await saved(rev + 1);
    subSizeRev = rev;
    // (c) the first judge's marker in the brand red
    await selectLayer("rect-04");
    await page.locator('[data-testid="prop-fill"]').fill("#ac1922");
    rev = await saved(rev + 1);
    // (d) a new rectangle (a badge) with the rectangle tool
    const known = new Set([...doc().frames[0].children.map((n) => n.id)]);
    await page.click('[data-testid="tool-rect"]');
    await drag(await at("square", 960, 140), await at("square", 1040, 180));
    rev = await saved(rev + 1);
    badge = doc().frames[0].children.map((n) => n.id).find((id) => !known.has(id))!;
    expect(node(badge)?.type).toBe("rect");
    // (e) pin the logo for good (Layers → pin)
    await page.keyboard.press("Escape");
    await page.hover('[data-testid="layer-logo"]');
    await page.click('[data-testid="pin-logo"]');
    rev = await saved(rev + 1);
    expect(node("logo")?.pins).toEqual(["*"]);

    const h0 = node("headline", original)!;
    const h1 = node("headline")!;
    expect(h1.y).toBeGreaterThan(h0.y);
    expect((node("sub") as any).style.size).toBe(30);
    expect((node("rect-04") as any).fill).toBe("#AC1922");
    expect(store.revisions(project).slice(1).every((r) => r.author === "human")).toBe(true);

    // The editor shows what the agent will keep: a dashed pin per layer he changed, and a count.
    await expect.poll(() => softPaths("headline"), { timeout: 10_000 }).toEqual(expect.arrayContaining(["y"]));
    expect(await softPaths("sub")).toEqual(expect.arrayContaining(["style.size"]));
    expect(await softPaths("rect-04")).toEqual(["fill"]);
    expect(await softPaths(badge)).toContain("#exists");
    expect(await page.locator('[data-testid="softpin-logo"]').count()).toBe(0); // the explicit pin covers it
    expect(await page.textContent('[data-testid="softpin-count"]')).toMatch(/\d+ kept/);
    await selectLayer("headline");
    expect(await page.textContent('[data-testid="soft-pins"]')).toMatch(/Kept from the agent's next turn \(you changed them since created\)/);
    await shot("02-nikola-tweaks-soft-pins");
    record.round1Tweaks = {
      headline: { from: { x: h0.x, y: h0.y }, to: { x: h1.x, y: h1.y } },
      sub: { size: [26, 30] },
      "rect-04": { fill: [(node("rect-04", original) as any).fill, "#AC1922"] },
      badge: node(badge),
      logo: "explicit pin *",
    };
    note(
      [
        "## 2. Nikola tweaks (round 1, in the editor)",
        "",
        `- Dragged the headline from y ${h0.y} to y ${h1.y}${h1.x !== h0.x ? ` (x ${h0.x} → ${h1.x})` : ""}.`,
        "- Sub line font size 26 → 30 (Properties → Size).",
        `- First judge's marker \`rect-04\` fill ${(node("rect-04", original) as any).fill} → #AC1922 (Properties → Fill).`,
        `- Added a rectangle \`${badge}\` with the rectangle tool.`,
        "- Pinned the logo for good (Layers → pin).",
        `- Every change was autosaved as a \`human\` revision (revs 1–${rev}).`,
        "- The Layers panel now shows a dashed pin on headline, sub, rect-04 and the new rectangle, and the top bar says how many properties are kept from the agent (“N kept”) (`02-nikola-tweaks-soft-pins.png`).",
      ].join("\n"),
    );
  }, 120_000);

  it("3. he hands it over with a note", async () => {
    await page.click('[data-testid="handoff"]');
    await page.fill('[data-testid="handoff-note"]', "Скрати го насловот во еден ред. Keep my layout, sizes and colours.");
    await shot("03-handoff-dialog");
    await page.click('[data-testid="handoff-send"]');
    await expect.poll(() => store.handoffState(project).turn, { timeout: 10_000 }).toBe("agent");
    handoff1Rev = head();
    await page.waitForSelector('[data-testid="take-back"]', { timeout: 10_000 });
    await shot("04-waiting-for-agent");
    note(["## 3. Hand to agent", "", `- Note: “Скрати го насловот во еден ред. Keep my layout, sizes and colours.” → checkpoint \`handoff-1\` at rev ${handoff1Rev}, turn \`agent\`.`, "- Banner: waiting for the agent, with a **Take it back** button (`04-waiting-for-agent.png`)."].join("\n"));
  }, 60_000);

  it("4. the agent's turn: note → lease → diff → pins → refused pinned edits → edits on top → render → hand back", async () => {
    const show = await pstudio(["handoff", "show", project]);
    expect(show.json).toMatchObject({ turn: "agent", handoff: { name: "handoff-1", note: "Скрати го насловот во еден ред. Keep my layout, sizes and colours." } });
    expect(show.json.softPins).toBeGreaterThanOrEqual(5);
    const lease = await pstudio(["lease", "take", project]);
    expect(lease.json.holder).toBe("agent:optibot-claude");
    // The editor goes read-only with the lease banner (it polls every 2 s).
    await expect.poll(() => page.locator('[data-testid="banner"].lease').count(), { timeout: 10_000 }).toBe(1);
    expect((await ui()).readOnly).toBe(true);
    await shot("05-agent-has-the-lease");

    const diff = await pstudio(["diff", project]);
    expect(diff.json.from).toBe(0);
    const changed = diff.json.items.map((i: any) => i.id).sort();
    expect(changed).toEqual(["headline", "logo", "rect-04", "sub", badge].sort());
    expect(diff.json.items.every((i: any) => i.authors.every((a: string) => a === "human"))).toBe(true);
    const pins = await pstudio(["pins", project]);
    pins1 = pins.json.effective;
    const keys = pins1.map((p) => `${p.node}.${p.path}`);
    expect(keys).toEqual(expect.arrayContaining(["logo.*", "headline.y", "sub.style.size", "rect-04.fill", `${badge}.#exists`]));
    const got = await pstudio(["get", project, "--out", join(dir, "doc.json")]);
    const base = got.json.rev;
    expect(base).toBe(handoff1Rev);

    // Try to undo his tweaks: every op is refused with exit 4 and nothing is written.
    const h0 = node("headline", original)!;
    const undo = await applyOps(
      base,
      [
        { op: "set", node: "headline", path: "y", value: h0.y },
        { op: "set", node: "sub", path: "style.size", value: 26 },
        { op: "set", node: "rect-04", path: "fill", value: (node("rect-04", original) as any).fill },
        { op: "delete", node: badge },
        { op: "set", node: "logo", path: "x", value: 140 },
      ],
      "put things back the way I made them",
    );
    expect(undo.code).toBe(4);
    expect(undo.json.error.code).toBe("pinned");
    const blocked = undo.json.error.details.blocked.map((b: any) => b.key);
    expect(blocked).toEqual(expect.arrayContaining(["headline.y", "sub.style.size", "rect-04.fill", `${badge}.#exists`, "logo.*"]));
    expect(head()).toBe(base);

    // The edit he asked for, on top of his layout: new words, same position / size / colour.
    const dry = await applyOps(base, [{ op: "set", node: "headline", path: "spans", value: [{ text: "Исти модели, други оценки." }] }], "shorter headline per note", ["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.json.text.headline).toMatchObject({ overflowX: 0, overflowY: 0 });
    const words = await applyOps(
      base,
      [
        { op: "set", node: "headline", path: "spans", value: [{ text: "Исти модели, други оценки." }] },
        { op: "set", node: "status", path: "spans", value: [{ text: "DRAFT — за преглед" }] },
      ],
      "Shorter headline in one line per his note; status says it is in review. Kept his position, sizes, colours.",
    );
    expect(words.code).toBe(0);
    expect(words.json.rebased).toBe(false);
    expect(words.json.text.headline.lines).toBe(1);

    // Look at it: render the PNG the way the agent does, and check it.
    const png = join(dir, "agent-1.png");
    const render = await pstudio(["render", project, "--frame", "square", "--out", png]);
    expect(render.code).toBe(0);
    expect(render.json).toMatchObject({ format: "png", frame: "square", rev: words.json.rev, warnings: [] });
    const bytes = readFileSync(png);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1080, 1080]);
    if (EVIDENCE) copyFileSync(png, join(outDir, "06-agent-1-render.png"));

    const back = await pstudio(["handoff", "back", project, "--summary", "Headline shortened to one line; status → in review. Kept your layout, sizes and colours."]);
    expect(back.json).toMatchObject({ checkpoint: "agent-1", turn: "human" });
    agent1Rev = back.json.rev;

    // The proof: every pin the agent saw at the start of its turn holds the same value now.
    const rows = survival(pins1, handoff1Rev, agent1Rev);
    expect(rows.filter((r) => !r.kept)).toEqual([]);
    expect(text(node("headline"))).toBe("Исти модели, други оценки.");
    record.round1Survival = rows;
    note(
      [
        "## 4. The agent's turn (pstudio only)",
        "",
        `1. ${cmdLine(show)}: turn agent, his note, ${show.json.softPins} protected properties.`,
        `2. ${cmdLine(lease)}: lease held by \`agent:optibot-claude\`; the editor shows the lease banner and goes read-only (\`05-agent-has-the-lease.png\`).`,
        `3. ${cmdLine(diff)}: since \`created\` (rev 0), all by \`human\`:`,
        "",
        "```",
        diff.json.text,
        "```",
        "",
        `4. ${cmdLine(pins)}: ${pins1.length} effective pins (${keys.join(", ")}).`,
        `5. ${cmdLine(got)}: base rev ${base}.`,
        `6. Tried to put his tweaks back in one batch: ${cmdLine(undo)} (\`pinned\`), nothing written. Blocked:`,
        "",
        ...undo.json.error.details.blocked.map((b: any) => `   - \`${b.key}\`: ${b.message}`),
        "",
        `7. ${cmdLine(dry)}: headline fits (${dry.json.text.headline.lines} line, no overflow).`,
        `8. ${cmdLine(words)}: rev ${words.json.rev}, headline “Исти модели, други оценки.” in ${words.json.text.headline.lines} line, status “DRAFT — за преглед”.`,
        `9. ${cmdLine(render)}: 1080×1080 PNG, no warnings (\`06-agent-1-render.png\`).`,
        `10. ${cmdLine(back)}: checkpoint \`agent-1\` at rev ${agent1Rev}, lease released, turn \`human\`.`,
        "",
        "**Every tweak survived** (value at `handoff-1` vs after `agent-1`):",
        "",
        survivalTable(rows),
      ].join("\n"),
    );
  }, 180_000);

  it("5. the editor highlights what the agent changed; the soft pins start over", async () => {
    await page.waitForSelector('[data-testid="agent-changes"]', { timeout: 10_000 });
    expect((await ui()).readOnly).toBe(false);
    const card = (await page.textContent('[data-testid="agent-changes"]'))!;
    expect(card).toMatch(/agent-1/);
    expect(card).toMatch(/Since handoff-1/);
    const listed = await page.$$eval('[data-testid="agent-changes"] li[data-change]', (els) => els.map((e) => e.getAttribute("data-change")));
    expect(listed.sort()).toEqual(["headline", "status"]);
    expect(await page.locator('[data-testid="layer-headline"].agent-changed').count()).toBe(1);
    expect(await page.locator('[data-testid="layer-sub"].agent-changed').count()).toBe(0);
    // After agent-1 nothing is soft-pinned until he changes something again.
    await expect.poll(() => page.locator('[data-testid^="softpin-"]').count(), { timeout: 10_000 }).toBe(0);
    await shot("07-what-the-agent-changed");
    note(["## 5. Back in the editor", "", "- The “What the agent changed” card says `agent-1 · since handoff-1` and lists exactly `headline` and `status`; both layers are highlighted (`07-what-the-agent-changed.png`).", "- The dashed soft-pin marks are gone: a new round starts at `agent-1`. His explicit logo pin stays."].join("\n"));
  }, 60_000);

  it("6. he tweaks again and hands over a second time; the agent compares with agent-1, not with created", async () => {
    await page.click('[data-testid="agent-changes"] button.mini'); // dismiss
    await selectLayer("sub");
    await setField("prop-size", "32");
    const rev = await saved(agent1Rev + 1);
    await selectLayer("kicker");
    await setField("prop-x", "680");
    await saved(rev + 1);
    // Only round 2 is soft-pinned now (the headline move from round 1 is not).
    await expect.poll(() => softPaths("kicker"), { timeout: 10_000 }).toEqual(["x"]);
    expect(await softPaths("sub")).toEqual(expect.arrayContaining(["style.size"]));
    expect(await page.locator('[data-testid="softpin-headline"]').count()).toBe(0);
    await shot("08-round-2-tweaks");
    await page.click('[data-testid="handoff"]');
    await page.fill('[data-testid="handoff-note"]', "Kicker: say МАКЕДОНСКИ AI ИНДЕКС. Status: ready to publish. Don't touch my sizes.");
    await page.click('[data-testid="handoff-send"]');
    await expect.poll(() => store.handoffState(project).turn, { timeout: 10_000 }).toBe("agent");
    handoff2Rev = head();

    const show = await pstudio(["handoff", "show", project]);
    expect(show.json.handoff).toMatchObject({ name: "handoff-2", rev: handoff2Rev });
    await pstudio(["lease", "take", project]);
    const diff = await pstudio(["diff", project]);
    expect(diff.json.from).toBe(agent1Rev);
    expect(diff.json.items.map((i: any) => i.id).sort()).toEqual(["kicker", "sub"]);
    const pins = await pstudio(["pins", project]);
    expect(pins.json.since).toBe("agent-1");
    pins2 = pins.json.effective;
    expect(pins2.map((p) => `${p.node}.${p.path}`)).toEqual(expect.arrayContaining(["logo.*", "kicker.x", "sub.style.size"]));
    expect(pins2.some((p) => p.node === "headline")).toBe(false);
    const blocked = await applyOps(handoff2Rev, [{ op: "set", node: "sub", path: "style.size", value: 28 }], "sub too big for one line");
    expect(blocked.code).toBe(4);
    const edit = await applyOps(
      handoff2Rev,
      [
        { op: "set", node: "kicker", path: "spans", value: [{ text: "МАКЕДОНСКИ AI ИНДЕКС" }] },
        { op: "set", node: "status", path: "spans", value: [{ text: "СПРЕМНО ЗА ОБЈАВА" }] },
      ],
      "Kicker and status per his second note; kept his kicker position and sub size.",
    );
    expect(edit.code).toBe(0);
    agent2OpsRev = edit.json.rev;
    const png = join(dir, "agent-2.png");
    const render = await pstudio(["render", project, "--out", png]);
    expect(render.json.warnings).toEqual([]);
    if (EVIDENCE) copyFileSync(png, join(outDir, "09-agent-2-render.png"));
    const back = await pstudio(["handoff", "back", project, "--summary", "Kicker → МАКЕДОНСКИ AI ИНДЕКС, status → ready to publish."]);
    expect(back.json.checkpoint).toBe("agent-2");
    agent2Rev = back.json.rev;
    const rows = survival(pins2, handoff2Rev, agent2Rev);
    expect(rows.filter((r) => !r.kept)).toEqual([]);
    expect((node("kicker") as any).x).toBe(680);
    record.round2Survival = rows;

    // The editor's card compares agent-2 with handoff-2: the first turn's headline is not listed.
    await expect.poll(async () => (await page.textContent('[data-testid="agent-changes"]').catch(() => "")) ?? "", { timeout: 10_000 }).toMatch(/agent-2/);
    const listed = await page.$$eval('[data-testid="agent-changes"] li[data-change]', (els) => els.map((e) => e.getAttribute("data-change")));
    expect(listed.sort()).toEqual(["kicker", "status"]);
    expect(await page.textContent('[data-testid="agent-changes"]')).toMatch(/Since handoff-2/);
    expect(await page.locator('[data-testid="layer-headline"].agent-changed').count()).toBe(0);
    await shot("10-second-agent-turn");
    note(
      [
        "## 6. Round 2",
        "",
        `- Nikola: sub size 30 → 32, kicker x → 680 (revs ${agent1Rev + 1}–${handoff2Rev}). Only these two layers get the dashed pin; the round-1 headline move does not (\`08-round-2-tweaks.png\`).`,
        `- Hand-off 2 with the note “Kicker: say МАКЕДОНСКИ AI ИНДЕКС. Status: ready to publish. Don't touch my sizes.” → \`handoff-2\` at rev ${handoff2Rev}.`,
        `- Agent: ${cmdLine(diff)} starts at \`agent-1\` (rev ${agent1Rev}) and lists only \`kicker\` and \`sub\`:`,
        "",
        "```",
        diff.json.text,
        "```",
        "",
        `- ${cmdLine(blocked)}: shrinking his sub size is refused.`,
        `- ${cmdLine(edit)}: new kicker and status words on top of his kicker position (rev ${agent2OpsRev}); ${cmdLine(render)} (\`09-agent-2-render.png\`); ${cmdLine(back)} → \`agent-2\`.`,
        "- The editor's card now reads `agent-2 · since handoff-2` and lists only `kicker` and `status`; the headline from round 1 is not highlighted again (`10-second-agent-turn.png`).",
        "",
        "**Every round-2 pin survived:**",
        "",
        survivalTable(rows),
      ].join("\n"),
    );
  }, 180_000);

  it("7. he reverts one revision from History, and gets a clear refusal when later changes overlap", async () => {
    await page.click('[data-testid="history-toggle"]');
    await page.waitForSelector(`[data-testid="rev-${agent2OpsRev}"]`);
    // Revert the agent's second edit only (status and kicker words go back; everything later stays).
    await page.hover(`[data-testid="rev-${agent2OpsRev}"]`);
    await page.click(`[data-testid="revert-${agent2OpsRev}"]`);
    await expect.poll(() => head(), { timeout: 10_000 }).toBe(agent2Rev + 1);
    const rv = store.revisions(project).at(-1)!;
    expect(rv).toMatchObject({ kind: "revert", reverts: agent2OpsRev, author: "human" });
    expect(text(node("status"))).toBe("DRAFT — за преглед");
    expect(text(node("kicker"))).toBe(text(node("kicker", original)));
    expect((node("kicker") as any).x).toBe(680);
    await saved(agent2Rev + 1);
    await shot("11-reverted-one-revision");
    // His round-1 sub-size revision cannot go alone: round 2 changed the same size later.
    const before = head();
    await page.hover(`[data-testid="rev-${subSizeRev}"]`);
    await page.click(`[data-testid="revert-${subSizeRev}"]`);
    const toasts = () => page.evaluate(() => ((window as any).__postStudio.useEditor.getState().toasts as Array<{ text: string; kind: string }>).filter((t) => t.kind === "error").map((t) => t.text).join("\n"));
    await expect.poll(toasts, { timeout: 10_000 }).toMatch(/can't be reverted on its own: later changes touch the same things: .*sub\.style\.size \(rev \d+\)/);
    expect(head()).toBe(before);
    const toast = await toasts();
    expect(await page.locator('[data-testid="toasts"] .toast.error').count()).toBe(1);
    await shot("12-revert-refused");
    await page.click('[data-testid="history-toggle"]');
    record.revert = { reverted: agent2OpsRev, as: before, refused: subSizeRev, message: toast };
    note(
      [
        "## 7. Per-revision revert",
        "",
        `- History → Revert on rev ${agent2OpsRev} (the agent's kicker + status edit): new \`revert\` revision ${before} by Nikola; kicker and status words are back, his kicker position stays (\`11-reverted-one-revision.png\`).`,
        `- Revert on rev ${subSizeRev} (his round-1 sub size) is refused, nothing written: “${toast.trim()}” (\`12-revert-refused.png\`).`,
      ].join("\n"),
    );
  }, 90_000);

  it("8. he approves; the agent cannot, and exports the approved revision", async () => {
    const no = await pstudio(["approve", project]);
    expect(no.code).toBe(1);
    expect(no.json.error).toMatchObject({ status: 403, code: "human-only" });
    await page.click('[data-testid="approve"]');
    await page.fill('[data-testid="approve-note"]', "Добро е. Ready for LinkedIn.");
    await page.click('[data-testid="approve-send"]');
    await page.waitForSelector('[data-testid="approved-chip"]', { timeout: 10_000 });
    const h = store.handoffState(project);
    expect(h.approved).toMatchObject({ name: "approved", rev: head(), author: "human", note: "Добро е. Ready for LinkedIn.", current: true });
    expect(await page.textContent('[data-testid="approved-chip"]')).toMatch(new RegExp(`Approved · rev ${head()}`));
    expect(await page.isDisabled('[data-testid="approve"]')).toBe(true);
    await shot("13-approved");
    const to = join(dir, "export-approved");
    const ex = await pstudio(["export", project, "--rev", "last-approved", "--to", to]);
    expect(ex.code).toBe(0);
    expect(ex.json.rev).toBe(head());
    for (const f of ["post.png", "post.svg", "post.jpg", "post-li.png", "post-studio.json", "export.json"]) expect(existsSync(join(to, f))).toBe(true);
    const cps = store.checkpoints(project).map((c) => `${c.name}@${c.rev}`);
    expect(cps).toEqual([`created@0`, `handoff-1@${handoff1Rev}`, `agent-1@${agent1Rev}`, `handoff-2@${handoff2Rev}`, `agent-2@${agent2Rev}`, `approved@${head()}`]);
    await page.click(".home");
    await page.waitForSelector(`[data-testid="approved-${project}"]`, { timeout: 10_000 });
    await shot("14-project-list-approved");
    record.checkpoints = cps;
    record.revisions = store.revisions(project).map((r) => ({ rev: r.rev, author: r.author, kind: r.kind, message: r.message }));
    note(
      [
        "## 8. Approve and export",
        "",
        `- ${cmdLine(no)}: an agent cannot approve (403 \`human-only\`).`,
        `- Nikola: Approve → note “Добро е. Ready for LinkedIn.” → checkpoint \`approved\` at rev ${head()}; the top bar shows “Approved · rev ${head()}” and the project list an “Approved” badge (\`13-approved.png\`, \`14-project-list-approved.png\`).`,
        `- ${cmdLine(ex)}: post.svg / .png / .jpg, post-li.*, figma/*, post-studio.json and export.json of rev ${head()}.`,
        "",
        `Checkpoints: ${cps.map((c) => `\`${c}\``).join(" → ")}.`,
        "",
        "## History of the run",
        "",
        "| Rev | Author | Kind | Message |",
        "|---|---|---|---|",
        ...store.revisions(project).map((r) => `| ${r.rev} | ${r.author} | ${r.kind} | ${r.message.replace(/\|/g, "\\|")} |`),
      ].join("\n"),
    );
  }, 120_000);

  it("produced no browser errors", () => {
    expect(errors).toEqual([]);
  });
});
