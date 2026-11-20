// Motion Part 1 (PLAN-motion.md §4.3): keyframes are plain set / unset ops, so apply, invert,
// pins, diff and outline work on them as on any property. These tests prove the pin engine needs
// no change for keyframe paths, and pin down the time wording agents read.
import { describe, expect, it } from "vitest";
import { presetOps } from "@post-studio/motion";
import { findItem, type Document } from "@post-studio/schema";
import { apply, attribute, checkPins, diffDocs, effectivePins, formatDiff, invert, outline, softPinsFromRevisions, validateDocument, type Op } from "../src/index.ts";
import { loadFixture } from "./helpers.ts";

const node = (doc: Document, id: string) => findItem(doc, id)!.item as any;

/** LUX-6 with 6 s of motion: headline slides up and fades in (in1 / in2), the logo pops. */
function motionDoc(): Document {
  const still = loadFixture();
  const ops = [
    ...presetOps(still, ["headline"], "slide-up-in", { at: 400 }),
    ...presetOps({ ...still, motion: { duration: 6000 } }, ["logo"], "fade-in", { at: 1200, dur: 400 }),
  ] as Op[];
  return apply(still, ops).doc;
}

describe("keyframe ops", () => {
  it("apply, validate and invert like any other property", () => {
    const doc = motionDoc();
    expect(doc.motion).toEqual({ duration: 6000, fps: 30, loop: true });
    expect(node(doc, "headline").anim.tracks.dy).toEqual({ in1: { t: 400, v: 40, ease: "out" }, in2: { t: 1000, v: 0 } });
    const v = validateDocument(doc);
    expect(v.errors).toEqual([]);
    expect(v.warnings.filter((w) => w.code.startsWith("motion"))).toEqual([]);

    const edit: Op[] = [
      { op: "set", node: "headline", path: "anim.tracks.dy.in1.t", value: 250 },
      { op: "unset", node: "logo", path: "anim.tracks.opacity.in2" },
      { op: "set", node: "logo", path: "anim.tracks.scale.k1", value: { t: 1200, v: 0.8, ease: "back-out" } },
      { op: "set", node: "$doc", path: "motion.duration", value: 4500 },
    ];
    const r = apply(doc, edit);
    expect(node(r.doc, "headline").anim.tracks.dy.in1.t).toBe(250);
    expect(node(r.doc, "logo").anim.tracks.opacity.in2).toBeUndefined();
    expect(JSON.stringify(apply(r.doc, r.inverse).doc)).toBe(JSON.stringify(doc));
    expect(JSON.stringify(apply(r.doc, invert(doc, edit)).doc)).toBe(JSON.stringify(doc));

    // The first keyframe on a layer creates `anim`; undo removes it again.
    const first = apply(doc, [{ op: "set", node: "sub", path: "anim.tracks.dx.k1", value: { t: 0, v: -80 } }]);
    expect(first.inverse).toEqual([{ op: "unset", node: "sub", path: "anim" }]);
  });

  it("validateDocument refuses bad motion and warns about late keyframes", () => {
    const doc = motionDoc();
    const late = apply(doc, [{ op: "set", node: "logo", path: "anim.tracks.opacity.in3", value: { t: 7000, v: 0 } }]).doc;
    const v = validateDocument(late);
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.code)).toContain("motion-late");

    expect(() => apply(doc, [{ op: "set", node: "logo", path: "anim.tracks.blur", value: {} }])).toThrow(/not a valid post-studio\/2 document/);
    expect(() => apply(doc, [{ op: "set", node: "logo", path: "anim.tracks.opacity.in1.v", value: 2 }])).toThrow(/valid/);

    const reveal = apply(doc, [{ op: "set", node: "logo", path: "anim.tracks.reveal.a", value: { t: 0, v: 0 } }]).doc;
    const r = validateDocument(reveal);
    expect(r.ok).toBe(false);
    expect(r.errors).toMatchObject([{ code: "motion", node: "logo" }]);
  });
});

