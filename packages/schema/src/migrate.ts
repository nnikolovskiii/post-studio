import { SCHEMA_VERSION } from "./document.ts";

export interface Migration {
  from: string;
  to: string;
  up(doc: Record<string, unknown>): Record<string, unknown>;
}

/** The chain's versions, oldest first. */
export const SCHEMA_VERSIONS = ["post-studio/1", "post-studio/2"] as const;

/**
 * Ordered chain. Every document that comes from outside (create --from, import, an exported
 * post-studio.json, a restored backup's stored documents) goes through migrate().
 */
export const MIGRATIONS: Migration[] = [
  // post-studio/2 is a superset (optional `motion` and `anim`): only the version string changes.
  { from: "post-studio/1", to: "post-studio/2", up: (doc) => doc },
];

export class UnknownSchemaVersionError extends Error {
  constructor(public readonly version: unknown) {
    super(`unknown document schema '${String(version)}' (this build knows ${SCHEMA_VERSION})`);
  }
}

/** Bring any known older document up to SCHEMA_VERSION. Returns the steps applied. */
export function migrate(
  input: Record<string, unknown>,
  chain: Migration[] = MIGRATIONS,
): { doc: Record<string, unknown>; applied: string[] } {
  let doc = input;
  const applied: string[] = [];
  const guard = new Set<string>();
  while (doc.schema !== SCHEMA_VERSION) {
    const version = String(doc.schema);
    const step = chain.find((m) => m.from === version);
    if (!step || guard.has(version)) throw new UnknownSchemaVersionError(doc.schema);
    guard.add(version);
    doc = { ...step.up(structuredClone(doc)), schema: step.to };
    applied.push(`${step.from} → ${step.to}`);
  }
  return { doc, applied };
}
