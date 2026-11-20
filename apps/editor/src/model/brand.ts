// Brand kits in the editor (Phase 5): the same kits, tokens and palette check as the server
// (packages/brand), computed locally so warnings show while he edits.
import { checkDocumentPalette, getKit, resolveBrandToken, type BrandKit, type DocPaletteResult } from "@post-studio/brand";
import type { Document } from "@post-studio/schema";
import { getAsset } from "../assets.ts";

export type Color = string | { token: string };

const dec = new TextDecoder();
const memo = new WeakMap<Document, { v: number; r: DocPaletteResult | undefined }>();

export const kitOf = (doc: Document | undefined): BrandKit | undefined => getKit(doc?.brandKit);

/** Palette verdict of the document against its kit (undefined without a kit). `v` invalidates when SVG assets arrive. */
export function docPalette(doc: Document, v = 0): DocPaletteResult | undefined {
  const hit = memo.get(doc);
  if (hit && hit.v === v) return hit.r;
  const kit = kitOf(doc);
  const r = kit
    ? checkDocumentPalette(doc, kit, {
        svgAsset: (ref) => {
          const a = getAsset(ref.replace(/^sha256:/, ""));
          return a ? dec.decode(a.bytes) : undefined;
        },
      })
    : undefined;
  memo.set(doc, { v, r });
  return r;
}

/** '#RRGGBB' of a colour or token; undefined for none / an unknown token. */
export function colorHexOf(c: Color | null | undefined): string | undefined {
  if (!c) return undefined;
  const h = typeof c === "string" ? c : resolveBrandToken(c.token);
  return h ? h.slice(0, 7).toUpperCase() : undefined;
}

/** For labels in History: '#AC1922' or 'lux.mark'. */
export const colorName = (c: Color | null | undefined) => (!c ? "none" : typeof c === "string" ? c : c.token);

/** True when a colour is outside the kit (tokens of the kit and their hex are inside). */
export function offPalette(kit: BrandKit | undefined, c: Color | null | undefined): boolean {
  if (!kit || !c) return false;
  if (typeof c !== "string") return !c.token.startsWith(kit.id + ".") || !kit.hex(c.token.slice(kit.id.length + 1));
  return !kit.byHex.has(c.slice(0, 7).toUpperCase());
}
