// Cached packages/text layout for the canvas, the overlay and the caret. Keyed by everything
// that affects layout, so a cloned document (every commit clones) still hits the cache.
import type { TextNode } from "@post-studio/schema";
import { layoutNode, measureAdvance, type FontRegistry, type TextLayout } from "@post-studio/text";

const cache = new Map<string, TextLayout>();

export function layoutFor(fonts: FontRegistry, node: TextNode, lang: string): TextLayout {
  const key = `${lang}|${node.box}|${node.align}|${node.w}|${node.h}|${JSON.stringify(node.style)}|${JSON.stringify(node.spans)}`;
  let L = cache.get(key);
  if (!L) {
    try {
      L = layoutNode(fonts, node, lang);
    } catch {
      // Unregistered font / weight: an empty box rather than a crash; validation reports it.
      L = { lines: [], width: 0, height: 0, boxW: node.w, boxH: node.h, overflowX: 0, overflowY: 0, lineHeight: node.style.size * 1.2, ascent: node.style.size * 0.9, descent: node.style.size * 0.3, missingGlyphs: [] };
    }
    if (cache.size > 3000) cache.delete(cache.keys().next().value!);
    cache.set(key, L);
  }
  return L;
}

export function textBoxFn(fonts: FontRegistry, lang: string) {
  return (n: TextNode) => {
    const L = layoutFor(fonts, n, lang);
    return { w: L.boxW, h: L.boxH };
  };
}

const spaceCache = new Map<string, number>();
export function spaceAdvance(fonts: FontRegistry, node: TextNode, lang: string): number {
  const key = `${lang}|${JSON.stringify(node.style)}`;
  let v = spaceCache.get(key);
  if (v === undefined) {
    try {
      v = measureAdvance(fonts, " ", node.style, lang);
    } catch {
      v = node.style.size * 0.25;
    }
    spaceCache.set(key, v);
  }
  return v;
}
