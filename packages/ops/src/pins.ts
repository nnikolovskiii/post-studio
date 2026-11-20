import { findItem, subtreeIds, walk, type Document, type Frame, type Node } from "@post-studio/schema";
import { applyOne } from "./apply.ts";
import { pathsOverlap } from "./rebase.ts";
import type { Op } from "./types.ts";

/**
 * A protected property. path: a property path, '*' (whole node), '#parent' (parent / z-order),
 * or '#exists' (may not be deleted). Keyed for overrides as '<node>.<path>'.
 */
export interface Pin {
  node: string;
  path: string;
  source: "explicit" | "soft";
  /** Revision that created a soft pin. */
  rev?: number;
}

export const pinKey = (p: { node: string; path: string }) => `${p.node}.${p.path}`;

/** A frame's editor-canvas position (`canvas`, `canvas.x`, …): never a soft pin. */
export const isCanvasPath = (path: string) => path === "canvas" || path.startsWith("canvas.");

/** A batch that only moves frames on the editor canvas (no design change). */
export const canvasOnly = (ops: Op[]) => ops.length > 0 && ops.every((op) => (op.op === "set" || op.op === "unset") && isCanvasPath(op.path));

/** Paths an agent may never write: his explicit pin list, editor lock and the strict-palette switch. */
const ALWAYS_PROTECTED = ["pins", "locked", "strictPalette"];

export function explicitPins(doc: Document): Pin[] {
  const out: Pin[] = [];
  for (const loc of walk(doc)) {
    for (const p of (loc.item as { pins?: string[] }).pins ?? []) out.push({ node: loc.id, path: p, source: "explicit" });
  }
  return out;
}

/**
 * Soft pins from human revisions since the agent's last checkpoint: every property he set,
 * every node he moved (#parent) and every node he added (#exists).
 */
export function softPinsFromRevisions(revisions: Array<{ rev: number; author: string; ops: Op[] }>): Pin[] {
  const out = new Map<string, Pin>();
  const add = (p: Pin) => out.set(pinKey(p), p);
  for (const r of revisions) {
    if (r.author !== "human") continue;
    for (const op of r.ops) {
      if (op.op === "set" || op.op === "unset") {
        // Moving a frame on the editor canvas is layout of the workspace, not a design decision.
        if (isCanvasPath(op.path)) continue;
        add({ node: op.node, path: op.path, source: "soft", rev: r.rev });
      }
      else if (op.op === "move") add({ node: op.node, path: "#parent", source: "soft", rev: r.rev });
      else if (op.op === "insert") for (const id of subtreeIds(op.node)) add({ node: id, path: "#exists", source: "soft", rev: r.rev });
      else if (op.op === "frame" && op.action === "add") add({ node: op.frame.id, path: "#exists", source: "soft", rev: r.rev });
    }
  }
  return [...out.values()];
}

/** Drop pins on nodes that no longer exist, and soft pins covered by an explicit one. */
export function effectivePins(doc: Document, soft: Pin[]): Pin[] {
  const exists = new Set<string>(["$doc", ...[...walk(doc)].map((l) => l.id)]);
  const explicit = explicitPins(doc);
  const keys = new Set(explicit.map(pinKey));
  return [...explicit, ...soft.filter((p) => exists.has(p.node) && !keys.has(pinKey(p)))];
}

export interface PinViolation {
  opIndex: number;
  op: string;
  pin: Pin;
  key: string;
  message: string;
}

export interface PinCheckResult {
  ok: boolean;
  blocked: PinViolation[];
  /** Overrides that were needed and given. */
  overridden: Array<PinViolation & { reason: string }>;
}

/**
 * Check an agent batch against pins. `overrides` maps '<node>.<path>' → reason.
 * Ops are walked in order on a scratch copy so later ops see earlier ones.
 */
export function checkPins(doc: Document, ops: Op[], pins: Pin[], overrides: Record<string, string> = {}): PinCheckResult {
  const work = structuredClone(doc);
  const byNode = new Map<string, Pin[]>();
  for (const p of pins) byNode.set(p.node, [...(byNode.get(p.node) ?? []), p]);
  const blocked: PinViolation[] = [];
  const overridden: PinCheckResult["overridden"] = [];

  const hit = (opIndex: number, op: Op, pin: Pin, why: string) => {
    const key = pinKey(pin);
    const v: PinViolation = {
      opIndex,
      op: op.op,
      pin,
      key,
      message: `${why} (${pin.source === "soft" ? "Nikola changed it since your last turn" : "pinned by Nikola"}; override with --override-pin ${key})`,
    };
    if (overrides[key]) overridden.push({ ...v, reason: overrides[key] });
    else blocked.push(v);
  };

  ops.forEach((op, i) => {
    switch (op.op) {
      case "set":
      case "unset": {
        if (ALWAYS_PROTECTED.some((p) => pathsOverlap(p, op.path))) {
          hit(i, op, { node: op.node, path: op.path.split(".")[0], source: "explicit" }, `'${op.path}' on '${op.node}' belongs to the human`);
          break;
        }
        for (const pin of byNode.get(op.node) ?? []) {
          if (pin.path === "*" || (!pin.path.startsWith("#") && pathsOverlap(pin.path, op.path))) {
            hit(i, op, pin, `${op.op} ${op.node}.${op.path} touches pinned ${pinKey(pin)}`);
          }
        }
        break;
      }
      case "delete":
      case "frame": {
        if (op.op === "frame" && op.action === "add") break;
        const id = op.op === "delete" ? op.node : op.frame;
        const loc = findItem(work, id);
        if (!loc) break;
        for (const sub of subtreeIds(loc.item as Node | Frame)) {
          for (const pin of byNode.get(sub) ?? []) hit(i, op, pin, `deleting '${id}' would remove pinned ${pinKey(pin)}`);
        }
        break;
      }
      case "move": {
        for (const pin of byNode.get(op.node) ?? []) {
          if (pin.path === "*" || pin.path === "#parent") hit(i, op, pin, `moving '${op.node}' changes pinned ${pinKey(pin)}`);
        }
        break;
      }
      case "insert": {
        for (const pin of byNode.get(op.parent) ?? []) {
          if (pin.path === "*") hit(i, op, pin, `inserting into '${op.parent}' changes pinned ${pinKey(pin)}`);
        }
        break;
      }
    }
    try {
      applyOne(work, op);
    } catch {
      // apply() reports real op errors; keep checking the rest.
    }
  });
  return { ok: blocked.length === 0, blocked, overridden };
}
