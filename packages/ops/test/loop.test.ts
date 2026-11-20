import { describe, expect, it } from "vitest";
import { findItem } from "@post-studio/schema";
import {
  apply,
  attribute,
  checkPins,
  diffDocs,
  effectivePins,
  footprint,
  formatDiff,
  outline,
  rebaseOrConflict,
  softPinsFromRevisions,
  validateDocument,
  type Op,
} from "../src/index.ts";
import { loadFixture } from "./helpers.ts";

describe("rebase or conflict", () => {
  const base = loadFixture();
  const theirsOps: Op[] = [
    { op: "set", node: "headline", path: "y", value: 76 },
    { op: "set", node: "headline", path: "style.font", value: "Rubik" },
  ];
  const head = apply(base, theirsOps).doc;
  const theirs = footprint(base, theirsOps).map((t) => ({ ...t, rev: 2 }));

  it("rebases ops that touch different properties", () => {
    const mine: Op[] = [{ op: "set", node: "headline", path: "spans", value: [{ text: "Исти модели, различни оценки." }] }];
    const r = rebaseOrConflict(base, head, mine, theirs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rebased).toBe(true);
    const h = findItem(r.doc, "headline")!.item as any;
    expect(h.y).toBe(76);
    expect(h.style.font).toBe("Rubik");
    expect(h.spans[0].text).toBe("Исти модели, различни оценки.");
  });

  it("returns conflicts for the same property, including parent/child paths", () => {
    const r = rebaseOrConflict(base, head, [{ op: "set", node: "headline", path: "style", value: { font: "IBM Plex Sans", weight: 700, size: 40, fill: "#000000" } }], theirs);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflicts).toEqual([{ node: "headline", path: "style", theirs: "style.font", rev: 2 }]);
  });

  it("conflicts when the other side deleted the node", () => {
    const delOps: Op[] = [{ op: "delete", node: "chart" }];
    const head2 = apply(base, delOps).doc;
    const r = rebaseOrConflict(base, head2, [{ op: "set", node: "row-1-a", path: "x", value: 1 }], footprint(base, delOps));
    expect(r.ok).toBe(false);
  });

  it("merges two inserts into the same parent", () => {
    const a: Op[] = [{ op: "insert", parent: "square", node: { id: "a", type: "rect", x: 0, y: 0, w: 1, h: 1 } }];
    const head3 = apply(base, a).doc;
    const r = rebaseOrConflict(base, head3, [{ op: "insert", parent: "square", node: { id: "b", type: "rect", x: 0, y: 0, w: 1, h: 1 } }], footprint(base, a));
    expect(r.ok).toBe(true);
  });

  it("is a plain apply when nothing happened since base", () => {
    const r = rebaseOrConflict(base, base, [{ op: "set", node: "sub", path: "x", value: 100 }], []);
    expect(r.ok && r.rebased).toBe(false);
  });
});

