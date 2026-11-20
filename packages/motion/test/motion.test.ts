import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EASES, findItem, ORIGINS, validateStructure, type Document, type Track } from "@post-studio/schema";
import {
  activeTracks,
  addKeyframe,
  addMotion,
  animSummary,
  BACK_OUT_C1,
  clearNodeMotion,
  deleteKeyframe,
  ease,
  editKeyframe,
  EASE_FUNCTIONS,
  fmtDuration,
  fmtTime,
  frameCount,
  frameTimes,
  getPreset,
  hasKeyframes,
  motionSummary,
  MotionError,
  moveKeyframe,
  nextKeyId,
  originPoint,
  posterTime,
  presetOps,
  PRESETS,
  readingOrder,
  removeMotion,
  sampleNode,
  sampleTrack,
  setOrigin,
  shiftKeyframes,
  snapToFrame,
  sortedKeyframes,
  stretchKeyframes,
  timeRange,
  validateMotion,
  type MotionOp,
} from "../src/index.ts";

const fixture = (): Document => JSON.parse(readFileSync(new URL("../../../fixtures/lux-6-square.hand.json", import.meta.url), "utf8"));

/** Minimal set / unset applier for these tests (the real one is @post-studio/ops, which depends on this package). */
function applyOps(doc: Document, ops: MotionOp[]): Document {
  const out = structuredClone(doc) as any;
  for (const op of ops) {
    const target = op.node === "$doc" ? out : (findItem(out, op.node)!.item as any);
    const keys = op.path.split(".");
    let cur = target;
    for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
    if (op.op === "set") cur[keys.at(-1)!] = structuredClone(op.value);
    else delete cur[keys.at(-1)!];
  }
  return out;
}

const node = (doc: Document, id: string) => findItem(doc, id)!.item as any;

describe("eases", () => {
  const ps = Array.from({ length: 1001 }, (_, i) => i / 1000);

  it("hit both endpoints exactly", () => {
    for (const name of EASES) {
      expect(ease(name, 0), name).toBe(0);
      expect(ease(name, 1), name).toBe(1);
    }
  });

  it("clamp progress outside 0–1 and default to 'out'", () => {
    for (const name of EASES) {
      expect(ease(name, -3)).toBe(0);
      expect(ease(name, 7)).toBe(1);
    }
    expect(ease(undefined, 0.3)).toBe(EASE_FUNCTIONS.out(0.3));
  });

  it("are monotonic and stay inside 0–1 (linear, in, out, in-out)", () => {
    for (const name of ["linear", "in", "out", "in-out"] as const) {
      let prev = -1;
      for (const p of ps) {
        const v = ease(name, p);
        expect(v, `${name}(${p})`).toBeGreaterThanOrEqual(prev);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        prev = v;
      }
    }
  });

  it("have the expected shapes", () => {
    expect(ease("linear", 0.25)).toBeCloseTo(0.25, 12);
    expect(ease("in", 0.5)).toBeCloseTo(0.125, 12); // slow start
    expect(ease("out", 0.5)).toBeCloseTo(0.875, 12); // fast start
    expect(ease("in-out", 0.5)).toBeCloseTo(0.5, 12);
    expect(ease("in-out", 0.25)).toBeLessThan(0.25);
    expect(ease("in-out", 0.75)).toBeGreaterThan(0.75);
    // in-out is symmetric
    for (const p of [0.1, 0.2, 0.37]) expect(ease("in-out", p) + ease("in-out", 1 - p)).toBeCloseTo(1, 12);
  });

  it("back-out overshoots a little, never more than about 10 %, and never goes below 0", () => {
    const vs = ps.map((p) => ease("back-out", p));
    const max = Math.max(...vs);
    expect(max).toBeGreaterThan(1.05);
    expect(max).toBeLessThan(1.11);
    expect(Math.min(...vs)).toBeGreaterThanOrEqual(0);
    expect(vs.indexOf(max)).toBeGreaterThan(500); // the overshoot comes late, then settles back to 1
    expect(BACK_OUT_C1).toBeCloseTo(1.70158, 5);
  });

  it("hold steps: start value until the next keyframe, then the next value", () => {
    for (const p of [0, 0.001, 0.5, 0.999]) expect(ease("hold", p)).toBe(0);
    expect(ease("hold", 1)).toBe(1);
  });
});

