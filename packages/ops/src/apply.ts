import {
  DOC_ID,
  findItem,
  SCHEMA_VERSION,
  isContainer,
  subtreeIds,
  validateStructure,
  type Document,
  type Frame,
  type Node,
} from "@post-studio/schema";
import { OpError, type Op } from "./types.ts";

const FORBIDDEN_FIRST_KEY: Record<"doc" | "frame" | "node", Set<string>> = {
  doc: new Set(["schema", "id", "frames"]),
  frame: new Set(["id", "children"]),
  node: new Set(["id", "type", "children"]),
};

export interface ApplyResult {
  doc: Document;
  /** Ops that undo this batch when applied to `doc`, in order. */
  inverse: Op[];
}

export interface ApplyOptions {
  /** Validate the resulting document structure (default true). */
  validate?: boolean;
  /** Called before each op with the document state it will see. Throw to reject. */
  guard?: (op: Op, index: number, doc: Document) => void;
}

/** Apply a batch atomically. The input document is never mutated. */
export function apply(doc: Document, ops: Op[], options: ApplyOptions = {}): ApplyResult {
  const work = structuredClone(doc);
  const inverse: Op[] = [];
  ops.forEach((op, i) => {
    options.guard?.(op, i, work);
    try {
      inverse.unshift(...applyOne(work, op));
    } catch (e) {
      if (e instanceof OpError && e.opIndex === undefined) throw new OpError(e.code, e.message, i, e.details);
      throw e;
    }
  });
  if (options.validate !== false) {
    const v = validateStructure(work);
    if (!v.ok) throw new OpError("invalid-document", `result is not a valid ${SCHEMA_VERSION} document`, undefined, v.errors);
  }
  return { doc: work, inverse };
}

/** The ops that undo `ops` against `doc`. */
export function invert(doc: Document, ops: Op[]): Op[] {
  return apply(doc, ops, { validate: false }).inverse;
}

/** Mutates `doc`. Returns the inverse ops (to apply in order). */
export function applyOne(doc: Document, op: Op): Op[] {
  switch (op.op) {
    case "set":
    case "unset":
      return applySetLike(doc, op);
    case "insert": {
      const parent = findItem(doc, op.parent);
      if (!parent || !isContainer(parent.item)) throw new OpError("not-found", `parent '${op.parent}' is not a frame or group`);
      for (const id of subtreeIds(op.node)) {
        if (id === DOC_ID || findItem(doc, id)) throw new OpError("duplicate-id", `id '${id}' already exists`);
      }
      const kids = parent.item.children;
      const index = op.index ?? kids.length;
      if (index > kids.length) throw new OpError("bad-index", `index ${index} > ${kids.length} children of '${op.parent}'`);
      kids.splice(index, 0, structuredClone(op.node));
      return [{ op: "delete", node: op.node.id }];
    }
    case "delete": {
      const loc = findItem(doc, op.node);
      if (!loc || loc.kind !== "node") throw new OpError("not-found", `node '${op.node}' not found`);
      const parent = findItem(doc, loc.parent)!;
      const [removed] = (parent.item as Frame).children.splice(loc.index, 1);
      return [{ op: "insert", parent: loc.parent, index: loc.index, node: removed }];
    }
    case "move": {
      const loc = findItem(doc, op.node);
      if (!loc || loc.kind !== "node") throw new OpError("not-found", `node '${op.node}' not found`);
      const targetId = op.parent ?? loc.parent;
      const target = findItem(doc, targetId);
      if (!target || !isContainer(target.item)) throw new OpError("not-found", `parent '${targetId}' is not a frame or group`);
      if (subtreeIds(loc.item as Node).includes(targetId)) throw new OpError("cycle", `cannot move '${op.node}' into itself`);
      const from = (findItem(doc, loc.parent)!.item as Frame).children;
      const [node] = from.splice(loc.index, 1);
      const to = target.item.children;
      if (op.index > to.length) {
        from.splice(loc.index, 0, node);
        throw new OpError("bad-index", `index ${op.index} > ${to.length} children of '${targetId}'`);
      }
      to.splice(op.index, 0, node);
      return [{ op: "move", node: op.node, parent: loc.parent, index: loc.index }];
    }
    case "frame": {
      if (op.action === "add") {
        for (const id of subtreeIds(op.frame)) {
          if (id === DOC_ID || findItem(doc, id)) throw new OpError("duplicate-id", `id '${id}' already exists`);
        }
        const index = op.index ?? doc.frames.length;
        if (index > doc.frames.length) throw new OpError("bad-index", `frame index ${index} > ${doc.frames.length}`);
        doc.frames.splice(index, 0, structuredClone(op.frame));
        return [{ op: "frame", action: "remove", frame: op.frame.id }];
      }
      const index = doc.frames.findIndex((f) => f.id === op.frame);
      if (index < 0) throw new OpError("not-found", `frame '${op.frame}' not found`);
      const [removed] = doc.frames.splice(index, 1);
      return [{ op: "frame", action: "add", frame: removed, index }];
    }
    default:
      throw new OpError("bad-op", `unknown op ${JSON.stringify((op as { op?: unknown }).op)}`);
  }
}

