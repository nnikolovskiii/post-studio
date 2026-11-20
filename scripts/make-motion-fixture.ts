// Generates fixtures/lux-6-motion.json (Motion Part 2): the hand-written LUX-6 square with 6 s of
// motion, built only with the presets agents use (packages/motion presetOps) plus two plain
// keyframe ops, then applied with packages/ops. Covers every track the renderer draws:
//   headline  fade-up (dy + opacity)          sub        typewriter by word (reveal)
//   rule-top / row-1-track / rule-bottom: staggered bar grow (scaleX from the left; the track line
//             runs right-to-left, w < 0)      chart      group fade-in (children move with it)
//   row markers: staggered pop (scale, back-out)   logo   spin in (rotate) + fade
//   status    slide down out at the end (exit preset)
//   pnpm exec tsx scripts/make-motion-fixture.ts
import { readFileSync, writeFileSync } from "node:fs";
import { presetOps, readingOrder } from "@post-studio/motion";
import { apply, validateDocument, type Op } from "@post-studio/ops";
import type { Document } from "@post-studio/schema";

const ROOT = new URL("../", import.meta.url).pathname;
const still = JSON.parse(readFileSync(`${ROOT}fixtures/lux-6-square.hand.json`, "utf8")) as Document;

export function buildMotionFixture(base: Document): Document {
  let doc = base;
  const step = (ops: Op[]) => {
    doc = apply(doc, ops).doc;
  };
  step(presetOps(doc, ["headline"], "fade-up", { at: 200, dur: 600 }) as Op[]);
  step(presetOps(doc, ["sub"], "typewriter", { at: 700, dur: 900, ease: "linear" }) as Op[]);
  step([{ op: "set", node: "sub", path: "anim.revealBy", value: "word" }]);
  step(presetOps(doc, readingOrder(doc, ["rule-top", "row-1-track", "rule-bottom"]), "grow-left", { at: 800, dur: 700, stagger: 120 }) as Op[]);
  step(presetOps(doc, ["chart"], "fade-in", { at: 900, dur: 400 }) as Op[]);
  step(presetOps(doc, readingOrder(doc, ["row-1-a", "row-1-b", "row-2-a", "row-2-b"]), "pop", { at: 1300, dur: 500, stagger: 80 }) as Op[]);
  step(presetOps(doc, ["logo"], "fade-in", { at: 0, dur: 500 }) as Op[]);
  step([
    { op: "set", node: "logo", path: "anim.tracks.rotate.in1", value: { t: 0, v: -90, ease: "back-out" } },
    { op: "set", node: "logo", path: "anim.tracks.rotate.in2", value: { t: 600, v: 0 } },
  ]);
  step(presetOps(doc, ["status"], "slide-down-out", { at: 5200, dur: 500 }) as Op[]);
  return { ...doc, title: "LUX-6 motion fixture" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const doc = buildMotionFixture(still);
  const v = validateDocument(doc);
  if (!v.ok) throw new Error(JSON.stringify(v.errors, null, 2));
  writeFileSync(`${ROOT}fixtures/lux-6-motion.json`, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote fixtures/lux-6-motion.json (${JSON.stringify(doc.motion)}; warnings: ${v.warnings.map((w) => w.code).join(", ") || "none"})`);
}