describe("sampleTrack", () => {
  const track: Track = { k1: { t: 400, v: 40, ease: "linear" }, k2: { t: 1000, v: 0 }, k3: { t: 2000, v: 10, ease: "hold" }, k4: { t: 3000, v: -5 } };

  it("holds the first value before the first keyframe and the last after the last", () => {
    expect(sampleTrack(track, 0)).toBe(40);
    expect(sampleTrack(track, 399)).toBe(40);
    expect(sampleTrack(track, 3000)).toBe(-5);
    expect(sampleTrack(track, 99_999)).toBe(-5);
  });

  it("is exact on keyframes and interpolates between them with the first keyframe's ease", () => {
    expect(sampleTrack(track, 400)).toBe(40);
    expect(sampleTrack(track, 1000)).toBe(0);
    expect(sampleTrack(track, 700)).toBeCloseTo(20, 12); // linear halfway
    // k2 has no ease: default 'out'
    expect(sampleTrack(track, 1500)).toBeCloseTo(10 * ease("out", 0.5), 12);
    // k3 is 'hold': 10 until 3000, then −5
    expect(sampleTrack(track, 2999)).toBe(10);
    expect(sampleTrack(track, 2000)).toBe(10);
  });

  it("orders keyframes by time, not by map order", () => {
    const reversed: Track = Object.fromEntries(Object.entries(track).reverse());
    const shuffled: Track = { k3: track.k3, k1: track.k1, k4: track.k4, k2: track.k2 };
    for (const t of [0, 400, 550, 700, 1000, 1200, 2500, 3000, 4000]) {
      expect(sampleTrack(reversed, t)).toBe(sampleTrack(track, t));
      expect(sampleTrack(shuffled, t)).toBe(sampleTrack(track, t));
    }
    expect(sortedKeyframes(shuffled).map((k) => k.key)).toEqual(["k1", "k2", "k3", "k4"]);
  });

  it("jumps when two keyframes share a time (the later id wins from that moment)", () => {
    const j: Track = { b: { t: 500, v: 1 }, a: { t: 500, v: 0 }, z: { t: 0, v: 0, ease: "linear" } };
    expect(sampleTrack(j, 250)).toBeCloseTo(0, 12); // z → a (0 → 0)
    expect(sampleTrack(j, 500)).toBe(1);
    expect(sampleTrack(j, 800)).toBe(1);
  });

  it("returns the neutral value for empty or missing tracks, and a single keyframe holds forever", () => {
    expect(sampleTrack(undefined, 100, 1)).toBe(1);
    expect(sampleTrack({}, 100, 0)).toBe(0);
    expect(sampleTrack({ only: { t: 900, v: 0.3 } }, 0)).toBe(0.3);
    expect(sampleTrack({ only: { t: 900, v: 0.3 } }, 5000)).toBe(0.3);
  });
});