describe("pins", () => {
  const base = loadFixture();
  const humanRevs = [
    { rev: 3, author: "human", ops: [{ op: "set", node: "headline", path: "y", value: 76 }, { op: "set", node: "headline", path: "style.size", value: 56 }] as Op[] },
    { rev: 4, author: "human", ops: [{ op: "insert", parent: "square", node: { id: "sticker", type: "ellipse", x: 900, y: 900, w: 40, h: 40, fill: "#AC1922" } }] as Op[] },
    { rev: 5, author: "agent:claude", ops: [{ op: "set", node: "sub", path: "x", value: 140 }] as Op[] },
  ];
  const doc = apply(base, humanRevs.flatMap((r) => r.ops)).doc;
  const soft = softPinsFromRevisions(humanRevs);

  it("soft-pins exactly what the human changed or added", () => {
    expect(soft.map((p) => `${p.node}.${p.path}`).sort()).toEqual(["headline.style.size", "headline.y", "sticker.#exists"]);
  });

  it("rejects an agent op on a soft-pinned property, allows other properties", () => {
    const pins = effectivePins(doc, soft);
    const bad = checkPins(doc, [{ op: "set", node: "headline", path: "y", value: 104 }], pins);
    expect(bad.ok).toBe(false);
    expect(bad.blocked[0].key).toBe("headline.y");
    expect(bad.blocked[0].message).toMatch(/--override-pin headline.y/);
    const parentWrite = checkPins(doc, [{ op: "set", node: "headline", path: "style", value: {} }], pins);
    expect(parentWrite.blocked.map((b) => b.key)).toEqual(["headline.style.size"]);
    const ok = checkPins(doc, [{ op: "set", node: "headline", path: "spans", value: [{ text: "Кус наслов" }] }], pins);
    expect(ok.ok).toBe(true);
  });

  it("protects nodes he added from deletion, and his pins list", () => {
    const pins = effectivePins(doc, soft);
    expect(checkPins(doc, [{ op: "delete", node: "sticker" }], pins).ok).toBe(false);
    expect(checkPins(doc, [{ op: "set", node: "sticker", path: "fill", value: "#305880" }], pins).ok).toBe(true);
    expect(checkPins(doc, [{ op: "set", node: "logo", path: "pins", value: [] }], pins).ok).toBe(false);
  });

  it("honours explicit pins: whole node, single property and z-order", () => {
    const pinned = apply(doc, [
      { op: "set", node: "logo", path: "pins", value: ["*"] },
      { op: "set", node: "source", path: "pins", value: ["spans"] },
      { op: "set", node: "footer", path: "pins", value: ["#parent"] },
    ]).doc;
    const pins = effectivePins(pinned, []);
    expect(checkPins(pinned, [{ op: "set", node: "logo", path: "x", value: 0 }], pins).ok).toBe(false);
    expect(checkPins(pinned, [{ op: "set", node: "source", path: "spans.0.text", value: "x" }], pins).ok).toBe(false);
    expect(checkPins(pinned, [{ op: "set", node: "source", path: "x", value: 0 }], pins).ok).toBe(true);
    expect(checkPins(pinned, [{ op: "move", node: "footer", index: 0 }], pins).ok).toBe(false);
    expect(checkPins(pinned, [{ op: "frame", action: "remove", frame: "square" }], pins).ok).toBe(false);
  });

  it("lets an agent override a pin with a reason", () => {
    const pins = effectivePins(doc, soft);
    const r = checkPins(doc, [{ op: "set", node: "headline", path: "y", value: 104 }], pins, { "headline.y": "Nikola asked to recenter" });
    expect(r.ok).toBe(true);
    expect(r.overridden[0]).toMatchObject({ key: "headline.y", reason: "Nikola asked to recenter" });
  });
});

describe("diff", () => {
  it("reads like the plan example and is attributed", () => {
    const base = loadFixture();
    const revs = [
      { rev: 14, author: "human", ops: [{ op: "set", node: "headline", path: "y", value: 76 }] as Op[] },
      { rev: 19, author: "human", ops: [
        { op: "set", node: "headline", path: "style.font", value: "Rubik" },
        { op: "set", node: "headline", path: "style.weight", value: 700 },
        { op: "set", node: "headline", path: "style.size", value: 56 },
      ] as Op[] },
      { rev: 21, author: "human", ops: [{ op: "delete", node: "source" }] as Op[] },
    ];
    const after = apply(base, revs.flatMap((r) => r.ops)).doc;
    const d = attribute(diffDocs(base, after), revs);
    const text = formatDiff(d);
    expect(text).toContain("moved 0,-24 · font IBM Plex Sans 600 → Rubik 700 · size 50 → 56   (human, rev 14–19)");
    expect(text).toMatch(/source:\s+deleted\s+\(human, rev 21\)/);
    expect(text).toMatch(/unchanged:\s+logo, masthead, kicker/);
  });

  it("keeps the unchanged line short when many layers share a role (imported charts)", () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({ id: `bar-${i}`, type: "rect" as const, role: "bar", x: 0, y: i * 10, w: 5, h: 5 }));
    const base = apply(loadFixture(), [{ op: "insert", parent: "square", node: { id: "bars", type: "group", x: 0, y: 0, w: 10, h: 200, children: bars } }]).doc;
    const after = apply(base, [{ op: "set", node: "headline", path: "y", value: 90 }]).doc;
    const d = diffDocs(base, after);
    expect(d.unchanged.filter((u) => u.role === "bar")).toHaveLength(20); // the JSON keeps everything
    const line = formatDiff(d).split("\n").find((l) => l.startsWith("unchanged:"))!;
    expect(line).not.toContain("bar-3");
    expect(line).toMatch(/\(\+\d+ more, incl\. 20 bar\)$/);
  });

  it("reports added subtrees once, z-order and reparenting", () => {
    const base = loadFixture();
    const after = apply(base, [
      { op: "insert", parent: "square", node: { id: "g", type: "group", x: 0, y: 0, w: 10, h: 10, children: [{ id: "g1", type: "rect", x: 0, y: 0, w: 1, h: 1 }] } },
      { op: "move", node: "footer", parent: "chart", index: 0 },
      { op: "move", node: "logo", index: 3 },
    ]).doc;
    const d = diffDocs(base, after);
    expect(d.items.find((i) => i.id === "g")?.kind).toBe("added");
    expect(d.items.find((i) => i.id === "g1")).toBeUndefined();
    expect(d.items.find((i) => i.id === "footer")?.parent).toEqual({ from: "square", to: "chart" });
    expect(d.items.find((i) => i.id === "logo")?.index).toEqual({ from: 0, to: 3 });
  });

  it("says 'no changes' for identical docs", () => {
    const base = loadFixture();
    expect(diffDocs(base, base).items).toEqual([]);
  });
});

