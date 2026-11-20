import { DOC_ID, findItem, subtreeIds, type Document } from "@post-studio/schema";
import { apply, applyOne, type ApplyResult } from "./apply.ts";
import { OpError, type Op, type Touch } from "./types.ts";

/** What each op in a batch writes, computed against the document the batch was applied to. */
export function footprint(doc: Document, ops: Op[]): Touch[] {
  const work = structuredClone(doc);
  const out: Touch[] = [];
  for (const op of ops) {
    out.push(...touchesOf(work, op));
    try {
      applyOne(work, op);
    } catch {
      // Footprints are best-effort for ops that would fail; apply() reports the real error.
    }
  }
  return dedupe(out);
}

function touchesOf(doc: Document, op: Op): Touch[] {
  switch (op.op) {
    case "set":
    case "unset":
      return [{ node: op.node, path: op.path }];
    case "insert":
      return [{ node: op.parent, path: "#children" }, ...subtreeIds(op.node).map((id) => ({ node: id, path: "*" }))];
    case "delete": {
      const loc = findItem(doc, op.node);
      if (!loc) return [{ node: op.node, path: "*" }];
      return [{ node: loc.parent, path: "#children" }, ...subtreeIds(loc.item).map((id) => ({ node: id, path: "*" }))];
    }
    case "move": {
      const loc = findItem(doc, op.node);
      const t: Touch[] = [{ node: op.node, path: "#parent" }];
      if (loc) t.push({ node: loc.parent, path: "#children" });
      t.push({ node: op.parent ?? loc?.parent ?? op.node, path: "#children" });
      return t;
    }
    case "frame": {
      if (op.action === "add") {
        return [{ node: DOC_ID, path: "#children" }, ...subtreeIds(op.frame).map((id) => ({ node: id, path: "*" }))];
      }
      const loc = findItem(doc, op.frame);
      return [{ node: DOC_ID, path: "#children" }, ...(loc ? subtreeIds(loc.item) : [op.frame]).map((id) => ({ node: id, path: "*" }))];
    }
  }
}

function dedupe(t: Touch[]): Touch[] {
  const seen = new Set<string>();
  return t.filter((x) => {
    const k = `${x.node}\u0000${x.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + ".") || b.startsWith(a + ".");
}

/** Two writes conflict when they hit the same node and overlapping paths. Concurrent child-list edits merge. */
export function touchesConflict(a: Touch, b: Touch): boolean {
  if (a.node !== b.node) return false;
  if (a.path === "#children" && b.path === "#children") return false;
  if (a.path === "*" || b.path === "*") return true;
  return pathsOverlap(a.path, b.path);
}

export interface Conflict {
  node: string;
  path: string;
  theirs: string;
  /** Revision that wrote `theirs`, when known. */
  rev?: number;
}

export type RebaseResult = ({ ok: true; rebased: boolean } & ApplyResult) | { ok: false; conflicts: Conflict[]; error?: string };

/**
 * Apply `ops` (written against `base`) on top of `head`, which already includes other
 * revisions whose writes are `theirs`. Different properties merge; the same property conflicts.
 */
export function rebaseOrConflict(
  base: Document,
  head: Document,
  ops: Op[],
  theirs: Array<Touch & { rev?: number }>,
): RebaseResult {
  if (theirs.length === 0) return { ok: true, rebased: false, ...apply(head, ops) };
  const mine = footprint(base, ops);
  const conflicts: Conflict[] = [];
  for (const m of mine) {
    for (const t of theirs) {
      if (touchesConflict(m, t)) conflicts.push({ node: m.node, path: m.path, theirs: t.path, rev: t.rev });
    }
  }
  if (conflicts.length) return { ok: false, conflicts };
  try {
    return { ok: true, rebased: true, ...apply(head, ops) };
  } catch (e) {
    if (e instanceof OpError) {
      return { ok: false, conflicts: [], error: `ops do not apply on the newer revision: ${e.message}` };
    }
    throw e;
  }
}