describe("sampleNode", () => {
  it("is neutral without anim and fills missing tracks with neutral values", () => {
    expect(sampleNode(undefined, 0)).toEqual({ dx: 0, dy: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1, reveal: 1 });
    expect(sampleNode({ anim: { tracks: { dy: { k1: { t: 0, v: 40, ease: "linear" }, k2: { t: 1000, v: 0 } } } } }, 500)).toEqual({ dx: 0, dy: 20, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1, reveal: 1 });
  });

  it("clamps opacity and reveal to 0–1 and scales to ≥ 0 during a back-out overshoot", () => {
    const n = {
      anim: {
        tracks: {
          opacity: { a: { t: 0, v: 0, ease: "back-out" as const }, b: { t: 1000, v: 1 } },
          reveal: { a: { t: 0, v: 0, ease: "back-out" as const }, b: { t: 1000, v: 1 } },
          scaleX: { a: { t: 0, v: 1, ease: "back-out" as const }, b: { t: 1000, v: 0 } },
          scale: { a: { t: 0, v: 0.8, ease: "back-out" as const }, b: { t: 1000, v: 1 } },
        },
      },
    };
    const s = sampleNode(n, 750);
    expect(s.opacity).toBe(1);
    expect(s.reveal).toBe(1);
    expect(s.scaleX).toBe(0);
    expect(s.scale).toBeGreaterThan(1); // scale may overshoot upwards: that is the 'pop'
  });

  it("reports active tracks and the time range", () => {
    const n = { anim: { tracks: { opacity: { x: { t: 300, v: 0 }, y: { t: 900, v: 1 } }, dy: {}, rotate: { r: { t: 1500, v: 10 } } } } };
    expect(activeTracks(n)).toEqual(["rotate", "opacity"]);
    expect(timeRange(n)).toEqual([300, 1500]);
    expect(hasKeyframes(n)).toBe(true);
    expect(hasKeyframes({ anim: { origin: "left" } })).toBe(false);
    expect(timeRange({})).toBeUndefined();
  });
});

describe("frame times and anchors", () => {
  it("has round(duration × fps / 1000) frames at round(i × 1000 / fps) ms", () => {
    const t = frameTimes({ duration: 6000, fps: 30 });
    expect(t.length).toBe(180);
    expect(t.slice(0, 4)).toEqual([0, 33, 67, 100]);
    expect(t.at(-1)).toBe(5967);
    expect(frameCount({ duration: 6000 })).toBe(180); // fps defaults to 30
    expect(frameCount({ duration: 1000, fps: 24 })).toBe(24);
    expect(frameTimes({ duration: 1000, fps: 24 })[1]).toBe(42);
    expect(frameCount({ duration: 4500, fps: 25 })).toBe(113); // 112.5 rounds up
    expect(frameCount({ duration: 500, fps: 60 })).toBe(30);
    expect(new Set(frameTimes({ duration: 60_000, fps: 60 })).size).toBe(3600);
  });

  it("snaps a time to the nearest frame", () => {
    expect(snapToFrame(50, 30)).toBe(67);
    expect(snapToFrame(49, 30)).toBe(33);
    expect(snapToFrame(1000, 30)).toBe(1000);
  });

  it("places the nine origins on the box", () => {
    const got = Object.fromEntries(ORIGINS.map((o) => [o, originPoint(o, 200, 100)]));
    expect(got).toEqual({
      center: { x: 100, y: 50 },
      "top-left": { x: 0, y: 0 },
      top: { x: 100, y: 0 },
      "top-right": { x: 200, y: 0 },
      left: { x: 0, y: 50 },
      right: { x: 200, y: 50 },
      "bottom-left": { x: 0, y: 100 },
      bottom: { x: 100, y: 100 },
      "bottom-right": { x: 200, y: 100 },
    });
    expect(originPoint(undefined, 10, 10)).toEqual({ x: 5, y: 5 });
  });

  it("reads the poster moment", () => {
    expect(posterTime(undefined)).toBeUndefined();
    expect(posterTime({ poster: "rest" })).toBeUndefined();
    expect(posterTime({ poster: 1200 })).toBe(1200);
  });
});

