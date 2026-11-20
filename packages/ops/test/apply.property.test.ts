import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findItem, isContainer, subtreeIds, validateStructure, walk, type Document, type Node } from "@post-studio/schema";
import { apply, applyOne, invert, type Op } from "../src/index.ts";
import { loadFixture } from "./helpers.ts";

type Choice = [number, number, number, number, number];
let fresh = 0;

/** Turn random numbers into an op that is valid against `doc` (or undefined when none fits). */
function buildOp(doc: Document, [k, a, b, c, v]: Choice): Op | undefined {
  const nodes = [...walk(doc)].filter((l) => l.kind === "node");
  const containers = [...walk(doc)].filter((l) => isContainer(l.item));
  const pick = <T,>(arr: T[], r: number) => arr[Math.floor(r * arr.length)];
  const kind = Math.floor(k * 7);
  if (kind <= 2 && nodes.length) {
    const loc = pick(nodes, a);
    const n = loc.item as Node;
    const paths: Array<[string, unknown]> = [
      ["x", Math.round(v * 2000 - 500)],
      ["y", Math.round(v * 2000 - 500) / 4],
      ["rotation", Math.round(v * 360)],
      ["opacity", Math.round(v * 100) / 100],
      ["name", `n${Math.round(v * 99)}`],
      ["role", pick(["headline", "sub", "label", "art"], v)],
      ["meta.score", v],
      ["meta.deep.nested.k", Math.round(v * 9)],
      ["visible", v > 0.5],
    ];
    if (n.type !== "line") paths.push(["w", Math.round(v * 900)], ["h", Math.round(v * 900)]);
    if (n.type === "text") paths.push(["style.size", 10 + Math.round(v * 90)], ["spans.0.text", `Текст ${Math.round(v * 1000)}`], ["style.fill", "#305880"]);
    if (n.type === "rect" || n.type === "ellipse") paths.push(["fill", v > 0.5 ? "#AC1922" : null], ["stroke.width", 1]);
    if (n.type === "line") paths.push(["stroke.width", 1 + Math.round(v * 8)], ["w", Math.round(v * 400 - 200)]);
    const [path, value] = pick(paths, b);
    if (path === "stroke.width" && n.type !== "line" && !(n as any).stroke) return { op: "set", node: n.id, path: "stroke", value: { color: "#000000", width: 1 } };
    return { op: "set", node: n.id, path, value };
  }
  if (kind === 3 && nodes.length) {
    const loc = pick(nodes, a);
    const opt = ["rotation", "name", "role", "meta", "opacity", "visible"].filter((p) => p in (loc.item as object));
    if (!opt.length) return undefined;
    return { op: "unset", node: loc.id, path: pick(opt, b) };
  }
  if (kind === 4) {
    const parent = pick(containers, a);
    const kids = (parent.item as any).children as Node[];
    const id = `new-${fresh++}`;
    const node: Node =
      c > 0.5
        ? { id, type: "rect", x: 10, y: 10, w: 20, h: 20, fill: "#190F0B" }
        : { id, type: "group", x: 5, y: 5, w: 50, h: 50, children: [{ id: `${id}-c`, type: "ellipse", x: 0, y: 0, w: 4, h: 4 }] };
    return { op: "insert", parent: parent.id, index: Math.floor(b * (kids.length + 1)), node };
  }
  if (kind === 5 && nodes.length) {
    const loc = pick(nodes, a);
    if (c < 0.4) return { op: "delete", node: loc.id };
    const forbidden = new Set(subtreeIds(loc.item as Node));
    const targets = containers.filter((t) => !forbidden.has(t.id));
    const target = pick(targets, b);
    const len = (target.item as any).children.length - (target.id === loc.parent ? 1 : 0);
    return { op: "move", node: loc.id, parent: target.id, index: Math.floor(v * (len + 1)) };
  }
  if (kind === 6) {
    if (c < 0.5 && doc.frames.length > 1) return { op: "frame", action: "remove", frame: pick(doc.frames, a).id };
    const id = `frm-${fresh++}`;
    return { op: "frame", action: "add", index: Math.floor(b * (doc.frames.length + 1)), frame: { id, name: "LinkedIn", w: 1080, h: 1350, children: [] } };
  }
  return undefined;
}