describe("validateDocument", () => {
  const base = loadFixture();
  it("checks fonts, assets, tokens, overflow and frame bounds through the context", () => {
    const doc = apply(base, [
      { op: "set", node: "headline", path: "style.font", value: "Comic Sans" },
      { op: "set", node: "sub", path: "style.fill", value: { token: "lux.accent" } },
      { op: "set", node: "footer", path: "x", value: 1070 },
    ]).doc;
    const r = validateDocument(doc, {
      checkFont: (f) => (f === "Comic Sans" ? `font '${f}' is not registered` : undefined),
      assetExists: () => false,
      measureText: (n) => ({ width: n.w, height: n.h, lines: 1, overflowX: 0, overflowY: n.id === "source" ? 12 : 0, missingGlyphs: [] }),
      previous: base,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code).sort()).toEqual(["asset", "font"]);
    // The fixture's kit is LUX: the token resolves, but the accent is outside the accent object.
    expect(r.warnings.map((w) => `${w.node}:${w.code}`).sort()).toEqual(["footer:bounds", "source:overflow", "sub:accent-outside"]);
    const unknown = validateDocument(apply(base, [{ op: "set", node: "sub", path: "style.fill", value: { token: "lux.nope" } }]).doc, {});
    expect(unknown.warnings.map((w) => `${w.node}:${w.code}`)).toEqual(["sub:token"]);
  });

  it("does not warn about nodes that were already outside the frame", () => {
    const out = apply(base, [{ op: "set", node: "footer", path: "x", value: 1070 }]).doc;
    const again = apply(out, [{ op: "set", node: "footer", path: "y", value: 1000 }]).doc;
    expect(validateDocument(again, { previous: out }).warnings).toEqual([]);
  });

  it("makes unresolved tokens errors in strict mode", () => {
    const doc = apply(base, [{ op: "set", node: "sub", path: "style.fill", value: { token: "lux.nope" } }]).doc;
    expect(validateDocument(doc, { strictPalette: true }).ok).toBe(false);
    expect(validateDocument(doc, { strictPalette: true, resolveToken: () => "#655B56" }).ok).toBe(true);
    expect(validateDocument(doc, { strictPalette: true, resolveToken: () => "#000000" }).errors.map((e) => e.code)).toEqual(["palette"]);
  });
});

describe("outline", () => {
  it("prints one line per node with roles and pins", () => {
    const text = outline(loadFixture(), { pins: [{ node: "headline", path: "y" }] });
    expect(text.split("\n")[0]).toContain("prj_lux6hand");
    expect(text).toMatch(/headline text @135,100 810×112 .*IBM Plex Sans 600 50px #190F0B fixed-width center · "Исти модели.\\nРазлични оценки."\s+📌y/);
    expect(text).toMatch(/ {4}row-1-a rect/);
  });
});