describe("validation", () => {
  const motionDoc = () => {
    const d = fixture();
    d.motion = { duration: 3000, fps: 30 };
    return d;
  };

  it("accepts a still document and a valid motion document", () => {
    expect(validateMotion(fixture())).toEqual({ errors: [], warnings: [], keyframes: 0 });
    const d = motionDoc();
    node(d, "headline").anim = { tracks: { dy: { in1: { t: 400, v: 40, ease: "out" }, in2: { t: 1000, v: 0 } } } };
    node(d, "headline").anim.revealBy = "word";
    node(d, "headline").anim.tracks.reveal = { a: { t: 0, v: 0 }, b: { t: 900, v: 1 } };
    expect(validateStructure(d).ok).toBe(true);
    expect(validateMotion(d)).toEqual({ errors: [], warnings: [], keyframes: 4 });
  });

  it("warns about a keyframe after the end and a late poster", () => {
    const d = motionDoc();
    d.motion!.poster = 4000;
    node(d, "logo").anim = { tracks: { opacity: { a: { t: 2500, v: 0 }, b: { t: 3500, v: 1 } } } };
    const r = validateMotion(d);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => [w.code, w.node])).toEqual([
      ["motion-late", "logo"],
      ["motion-late", "$doc"],
    ]);
    expect(r.warnings[0].message).toBe("opacity keyframe b at 3.50 s after the end (3.00 s): never plays");
  });

  it("refuses reveal on a non-text layer", () => {
    const d = motionDoc();
    node(d, "logo").anim = { tracks: { reveal: { a: { t: 0, v: 0 }, b: { t: 500, v: 1 } } } };
    expect(validateStructure(d).ok).toBe(true); // the schema allows the shape …
    const r = validateMotion(d); // … the motion check refuses it
    expect(r.errors).toMatchObject([{ code: "motion", node: "logo", path: "logo.anim.tracks.reveal" }]);
  });

  it("warns when layers have keyframes but the document has no motion", () => {
    const d = fixture();
    node(d, "logo").anim = { tracks: { opacity: { a: { t: 0, v: 0 } } } };
    expect(validateMotion(d).warnings.map((w) => w.code)).toEqual(["motion-off"]);
  });

  it("caps the keyframes of a whole document at 5000", () => {
    const d = motionDoc();
    const texts = ["headline", "sub", "source", "footer", "status", "kicker"];
    for (const [i, id] of texts.entries()) {
      node(d, id).anim = { tracks: {} };
      for (const tr of ["dx", "dy", "scale", "rotate", "opacity", "scaleX", "scaleY", "reveal"]) {
        node(d, id).anim.tracks[tr] = Object.fromEntries(Array.from({ length: i === 5 ? 50 : 100 }, (_, k) => [`k${k}`, { t: k * 10, v: 0.5 }]));
      }
    }
    expect(validateStructure(d).ok).toBe(true);
    const r = validateMotion(d);
    expect(r.keyframes).toBe(5 * 800 + 400);
    expect(validateMotion(d).errors).toEqual([]);
    node(d, "masthead").anim = { tracks: { dy: Object.fromEntries(Array.from({ length: 1 }, (_, k) => [`k${k}`, { t: k, v: 0 }])) } };
    expect(validateMotion(d).errors).toEqual([]); // 4401
    node(d, "kicker").anim.tracks.dy = Object.fromEntries(Array.from({ length: 100 }, (_, k) => [`k${k}`, { t: k, v: 0 }]));
    node(d, "kicker").anim.tracks.dx = Object.fromEntries(Array.from({ length: 100 }, (_, k) => [`k${k}`, { t: k, v: 0 }]));
    // 5 × 800 + 6 × 50 + 2 × 100 + 1 = 4501 … push past 5000 with the logo
    node(d, "logo").anim = { tracks: {} };
    for (const tr of ["dx", "dy", "scale", "rotate", "opacity", "scaleX"]) {
      node(d, "logo").anim.tracks[tr] = Object.fromEntries(Array.from({ length: 100 }, (_, k) => [`k${k}`, { t: k, v: 0.5 }]));
    }
    const over = validateMotion(d);
    expect(over.keyframes).toBe(5101);
    expect(over.errors).toMatchObject([{ code: "motion", node: "$doc" }]);
  });

  it("the schema refuses unknown tracks, out-of-range values, bad ids, too many keyframes per track and bad motion fields", () => {
    const cases: Array<[string, (d: any) => void, RegExp]> = [
      ["unknown track", (d) => (node(d, "logo").anim = { tracks: { blur: {} } }), /unknown track 'blur'/],
      ["opacity > 1", (d) => (node(d, "logo").anim = { tracks: { opacity: { a: { t: 0, v: 1.5 } } } }), /opacity values are 0–1/],
      ["negative scale", (d) => (node(d, "logo").anim = { tracks: { scaleX: { a: { t: 0, v: -1 } } } }), /scaleX values are 0–20/],
      ["scale > 20", (d) => (node(d, "logo").anim = { tracks: { scale: { a: { t: 0, v: 21 } } } }), /scale values are 0–20/],
      ["fractional time", (d) => (node(d, "logo").anim = { tracks: { dx: { a: { t: 0.5, v: 1 } } } }), /whole milliseconds/],
      ["negative time", (d) => (node(d, "logo").anim = { tracks: { dx: { a: { t: -1, v: 1 } } } }), /./],
      ["bad keyframe id", (d) => (node(d, "logo").anim = { tracks: { dx: { "k.1": { t: 0, v: 1 } } } }), /keyframe ids/],
      ["unknown ease", (d) => (node(d, "logo").anim = { tracks: { dx: { a: { t: 0, v: 1, ease: "bounce" } } } }), /./],
      ["unknown origin", (d) => (node(d, "logo").anim = { origin: "middle" }), /./],
      ["101 keyframes", (d) => (node(d, "logo").anim = { tracks: { dx: Object.fromEntries(Array.from({ length: 101 }, (_, k) => [`k${k}`, { t: k, v: 0 }])) } }), /at most 100 keyframes/],
      ["fps 29", (d) => (d.motion = { duration: 6000, fps: 29 }), /fps is 24, 25, 30 or 60/],
      ["duration too long", (d) => (d.motion = { duration: 60_001 }), /./],
      ["duration too short", (d) => (d.motion = { duration: 499 }), /./],
      ["extra motion field", (d) => (d.motion = { duration: 6000, audio: "x" }), /nrecognized/],
      ["anim on a frame", (d) => (d.frames[0].anim = {}), /nrecognized/],
    ];
    for (const [name, mutate, re] of cases) {
      const d = fixture() as any;
      mutate(d);
      const r = validateStructure(d);
      expect(r.ok, name).toBe(false);
      expect(r.errors.map((e) => e.message).join(" | "), name).toMatch(re);
    }
  });
});

