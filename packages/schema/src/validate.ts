import { z } from "zod";
import { DocumentSchema, type Document } from "./document.ts";
import { DOC_ID, walk } from "./tree.ts";

export interface Issue {
  /** JSON-ish location, e.g. 'frames.0.children.3.style.size' or a node id. */
  path: string;
  node?: string;
  code: string;
  message: string;
}

export interface StructuralResult {
  ok: boolean;
  errors: Issue[];
  doc?: Document;
}

/** Schema + structural checks (unique ids). No registries needed. */
export function validateStructure(input: unknown): StructuralResult {
  const parsed = DocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.map(String).join("."),
        code: "schema",
        message: i.message,
      })),
    };
  }
  const doc = input as Document;
  const errors: Issue[] = [];
  const seen = new Set<string>();
  for (const loc of walk(doc)) {
    if (loc.id === DOC_ID) errors.push({ path: loc.id, node: loc.id, code: "id", message: "'$doc' is reserved" });
    if (seen.has(loc.id)) {
      errors.push({ path: loc.id, node: loc.id, code: "duplicate-id", message: `id '${loc.id}' is used more than once` });
    }
    seen.add(loc.id);
  }
  return { ok: errors.length === 0, errors, doc: errors.length === 0 ? doc : undefined };
}

export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
