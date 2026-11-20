import type { Document } from "@post-studio/schema";
import type { FontRegistry } from "@post-studio/text";

export type ImportMode = "layout" | "template" | "fallback";

export interface UploadedAsset {
  /** 'sha256:<hex>' as returned by the asset upload (after sanitizing). */
  ref: string;
  mime: string;
  bytes: number;
}

/** Uploads one asset through the normal path (POST /v1/assets: sniffing, limits, SVG sanitizer). */
export type AssetSink = (bytes: Uint8Array, name: string) => Promise<UploadedAsset>;

export interface ImportOptions {
  fonts: FontRegistry;
  upload: AssetSink;
  /** Default 'auto': layout → template → fallback. */
  mode?: ImportMode | "auto";
  title?: string;
  /** Brand kit id; default: from copy.json `lane` or the slug prefix (lux-, kites-, studio-). null = none. */
  kit?: string | null;
  /** Clock for meta.import.at (tests). */
  now?: () => Date;
}

export interface ImportedAsset {
  ref: string;
  mime: string;
  from: string;
  note?: string;
}

export interface FrameReport {
  id: string;
  name: string;
  w: number;
  h: number;
  source: string;
  nodes: number;
  texts: number;
  roles: Record<string, string[]>;
}

export interface ImportReport {
  mode: ImportMode;
  /** Why richer modes were not used (auto). */
  why: string[];
  source: string;
  frames: FrameReport[];
  assets: ImportedAsset[];
  warnings: string[];
  /** Elements that were intentionally left out (hidden template guides, comments …). */
  skipped: string[];
  /** Largest |packages/text width − Chrome advance| over the layout's text items (layout mode). */
  maxAdvanceDelta?: number;
}

export interface ImportResult {
  doc: Document;
  report: ImportReport;
}

export class ImportError extends Error {
  constructor(
    message: string,
    public readonly reasons: string[] = [],
  ) {
    super(reasons.length ? `${message}: ${reasons.slice(0, 8).join("; ")}${reasons.length > 8 ? ` (+${reasons.length - 8} more)` : ""}` : message);
  }
}
