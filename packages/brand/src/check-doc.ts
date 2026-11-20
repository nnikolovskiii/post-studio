// The palette rules of check_palette.py, applied to a post-studio/1 document (PLAN §3.6, Phase 5).
// It mirrors what packages/render writes into post.svg, so a document that passes here exports a
// post.svg that passes check_palette.py, and the other way round (tested on real posts):
//   - every colour (resolved token or hex) must be in the kit;
//   - the kit accent only inside the accent object (`accent: true` or role 'accent'; the renderer
//     wraps it in <g id="accent">), and at most one accent object per frame;
//   - the frame starts with the kit paper (frame background, or a full-frame rect as first layer);
//   - svg nodes: the SVG art itself (after its recolour map) passes check_palette --art: no
//     gradients, filters or paint servers, palette colours, the accent only in its accent group.
// Images (rasters) are not checked, exactly like check_palette.py.
import type { Document, Frame, Issue, Node } from "@post-studio/schema";
import { checkSvgPalette } from "./check-svg.ts";
import { resolveBrandToken, type BrandKit } from "./kits.ts";
import { paletteLane } from "./lane.ts";
import { recolorMap, recolorText } from "./recolor.ts";

export interface DocPaletteOptions {
  /** SVG text of an asset ('sha256:…'), for svg nodes. Undefined when not available. */
  svgAsset?: (ref: string) => string | undefined;
  /** Resolve a colour token (default: the registered kits). */
  resolveToken?: (token: string) => string | undefined;
}

export interface FramePalette {
  frame: string;
  ok: boolean;
  accentObjects: number;
}

export interface DocPaletteResult {
  kit: string;
  /** True when no rule is broken: the same verdict check_palette.py gives on the exported post.svg. */
  ok: boolean;
  /** Broken rules (codes: palette, accent-outside, accent-count, paper, svg-art). */
  issues: Issue[];
  /** Hints that check_palette.py does not fail on (codes: accent-missing, accent-empty, svg-unchecked). */
  advice: Issue[];
  frames: FramePalette[];
}

type Color = string | { token: string } | null | undefined;

/** The frame's accent object: `accent: true`, role 'accent', or a group with id 'accent' (post.svg's <g id="accent">). */
export function isAccentObject(n: Node): boolean {
  return n.accent === true || n.role === "accent" || (n.type === "group" && n.id === "accent");
}

/** Colour properties of a node as the renderer paints them. */
export function paintedColors(n: Node): Array<{ path: string; value: Color }> {
  const out: Array<{ path: string; value: Color }> = [];
  const it = n as Node & Record<string, any>;
  if (n.type === "text") {
    if (n.spans.some((s) => s.text.trim())) out.push({ path: "style.fill", value: n.style.fill });
    n.spans.forEach((s, i) => s.fill !== undefined && s.text.trim() && out.push({ path: `spans.${i}.fill`, value: s.fill }));
    return out;
  }
  if (it.fill !== undefined && it.fill !== null) out.push({ path: "fill", value: it.fill });
  if (it.stroke?.color !== undefined) out.push({ path: "stroke.color", value: it.stroke.color });
  return out;
}

function hexOf(c: Color, resolve: (t: string) => string | undefined): string | undefined {
  if (c === null || c === undefined) return undefined;
  const h = typeof c === "string" ? c : resolve(c.token);
  return h ? h.slice(0, 7).toUpperCase() : undefined;
}

