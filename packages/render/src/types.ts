import type { Document } from "@post-studio/schema";
import type { FontRegistry } from "@post-studio/text";

export type Color = string | { token: string };

export interface AssetData {
  mime: string;
  bytes: Uint8Array;
}

/** sha256 (64 hex, no prefix) → bytes. Undefined when missing. */
export type AssetResolver = (sha256: string) => AssetData | undefined;

export type TextMode = "live" | "outlined";

export interface RenderOptions {
  fonts: FontRegistry;
  assets: AssetResolver;
  /** Frame id; default the first frame. */
  frame?: string;
  /**
   * live: real <text> positioned from the packages/text layout (line breaks match).
   * outlined: every glyph as a path shaped by HarfBuzz; needs no fonts.
   */
  text?: TextMode;
  /** live only: embed the used font files as @font-face data URIs (default true). */
  embedFonts?: boolean;
  /**
   * live only. 'glyph' (default): every character gets its HarfBuzz x, so a browser draws each
   * glyph exactly where the outlined export does, whatever its own hinting / advance rounding
   * (Chrome on Linux rounds advances to whole px). 'line': one x per line and span run, the
   * browser lays out the rest (cleaner text for Figma, which re-flows with its own metrics).
   */
  positioning?: "glyph" | "line";
  /** Brand token → #RRGGBB[AA]. Unresolved tokens draw magenta and warn. */
  resolveToken?: (token: string) => string | undefined;
  /** How image / svg bytes are referenced. Default: data URIs (self-contained files). */
  imageHref?: (sha256: string, data: AssetData) => string;
  /** Add <title> with the document title (default true). */
  title?: boolean;
  /**
   * Draw the moment `time` (ms) of a motion project: every node with keyframes is wrapped in one
   * <g> with its sampled transform and opacity, text `reveal` draws the first units only.
   * Undefined, or a document without `motion`: the rest pose, byte-identical to a still render.
   */
  time?: number;
}

export interface RenderResult {
  svg: string;
  frame: { id: string; name: string; w: number; h: number };
  warnings: string[];
  /** Font files embedded or referenced, for reports. */
  fontsUsed: Array<{ family: string; weight: number; file: string }>;
}

export type { Document };
