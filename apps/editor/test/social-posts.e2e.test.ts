// Phase 5 done-when, end to end with real processes: a new LUX post is started from the LUX kit
// template, edited by an agent with brand tokens, checked by the check_palette.py rules (strict
// mode included), approved by Nikola, and exported with --social-posts into the posts/ folder of
// a TEMP COPY of social-posts, which only works after the proposed social-posts patch is applied
// there. The temp review site is then built and the page is looked at in headless Chrome.
// Never writes into the real ../social-posts.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getKit } from "@post-studio/brand";
import { chromeEnv, findChrome } from "@post-studio/render";
import { ensureEditorBuilt } from "../build-if-stale.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = join(root, "apps/cli/bin/pstudio");
const PATCH = join(root, "proposals/social-posts-post-studio.patch");
const REAL_SP = join(root, "../social-posts");
const VENV_PY = join(process.env.HOME ?? "", ".cache/social-posts-venv/bin/python");
const evidence = process.env.PHASE5_EVIDENCE ? join(root, "test-artifacts/phase5") : undefined;
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const hasReviewSite = existsSync(join(REAL_SP, "review-site/build.py")) && spawnSync(VENV_PY, ["-c", "import PIL"]).status === 0;
const chrome = findChrome();
const SLUG = "lux-7-post-studio-check";
const PASSWORD = "phase5 e2e correct horse";

let dir: string;
let url: string;
let server: ChildProcess;
let sp: string; // temp social-posts copy
const agent = () => join(dir, "agent.token");
const human = () => join(dir, "human.token");

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => res(p));
    });
  });
}

function ps(args: string[], tokenFile = agent(), cwd = root): Promise<{ code: number | null; json: any; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["--json", "--url", url, "--token-file", tokenFile, ...args], { cwd, env: { ...process.env, PSTUDIO_TOKEN: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      resolve({ code, json, stdout, stderr });
    });
    child.stdin.end();
  });
}