describe("pins on keyframes (no change to the pin engine)", () => {
  const doc = motionDoc();
  // Nikola retimed the headline's dy in1, added an opacity keyframe on the logo, changed the duration.
  const human: Op[][] = [
    [{ op: "set", node: "headline", path: "anim.tracks.dy.in1.t", value: 250 }],
    [{ op: "set", node: "logo", path: "anim.tracks.opacity.k9", value: { t: 3000, v: 0.5 } }],
    [{ op: "set", node: "$doc", path: "motion.duration", value: 4500 }],
  ];
  let head = doc;
  for (const ops of human) head = apply(head, ops).doc;
  const soft = softPinsFromRevisions(human.map((ops, i) => ({ rev: 31 + i, author: "human", ops })));
  const pins = effectivePins(head, soft);
  const check = (ops: Op[]) => checkPins(head, ops, pins);

  it("soft-pins exactly the paths he wrote", () => {
    expect(pins.map((p) => `${p.node}.${p.path}`)).toEqual(["headline.anim.tracks.dy.in1.t", "logo.anim.tracks.opacity.k9", "$doc.motion.duration"]);
  });

  it("a retimed keyframe: its time is blocked, its value and ease are free", () => {
    expect(check([{ op: "set", node: "headline", path: "anim.tracks.dy.in1.t", value: 100 }]).ok).toBe(false);
    expect(check([{ op: "set", node: "headline", path: "anim.tracks.dy.in1.v", value: 80 }]).ok).toBe(true);
    expect(check([{ op: "set", node: "headline", path: "anim.tracks.dy.in1.ease", value: "back-out" }]).ok).toBe(true);
    // Other keyframes of the same track and other tracks are free.
    expect(check([{ op: "set", node: "headline", path: "anim.tracks.dy.in2.t", value: 700 }]).ok).toBe(true);
    expect(check([{ op: "set", node: "headline", path: "anim.tracks.opacity.in1.t", value: 250 }]).ok).toBe(true);
    expect(check([{ op: "set", node: "headline", path: "anim.tracks.dy.in3", value: { t: 2000, v: -10 } }]).ok).toBe(true);
  });

  it("deleting or rewriting a pinned keyframe, its track or the whole anim is refused", () => {
    for (const op of [
      { op: "unset", node: "headline", path: "anim.tracks.dy.in1" },
      { op: "set", node: "headline", path: "anim.tracks.dy.in1", value: { t: 400, v: 40 } },
      { op: "unset", node: "headline", path: "anim.tracks.dy" },
      { op: "unset", node: "headline", path: "anim" },
      { op: "set", node: "headline", path: "anim", value: {} },
    ] as Array<Extract<Op, { op: "set" | "unset" }>>) {
      const r = check([op]);
      expect(r.ok, `${op.op} ${op.path}`).toBe(false);
      expect(r.blocked[0].key).toBe("headline.anim.tracks.dy.in1.t");
    }
    // Deleting the layer would remove the pin as well.
    expect(check([{ op: "delete", node: "headline" }]).ok).toBe(false);
  });

  it("a keyframe he added is pinned whole (time, value, ease, delete)", () => {
    for (const path of ["anim.tracks.opacity.k9.t", "anim.tracks.opacity.k9.v", "anim.tracks.opacity.k9.ease"]) {
      expect(check([{ op: "set", node: "logo", path, value: path.endsWith("ease") ? "in" : 1 }]).ok, path).toBe(false);
    }
    expect(check([{ op: "unset", node: "logo", path: "anim.tracks.opacity.k9" }]).ok).toBe(false);
    expect(check([{ op: "set", node: "logo", path: "anim.tracks.opacity.in1.v", value: 0.2 }]).ok).toBe(true);
  });

  it("the duration he set is pinned; other motion fields are free", () => {
    expect(check([{ op: "set", node: "$doc", path: "motion.duration", value: 6000 }]).ok).toBe(false);
    expect(check([{ op: "set", node: "$doc", path: "motion", value: { duration: 6000 } }]).ok).toBe(false);
    expect(check([{ op: "unset", node: "$doc", path: "motion" }]).ok).toBe(false);
    expect(check([{ op: "set", node: "$doc", path: "motion.fps", value: 60 }]).ok).toBe(true);
  });

  it("an override with a reason lets one pinned keyframe change, and shows up as overridden", () => {
    const r = checkPins(head, [{ op: "set", node: "headline", path: "anim.tracks.dy.in1.t", value: 300 }], pins, { "headline.anim.tracks.dy.in1.t": "his note asks to start the headline at 0.3 s" });
    expect(r.ok).toBe(true);
    expect(r.overridden[0].reason).toMatch(/0.3 s/);
  });

  it("explicit pins on a keyframe, a track or all of a layer's motion", () => {
    const pinned = apply(doc, [
      { op: "set", node: "headline", path: "pins", value: ["anim.tracks.dy.in2"] },
      { op: "set", node: "logo", path: "pins", value: ["anim.tracks.opacity"] },
      { op: "set", node: "sub", path: "pins", value: ["anim"] },
    ]).doc;
    const ep = effectivePins(pinned, []);
    const c = (ops: Op[]) => checkPins(pinned, ops, ep).ok;
    expect(c([{ op: "set", node: "headline", path: "anim.tracks.dy.in2.v", value: 5 }])).toBe(false);
    expect(c([{ op: "set", node: "headline", path: "anim.tracks.dy.in1.v", value: 5 }])).toBe(true);
    expect(c([{ op: "set", node: "logo", path: "anim.tracks.opacity.in7", value: { t: 0, v: 0 } }])).toBe(false); // new keyframe in a pinned track
    expect(c([{ op: "set", node: "logo", path: "anim.tracks.scale.k1", value: { t: 0, v: 1 } }])).toBe(true);
    expect(c([{ op: "set", node: "sub", path: "anim.tracks.dx.k1", value: { t: 0, v: -80 } }])).toBe(false); // first keyframe on a pinned layer
    expect(c([{ op: "set", node: "sub", path: "x", value: 140 }])).toBe(true); // the layout is not the motion
    // An agent can never write the pin list itself.
    expect(c([{ op: "set", node: "sub", path: "pins", value: [] }])).toBe(false);
  });
});