function targetObject(doc: Document, id: string): { obj: Record<string, unknown>; kind: "doc" | "frame" | "node" } {
  if (id === DOC_ID) return { obj: doc as unknown as Record<string, unknown>, kind: "doc" };
  const loc = findItem(doc, id);
  if (!loc) throw new OpError("not-found", `node '${id}' not found`);
  return { obj: loc.item as unknown as Record<string, unknown>, kind: loc.kind };
}

function applySetLike(doc: Document, op: Extract<Op, { op: "set" | "unset" }>): Op[] {
  const { obj, kind } = targetObject(doc, op.node);
  const keys = op.path.split(".");
  if (FORBIDDEN_FIRST_KEY[kind].has(keys[0])) {
    throw new OpError("forbidden-path", `'${keys[0]}' cannot be changed with ${op.op}; use insert/delete/move/frame`);
  }
  // Walk to the parent container, creating plain objects for 'set' when missing.
  let cur: any = obj;
  let createdAt: number | undefined;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = Array.isArray(cur) ? arrayKey(cur, keys[i], false) : keys[i];
    if (cur[k] === undefined) {
      if (op.op === "unset") throw new OpError("not-found", `path '${op.path}' is not set on '${op.node}'`);
      if (Array.isArray(cur)) throw new OpError("bad-path", `no element ${k} in '${keys.slice(0, i + 1).join(".")}'`);
      cur[k] = {};
      createdAt ??= i;
    } else if (cur[k] === null || typeof cur[k] !== "object") {
      throw new OpError("bad-path", `'${keys.slice(0, i + 1).join(".")}' is not an object on '${op.node}'`);
    }
    cur = cur[k];
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(cur)) {
    const k = arrayKey(cur, last, op.op === "set");
    if (op.op === "unset") throw new OpError("bad-path", `cannot unset an array element ('${op.path}'); set the array instead`);
    const existed = k < cur.length;
    const old = cur[k];
    if (!existed && k !== cur.length) throw new OpError("bad-path", `index ${k} out of range in '${op.path}'`);
    cur[k] = structuredClone(op.value);
    return existed
      ? [{ op: "set", node: op.node, path: op.path, value: old }]
      : [{ op: "set", node: op.node, path: keys.slice(0, -1).join("."), value: cur.slice(0, k) }];
  }
  const existed = Object.prototype.hasOwnProperty.call(cur, last);
  const old = cur[last];
  if (op.op === "unset") {
    if (!existed) throw new OpError("not-found", `path '${op.path}' is not set on '${op.node}'`);
    delete cur[last];
    return [{ op: "set", node: op.node, path: op.path, value: old }];
  }
  if (op.value === undefined) throw new OpError("bad-value", "set needs a JSON value (use unset to remove)");
  cur[last] = structuredClone(op.value);
  if (createdAt !== undefined) return [{ op: "unset", node: op.node, path: keys.slice(0, createdAt + 1).join(".") }];
  return existed ? [{ op: "set", node: op.node, path: op.path, value: old }] : [{ op: "unset", node: op.node, path: op.path }];
}

function arrayKey(arr: unknown[], key: string, allowAppend: boolean): number {
  if (!/^\d+$/.test(key)) throw new OpError("bad-path", `'${key}' is not an array index`);
  const n = Number(key);
  if (n > arr.length || (!allowAppend && n === arr.length)) throw new OpError("bad-path", `index ${n} out of range`);
  return n;
}
