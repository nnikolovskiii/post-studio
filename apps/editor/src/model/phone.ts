// Phone review view (PLAN Phase 8): pure helpers, tested in phone.test.ts.
// Which view opens, which text layers can be edited on the phone, how a plain-text edit maps
// back onto the rich spans (emphasis kept), and the pinch / pan maths of the zoom viewer.
import type { Document, Frame, Node, TextNode } from "@post-studio/schema";
import { fullText, replaceRange, textDiff, type Span } from "./richtext.ts";

// ---------------------------------------------------------------- which view

export type ViewMode = "phone" | "desktop";
export const VIEW_KEY = "post-studio:view";

export interface DeviceInfo {
  /** `(pointer: coarse)`: the primary input is a finger. */
  coarse: boolean;
  /** Shorter side of the screen in CSS px (a phone is ≤ 600 in either orientation). */
  shortSide: number;
}

export const isPhoneLike = (d: DeviceInfo) => d.coarse && d.shortSide <= 600;

/**
 * `?view=phone|desktop` wins (and is remembered), then the remembered choice, then the device:
 * a touch screen whose short side is at most 600 px opens the phone view. A laptop never does.
 */
export function chooseView(query: string | null, stored: string | null, device: DeviceInfo): { mode: ViewMode; remember?: ViewMode } {
  if (query === "phone" || query === "desktop") return { mode: query, remember: query };
  if (stored === "phone" || stored === "desktop") return { mode: stored };
  return { mode: isPhoneLike(device) ? "phone" : "desktop" };
}

// ---------------------------------------------------------------- text layers

export interface TextLayer {
  id: string;
  frame: string;
  /** Role, else a meaningful id or name, else "" (see layerLabel). */
  label: string;
  role?: string;
  text: string;
  /** Spans that differ from the base style (bold or colour emphasis). */
  styledRuns: number;
  /** Why it cannot be edited on the phone (undefined = editable). */
  blocked?: string;
  /** Frame-space top, for reading order. */
  top: number;
  left: number;
  /** Inside a group (chart rows, scores): listed after the main texts. */
  inGroup: boolean;
}

/** More emphasis runs than this and a plain-text box is no longer an honest way to edit it. */
export const MAX_PHONE_RUNS = 8;

export const styledRuns = (spans: Span[]) => spans.filter((s) => s.text && (s.weight !== undefined || s.fill !== undefined)).length;

/** Names an importer or the editor made up ("text-03", "rect-04-copy"): no help on a small screen. */
const GENERATED = /^(text|rect|ellipse|circle|line|path|group|image|svg|layer)[-_ ]?\d+([-_ ]copy(\d+)?)*$/i;

/** A readable label for a layer: its role, else a meaningful id or name, else "" (the text itself says enough). */
export function layerLabel(n: Node): string {
  for (const c of [roleOf(n), n.name, n.id]) if (c && !GENERATED.test(c.trim())) return c;
  return "";
}

function roleOf(n: Node): string | undefined {
  const r = (n as { role?: unknown }).role;
  return typeof r === "string" ? r : undefined;
}

/** Why a text layer cannot be edited on the phone, in words he can act on. */
export function phoneEditBlock(n: TextNode, hiddenOrLockedAncestor = false): string | undefined {
  if (n.locked || hiddenOrLockedAncestor) return "Locked or hidden: change it on the desktop editor.";
  if (n.visible === false) return "Hidden layer: show it on the desktop editor first.";
  if (styledRuns(n.spans) > MAX_PHONE_RUNS) return `This text has ${styledRuns(n.spans)} styled runs (bold / colour). Edit it on the desktop editor so none of them breaks.`;
  return undefined;
}

/** Every text layer of a frame, top to bottom, left to right (groups opened). */
export function textLayers(frame: Frame): TextLayer[] {
  const out: TextLayer[] = [];
  const visit = (nodes: Node[], ox: number, oy: number, blockedAbove: boolean, inGroup = false) => {
    for (const n of nodes) {
      if (n.type === "group") {
        visit(n.children, ox + n.x, oy + n.y, blockedAbove || !!n.locked || n.visible === false, true);
        continue;
      }
      if (n.type !== "text") continue;
      const role = roleOf(n);
      out.push({
        id: n.id,
        frame: frame.id,
        label: layerLabel(n),
        role,
        text: fullText(n.spans),
        styledRuns: styledRuns(n.spans),
        blocked: phoneEditBlock(n, blockedAbove),
        top: oy + n.y,
        left: ox + n.x,
        inGroup,
      });
    }
  };
  visit(frame.children, 0, 0, false);
  return out.sort((a, b) => a.top - b.top || a.left - b.left);
}