describe("diff and outline speak time (§4.3)", () => {
  const doc = motionDoc();
  const revs: Array<{ rev: number; author: string; ops: Op[] }> = [
    {
      rev: 31,
      author: "human",
      ops: [
        { op: "set", node: "headline", path: "anim.tracks.opacity.in1.t", value: 250 },
        { op: "set", node: "headline", path: "anim.tracks.dy.in1.t", value: 250 },
      ],
    },
    {
      rev: 33,
      author: "agent:optibot-claude",
      ops: [
        { op: "set", node: "logo", path: "anim.tracks.scale.k1", value: { t: 1200, v: 0.8, ease: "back-out" } },
        { op: "set", node: "logo", path: "anim.tracks.scale.k2", value: { t: 1600, v: 1 } },
      ],
    },
    { rev: 34, author: "human", ops: [{ op: "set", node: "$doc", path: "motion.duration", value: 4500 }] },
  ];
  let after = doc;
  for (const r of revs) after = apply(after, r.ops).doc;

  it("names retimed keyframes, new keyframes and the new length", () => {
    const text = formatDiff(attribute(diffDocs(doc, after), revs));
    expect(text).toBe(
      [
        "document: duration 6.0 s → 4.5 s   (human, rev 34)",
        "logo:     new scale keyframes 1.20 s (0.8, back-out), 1.60 s (1)   (agent:optibot-claude, rev 33)",
        "headline: dy in1 0.40 s → 0.25 s · opacity in1 0.40 s → 0.25 s   (human, rev 31)",
        "unchanged: masthead, kicker, sub, chart, row-1-label, row-2-label, source, footer, status",
      ].join("\n"),
    );
  });

  it("names value / ease edits, removed keyframes, origin, and motion added / removed", () => {
    const edits = apply(after, [
      { op: "set", node: "headline", path: "anim.tracks.dy.in1.v", value: 80 },
      { op: "set", node: "headline", path: "anim.tracks.dy.in1.ease", value: "back-out" },
      { op: "unset", node: "logo", path: "anim.tracks.opacity" },
      { op: "set", node: "logo", path: "anim.origin", value: "bottom-left" },
      { op: "set", node: "sub", path: "anim", value: { tracks: { dx: { k1: { t: 0, v: -80, ease: "out" }, k2: { t: 600, v: 0 } } } } },
      { op: "set", node: "$doc", path: "motion.loop", value: false },
      { op: "set", node: "$doc", path: "motion.poster", value: 1200 },
    ]).doc;
    const d = diffDocs(after, edits);
    const line = (id: string) => formatDiff({ items: d.items.filter((i) => i.id === id), unchanged: [] }).replace(/^\S+(?: \(\S+\))?:\s+/, "");
    expect(line("headline")).toBe("dy in1 40 → 80, ease out → back-out");
    expect(line("logo")).toBe("removed opacity keyframes in1 1.20 s (0, out), in2 1.60 s (1) · origin center → bottom-left");
    expect(line("sub")).toBe("new motion: dx -80→0 · 0.00–0.60 s · out");
    expect(line("$doc")).toBe("loop off · poster rest → 1.20 s");

    const removed = apply(after, [
      { op: "unset", node: "headline", path: "anim" },
      { op: "unset", node: "logo", path: "anim" },
      { op: "unset", node: "$doc", path: "motion" },
    ]).doc;
    const r = diffDocs(after, removed);
    expect(formatDiff({ items: r.items.filter((i) => i.id === "$doc"), unchanged: [] })).toBe("document: motion removed (now a still post)");
    expect(formatDiff({ items: r.items.filter((i) => i.id === "headline"), unchanged: [] })).toMatch(/^headline: motion cleared \(was dy 40→0, opacity 0→1 · 0\.25–1\.00 s · out\)$/);
    const added = diffDocs(loadFixture(), doc);
    expect(formatDiff({ items: added.items.filter((i) => i.id === "$doc"), unchanged: [] })).toBe("document: motion added: 6.0 s @ 30 fps, loop, poster rest");
  });

  it("layout and motion changes on one layer read side by side", () => {
    const both = apply(doc, [
      { op: "set", node: "headline", path: "y", value: 135 },
      { op: "set", node: "headline", path: "anim.tracks.dy.in2.t", value: 900 },
    ]).doc;
    const d = diffDocs(doc, both);
    expect(formatDiff({ items: d.items, unchanged: [] })).toBe("headline: moved 0,35 · dy in2 1.00 s → 0.90 s");
  });

  it("outline adds a motion header and one anim line per animated layer", () => {
    const text = outline(after, { pins: [{ node: "headline", path: "anim.tracks.dy.in1.t" }] });
    const lines = text.split("\n");
    expect(lines[1]).toBe("  motion: 4.5 s @ 30 fps, loop, poster rest");
    const h = lines.findIndex((l) => l.trimStart().startsWith("headline text"));
    expect(lines[h]).toMatch(/📌anim\.tracks\.dy\.in1\.t$/);
    expect(lines[h + 1]).toBe("      anim: dy 40→0, opacity 0→1 · 0.25–1.00 s · out");
    const l = lines.findIndex((x) => x.trimStart().startsWith("logo image"));
    expect(lines[l + 1]).toBe("      anim: scale 0.8→1, opacity 0→1 · 1.20–1.60 s · back-out/out");
    expect(lines.filter((x) => x.includes("anim:")).length).toBe(2);
  });

  it("a still document's outline and diff are unchanged (no motion lines)", () => {
    const still = loadFixture();
    expect(outline(still)).not.toMatch(/motion:|anim:/);
    const moved = apply(still, [{ op: "set", node: "headline", path: "y", value: 135 }]).doc;
    expect(formatDiff({ items: diffDocs(still, moved).items, unchanged: [] })).toBe("headline: moved 0,35");
  });
});
