// Font registry core: no Node APIs, so the browser editor shapes text with the same code.
// The Node loader (registry.ts) reads woff2 files from disk; the editor fetches decompressed sfnt bytes.
import * as hb from "harfbuzzjs";

/** The 31 letters of the Macedonian alphabet, upper and lower case (62 total). */
export const MACEDONIAN_LETTERS = "АБВГДЃЕЖЗЅИЈКЛЉМНЊОПРСТЌУФХЦЧЏШабвгдѓежзѕијклљмнњопрстќуфхцчџш";

export interface FaceSpec {
  weights: [number, number];
  /** Variation axis driven by weight ('wght') for variable fonts. */
  axis?: string;
  files: string[];
}

export interface FamilySpec {
  family: string;
  faces: FaceSpec[];
}

export interface RegistryManifest {
  families: FamilySpec[];
}

export interface LoadedFile {
  file: string;
  sha256: string;
  bytes: number;
  face: hb.Face;
  /** Decompressed font (TTF/OTF bytes); renderers that need real font files use it. */
  sfnt: Uint8Array;
  /** The registered file as stored (woff2); absent in the browser, where fonts load by URL. */
  raw?: Uint8Array;
  upem: number;
  unicodes: Set<number>;
}

export interface FaceInfo {
  family: string;
  weightMin: number;
  weightMax: number;
  variable: boolean;
  files: Array<{ file: string; sha256: string; bytes: number }>;
  /** Macedonian letters no file in the face covers. Empty = passes the 62-letter check. */
  missingMacedonian: string[];
}

export class FontRegistryError extends Error {}

/** Bytes of one registered file. sha256 / bytes describe the stored (woff2) file. */
export interface FontSource {
  sfnt: Uint8Array;
  raw?: Uint8Array;
  sha256: string;
  bytes: number;
}

/**
 * Registered fonts. Load once (async: woff2 → sfnt), then shape synchronously.
 * A face is a family + weight range made of one or more subset files.
 */
export class FontRegistry {
  private files = new Map<string, LoadedFile>();
  private faces: Array<FaceSpec & { family: string }> = [];
  private fonts = new Map<string, hb.Font>();

  protected constructor(public readonly dir: string) {}

  /** Build a registry from a manifest and a loader for each file (Node: disk, browser: fetch). */
  static async fromSources(manifest: RegistryManifest, source: (file: string) => Promise<FontSource>, dir = ""): Promise<FontRegistry> {
    const reg = new FontRegistry(dir);
    for (const fam of manifest.families) {
      for (const face of fam.faces) {
        for (const f of face.files) {
          if (!reg.files.has(f)) reg.addFile(f, await source(f));
        }
        reg.faces.push({ ...face, family: fam.family });
      }
    }
    return reg;
  }

  private addFile(file: string, src: FontSource): LoadedFile {
    const face = new hb.Face(new hb.Blob(src.sfnt));
    const loaded: LoadedFile = {
      file,
      sha256: src.sha256,
      bytes: src.bytes,
      face,
      sfnt: src.sfnt,
      raw: src.raw,
      upem: face.upem,
      unicodes: new Set(face.collectUnicodes()),
    };
    this.files.set(file, loaded);
    return loaded;
  }

  /** The manifest this registry was built from (families / faces / files). */
  manifest(): RegistryManifest {
    const families: FamilySpec[] = [];
    for (const f of this.faces) {
      let fam = families.find((x) => x.family === f.family);
      if (!fam) families.push((fam = { family: f.family, faces: [] }));
      fam.faces.push({ weights: [...f.weights] as [number, number], ...(f.axis ? { axis: f.axis } : {}), files: [...f.files] });
    }
    return { families };
  }

  families(): string[] {
    return [...new Set(this.faces.map((f) => f.family))];
  }

  /** Every registered face with its coverage check. */
  describe(): FaceInfo[] {
    return this.faces.map((f) => {
      const files = f.files.map((n) => this.files.get(n)!);
      return {
        family: f.family,
        weightMin: f.weights[0],
        weightMax: f.weights[1],
        variable: !!f.axis,
        files: files.map((x) => ({ file: x.file, sha256: x.sha256, bytes: x.bytes })),
        missingMacedonian: [...MACEDONIAN_LETTERS].filter((c) => !files.some((x) => x.unicodes.has(c.codePointAt(0)!))),
      };
    });
  }

  /** undefined when the family/weight is registered; otherwise a readable error. */
  checkFont(family: string, weight: number): string | undefined {
    const faces = this.faces.filter((f) => f.family === family);
    if (!faces.length) return `font '${family}' is not registered (registered: ${this.families().join(", ")})`;
    if (!faces.some((f) => weight >= f.weights[0] && weight <= f.weights[1])) {
      const avail = faces.map((f) => (f.weights[0] === f.weights[1] ? `${f.weights[0]}` : `${f.weights[0]}–${f.weights[1]}`)).join(", ");
      return `'${family}' has no weight ${weight} (available: ${avail})`;
    }
    return undefined;
  }

  private face(family: string, weight: number): FaceSpec & { family: string } {
    const msg = this.checkFont(family, weight);
    if (msg) throw new FontRegistryError(msg);
    return this.faces.find((f) => f.family === family && weight >= f.weights[0] && weight <= f.weights[1])!;
  }

  /** Every loaded font file (all families), in registration order. */
  allFiles(): LoadedFile[] {
    return [...this.files.values()];
  }

  /** Family / weight range / variation axis for each registered face. */
  faceSpecs(): Array<{ family: string; weights: [number, number]; axis?: string; files: string[] }> {
    return this.faces.map((f) => ({ family: f.family, weights: f.weights, axis: f.axis, files: [...f.files] }));
  }

  /** Files of a face in lookup order. */
  filesFor(family: string, weight: number): LoadedFile[] {
    return this.face(family, weight).files.map((n) => this.files.get(n)!);
  }

  /** hb.Font for one file at a weight (variations applied for variable faces). */
  font(family: string, weight: number, file: string): hb.Font {
    const spec = this.face(family, weight);
    const key = `${file}@${spec.axis ? weight : "static"}`;
    let font = this.fonts.get(key);
    if (!font) {
      font = new hb.Font(this.files.get(file)!.face);
      if (spec.axis) font.setVariations([new hb.Variation(spec.axis, weight)]);
      this.fonts.set(key, font);
    }
    return font;
  }

  /** Ascender / descender (font units, descender negative) from the face's first file. */
  extents(family: string, weight: number): { ascender: number; descender: number; lineGap: number; upem: number } {
    const first = this.filesFor(family, weight)[0];
    const e = this.font(family, weight, first.file).hExtents();
    return { ...e, upem: first.upem };
  }
}
