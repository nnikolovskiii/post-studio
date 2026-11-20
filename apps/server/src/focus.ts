// What Nikola pointed at when he handed a project over ("change this"). The hand-off stores the
// node ids plus a readable snapshot of each node at that moment, so the agent sees which layers
// "this" / "that" / "it" in his note mean even if the layer is renamed or moved later.
import { ID_RE, walk, type Document } from "@post-studio/schema";

export const FOCUS_MAX = 20;
const EXCERPT = 80;

export interface FocusItem {
  id: string;
  type: string;
  frame: string;
  name?: string;
  role?: string;
  /** Text nodes: the words, whitespace collapsed, cut to 80 characters. */
  text?: string;
}

export class FocusError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Validate a request's `focus` (undefined / null / [] = none) against the current document. */
export function parseFocus(input: unknown, doc: Document): FocusItem[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new FocusError(400, "focus is a list of node ids, e.g. [\"headline\"]");
  const ids = [...new Set(input)];
  if (ids.some((x) => typeof x !== "string" || !ID_RE.test(x))) throw new FocusError(400, "focus holds node ids (letters, digits, '_' and '-')");
  if (ids.length > FOCUS_MAX) throw new FocusError(400, `point at ${FOCUS_MAX} elements at most (got ${ids.length})`);
  const found = new Map<string, FocusItem>();
  for (const loc of walk(doc)) {
    if (!ids.includes(loc.id)) continue;
    const item = loc.item as { type?: string; name?: string; role?: string; spans?: Array<{ text: string }> };
    const f: FocusItem = { id: loc.id, type: loc.kind === "frame" ? "frame" : (item.type ?? "node"), frame: loc.frame };
    if (item.name) f.name = item.name;
    if (item.role) f.role = item.role;
    if (item.type === "text" && Array.isArray(item.spans)) f.text = excerpt(item.spans.map((s) => s.text).join(""));
    found.set(loc.id, f);
  }
  const missing = (ids as string[]).filter((id) => !found.has(id));
  if (missing.length) throw new FocusError(422, `not in the document: ${missing.join(", ")}`, { missing });
  return (ids as string[]).map((id) => found.get(id)!);
}

export function excerpt(s: string, max = EXCERPT): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** One line for people and agents: headline (text "Исти модели."), bar-3 (rect, role bar). */
export function focusLine(items: FocusItem[]): string {
  return items
    .map((f) => {
      const bits = [f.text !== undefined ? `text "${f.text}"` : f.type, f.name && f.name !== f.id ? `“${f.name}”` : "", f.role ? `role ${f.role}` : "", `in ${f.frame}`].filter(Boolean);
      return `${f.id} (${bits.join(", ")})`;
    })
    .join(", ");
}

/**
 * The moment he was looking at when he handed a motion project over ("make it punchier here"):
 * the playhead in ms. undefined / null = none. Only for motion projects, inside one pass.
 */
export function parseAt(input: unknown, doc: Document): number | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) throw new FocusError(400, "at is the playhead time in ms (a number ≥ 0)");
  if (!doc.motion) throw new FocusError(400, "at is only for motion projects (this one has no timeline)");
  const at = Math.round(input);
  if (at > doc.motion.duration) throw new FocusError(400, `at ${at} ms is after the end of the motion (${doc.motion.duration} ms)`);
  return at;
}

/** 1200 → "1.20 s" (the same wording as the timeline). */
export const atText = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;