export function checkDocumentPalette(doc: Document, kit: BrandKit, opts: DocPaletteOptions = {}): DocPaletteResult {
  const resolve = opts.resolveToken ?? resolveBrandToken;
  const lane = paletteLane(kit);
  const issues: Issue[] = [];
  const advice: Issue[] = [];
  const frames: FramePalette[] = [];

  for (const frame of doc.frames) {
    const before = issues.length;
    let accentObjects = 0;
    const firstAccent: string[] = [];
    const color = (node: string, path: string, c: Color, inAccent: boolean) => {
      const hex = hexOf(c, resolve);
      if (!hex) return; // unresolved tokens are reported by the token check
      const shown = typeof c === "string" ? c : `${hex} (token ${(c as { token: string }).token})`;
      if (!kit.byHex.has(hex)) issues.push({ path: `${node}.${path}`, node, code: "palette", message: `${shown} is not in the ${kit.id} palette` });
      if (hex === kit.accentHex && !inAccent) {
        issues.push({ path: `${node}.${path}`, node, code: "accent-outside", message: `the ${kit.id} accent ${kit.accentHex} is used outside the accent object (mark one layer as the accent, DESIGN §1.4)` });
      }
    };

    // Paper: the first painted element of post.svg must be a full-frame rect in the paper colour.
    const paperOk = (() => {
      if (frame.background) return hexOf(frame.background.color, resolve) === kit.paperHex;
      const first = frame.children.find((n) => n.visible !== false);
      if (!first || first.type !== "rect") return false;
      return first.x <= 0 && first.y <= 0 && first.w >= frame.w && first.h >= frame.h && hexOf(first.fill, resolve) === kit.paperHex;
    })();
    if (frame.background) color(frame.id, "background.color", frame.background.color, false);
    if (!paperOk) {
      issues.push({ path: `${frame.id}.background`, node: frame.id, code: "paper", message: `frame '${frame.id}' must start with the ${kit.id} paper ${kit.paperHex} (frame background, or a full-frame rect as the bottom layer)` });
    }

    const visit = (nodes: Node[], inAccent: boolean) => {
      for (const n of nodes) {
        if (n.visible === false) continue;
        const acc = isAccentObject(n);
        if (acc) {
          accentObjects++;
          firstAccent.push(n.id);
          if (n.type === "group" && !n.children.some((c) => c.visible !== false)) {
            advice.push({ path: n.id, node: n.id, code: "accent-empty", message: `the accent object '${n.id}' is empty: put the one ${kit.id} accent (${kit.accentHex}) element in it` });
          }
        }
        const inside = inAccent || acc;
        for (const c of paintedColors(n)) color(n.id, c.path, c.value, inside);
        if (n.type === "svg") {
          const text = opts.svgAsset?.(n.asset);
          if (text === undefined) {
            advice.push({ path: `${n.id}.asset`, node: n.id, code: "svg-unchecked", message: `the SVG art of '${n.id}' could not be read, so its colours were not checked` });
          } else {
            const r = checkSvgPalette(recolorText(text, recolorMap(n.recolor)), lane, { art: true, insideAccent: inside, path: "" });
            for (const e of r.errors) issues.push({ path: `${n.id}.asset`, node: n.id, code: "svg-art", message: `SVG art${e.replace(/^:(\d+):/, " line $1:").replace(/^: /, ": ")}` });
            if (!inside && r.accentGroups) {
              accentObjects += r.accentGroups;
              firstAccent.push(`${n.id} (its <g id="accent">)`);
            }
          }
        }
        if (n.type === "group") visit(n.children, inside);
      }
    };
    visit(frame.children, false);

    if (accentObjects > 1) {
      issues.push({ path: frame.id, node: frame.id, code: "accent-count", message: `frame '${frame.id}' has ${accentObjects} accent objects (${firstAccent.join(", ")}); a frame has exactly one (DESIGN §1.4)` });
    } else if (accentObjects === 0) {
      advice.push({ path: frame.id, node: frame.id, code: "accent-missing", message: `frame '${frame.id}' has no accent object; DESIGN §1.4 asks for one ${kit.id} accent per frame` });
    }
    frames.push({ frame: frame.id, ok: issues.length === before, accentObjects });
  }
  return { kit: kit.id, ok: issues.length === 0, issues, advice, frames };
}

/** Stable identity of an issue across revisions (strict mode only blocks new ones). */
export function issueKey(i: Issue): string {
  return `${i.code}|${i.path}|${i.message.replace(/ line \d+:/, ":")}`;
}

export type { Frame };
