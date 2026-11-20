// Brand kits are data copied from social-posts: their palettes must be check_palette.py's LANES,
// every type style must use a registered font, and tokens / aliases must resolve.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FontRegistry } from "@post-studio/text";
import { GUIDE_SETS, getKit, guidesFor, knownGuideSet, kitJson, listKits, resolveBrandToken, tokenFor } from "../src/index.ts";
import { FIX, PY_TOOL, hasPython } from "./palette-fixtures.ts";

let fonts: FontRegistry;
beforeAll(async () => {
  fonts = await FontRegistry.load();
});

describe("brand kits", () => {
  it("have exactly check_palette.py's palette, paper and accent per lane (mosaic: PLAN-DAILY §7)", () => {
    const lanes: Record<string, { paper: string; accent: string; colors: Record<string, string> }> = hasPython
      ? JSON.parse(spawnSync("python3", [PY_TOOL, "--lanes"], { encoding: "utf8" }).stdout)
      : JSON.parse(readFileSync(join(FIX, "lanes.json"), "utf8"));
    for (const kit of listKits()) {
      const lane = lanes[kit.checkPaletteLane ?? kit.id];
      expect(lane, kit.id).toBeDefined();
      expect(kit.paperHex).toBe(lane.paper);
      expect(kit.accentHex).toBe(lane.accent);
      expect([...kit.byHex.keys()].sort()).toEqual(Object.keys(lane.colors).sort());
    }
    expect(getKit("mosaic")!.checkPaletteLane).toBeNull();
    expect(getKit("mosaic")!.byHex.get("#23487F")?.name).toBe("accent");
  });

  it("type styles use registered fonts and weights, and a kit colour", () => {
    for (const kit of listKits()) {
      for (const s of kit.type) {
        expect(fonts.checkFont(s.font, s.weight), `${kit.id}.${s.name}`).toBeUndefined();
        expect(kit.hex(s.fill), `${kit.id}.${s.name} fill`).toBeDefined();
      }
    }
    const lux = getKit("lux")!;
    expect(lux.style("headline")).toMatchObject({ font: "IBM Plex Sans", weight: 600, size: 60 });
    expect(lux.style("kicker")).toMatchObject({ font: "IBM Plex Mono", weight: 500, size: 26, case: "upper", letterSpacing: 1.56 });
  });

  it("resolves tokens and aliases of any kit", () => {
    expect(resolveBrandToken("lux.ink")).toBe("#190F0B");
    expect(resolveBrandToken("lux.accent")).toBe("#AC1922");
    expect(resolveBrandToken("kites.paper")).toBe("#FFFCF9");
    expect(resolveBrandToken("mosaic.accent")).toBe("#23487F");
    expect(resolveBrandToken("lux.nope")).toBeUndefined();
    expect(resolveBrandToken("nokit.ink")).toBeUndefined();
    expect(tokenFor(getKit("lux")!, "#190f0bcc")).toBe("lux.ink");
    expect(JSON.parse(JSON.stringify(kitJson(getKit("lux")!)))).toMatchObject({ id: "lux", paperHex: "#FCFAF6", accentHex: "#AC1922" });
  });

  it("guide sets: every kit's guides exist, sizes match, aliases resolve", () => {
    for (const kit of listKits()) {
      for (const [size, id] of Object.entries(kit.guides)) {
        const [w, h] = size.split("x").map(Number);
        const g = guidesFor({ w, h, guides: id });
        expect(g, `${kit.id} ${size}`).toBeDefined();
        expect([g!.w, g!.h]).toEqual([w, h]);
        expect(knownGuideSet(id)).toBe(true);
      }
    }
    expect(guidesFor({ w: 1080, h: 1080, guides: "lux/ig-1080" })!.id).toBe("lane/ig-1080");
    expect(guidesFor({ w: 1080, h: 1080, guides: "none" })).toBeUndefined();
    expect(new Set(GUIDE_SETS.map((g) => g.id)).size).toBe(GUIDE_SETS.length);
  });
});