describe("op-writing helpers (they return ops, never apply)", () => {
  const base = () => {
    const d = fixture();
    d.motion = { duration: 6000, fps: 30, loop: true };
    return d;
  };

  it("adds keyframes with fresh ids and updates the one at the same time", () => {
    let d = base();
    const before = JSON.stringify(d);
    const a = addKeyframe(d, "headline", "dy", { t: 400, v: 40, ease: "out" });
    expect(JSON.stringify(d)).toBe(before); // nothing applied
    expect(a).toEqual([{ op: "set", node: "headline", path: "anim.tracks.dy.k1", value: { t: 400, v: 40, ease: "out" } }]);
    d = applyOps(d, a);
    expect(addKeyframe(d, "headline", "dy", { t: 1000, v: 0 })).toEqual([{ op: "set", node: "headline", path: "anim.tracks.dy.k2", value: { t: 1000, v: 0 } }]);
    expect(addKeyframe(d, "headline", "dy", { t: 400, v: 60 })).toEqual([{ op: "set", node: "headline", path: "anim.tracks.dy.k1.v", value: 60 }]);
    expect(addKeyframe(d, "headline", "dy", { t: 400, v: 40 })).toEqual([]);
    expect(addKeyframe(d, "headline", "dy", { t: 400, v: 40 }, { replaceAtSameTime: false })[0].path).toBe("anim.tracks.dy.k2");
    expect(addKeyframe(d, "headline", "dy", { t: 500, v: 1 }, { key: "in1" })[0].path).toBe("anim.tracks.dy.in1");
    expect(() => addKeyframe(d, "headline", "dy", { t: 500, v: 1 }, { key: "k1" })).toThrow(/already has/);
    expect(() => addKeyframe(d, "headline", "blur", { t: 0, v: 1 })).toThrow(MotionError);
    expect(() => addKeyframe(d, "headline", "dy", { t: 1.5, v: 1 })).toThrow(/whole ms/);
    expect(() => addKeyframe(d, "nope", "dy", { t: 0, v: 1 })).toThrow(/not found/);
  });

  it("never reuses an id it was told to avoid, and counts past gaps", () => {
    const n = { anim: { tracks: { dy: { k1: { t: 0, v: 0 }, k7: { t: 1, v: 0 }, in3: { t: 2, v: 0 } } } } };
    expect(nextKeyId(n, "dy")).toBe("k8");
    expect(nextKeyId(n, "dy", "in")).toBe("in4");
    expect(nextKeyId(n, "dy", "k", ["k8", "k9"])).toBe("k10");
    expect(nextKeyId({}, "opacity", "out")).toBe("out1");
  });

  it("retimes only `t`, edits only `v` / ease, deletes with unset", () => {
    let d = base();
    d = applyOps(d, [...addKeyframe(d, "headline", "dy", { t: 400, v: 40, ease: "out" }, { key: "in1" }), ...addKeyframe(d, "headline", "dy", { t: 1000, v: 0 }, { key: "in2" })]);
    expect(moveKeyframe(d, "headline", "dy", "in1", 250)).toEqual([{ op: "set", node: "headline", path: "anim.tracks.dy.in1.t", value: 250 }]);
    expect(moveKeyframe(d, "headline", "dy", "in1", 400)).toEqual([]);
    expect(editKeyframe(d, "headline", "dy", "in1", { v: 80, ease: "back-out" })).toEqual([
      { op: "set", node: "headline", path: "anim.tracks.dy.in1.v", value: 80 },
      { op: "set", node: "headline", path: "anim.tracks.dy.in1.ease", value: "back-out" },
    ]);
    expect(editKeyframe(d, "headline", "dy", "in1", { ease: null })).toEqual([{ op: "unset", node: "headline", path: "anim.tracks.dy.in1.ease" }]);
    expect(deleteKeyframe(d, "headline", "dy", "in2")).toEqual([{ op: "unset", node: "headline", path: "anim.tracks.dy.in2" }]);
    expect(() => deleteKeyframe(d, "headline", "dy", "in9")).toThrow(/no dy keyframe 'in9'/);
  });

  it("shifts and stretches a layer's keyframes, and refuses a shift before 0", () => {
    let d = base();
    d = applyOps(d, presetOps(d, ["headline"], "slide-up-in", { at: 400 }));
    const shift = shiftKeyframes(d, "headline", -150);
    expect(shift.map((o) => [o.path, (o as any).value])).toEqual([
      ["anim.tracks.dy.in1.t", 250],
      ["anim.tracks.dy.in2.t", 850],
      ["anim.tracks.opacity.in1.t", 250],
      ["anim.tracks.opacity.in2.t", 850],
    ]);
    expect(shiftKeyframes(d, "headline", -150, { tracks: ["opacity"] }).length).toBe(2);
    expect(shiftKeyframes(d, "headline", 0)).toEqual([]);
    expect(() => shiftKeyframes(d, "headline", -401)).toThrow(/before 0/);
    const stretch = stretchKeyframes(d, "headline", 0.5, 400);
    expect(stretch.map((o) => (o as any).value)).toEqual([700, 700]); // only the end keyframes move (1000 → 700)
    expect(() => stretchKeyframes(d, "headline", 0, 0)).toThrow(/> 0/);
  });

  it("writes presets with stagger, origins and ids in<n> / out<n>", () => {
    const d = fixture(); // still post: the preset adds $doc.motion
    const rows = ["row-1-a", "headline", "sub"];
    const ops = presetOps(d, rows, "grow-left", { at: 200, dur: 500, stagger: 80 });
    expect(ops[0]).toEqual({ op: "set", node: "$doc", path: "motion", value: { duration: 6000, fps: 30, loop: true } });
    const keyOps = ops.filter((o) => o.path.startsWith("anim.tracks"));
    expect(keyOps.map((o) => [o.node, o.path, (o as any).value])).toEqual([
      ["row-1-a", "anim.tracks.scaleX.in1", { t: 200, v: 0, ease: "out" }],
      ["row-1-a", "anim.tracks.scaleX.in2", { t: 700, v: 1 }],
      ["headline", "anim.tracks.scaleX.in1", { t: 280, v: 0, ease: "out" }],
      ["headline", "anim.tracks.scaleX.in2", { t: 780, v: 1 }],
      ["sub", "anim.tracks.scaleX.in1", { t: 360, v: 0, ease: "out" }],
      ["sub", "anim.tracks.scaleX.in2", { t: 860, v: 1 }],
    ]);
    expect(ops.filter((o) => o.path === "anim.origin").map((o) => [o.node, (o as any).value])).toEqual([
      ["row-1-a", "left"],
      ["headline", "left"],
      ["sub", "left"],
    ]);
    const after = applyOps(d, ops);
    expect(validateStructure(after).ok).toBe(true);
    expect(validateMotion(after)).toMatchObject({ errors: [], warnings: [] });
    expect(sampleNode(node(after, "headline"), 280).scaleX).toBe(0);
    expect(sampleNode(node(after, "headline"), 780).scaleX).toBe(1);
  });

  it("knows every preset, accepts the agent alias 'fade-up', and applies distance / ease overrides", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["fade-in", "slide-up-in", "slide-in-left", "slide-in-right", "pop", "grow-left", "grow-bottom", "typewriter", "fade-out", "slide-down-out"]);
    expect(getPreset("fade-up")?.id).toBe("slide-up-in");
    const d = base();
    const ops = presetOps(d, ["headline"], "fade-up", { at: 400, dur: 600, ease: "in-out", distance: 60 });
    expect(ops).toEqual([
      { op: "set", node: "headline", path: "anim.tracks.dy.in1", value: { t: 400, v: 60, ease: "in-out" } },
      { op: "set", node: "headline", path: "anim.tracks.dy.in2", value: { t: 1000, v: 0 } },
      { op: "set", node: "headline", path: "anim.tracks.opacity.in1", value: { t: 400, v: 0, ease: "in-out" } },
      { op: "set", node: "headline", path: "anim.tracks.opacity.in2", value: { t: 1000, v: 1 } },
    ]);
    // A second preset on the same layer gets the next ids; an exit preset uses out<n>.
    const d2 = applyOps(d, ops);
    expect(presetOps(d2, ["headline"], "fade-in", { at: 2000 }).map((o) => o.path)).toEqual(["anim.tracks.opacity.in3", "anim.tracks.opacity.in4"]);
    expect(presetOps(d2, ["headline"], "fade-out", { at: 5000 }).map((o) => o.path)).toEqual(["anim.tracks.opacity.out1", "anim.tracks.opacity.out2"]);
    // A keyframe at exactly the same time updates the existing one instead of doubling it.
    expect(presetOps(d2, ["headline"], "fade-in", { at: 400, dur: 600 })).toEqual([{ op: "set", node: "headline", path: "anim.tracks.opacity.in1.ease", value: "out" }]);
    for (const p of PRESETS) {
      const target = p.textOnly ? "headline" : "logo";
      const after = applyOps(d, presetOps(d, [target], p.id, { at: 0 }));
      expect(validateStructure(after).ok, p.id).toBe(true);
      expect(validateMotion(after).errors, p.id).toEqual([]);
    }
  });

  it("refuses typewriter on a non-text layer, unknown presets and bad times", () => {
    const d = base();
    expect(() => presetOps(d, ["logo"], "typewriter", { at: 0 })).toThrow(/text layers only/);
    expect(() => presetOps(d, ["logo"], "wiggle", { at: 0 })).toThrow(/unknown preset/);
    expect(() => presetOps(d, [], "pop", { at: 0 })).toThrow(/at least one/);
    expect(() => presetOps(d, ["logo"], "pop", { at: -1 })).toThrow(/≥ 0/);
    expect(() => presetOps(d, ["logo"], "pop", { at: 0, dur: 0 })).toThrow(/> 0/);
  });

  it("orders layers top-to-bottom, then left-to-right", () => {
    const d = fixture();
    expect(readingOrder(d, ["footer", "status", "headline", "logo", "kicker"])).toEqual(["logo", "kicker", "headline", "footer", "status"]);
  });

  it("adds and removes motion, clears a layer, sets an origin", () => {
    const still = fixture();
    expect(addMotion(still)).toEqual([{ op: "set", node: "$doc", path: "motion", value: { duration: 6000, fps: 30, loop: true } }]);
    let d = applyOps(still, presetOps(still, ["headline", "logo"], "pop", { at: 0, stagger: 100 }));
    expect(addMotion(d)).toEqual([]);
    expect(clearNodeMotion(d, "logo")).toEqual([{ op: "unset", node: "logo", path: "anim" }]);
    expect(clearNodeMotion(d, "sub")).toEqual([]);
    expect(setOrigin(d, "logo", "center")).toEqual([]);
    expect(setOrigin(d, "logo", "top-left")).toEqual([{ op: "set", node: "logo", path: "anim.origin", value: "top-left" }]);
    expect(setOrigin(still, "logo", "center")).toEqual([]);
    const rm = removeMotion(d);
    expect(rm).toEqual([
      { op: "unset", node: "logo", path: "anim" },
      { op: "unset", node: "headline", path: "anim" },
      { op: "unset", node: "$doc", path: "motion" },
    ]);
    d = applyOps(d, rm);
    expect(JSON.stringify(d)).toBe(JSON.stringify(still));
  });
});

