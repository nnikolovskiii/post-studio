// Node loader for the font registry: reads the woff2 files from fonts/ and decompresses them.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import wawoff from "wawoff2";
import { FontRegistry as CoreRegistry, FontRegistryError, type RegistryManifest } from "./registry-core.ts";

export * from "./registry-core.ts";

export const DEFAULT_FONTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fonts");

export class FontRegistry extends CoreRegistry {
  static async load(dir = DEFAULT_FONTS_DIR, manifest?: RegistryManifest): Promise<FontRegistry> {
    const m = manifest ?? (JSON.parse(readFileSync(join(dir, "registry.json"), "utf8")) as RegistryManifest);
    return CoreRegistry.fromSources(
      m,
      async (file) => {
        const path = join(dir, file);
        if (!existsSync(path)) throw new FontRegistryError(`font file missing: ${path}`);
        const raw = new Uint8Array(readFileSync(path));
        // wawoff2 returns a view into its own WASM heap that the next decompress overwrites: copy it.
        const sfnt = file.endsWith(".woff2") ? new Uint8Array(await wawoff.decompress(raw)).slice() : raw;
        return { raw, sfnt, sha256: createHash("sha256").update(raw).digest("hex"), bytes: raw.length };
      },
      dir,
    ) as Promise<FontRegistry>;
  }
}
