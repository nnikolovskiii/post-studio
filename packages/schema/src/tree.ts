import type { Document, Frame, Node } from "./document.ts";

/** Where a node or frame sits. `parent` is the frame or group id; frames have parent '$doc'. */
export interface Location {
  kind: "frame" | "node";
  id: string;
  parent: string;
  index: number;
  frame: string;
  item: Frame | Node;
  /** Absolute offset added by ancestor groups. */
  offset: { x: number; y: number };
  depth: number;
}

export const DOC_ID = "$doc";

export function isContainer(item: Frame | Node): item is Frame | Extract<Node, { type: "group" }> {
  return "children" in item && Array.isArray((item as { children?: unknown }).children);
}

/** Every frame and node in document order (depth-first, parents first). */
export function* walk(doc: Document): Generator<Location> {
  for (let fi = 0; fi < doc.frames.length; fi++) {
    const frame = doc.frames[fi];
    yield { kind: "frame", id: frame.id, parent: DOC_ID, index: fi, frame: frame.id, item: frame, offset: { x: 0, y: 0 }, depth: 0 };
    yield* walkChildren(frame.children, frame.id, frame.id, { x: 0, y: 0 }, 1);
  }
}

function* walkChildren(
  children: Node[],
  parent: string,
  frame: string,
  offset: { x: number; y: number },
  depth: number,
): Generator<Location> {
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    yield { kind: "node", id: node.id, parent, index: i, frame, item: node, offset, depth };
    if (node.type === "group") {
      yield* walkChildren(node.children, node.id, frame, { x: offset.x + node.x, y: offset.y + node.y }, depth + 1);
    }
  }
}

export function indexDocument(doc: Document): Map<string, Location> {
  const map = new Map<string, Location>();
  for (const loc of walk(doc)) map.set(loc.id, loc);
  return map;
}

export function findItem(doc: Document, id: string): Location | undefined {
  for (const loc of walk(doc)) if (loc.id === id) return loc;
  return undefined;
}

/** Children array of a frame or group, by id. */
export function childrenOf(doc: Document, containerId: string): Node[] | undefined {
  const loc = findItem(doc, containerId);
  if (!loc) return undefined;
  return isContainer(loc.item) ? loc.item.children : undefined;
}

/** All ids in a subtree (the node itself first). */
export function subtreeIds(item: Frame | Node): string[] {
  const out = [item.id];
  if (isContainer(item)) for (const c of item.children) out.push(...subtreeIds(c));
  return out;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

export function hasPath(obj: unknown, path: string): boolean {
  const keys = path.split(".");
  let cur: any = obj;
  for (let i = 0; i < keys.length; i++) {
    if (cur === null || typeof cur !== "object") return false;
    const k = Array.isArray(cur) ? Number(keys[i]) : keys[i];
    if (!(k in cur)) return false;
    cur = cur[k];
  }
  return true;
}