describe("time wording", () => {
  it("formats times, lengths, the document's motion and a layer's motion", () => {
    expect(fmtTime(400)).toBe("0.40 s");
    expect(fmtTime(1234)).toBe("1.23 s");
    expect(fmtDuration(6000)).toBe("6.0 s");
    expect(fmtDuration(4500)).toBe("4.5 s");
    expect(fmtDuration(4550)).toBe("4.55 s");
    expect(motionSummary({ duration: 6000, fps: 30, loop: true })).toBe("6.0 s @ 30 fps, loop, poster rest");
    expect(motionSummary({ duration: 4500, fps: 25, poster: 1200 })).toBe("4.5 s @ 25 fps, poster 1.20 s");
    expect(animSummary({ tracks: { dy: { k1: { t: 400, v: 40, ease: "out" }, k2: { t: 1000, v: 0 } }, opacity: { k1: { t: 400, v: 0, ease: "out" }, k2: { t: 1000, v: 1 } } } })).toBe(
      "dy 40→0, opacity 0→1 · 0.40–1.00 s · out",
    );
    expect(animSummary({ origin: "left", tracks: { scaleX: { a: { t: 0, v: 0, ease: "back-out" }, b: { t: 500, v: 1.05, ease: "linear" }, c: { t: 700, v: 1 } } } })).toBe(
      "scaleX 0→1.05→1 · 0.00–0.70 s · back-out/linear · origin left",
    );
    expect(animSummary({ revealBy: "word", tracks: { reveal: { a: { t: 0, v: 0, ease: "linear" }, b: { t: 2000, v: 1 } } } })).toBe("reveal 0→1 · 0.00–2.00 s · linear · by word");
    expect(animSummary({ tracks: { rotate: Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`k${i}`, { t: i * 100, v: i * 10 }])) } })).toBe(
      "rotate 0°→10°→20°→…→50° · 0.00–0.50 s · out",
    );
    expect(animSummary({ tracks: { opacity: { a: { t: 300, v: 0.5 } } } })).toBe("opacity 0.5 · 0.30 s");
    expect(animSummary({ origin: "bottom" })).toBe("no keyframes · origin bottom");
  });
});
