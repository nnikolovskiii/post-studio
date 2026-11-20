import { z } from "zod";
import { FrameSchema, IdSchema, NodeSchema, type Frame, type Node } from "@post-studio/schema";

export type SetOp = { op: "set"; node: string; path: string; value: unknown };
export type UnsetOp = { op: "unset"; node: string; path: string };
export type InsertOp = { op: "insert"; parent: string; index?: number; node: Node };
export type DeleteOp = { op: "delete"; node: string };
export type MoveOp = { op: "move"; node: string; parent?: string; index: number };
export type FrameAddOp = { op: "frame"; action: "add"; frame: Frame; index?: number };
export type FrameRemoveOp = { op: "frame"; action: "remove"; frame: string };
export type Op = SetOp | UnsetOp | InsertOp | DeleteOp | MoveOp | FrameAddOp | FrameRemoveOp;

const Target = z.union([IdSchema, z.literal("$doc")]);
const PathSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9#_-]+)*$/, "paths look like 'style.size' or 'spans.0.text'");
const Index = z.number().int().min(0);

export const OpSchema: z.ZodType<Op> = z.union([
  z.object({ op: z.literal("set"), node: Target, path: PathSchema, value: z.json() }).strict(),
  z.object({ op: z.literal("unset"), node: Target, path: PathSchema }).strict(),
  z.object({ op: z.literal("insert"), parent: IdSchema, index: Index.optional(), node: NodeSchema }).strict(),
  z.object({ op: z.literal("delete"), node: IdSchema }).strict(),
  z.object({ op: z.literal("move"), node: IdSchema, parent: IdSchema.optional(), index: Index }).strict(),
  z.object({ op: z.literal("frame"), action: z.literal("add"), frame: FrameSchema, index: Index.optional() }).strict(),
  z.object({ op: z.literal("frame"), action: z.literal("remove"), frame: IdSchema }).strict(),
]) as unknown as z.ZodType<Op>;

export const OpBatchSchema = z.array(OpSchema).min(1).max(5000);

export class OpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly opIndex?: number,
    public readonly details?: unknown,
  ) {
    super(opIndex === undefined ? message : `op ${opIndex}: ${message}`);
  }
}

/** One thing an op writes. path: property path, or '*' (whole node), '#parent', '#children', '#exists'. */
export interface Touch {
  node: string;
  path: string;
}

export type Author = "human" | `agent:${string}`;

export function isAgent(author: string): boolean {
  return author.startsWith("agent:");
}
