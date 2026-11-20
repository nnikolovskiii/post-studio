import { z } from "zod";
import { DocumentSchema, SCHEMA_VERSION } from "./document.ts";

export * from "./document.ts";
export * from "./tree.ts";
export * from "./validate.ts";
export * from "./migrate.ts";
export * from "./motion.ts";

let cached: Record<string, unknown> | undefined;

/** JSON Schema (draft 2020-12) for the current version (post-studio/2), served at GET /v1/schema. */
export function documentJsonSchema(): Record<string, unknown> {
  if (!cached) {
    cached = {
      ...(z.toJSONSchema(DocumentSchema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>),
      $id: `https://post-studio.local/schema/${SCHEMA_VERSION.replace("/", "-")}.json`,
      title: SCHEMA_VERSION,
    };
  }
  return cached;
}
