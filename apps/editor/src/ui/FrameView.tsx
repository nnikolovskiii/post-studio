// One frame on the canvas: the same markup packages/render writes into post.svg (live text,
// glyph positioning), node by node, so only changed layers are rebuilt in the DOM.
//
// Motion (PLAN-motion.md §5.3): at a playhead time every animated layer is drawn as its cached
// rest markup inside one <g> carrying the sampled transform / opacity (packages/render
// animAttrs, the same function the export uses). So playback changes only wrapper attributes;
// the per-layer markup cache keeps working. Text `reveal` is the one inner-markup change, cached
// per number of units shown. A group with animated layers inside is drawn as its own <g> around
// its children, so those children get wrappers too.
import { memo, useLayoutEffect, useMemo } from "react";
import { animAttrs, createNodeRenderer, nodeBox as renderBox, num, revealCut, type NodeRenderer } from "@post-studio/render";
import { isAccentObject } from "@post-studio/brand";
import { NODE_DEFAULTS, type Document, type Frame, type Node } from "@post-studio/schema";
import type { FontRegistry } from "@post-studio/text";
import { hasKeyframes, sampleNode } from "@post-studio/motion";
import { assetUrl, getAsset } from "../assets.ts";
import { layoutFor } from "../textlayout.ts";
import { subtreeAnimated } from "../model/motion.ts";
import { perf } from "../timeline.ts";

const markupCache = new Map<string, string>();

function cached(key: string, make: () => string): string {
  let html = markupCache.get(key);
  if (html === undefined) {
    html = make();
    if (markupCache.size > 4000) markupCache.delete(markupCache.keys().next().value!);
    markupCache.set(key, html);
  }
  return html;
}

function markupFor(r: NodeRenderer, node: Node, salt: string): string {
  return cached(`${salt}|${JSON.stringify(node)}`, () => r.node(node));
}

const Layer = memo(function Layer({ html }: { html: string }) {
  return <g dangerouslySetInnerHTML={{ __html: html }} />;
});

const rendererOptions = (fonts: FontRegistry) =>
  ({
    fonts,
    assets: (sha: string) => getAsset(sha),
    imageHref: (sha: string) => assetUrl(sha),
    embedFonts: false,
    positioning: "glyph",
    text: "live",
  }) as const;

export function useRenderer(fonts: FontRegistry, doc: Document): NodeRenderer {
  // The renderer only reads the document's language; assets are looked up live.
  return useMemo(() => createNodeRenderer(doc, rendererOptions(fonts)), [fonts, doc.lang]);
}

/** What a frame needs to draw a moment of a motion project. */
export interface TimeContext {
  t: number;
  fonts: FontRegistry;
  lang: string;
  /** Renderer at time t (text reveal, accent groups with animated layers inside). */
  at: NodeRenderer;
}

export function makeTimeContext(fonts: FontRegistry, doc: Document, t: number | undefined): TimeContext | undefined {
  if (t === undefined || !doc.motion) return undefined;
  return { t, fonts, lang: doc.lang, at: createNodeRenderer(doc, { ...rendererOptions(fonts), time: t }) };
}

const NodeView = memo(function NodeView({ node, r, salt, tc }: { node: Node; r: NodeRenderer; salt: string; tc?: TimeContext }) {
  if (!tc || node.visible === false || !subtreeAnimated(node)) return <Layer html={markupFor(r, node, salt)} />;
  const own = hasKeyframes(node) ? sampleNode(node, tc.t) : undefined;
  let inner: React.ReactNode;
  if (node.type === "group" && node.children.some(subtreeAnimated)) {
    if (isAccentObject(node)) {
      // Rare: an accent group with animated layers inside. Its children render inside the
      // accent context (SVG ids), so take the renderer's markup for this moment as it is.
      return <Layer html={cached(`${salt}|${tc.t}|${JSON.stringify(node)}`, () => tc.at.node(node))} />;
    }
    const transform = `translate(${num(node.x)} ${num(node.y)})${node.rotation ? ` rotate(${num(node.rotation)} ${num(node.w / 2)} ${num(node.h / 2)})` : ""}`;
    const opacity = node.opacity !== undefined && node.opacity !== NODE_DEFAULTS.opacity ? node.opacity : undefined;
    inner = (
      <g id={node.id} transform={transform} opacity={opacity}>
        {node.children.map((c) => (
          <NodeView key={c.id} node={c} r={r} salt={salt} tc={subtreeAnimated(c) ? tc : undefined} />
        ))}
      </g>
    );
  } else if (node.type === "text" && own && own.reveal < 1) {
    const L = layoutFor(tc.fonts, node, tc.lang);
    const cut = revealCut(L, node.spans.map((s) => s.text).join(""), node.anim?.revealBy ?? "char", own.reveal);
    // Only the reveal track, so the renderer's own wrapper is a neutral <g>; ours carries the rest.
    const revealOnly = { ...node, anim: { ...node.anim, tracks: { reveal: node.anim!.tracks!.reveal } } } as Node;
    inner = <Layer html={cached(`${salt}|cut${cut}|${JSON.stringify(node)}`, () => tc.at.node(revealOnly))} />;
  } else inner = <Layer html={markupFor(r, node, salt)} />;
  if (!own) return <>{inner}</>;
  const box = node.type === "text" ? { x: node.x, y: node.y, w: layoutFor(tc.fonts, node, tc.lang).boxW, h: layoutFor(tc.fonts, node, tc.lang).boxH } : renderBox(node);
  const a = animAttrs(own, box, node.anim?.origin);
  return (
    <g transform={a.transform} opacity={a.opacity} data-anim={node.id}>
      {inner}
    </g>
  );
});

export const FrameView = memo(function FrameView(props: { frame: Frame; x: number; y: number; renderer: NodeRenderer; salt: string; tc?: TimeContext }) {
  const { frame, renderer, salt, tc } = props;
  const bg = renderer.background(frame);
  useLayoutEffect(() => {
    perf.paints[frame.id] = (perf.paints[frame.id] ?? 0) + 1;
    perf.lastPaint = performance.now();
  });
  return (
    <svg x={props.x} y={props.y} width={frame.w} height={frame.h} viewBox={`0 0 ${frame.w} ${frame.h}`} overflow="hidden" data-frame={frame.id} data-time={tc?.t} className="frame">
      {bg ? <Layer html={bg} /> : null}
      {frame.children.map((n) => (
        // Static layers get no time context, so memo skips them while the playhead moves.
        <NodeView key={n.id} node={n} r={renderer} salt={salt} tc={tc && subtreeAnimated(n) ? tc : undefined} />
      ))}
    </svg>
  );
});