function buildBatch(doc: Document, choices: Choice[]): Op[] {
  const work = structuredClone(doc);
  const ops: Op[] = [];
  for (const ch of choices) {
    const op = buildOp(work, ch);
    if (!op) continue;
    applyOne(work, op);
    ops.push(op);
  }
  return ops;
}

const unit = fc.nat({ max: 999_999 }).map((n) => n / 1_000_000);
const choices = fc.array(fc.tuple(unit, unit, unit, unit, unit), { minLength: 1, maxLength: 25 });

describe("apply / invert (property-based)", () => {
  it("apply then invert gives back the original document", () => {
    const base = loadFixture();
    fc.assert(
      fc.property(choices, (ch) => {
        const ops = buildBatch(base, ch);
        const { doc, inverse } = apply(base, ops);
        expect(validateStructure(doc).ok).toBe(true);
        const back = apply(doc, inverse);
        expect(back.doc).toEqual(base);
        // Inverse of the inverse re-does the batch.
        expect(apply(back.doc, back.inverse).doc).toEqual(doc);
      }),
      { numRuns: 400 },
    );
  });

  it("never mutates its input", () => {
    const base = loadFixture();
    const snapshot = JSON.stringify(base);
    fc.assert(
      fc.property(choices, (ch) => {
        apply(base, buildBatch(base, ch));
        expect(JSON.stringify(base)).toBe(snapshot);
      }),
      { numRuns: 100 },
    );
  });

  it("invert() matches the inverse returned by apply()", () => {
    const base = loadFixture();
    fc.assert(
      fc.property(choices, (ch) => {
        const ops = buildBatch(base, ch);
        expect(invert(base, ops)).toEqual(apply(base, ops).inverse);
      }),
      { numRuns: 100 },
    );
  });
});

describe("apply (examples)", () => {
  it("is all-or-nothing", () => {
    const base = loadFixture();
    expect(() =>
      apply(base, [
        { op: "set", node: "headline", path: "x", value: 1 },
        { op: "set", node: "missing", path: "x", value: 1 },
      ]),
    ).toThrow(/op 1: node 'missing' not found/);
    expect(findItem(base, "headline")!.item).toMatchObject({ x: 135 });
  });

  it("rejects ops that leave an invalid document", () => {
    const base = loadFixture();
    expect(() => apply(base, [{ op: "set", node: "headline", path: "style.size", value: -3 }])).toThrow(/not a valid/);
    expect(() => apply(base, [{ op: "set", node: "headline", path: "type", value: "rect" }])).toThrow(/cannot be changed/);
    expect(() => apply(base, [{ op: "insert", parent: "square", node: { id: "logo", type: "rect", x: 0, y: 0, w: 1, h: 1 } }])).toThrow(/already exists/);
    expect(() => apply(base, [{ op: "move", node: "chart", parent: "row-1-a", index: 0 }])).toThrow(/not a frame or group/);
    expect(() => apply(base, [{ op: "move", node: "chart", parent: "chart", index: 0 }])).toThrow(/into itself/);
  });

  it("creates intermediate objects and inverts them away", () => {
    const base = loadFixture();
    const { doc, inverse } = apply(base, [{ op: "set", node: "rule-top", path: "meta.a.b", value: 1 }]);
    expect((findItem(doc, "rule-top")!.item as any).meta).toEqual({ a: { b: 1 } });
    expect(inverse).toEqual([{ op: "unset", node: "rule-top", path: "meta" }]);
  });

  it("sets document-level fields through $doc", () => {
    const base = loadFixture();
    const { doc } = apply(base, [{ op: "set", node: "$doc", path: "title", value: "Нов наслов" }]);
    expect(doc.title).toBe("Нов наслов");
    expect(() => apply(base, [{ op: "set", node: "$doc", path: "frames", value: [] }])).toThrow(/cannot be changed/);
  });
});

describe("generator sanity", () => {
  it("produces every op kind", () => {
    const base = loadFixture();
    const seen = new Set<string>();
    fc.assert(
      fc.property(choices, (ch) => {
        for (const op of buildBatch(base, ch)) seen.add(op.op === "frame" ? `frame-${op.action}` : op.op);
      }),
      { numRuns: 200 },
    );
    expect([...seen].sort()).toEqual(["delete", "frame-add", "frame-remove", "insert", "move", "set", "unset"]);
  });
});
