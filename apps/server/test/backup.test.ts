import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backup, listBackups, restore } from "../src/backup.ts";
import { Store } from "../src/store.ts";
import { LOGO, loadFixture, sharedFonts } from "./helpers.ts";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function seeded() {
  const data = tmp("pstudio-bk-");
  const store = new Store({ dataDir: data, fonts: await sharedFonts() });
  const actor = { author: "agent:test" };
  store.addAsset(LOGO(), actor);
  const { project } = store.createProject(loadFixture(), actor);
  for (let i = 0; i < 60; i++) store.applyOps(project, { base: i, ops: [{ op: "set", node: "sub", path: "y", value: 200 + i }], message: `step ${i}` }, actor);
  store.close();
  return { data, project };
}

describe("backup and restore", () => {
  it("round-trips projects (with snapshots), revisions and assets", async () => {
    const { data, project } = await seeded();
    const out = tmp("pstudio-bk-out-");
    const b = backup(data, out, 14);
    expect(b.manifest.projects).toHaveLength(1);
    expect(b.manifest.assets).toBe(1);
    const target = join(tmp("pstudio-bk-tgt-"), "data");
    const r = restore(b.file, target);
    expect(r.verified).toEqual({ integrity: "ok", projects: 1, assets: 1 });
    const store = new Store({ dataDir: target, fonts: await sharedFonts() });
    expect(store.getProject(project).head).toBe(60);
    expect(store.docAt(project, 33)).toEqual(new Store({ dataDir: data, fonts: await sharedFonts() }).docAt(project, 33));
    expect(store.revisions(project)).toHaveLength(61);
    store.close();
  });

  it("keeps only the newest N backups", async () => {
    const { data } = await seeded();
    const out = tmp("pstudio-bk-keep-");
    // Fake older backups so pruning has something to remove.
    for (const d of ["20260101-000000", "20260102-000000", "20260103-000000"]) writeFileSync(join(out, `post-studio-${d}.tar.gz`), "old");
    const b = backup(data, out, 2);
    expect(b.pruned).toEqual(["post-studio-20260102-000000.tar.gz", "post-studio-20260101-000000.tar.gz"]);
    expect(listBackups(out).map((x) => x.file)).toEqual([b.file, join(out, "post-studio-20260103-000000.tar.gz")]);
  });

  it("refuses a non-empty target unless forced, and then moves the old data aside", async () => {
    const { data } = await seeded();
    const b = backup(data, tmp("pstudio-bk-o-"));
    const target = tmp("pstudio-bk-busy-");
    writeFileSync(join(target, "keep.txt"), "x");
    expect(() => restore(b.file, target)).toThrow(/not empty/);
    const r = restore(b.file, target, { force: true });
    expect(existsSync(join(r.movedAside!, "keep.txt"))).toBe(true);
    expect(readdirSync(target).sort()).toEqual(["assets", "post-studio.db"]);
  });

  it("detects a tampered backup before touching the target", async () => {
    const { data } = await seeded();
    const b = backup(data, tmp("pstudio-bk-t-"));
    const x = tmp("pstudio-bk-x-");
    execFileSync("tar", ["-xzf", b.file, "-C", x]);
    rmSync(join(x, "assets"), { recursive: true });
    execFileSync("mkdir", [join(x, "assets")]);
    const bad = join(x, "post-studio-20990101-000000.tar.gz");
    execFileSync("tar", ["-czf", bad, "-C", x, "manifest.json", "post-studio.db", "assets"]);
    const target = join(tmp("pstudio-bk-tt-"), "data");
    expect(() => restore(bad, target)).toThrow(/asset count/);
    expect(existsSync(target)).toBe(false);
  });
});

describe("restore across filesystems", () => {
  it("restores into a target outside the temp filesystem (no EXDEV)", async () => {
    const { data } = await seeded();
    const b = backup(data, tmp("pstudio-bk-fs-"));
    // The project tree is on the home filesystem; os.tmpdir() is often tmpfs.
    const base = mkdtempSync(join(new URL("../../../test-artifacts/", import.meta.url).pathname, "tmp-restore-"));
    dirs.push(base);
    const r = restore(b.file, join(base, "data"));
    expect(r.verified.integrity).toBe("ok");
    expect(readdirSync(base)).toEqual(["data"]);
  });
});
