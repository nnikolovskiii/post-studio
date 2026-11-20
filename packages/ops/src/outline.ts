import { animSummary, motionSummary } from "@post-studio/motion";
import { walk, type Document, type Frame, type Node } from "@post-studio/schema";
import { sketchWords } from "./diff.ts";

const r = (n: number) => Math.round(n * 10) / 10;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const colorStr = (c: unknown) => (typeof c === "string" ? c : c && typeof c === "object" && "token" in c ? `@${(c as { token: string }).token}` : "");

/** Short indented tree for an LLM's context: one line per node with the facts an agent edits. */
export function outline(doc: Document, opts: { pins?: Array<{ node: string; path: string }>; maxText?: number } = {}): string {
  const pinned = new Map<string, string[]>();
  for (const p of opts.pins ?? []) pinned.set(p.node, [...(pinned.get(p.node) ?? []), p.path]);
  const lines = [`${doc.title}  [${doc.id}] lang=${doc.lang}${doc.brandKit ? ` kit=${doc.brandKit}` : ""}`];
  if (doc.motion) lines.push(`  motion: ${motionSummary(doc.motion)}`);
  for (const loc of walk(doc)) {
    const pad = "  ".repeat(loc.depth + 1);
    const pins = pinned.get(loc.id);
    const pinStr = pins?.length ? `  📌${pins.join(",")}` : "";
    if (loc.kind === "frame") {
      const f = loc.item as Frame;
      lines.push(`${pad}frame ${f.id} "${f.name}" ${f.w}×${f.h}${f.background ? ` bg ${colorStr(f.background.color)}` : ""}${pinStr}`);
      continue;
    }
    const n = loc.item as Node;
    const head = `${pad}${n.id}${n.role && n.role !== n.id ? ` (${n.role})` : ""} ${n.type} @${r(n.x)},${r(n.y)} ${r(n.w)}×${r(n.h)}`;
    const extra: string[] = [];
    if (n.rotation) extra.push(`rot ${r(n.rotation)}°`);
    if (n.visible === false) extra.push("hidden");
    if (n.locked) extra.push("locked");
    switch (n.type) {
      case "text":
        extra.push(`${n.style.font} ${n.style.weight} ${n.style.size}px ${colorStr(n.style.fill)} ${n.box} ${n.align}`);
        extra.push(JSON.stringify(clip(n.spans.map((s) => s.text).join(""), opts.maxText ?? 80)));
        break;
      case "rect":
      case "ellipse":
      case "path":
        if (n.fill) extra.push(`fill ${colorStr(n.fill)}`);
        if (n.stroke) extra.push(`stroke ${colorStr(n.stroke.color)} ${n.stroke.width}`);
        if (n.sketch) extra.push(`hand-drawn ${sketchWords(n.sketch)}`);
        break;
      case "line":
        extra.push(`stroke ${colorStr(n.stroke.color)} ${n.stroke.width}`);
        if (n.sketch) extra.push(`hand-drawn ${sketchWords(n.sketch)}`);
        break;
      case "image":
      case "svg":
        extra.push(n.asset.slice(0, 19) + "…");
        break;
      case "group":
        extra.push(`${n.children.length} children`);
        break;
    }
    if (n.meta && Object.keys(n.meta).length) extra.push(`meta ${clip(JSON.stringify(n.meta), 60)}`);
    lines.push(`${head}  ${extra.join(" · ")}${pinStr}`);
    if (n.anim) lines.push(`${pad}  anim: ${animSummary(n.anim)}`);
  }
  return lines.join("\n");
}
