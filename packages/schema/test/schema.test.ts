import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  documentJsonSchema,
  findItem,
  indexDocument,
  migrate,
  MIGRATIONS,
  SCHEMA_VERSION,
  SCHEMA_VERSIONS,
  UnknownSchemaVersionError,
  validateStructure,
  type Document,
} from "../src/index.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8")) as Document;

describe("post-studio/2 schema (still documents, as in /1)", () => {
  it("accepts the hand-written LUX-6 square fixture", () => {
    const r = validateStructure(fixture("lux-6-square.hand.json"));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("does not add defaults on parse (documents stay as written)", () => {
    const doc = fixture("lux-6-square.hand.json");
    const before = JSON.stringify(doc);
    validateStructure(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect("rotation" in doc.frames[0].children[0]).toBe(false);
  });

  it("rejects duplicate ids across frames and groups", () => {
    const doc = fixture("lux-6-square.hand.json");
    doc.frames[0].children.push({ ...(doc.frames[0].children[0] as any), id: "row-1-a" });
    const r = validateStructure(doc);
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("duplicate-id");
  });

  it("rejects unknown fields, bad colors, gradients-by-stealth and bad ids", () => {
    const doc = fixture("lux-6-square.hand.json");
    const head = doc.frames[0].children.find((n) => n.id === "headline") as any;
    head.style.fill = "linear-gradient(red, blue)";
    head.filter = "blur(2px)";
    const r = validateStructure(doc);
    expect(r.ok).toBe(false);
    const paths = r.errors.map((e) => e.path);
    expect(paths.some((p) => p.endsWith("style.fill"))).toBe(true);
    expect(r.errors.some((e) => e.message.toLowerCase().includes("unrecognized"))).toBe(true);

    const bad = fixture("lux-6-square.hand.json");
    (bad.frames[0].children[0] as any).id = "has.dot";
    expect(validateStructure(bad).ok).toBe(false);
  });

  it("allows negative line extents but not negative rect sizes", () => {
    const doc = fixture("lux-6-square.hand.json");
    expect(validateStructure(doc).ok).toBe(true);
    (doc.frames[0].children.find((n) => n.id === "rule-top") as any).w = -10;
    expect(validateStructure(doc).ok).toBe(true);
    doc.frames[0].children.push({ id: "r", type: "rect", x: 0, y: 0, w: -1, h: 2 } as any);
    expect(validateStructure(doc).ok).toBe(false);
  });

  it("indexes nested group children with absolute offsets", () => {
    const doc = fixture("lux-6-square.hand.json");
    const idx = indexDocument(doc);
    const loc = idx.get("row-1-a")!;
    expect(loc.parent).toBe("chart");
    expect(loc.frame).toBe("square");
    expect(loc.offset).toEqual({ x: 135, y: 340 });
    expect(findItem(doc, "square")?.kind).toBe("frame");
  });

  it("generates a JSON Schema that covers every node type", () => {
    const js = documentJsonSchema() as any;
    expect(js.title).toBe(SCHEMA_VERSION);
    const text = JSON.stringify(js);
    for (const t of ["text", "rect", "ellipse", "line", "path", "image", "svg", "group"]) {
      expect(text).toContain(`"const":"${t}"`);
    }
    expect(text.length).toBeGreaterThan(2000);
  });

  it("passes current docs through, rejects unknown versions and runs a custom chain", () => {
    const doc = fixture("lux-6-square.hand.json") as any;
    expect(SCHEMA_VERSION).toBe("post-studio/2");
    expect(migrate(doc)).toEqual({ doc, applied: [] });
    expect(() => migrate({ ...doc, schema: "post-studio/0" })).toThrow(UnknownSchemaVersionError);
    expect(() => migrate({ ...doc, schema: "post-studio/3" })).toThrow(/unknown document schema 'post-studio\/3'/);
    const chain = [...MIGRATIONS, { from: "post-studio/0", to: "post-studio/1", up: (d: any) => ({ ...d, lang: d.language, language: undefined }) }];
    const out = migrate({ ...doc, schema: "post-studio/0" }, chain);
    expect(out.applied).toEqual(["post-studio/0 → post-studio/1", "post-studio/1 → post-studio/2"]);
    expect(out.doc.schema).toBe(SCHEMA_VERSION);
  });
});

describe("migration post-studio/1 → post-studio/2 (Motion Part 1)", () => {
  const root = new URL("../../../", import.meta.url);
  const templates = readdirSync(new URL("brand-kits/templates/", root)).filter((f) => f.endsWith(".json") && f !== "index.json");
  const v1Docs: Array<[string, Record<string, unknown>]> = [
    ["fixtures/lux-6-square.hand.json", fixture("lux-6-square.hand.json") as any],
    ...templates.map((f) => [`brand-kits/templates/${f}`, JSON.parse(readFileSync(new URL(`brand-kits/templates/${f}`, root), "utf8")).doc] as [string, Record<string, unknown>]),
  ].map(([name, d]) => [name, { ...d, schema: "post-studio/1" }]);

  it("is the first step of the chain", () => {
    expect(SCHEMA_VERSIONS).toEqual(["post-studio/1", "post-studio/2"]);
    expect(MIGRATIONS.map((m) => `${m.from} → ${m.to}`)).toEqual(["post-studio/1 → post-studio/2"]);
  });

  it("changes only the schema string of every v1 fixture and template, keeps key order, and the result validates", () => {
    expect(v1Docs.length).toBeGreaterThanOrEqual(6);
    for (const [name, v1] of v1Docs) {
      const json = JSON.stringify(v1);
      const out = migrate(v1);
      expect(out.applied, name).toEqual(["post-studio/1 → post-studio/2"]);
      expect(JSON.stringify(out.doc), name).toBe(json.replace('"schema":"post-studio/1"', '"schema":"post-studio/2"'));
      expect(JSON.stringify(v1), name).toBe(json); // the input is not mutated
      const r = validateStructure(out.doc);
      expect(r.errors, name).toEqual([]);
      // A v1 document is not a valid v2 document until it is migrated.
      expect(validateStructure(v1).ok, name).toBe(false);
    }
  });

  it("checked-in fixtures and templates are already post-studio/2", () => {
    expect(fixture("lux-6-square.hand.json").schema).toBe("post-studio/2");
    for (const f of templates) expect(JSON.parse(readFileSync(new URL(`brand-kits/templates/${f}`, root), "utf8")).doc.schema, f).toBe("post-studio/2");
  });
});

describe("post-studio/2 motion fields", () => {
  it("accepts motion on the document and anim on any node type, at any depth", () => {
    const doc = fixture("lux-6-square.hand.json") as any;
    doc.motion = { duration: 6000, fps: 30, loop: true, poster: "rest" };
    const kf = { a: { t: 0, v: 0, ease: "out" }, b: { t: 600, v: 1 } };
    const chart = doc.frames[0].children.find((n: any) => n.id === "chart");
    chart.anim = { origin: "bottom-left", tracks: { opacity: kf } };
    chart.children[0].anim = { tracks: { scaleX: kf, dx: { a: { t: 0, v: -40 } } } };
    doc.frames[0].children.find((n: any) => n.id === "headline").anim = { revealBy: "line", tracks: { reveal: kf, rotate: { a: { t: 0, v: -720 } } } };
    for (const n of doc.frames[0].children) n.anim ??= { tracks: { dy: kf } };
    const r = validateStructure(doc);
    expect(r.errors).toEqual([]);
  });

  it("serves motion and anim in the JSON Schema", () => {
    const js = documentJsonSchema() as any;
    expect(js.$id).toBe("https://post-studio.local/schema/post-studio-2.json");
    expect(js.properties.schema.const).toBe("post-studio/2");
    expect(js.properties.motion.required).toEqual(["duration"]);
    const text = JSON.stringify(js);
    for (const word of ["anim", "tracks", "scaleX", "reveal", "revealBy", "back-out", "bottom-right", "propertyNames"]) expect(text, word).toContain(`"${word}"`.replace(/"propertyNames"/, "propertyNames"));
  });
});
