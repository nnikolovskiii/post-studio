// The TypeScript port of check_palette.py must give exactly its messages, in its order, on every
// real post and on one synthetic SVG per rule. With python3 installed the tool runs live;
// otherwise the recorded golden.json (also checked here) stands in.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import fc from "fast-check";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSvgPalette, cssDecls, getKit, listKits, paletteLane } from "../src/index.ts";
import { FIX, MUTATIONS, ROOT, fixtureSvgs, hasPython, runPythonBatch, writeMutations } from "./palette-fixtures.ts";

const GOLDEN = join(FIX, "golden.json");
const LANES = ["lux", "kites", "studio", "mosaic"];
type Golden = Record<string, string[]>;

function ts(lane: string, file: string, text: string, art = false): string[] {
  return checkSvgPalette(text, paletteLane(getKit(lane)!), { path: file, art }).errors;
}

describe("check_palette.py port", () => {
  const golden: Golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, "utf8")) : {};
  const fresh: Golden = {};
  const files = fixtureSvgs();

  it("covers the real posts (OK and FAIL) of every lane", () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
    for (const lane of LANES) expect(files.some((f) => f.lane === lane)).toBe(true);
  });

  it("gives check_palette.py's exact messages on every real post, in every lane", () => {
    let compared = 0;
    let fails = 0;
    // Every file in every lane, except the two ~470 kB LUX-6 files (base64 fonts), which take
    // check_palette.py a second each: those run in their own lane only.
    const lanesOf = (f: { file: string; lane: string }) => (statSync(join(ROOT, f.file)).size > 200_000 ? [f.lane] : LANES);
    const jobs = files.flatMap((f) => lanesOf(f).map((lane) => [lane, f.file, false] as [string, string, boolean]));
    const py = hasPython ? runPythonBatch(jobs) : [];
    const pyOf = new Map(jobs.map((j, i) => [`${j[0]} ${j[1]}`, py[i]]));
    for (const f of files) {
      const text = readFileSync(join(ROOT, f.file), "utf8");
      for (const lane of lanesOf(f)) {
        const key = `${lane} ${f.file}`;
        // check_palette.py prints the path it was given; run it from the repo root with the relative path.
        const want = hasPython ? pyOf.get(key)! : golden[key];
        expect(want, `no golden for ${key}`).toBeDefined();
        fresh[key] = want;
        expect(ts(lane, f.file, text), key).toEqual(want);
        compared++;
        if (want.length) fails++;
      }
    }
    expect(compared).toBe(jobs.length);
    expect(fails).toBeGreaterThan(20);
    expect(compared - fails).toBeGreaterThan(15);
  });

  it("gives check_palette.py's exact messages on one SVG per rule", () => {
    const paths = writeMutations();
    const names = Object.keys(MUTATIONS);
    const py = hasPython ? runPythonBatch(names.map((n) => ["lux", paths[n], !!MUTATIONS[n].art])) : [];
    for (const [i, [name, m]] of Object.entries(MUTATIONS).entries()) {
      const key = `mutation ${name}`;
      const want = hasPython ? py[i].map((l) => l.split(paths[name]).join(`${name}.svg`)) : golden[key];
      expect(want, `no golden for ${key}`).toBeDefined();
      fresh[key] = want;
      expect(ts("lux", `${name}.svg`, m.svg, m.art), name).toEqual(want);
    }
    expect(fresh["mutation clean"]).toEqual([]);
    expect(fresh["mutation two-accent-groups"].some((l) => l.includes("more than one"))).toBe(true);
  });

  it("matches the recorded golden output (so the comparison also holds without Python)", () => {
    if (process.env.UPDATE_PALETTE_GOLDEN && hasPython) {
      writeFileSync(GOLDEN, JSON.stringify(fresh, null, 1) + "\n");
      return;
    }
    for (const [k, v] of Object.entries(fresh)) expect(golden[k], k).toEqual(v);
  });

  it("cssDecls finds exactly what Python's re.findall(r'([\\w-]+)\\s*:\\s*([^;}{]+)') finds", () => {
    const naive = (t: string) => [...t.matchAll(/([\p{L}\p{N}_-]+)\s*:\s*([^;}{]+)/gu)].map((m) => [m[1], m[2]]);
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a", "Z", "9", "_", "-", ":", " ", "\n", ";", "{", "}", "#", "(", "ж"), { maxLength: 40 }), (chars) => {
        const t = chars.join("");
        expect(cssDecls(t)).toEqual(naive(t));
      }),
      { numRuns: 3000 },
    );
  });

  it("reports malformed XML instead of throwing", () => {
    const r = checkSvgPalette("<svg><g></svg>", paletteLane(getKit("lux")!), { path: "x.svg" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/^x\.svg: XML parse error/);
  });

  it("inside an accent object the accent colour is allowed everywhere and inner accent groups do not count", () => {
    const art = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#AC1922"/><g id="accent"/><g id="accent"/><style>.a{fill:#AC1922}</style></svg>';
    const lane = paletteLane(getKit("lux")!);
    expect(checkSvgPalette(art, lane, { art: true, insideAccent: true }).errors).toEqual([]);
    expect(checkSvgPalette(art, lane, { art: true }).errors.length).toBe(3);
  });

  it("every kit is listed", () => {
    expect(listKits().map((k) => k.id).sort()).toEqual(["kites", "lux", "mosaic", "studio"]);
    expect(basename(GOLDEN)).toBe("golden.json");
  });
});