export function textNodeById(doc: Document, id: string): TextNode | undefined {
  const find = (nodes: Node[]): TextNode | undefined => {
    for (const n of nodes) {
      if (n.id === id && n.type === "text") return n;
      if (n.type === "group") {
        const r = find(n.children);
        if (r) return r;
      }
    }
    return undefined;
  };
  for (const f of doc.frames) {
    const r = find(f.children);
    if (r) return r;
  }
  return undefined;
}

// ---------------------------------------------------------------- plain edit → spans

export interface PlainEdit {
  spans: Span[];
  changed: boolean;
  /**
   * The edit replaced characters from more than one style run (e.g. retyped across a bold
   * word): the new text takes one style, so that emphasis is gone. The phone asks before saving.
   */
  emphasisLost: string[];
}

/**
 * Turn the phone's plain textarea back into spans: only the changed range is replaced (common
 * prefix and suffix kept), so bold / colour on untouched words stays exactly where it was.
 * New text takes the style of the first replaced character, like the desktop editor.
 */
export function applyPlainEdit(spans: Span[], next: string, baseWeight: number): PlainEdit {
  const before = fullText(spans);
  const norm = next.replace(/\r\n?/g, "\n");
  if (norm === before) return { spans, changed: false, emphasisLost: [] };
  const d = textDiff(before, norm);
  const lost: string[] = [];
  if (d.end > d.start) {
    // Styled runs that the replaced range covers but does not start in: their style goes away.
    let pos = 0;
    const firstAttrs = attrsKeyAt(spans, d.start);
    for (const s of spans) {
      const a = Math.max(d.start, pos);
      const b = Math.min(d.end, pos + s.text.length);
      if (b > a && (s.weight !== undefined || s.fill !== undefined) && attrsKey(s) !== firstAttrs) lost.push(s.text.slice(a - pos, b - pos));
      pos += s.text.length;
    }
  }
  return { spans: replaceRange(spans, d.start, d.end, d.insert, { weight: baseWeight }), changed: true, emphasisLost: lost };
}

const attrsKey = (s: Span) => JSON.stringify([s.weight ?? null, s.fill ?? null]);
function attrsKeyAt(spans: Span[], index: number): string {
  let pos = 0;
  for (const s of spans) {
    if (index < pos + s.text.length) return attrsKey(s);
    pos += s.text.length;
  }
  return spans.length ? attrsKey(spans[spans.length - 1]) : "";
}

// ---------------------------------------------------------------- zoom viewer

export interface ZoomState {
  /** Scale on top of fit-to-screen (1 = the frame fits). */
  k: number;
  x: number;
  y: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;
const clampK = (k: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k));

/** Zoom by `factor` about a screen point, keeping that point still. */
export function zoomAbout(z: ZoomState, factor: number, cx: number, cy: number): ZoomState {
  const k = clampK(z.k * factor);
  const r = k / z.k;
  return { k, x: cx - (cx - z.x) * r, y: cy - (cy - z.y) * r };
}

/** One pinch step: the two fingers moved from (a0, b0) to (a1, b1). */
export function pinchStep(z: ZoomState, a0: { x: number; y: number }, b0: { x: number; y: number }, a1: { x: number; y: number }, b1: { x: number; y: number }): ZoomState {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y) || 1;
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  const zoomed = zoomAbout(z, d1 / d0, m0.x, m0.y);
  return { ...zoomed, x: zoomed.x + (m1.x - m0.x), y: zoomed.y + (m1.y - m0.y) };
}

/**
 * Keep the content (w × h at k = 1, centred in the viewport) from leaving the screen: at k = 1
 * it is centred; zoomed in, its edges may not come inside the viewport edges.
 */
export function clampPan(z: ZoomState, contentW: number, contentH: number, viewW: number, viewH: number): ZoomState {
  const k = clampK(z.k);
  const w = contentW * k;
  const h = contentH * k;
  const ox = (viewW - contentW) / 2; // where the k = 1 content sits
  const oy = (viewH - contentH) / 2;
  // Screen left edge of the content = x + o * k (transform origin at the viewport's top-left).
  const fit = (pos: number, size: number, view: number, o: number) =>
    size <= view ? (view - size) / 2 - o * k : Math.min(-o * k, Math.max(view - size - o * k, pos));
  return { k, x: fit(z.x, w, viewW, ox), y: fit(z.y, h, viewH, oy) };
}
