// Brand lane of a social-posts post, and the accent object for imports that lose the
// post.svg <g id="accent"> group (the LUX Figma layout pack is flat).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getKit } from "@post-studio/brand";
import { DOMParser, type Element as XElement } from "@xmldom/xmldom";
import type { Frame, Node } from "@post-studio/schema";

/** Kit id for a post: copy.json `lane` (e.g. 'studio-mosaic' → mosaic), else the slug prefix. */
export function laneKit(slug: string, copy: Record<string, unknown> | undefined): string | undefined {
  const lane = typeof copy?.lane === "string" ? copy.lane.toLowerCase() : "";
  if (lane.includes("mosaic")) return "mosaic";
  for (const id of ["lux", "kites", "studio"]) if (lane === id || lane.startsWith(`${id}-`) || lane.startsWith(`${id} `)) return id;
  const prefix = slug.split("-")[0];
  if (prefix === "lux" || prefix === "kites" || prefix === "studio") return prefix;
  return undefined;
}

export function knownKit(id: string): boolean {
  return !!getKit(id);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Text strings inside post.svg's <g id="accent">. */
export function accentTexts(dir: string, file: string): Set<string> {
  const out = new Set<string>();
  const p = join(dir, file);
  if (!existsSync(p)) return out;
  const doc = new DOMParser({ onError: () => undefined }).parseFromString(readFileSync(p, "utf8"), "image/svg+xml");
  const groups = (Array.from(doc.getElementsByTagName("g")) as unknown as XElement[]).filter((g) => g.getAttribute("id") === "accent");
  for (const g of groups) for (const t of Array.from(g.getElementsByTagName("text")) as unknown as XElement[]) out.add(norm(t.textContent ?? ""));
  out.delete("");
  return out;
}

/** Mark text nodes whose text was inside the source's accent group as the accent object. */
export function markAccentTexts(frame: Frame, texts: Set<string>): string[] {
  const marked: string[] = [];
  if (!texts.size) return marked;
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === "text" && texts.has(norm(n.spans.map((s) => s.text).join(" ")))) {
        n.accent = true;
        marked.push(n.id);
      }
      if (n.type === "group") walk(n.children);
    }
  };
  walk(frame.children);
  return marked;
}