/** The parts of social-posts that the patch and the review site touch, copied (read-only source). */
function copySocialPosts(to: string): void {
  mkdirSync(to, { recursive: true });
  if (!existsSync(REAL_SP)) {
    // Minimal stand-in so the gate can still be tested without the sibling project.
    writeFileSync(join(to, "AGENTS.md"), "# social-posts\n");
    mkdirSync(join(to, "posts"));
    return;
  }
  for (const f of ["AGENTS.md", "tools/check_palette.py", "review-site/build.py", "review-site/site/styles.css", "daily/PROMPT-TEMPLATE.md"]) {
    mkdirSync(join(to, f, ".."), { recursive: true });
    cpSync(join(REAL_SP, f), join(to, f));
  }
  for (const slug of readdirSync(join(REAL_SP, "posts"))) {
    const src = join(REAL_SP, "posts", slug);
    for (const f of readdirSync(src)) {
      if (/^(post\.jpg|copy\.json|caption.*\.txt|alt\.txt|review-note\.txt|post-motion\.svg)$/.test(f)) {
        mkdirSync(join(to, "posts", slug), { recursive: true });
        cpSync(join(src, f), join(to, "posts", slug, f));
      }
    }
  }
  if (existsSync(join(REAL_SP, "review/linkedin"))) cpSync(join(REAL_SP, "review/linkedin"), join(to, "review/linkedin"), { recursive: true });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pstudio-p5-"));
  const data = join(dir, "data");
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  expect((await ps(["token", "create", "claude", "--data-dir", data, "--save", agent()])).code).toBe(0);
  expect((await ps(["token", "create", "nikola", "--human", "--data-dir", data, "--save", human()])).code).toBe(0);
  writeFileSync(join(dir, "pw"), PASSWORD + "\n");
  expect((await ps(["admin", "set-password", "--data-dir", data, "--password-file", join(dir, "pw")])).code).toBe(0);
  ensureEditorBuilt(() => undefined);
  server = spawn(bin, ["serve", "--no-build", "--data-dir", data, "--port", String(port)], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/v1/health`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  sp = join(dir, "social-posts");
  copySocialPosts(sp);
  if (evidence) mkdirSync(evidence, { recursive: true });
});

afterAll(() => {
  server?.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
});

const steps: string[] = [];
const log = (s: string) => steps.push(s);

describe("Phase 5: new LUX post from the kit → palette rules → approved export into social-posts", () => {
  let project = "";
  let base = 0;

  it("lists the kits and the lane templates", async () => {
    const k = await ps(["kits"]);
    expect(k.json.kits.map((x: any) => x.id)).toEqual(["lux", "mosaic", "kites", "studio"]);
    const show = await ps(["kits", "show", "lux"], agent());
    expect(show.json.colors.find((c: any) => c.name === "mark").hex).toBe("#AC1922");
    const t = await ps(["templates"]);
    expect(t.json.templates.map((x: any) => x.id)).toEqual(["lux/post", "lux/square", "mosaic/square", "kites/square", "studio/square"]);
    log(`pstudio kits → ${k.json.kits.map((x: any) => x.id).join(", ")}; pstudio templates → ${t.json.templates.map((x: any) => x.id).join(", ")}`);
  });

  it("an agent starts a new LUX post from the LUX template (square + LinkedIn)", async () => {
    const r = await ps(["create", "--template", "lux/post", "--title", "LUX-7 · Post Studio check", "--lang", "mk"]);
    expect(r.code, r.stderr).toBe(0);
    project = r.json.project;
    expect(r.json.warnings).toEqual([]);
    const doc = (await ps(["get", project])).json.doc;
    expect(doc).toMatchObject({ brandKit: "lux", lang: "mk", title: "LUX-7 · Post Studio check" });
    expect(doc.frames.map((f: any) => [f.id, f.w, f.h, f.guides])).toEqual([
      ["square", 1080, 1080, "lux/ig-1080"],
      ["li", 1080, 1350, "lux/li-1350"],
    ]);
    const roles = (f: any) => f.children.map((n: any) => n.role);
    expect(roles(doc.frames[0])).toEqual(["art", "kicker", "headline", "source", "accent", "logo", "footer"]);
    expect(doc.frames[0].children.find((n: any) => n.role === "headline").style.fill).toEqual({ token: "lux.ink" });
    const pal = await ps(["palette", project]);
    expect(pal.json.check.ok).toBe(true);
    expect(pal.json.check.advice.map((a: any) => a.code)).toEqual(["accent-empty", "accent-empty"]);
    base = r.json.rev;
    log(`pstudio create --template lux/post → ${project} rev 0, kit lux, frames square + li, palette OK (hint: the accent group is still empty)`);
  });

  it("the agent fills it with brand tokens; the palette check catches an off-palette colour and a second accent", async () => {
    const ops = [
      { op: "set", node: "headline", path: "spans", value: [{ text: "Исти модели,\nразлични оценки." }] },
      { op: "set", node: "headline-li", path: "spans", value: [{ text: "Исти модели,\nразлични оценки\nод двајца судии." }] },
      { op: "set", node: "kicker", path: "spans", value: [{ text: "МАКЕДОНСКИ AI ИНДЕКС · ГЕНЕРИРАЊЕ" }] },
      { op: "insert", parent: "art", index: 0, node: { id: "bar-1", type: "rect", x: 0, y: 40, w: 600, h: 40, fill: { token: "lux.ink" } } },
      { op: "insert", parent: "art", index: 1, node: { id: "track-2", type: "rect", x: 0, y: 96, w: 810, h: 40, fill: { token: "lux.surface" } } },
      { op: "insert", parent: "accent", index: 0, node: { id: "bar-2", type: "rect", x: 135, y: 408, w: 520, h: 40, fill: { token: "lux.mark" } } },
      { op: "insert", parent: "art-li", index: 0, node: { id: "bar-li-1", type: "rect", x: 0, y: 40, w: 640, h: 48, fill: { token: "lux.ink" } } },
      { op: "insert", parent: "accent-li", index: 0, node: { id: "bar-li-2", type: "rect", x: 108, y: 464, w: 560, h: 48, fill: { token: "lux.accent" } } },
    ];
    writeFileSync(join(dir, "ops.json"), JSON.stringify(ops));
    const r = await ps(["apply", project, "--base", String(base), "--ops", join(dir, "ops.json"), "-m", "first draft from the LUX kit"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.warnings).toEqual([]);
    base = r.json.rev;
    const pal = await ps(["palette", project]);
    expect(pal.json.check).toMatchObject({ ok: true, frames: [{ frame: "square", ok: true, accentObjects: 1 }, { frame: "li", ok: true, accentObjects: 1 }], advice: [] });

    // Off-palette and a second accent: warnings (not strict yet), written.
    writeFileSync(join(dir, "bad.json"), JSON.stringify([{ op: "insert", parent: "square", index: 7, node: { id: "oops", type: "rect", x: 135, y: 880, w: 40, h: 10, fill: "#FF8800", accent: true } }]));
    const warn = await ps(["apply", project, "--base", String(base), "--ops", join(dir, "bad.json"), "-m", "try an orange accent", "--dry-run"]);
    expect(warn.code).toBe(0);
    expect(warn.json.warnings.map((w: any) => `${w.node}:${w.code}`).sort()).toEqual(["oops:palette", "square:accent-count"]);
    log("agent apply with tokens (lux.ink / lux.surface / lux.mark inside the accent group) → palette OK on both frames; an orange 2nd accent → 2 warnings (dry run)");

    // Nikola switches strict mode on (human only: the agent cannot).
    writeFileSync(join(dir, "strict.json"), JSON.stringify([{ op: "set", node: "$doc", path: "strictPalette", value: true }]));
    const agentStrict = await ps(["apply", project, "--base", String(base), "--ops", join(dir, "strict.json"), "-m", "strict"]);
    expect(agentStrict.code).toBe(4);
    const strict = await ps(["apply", project, "--base", String(base), "--ops", join(dir, "strict.json"), "-m", "strict palette on"], human());
    expect(strict.code, strict.stderr).toBe(0);
    base = strict.json.rev;
    // His change makes it his turn: he hands it over, the agent takes the lease and tries again.
    expect((await ps(["handoff", "give", project, "--note", "Add an orange highlight if you like."], human())).code).toBe(0);
    expect((await ps(["lease", "take", project])).code).toBe(0);
    const blocked = await ps(["apply", project, "--base", String(base), "--ops", join(dir, "bad.json"), "-m", "try an orange accent"]);
    expect(blocked.code).toBe(1);
    expect(blocked.json.error.code).toBe("invalid-document");
    expect(blocked.json.error.details.errors.map((e: any) => `${e.node}:${e.code}`).sort()).toEqual(["oops:palette", "square:accent-count"]);
    expect(blocked.json.error.details.errors[0].message).toMatch(/strict palette/);
    const back = await ps(["handoff", "back", project, "--summary", "No orange highlight: strict palette refuses it (not in the LUX kit, and a 2nd accent). Nothing changed."]);
    expect(back.code, back.stderr).toBe(0);
    log("agent sets strictPalette → exit 4 (human only); Nikola turns strict on and hands over; the same orange accent → refused (exit 1, invalid-document: oops:palette, square:accent-count, '(strict palette)'); the agent hands back");
  });

  it("renders the post (both frames) with the kit colours", async () => {
    for (const f of ["square", "li"]) {
      const out = join(dir, `${f}.png`);
      const r = await ps(["render", project, "--frame", f, "--out", out]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.json.warnings).toEqual([]);
      if (evidence) cpSync(out, join(evidence, `lux7-${f}.png`));
    }
  });

  it("export into social-posts is refused until the rule is approved, the revision is approved and the post is on-palette", async () => {
    const target = join(sp, "posts", SLUG);
    const plain = await ps(["export", project, "--to", target]);
    expect(plain.code).toBe(1);
    expect(plain.json.error.code).toBe("refused");
    const before = await ps(["export", project, "--to", target, "--social-posts"]);
    expect(before.code).toBe(1);
    expect(before.json.error.code).toBe("not-approved");
    expect(before.json.error.message).toContain("proposals/social-posts-post-studio.patch");
    expect(existsSync(target)).toBe(false);
    log(`export --to posts/${SLUG} (no flag) → refused; --social-posts before the rule exists → not-approved, nothing written`);

    // Nikola approves the social-posts change: the proposal patch, applied to the temp copy only.
    if (existsSync(join(sp, "tools/check_palette.py"))) {
      const ap = spawnSync("git", ["apply", "-v", PATCH], { cwd: sp, encoding: "utf8" });
      expect(ap.status, ap.stderr).toBe(0);
    } else writeFileSync(join(sp, "AGENTS.md"), "# social-posts\n\n<!-- post-studio-export: allowed -->\n");
    log("temp copy: git apply proposals/social-posts-post-studio.patch → OK (AGENTS.md rule, check_palette.py mosaic lane, build.py, daily prompt)");

    const unapproved = await ps(["export", project, "--to", target, "--social-posts"]);
    expect(unapproved.json.error.code).toBe("not-approved");
    expect(unapproved.json.error.message).toMatch(/no approved revision/);
    const approve = await ps(["approve", project, "--note", "ok for social-posts"], human());
    expect(approve.code, approve.stderr).toBe(0);
    const headRev = (await ps(["export", project, "--to", target, "--social-posts", "--rev", "0"])).json;
    expect(headRev.error.message).toMatch(/rev 0 of .* is not approved/);
    log(`without an approved revision → not-approved; Nikola approves rev ${approve.json.rev}; --rev 0 (not approved) → refused`);
  });

  it("the approved export lands in posts/<slug>/ with copy.json, and passes check_palette.py", async () => {
    const target = join(sp, "posts", SLUG);
    const r = await ps(["export", project, "--to", target, "--social-posts"]);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(r.json.socialPosts).toBe(true);
    const files = r.json.files.map((f: any) => f.path).sort();
    expect(files).toEqual(["copy.json", "export.json", "figma/post-li.figma-ready.svg", "figma/post-li.outlined.svg", "figma/post.figma-ready.svg", "figma/post.outlined.svg", "post-li.jpg", "post-li.png", "post-li.svg", "post-studio.json", "post.jpg", "post.png", "post.svg"]);
    const copy = JSON.parse(readFileSync(join(target, "copy.json"), "utf8"));
    expect(copy).toMatchObject({ lane: "lux", kicker: "МАКЕДОНСКИ AI ИНДЕКС · ГЕНЕРИРАЊЕ", headline: [{ spans: [{ text: "Исти модели," }] }, { spans: [{ text: "различни оценки." }] }], language: "mk", post_studio: { project } });
    log(`export --social-posts → ${files.length} files in posts/${SLUG}/ (rev ${r.json.rev}, ${r.json.notes.join("; ")})`);
    if (hasPython && existsSync(join(sp, "tools/check_palette.py"))) {
      for (const f of ["post.svg", "post-li.svg"]) {
        const c = spawnSync("python3", [join(sp, "tools/check_palette.py"), "lux", join(target, f)], { encoding: "utf8" });
        expect(c.status, c.stdout).toBe(0);
        log(`python3 tools/check_palette.py lux ${f} → ${c.stdout.trim().replace(target + "/", "")}`);
      }
      // The patched check_palette.py's new mosaic lane is exactly the Mosaic kit.
      const lanes = spawnSync("python3", ["-c", "import json,sys; sys.path.insert(0,'tools'); import check_palette as c; print(json.dumps(c.LANES))"], { cwd: sp, encoding: "utf8" });
      const mosaic = JSON.parse(lanes.stdout).mosaic;
      const kit = getKit("mosaic")!;
      expect(mosaic.paper).toBe(kit.paperHex);
      expect(mosaic.accent).toBe(kit.accentHex);
      expect(Object.keys(mosaic.colors).sort()).toEqual([...kit.byHex.keys()].sort());
    }
  });

  it("protects folders Post Studio did not write, and hand-written copy.json", async () => {
    const other = join(sp, "posts", "lux-8-hand-made");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "post.svg"), "<svg/>");
    writeFileSync(join(other, "copy.json"), JSON.stringify({ kicker: "hand", headline: [{ spans: [{ text: "hand" }] }] }));
    const r = await ps(["export", project, "--to", other, "--social-posts"]);
    expect(r.json.error.code).toBe("exists");
    const f = await ps(["export", project, "--to", other, "--social-posts", "--force"]);
    expect(f.code, f.stderr).toBe(0);
    expect(f.json.notes).toContain("copy.json kept: it was not written by Post Studio");
    expect(JSON.parse(readFileSync(join(other, "copy.json"), "utf8")).kicker).toBe("hand");
    rmSync(other, { recursive: true });
    const nested = await ps(["export", project, "--to", join(sp, "posts", SLUG, "deeper"), "--social-posts"]);
    expect(nested.json.error.code).toBe("bad-target");
  });

  it.runIf(hasReviewSite && !!chrome)("the temp review site lists the new post in the LUX lane with its post.jpg (and the LinkedIn frame)", async () => {
    const b = spawnSync(VENV_PY, [join(sp, "review-site/build.py")], { encoding: "utf8" });
    expect(b.status, b.stderr).toBe(0);
    log(`temp review-site/build.py → ${b.stdout.trim().replace(sp, "<temp social-posts>")}`);
    const html = readFileSync(join(sp, "review-site/site/index.html"), "utf8");
    const lux = html.slice(html.indexOf('<section id="lux"'), html.indexOf("</section>", html.indexOf('<section id="lux"')));
    expect(lux).toContain(`<article class="post" id="${SLUG}">`);
    expect(lux).toContain(`img/${SLUG}.jpg`);
    expect(lux).toContain(`img/${SLUG}-li.jpg`);
    expect(existsSync(join(sp, "review-site/site/img", `${SLUG}.jpg`))).toBe(true);

    const browser = await chromium.launch({ executablePath: chrome, env: chromeEnv() as Record<string, string>, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
      await page.goto(`file://${join(sp, "review-site/site/index.html")}#${SLUG}`);
      const card = page.locator(`article#${SLUG}`);
      await card.scrollIntoViewIfNeeded();
      const img = card.locator("img").first();
      await img.evaluate((el: HTMLImageElement) => (el.complete ? null : new Promise((r) => (el.onload = r))));
      expect(await img.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])).toEqual([1080, 1080]);
      expect(await card.locator("h3").textContent()).toBe("Исти модели, различни оценки.");
      await card.locator("details.li summary").click();
      const li = card.locator("details.li img");
      await li.evaluate((el: HTMLImageElement) => (el.complete ? null : new Promise((r) => (el.onload = r))));
      expect(await li.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])).toEqual([1080, 1350]);
      if (evidence) {
        // Sticky page chrome would cover the top of the card in an element screenshot.
        await page.evaluate(() => document.querySelectorAll<HTMLElement>("*").forEach((el) => getComputedStyle(el).position === "sticky" && (el.style.position = "static")));
        await card.scrollIntoViewIfNeeded();
        await card.screenshot({ path: join(evidence, "review-site-card.png") });
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.locator('section#lux').evaluate((el) => el.scrollIntoView());
        await page.screenshot({ path: join(evidence, "review-site-lux-lane.png") });
      }
      log(`headless Chrome: the LUX lane shows article#${SLUG}: post.jpg 1080×1080, headline "Исти модели, различни оценки.", LinkedIn frame 1080×1350`);
    } finally {
      await browser.close();
    }
  });

  it.runIf(!!chrome)("the editor: new LUX post from the template, kit swatches, type styles, palette warnings, accent object", async () => {
    const tok = readFileSync(human(), "utf8").trim();
    const getDoc = async (id: string) => ((await (await fetch(`${url}/v1/projects/${id}`, { headers: { authorization: `Bearer ${tok}` } })).json()) as any).doc;
    const browser = await chromium.launch({ executablePath: chrome, env: chromeEnv() as Record<string, string>, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
      await page.goto(url + "/");
      await page.fill('[data-testid="login-password"]', PASSWORD);
      await page.click('[data-testid="login-submit"]');
      await page.click('[data-testid="new-project"]');
      await page.fill('[data-testid="new-title"]', "Editor template check");
      const options = await page.locator('[data-testid="new-template"] option').allTextContents();
      expect(options.join("|")).toContain("LUX post · square only");
      await page.selectOption('[data-testid="new-template"]', "lux/square");
      await page.click('[data-testid="create-project"]');
      await page.waitForURL(/\/p\/prj_/);
      const id = page.url().split("/p/")[1];
      expect((await getDoc(id)).brandKit).toBe("lux");
      log(`editor: New project → template lux/square → ${id} (brandKit lux)`);

      const chip = page.locator('[data-testid="palette-chip"]');
      await expect.poll(() => chip.textContent()).toBe("lux palette OK");
      await expect.poll(() => page.locator('[data-testid="brand-kit"]').inputValue()).toBe("lux");

      // Type style presets: the headline is recognised; switching it to the kicker style applies TYPE-SCALE + upper case.
      await page.click('[data-testid="layer-headline"]');
      await expect.poll(() => page.locator('[data-testid="prop-type-style"]').inputValue()).toBe("headline");
      await page.selectOption('[data-testid="prop-type-style"]', "kicker");
      await expect.poll(async () => (await getDoc(id)).frames[0].children.find((n: any) => n.id === "headline")?.style).toMatchObject({ font: "IBM Plex Mono", weight: 500, size: 26, fill: { token: "lux.muted" } });
      const spans = (await getDoc(id)).frames[0].children.find((n: any) => n.id === "headline").spans;
      expect(spans.map((x: any) => x.text).join("")).toBe(spans.map((x: any) => x.text).join("").toLocaleUpperCase("mk"));
      log("editor: type style Kicker on the headline → IBM Plex Mono 500 26, fill token lux.muted, text upper case");

      // Off-palette colour typed in → warning on the field and in the top bar; a kit swatch fixes it.
      await page.fill('[data-testid="prop-text-fill-text"]', "#123456");
      await page.press('[data-testid="prop-text-fill-text"]', "Enter");
      await expect.poll(() => page.locator('[data-testid="off-palette"]').count()).toBe(1);
      await expect.poll(() => chip.textContent()).toBe("1 palette problem");
      if (evidence) await page.screenshot({ path: join(evidence, "editor-off-palette.png") });
      await page.click('[data-testid="prop-text-fill-kit"] [data-token="lux.ink"]');
      await expect.poll(async () => (await getDoc(id)).frames[0].children.find((n: any) => n.id === "headline")?.style.fill).toEqual({ token: "lux.ink" });
      await expect.poll(() => chip.textContent()).toBe("lux palette OK");
      expect(await page.locator('[data-testid="off-palette"]').count()).toBe(0);
      log("editor: #123456 typed into the text colour → 'off palette' + '1 palette problem'; the lux.ink swatch → token written, 'lux palette OK'");

      // A second accent object in the frame is an accent-count problem.
      await page.check('[data-testid="prop-accent"]');
      await expect.poll(() => chip.textContent()).toBe("1 palette problem");
      await expect.poll(async () => (await getDoc(id)).frames[0].children.find((n: any) => n.id === "headline")?.accent).toBe(true);
      await page.keyboard.press("Escape");
      await page.click('[data-testid="palette-chip"]');
      await expect.poll(() => page.locator('[data-testid="palette-issues"] [data-code="accent-count"]').count()).toBe(1);
      if (evidence) await page.screenshot({ path: join(evidence, "editor-brand-panel.png") });
      await page.click('[data-testid="layer-headline"]');
      await page.uncheck('[data-testid="prop-accent"]');
      await expect.poll(() => chip.textContent()).toBe("lux palette OK");
      log("editor: headline marked as an accent object → 'accent-count' problem listed in the Brand kit panel; unmarked → OK");

      // Strict mode is a human switch on the project.
      await page.keyboard.press("Escape");
      await page.click('[data-testid="palette-chip"]');
      await page.check('[data-testid="strict-palette"]');
      await expect.poll(async () => (await getDoc(id)).strictPalette).toBe(true);
      await expect.poll(() => chip.textContent()).toBe("lux palette OK · strict");
      log("editor: Strict palette checkbox → doc.strictPalette true, chip 'lux palette OK · strict'");
    } finally {
      await browser.close();
    }
  });

  it("writes the evidence log", () => {
    if (evidence) writeFileSync(join(evidence, "social-posts-steps.md"), `# Phase 5 pipeline run (temp social-posts copy)\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`);
    expect(steps.length).toBeGreaterThan(5);
  });
});
