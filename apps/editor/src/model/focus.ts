// "Pointing at": the elements Nikola selects (desktop) or taps in point mode (phone) before he
// hands a project to the agent. The server stores the ids with the hand-off (with its own
// snapshot); here they only need a short label for the chips.
import { findItem, type Document } from "@post-studio/schema";
import { layerLabel } from "./phone.ts";

export const FOCUS_MAX = 20;

export interface FocusChip {
  id: string;
  label: string;
  kind: string;
}

const cut = (s: string, n = 28) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

/** Chips for the ids that still exist (deleted layers drop out), at most FOCUS_MAX. */
export function focusChips(doc: Document, ids: string[]): FocusChip[] {
  const out: FocusChip[] = [];
  for (const id of [...new Set(ids)]) {
    const loc = findItem(doc, id);
    if (!loc) continue;
    if (loc.kind === "frame") {
      out.push({ id, label: (loc.item as { name?: string }).name || id, kind: "frame" });
      continue;
    }
    const n = loc.item as Parameters<typeof layerLabel>[0];
    const text = n.type === "text" ? cut(n.spans.map((s) => s.text).join("")) : "";
    const name = layerLabel(n);
    out.push({ id, label: text ? (name && name !== "label" ? `${name}: “${text}”` : `“${text}”`) : name || id, kind: n.type });
    if (out.length >= FOCUS_MAX) break;
  }
  return out;
}

/** Toggle one id in a pointing list (tap again to un-point). */
export function togglePointed(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : list.length >= FOCUS_MAX ? list : [...list, id];
}
