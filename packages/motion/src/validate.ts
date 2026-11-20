// Motion checks that the zod schema cannot express (PLAN-motion.md §4.1). The schema already
// refuses unknown tracks, out-of-range values, bad keyframe ids and more than 100 keyframes per
// track; validateDocument (packages/ops) runs this on top.
import { MOTION_LIMITS, TRACKS, walk, type Document, type Issue, type Node } from "@post-studio/schema";
import { fmtTime } from "./format.ts";
import { posterTime } from "./sample.ts";

export interface MotionCheck {
  errors: Issue[];
  warnings: Issue[];
  /** Keyframes in the whole document. */
  keyframes: number;
}

export function validateMotion(doc: Document): MotionCheck {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const duration = doc.motion?.duration;
  let total = 0;
  let animatedWithoutMotion = 0;

  for (const loc of walk(doc)) {
    if (loc.kind !== "node") continue;
    const node = loc.item as Node;
    const anim = node.anim;
    if (!anim) continue;
    const tracks = anim.tracks ?? {};
    let count = 0;
    for (const name of TRACKS) {
      const track = tracks[name];
      if (!track) continue;
      const keys = Object.entries(track);
      count += keys.length;
      if (name === "reveal" && node.type !== "text" && keys.length) {
        errors.push({ path: `${loc.id}.anim.tracks.reveal`, node: loc.id, code: "motion", message: `'reveal' works on text layers only; '${loc.id}' is a ${node.type}` });
      }
      if (duration !== undefined) {
        const late = keys.filter(([, k]) => k.t > duration).map(([key, k]) => `${key} at ${fmtTime(k.t)}`);
        if (late.length) {
          warnings.push({
            path: `${loc.id}.anim.tracks.${name}`,
            node: loc.id,
            code: "motion-late",
            message: `${name} keyframe${late.length > 1 ? "s" : ""} ${late.join(", ")} after the end (${fmtTime(duration)}): never plays`,
          });
        }
      }
    }
    if (anim.revealBy !== undefined && node.type !== "text") {
      warnings.push({ path: `${loc.id}.anim.revealBy`, node: loc.id, code: "motion", message: `'revealBy' has no effect on a ${node.type}` });
    }
    total += count;
    if (count && !doc.motion) animatedWithoutMotion++;
  }

  if (total > MOTION_LIMITS.keyframesPerDocument) {
    errors.push({ path: "motion", node: "$doc", code: "motion", message: `${total} keyframes; a document holds at most ${MOTION_LIMITS.keyframesPerDocument}` });
  }
  if (animatedWithoutMotion) {
    warnings.push({
      path: "motion",
      node: "$doc",
      code: "motion-off",
      message: `${animatedWithoutMotion} layer${animatedWithoutMotion > 1 ? "s have" : " has"} keyframes but the document has no motion (set $doc.motion), so nothing plays`,
    });
  }
  const poster = posterTime(doc.motion);
  if (doc.motion && poster !== undefined && poster > doc.motion.duration) {
    warnings.push({ path: "motion.poster", node: "$doc", code: "motion-late", message: `poster moment ${fmtTime(poster)} is after the end (${fmtTime(doc.motion.duration)})` });
  }
  return { errors, warnings, keyframes: total };
}
