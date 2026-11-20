// The canvas: frames side by side (FrameView), an overlay in screen space (selection, handles,
// guides, snap lines, agent highlights, text caret) and every pointer interaction.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { findItem, type Document, type Frame, type Node, type TextNode, type TrackName } from "@post-studio/schema";
import type { Op } from "@post-studio/ops";
import {
  aabb,
  apply as applyPt,
  inv,
  mul,
  nodeAabb,
  nodeBox,
  nodeCorners,
  nodeMatrix,
  ownMatrix,
  parentMatrix,
  isTranslationOnly,
  resizeBox,
  rotateFromDrag,
  translate,
  unionBoxes,
  HANDLES,
  type Box,
  type Handle,
  type Mat,
  type Pt,
} from "../model/geometry.ts";
import { hitTest, pickFromChain, type HitMotion } from "../model/hit.ts";
import { animateMoveOps, animateRotateOps, fmtTime, hitMotionAt, keyAtTime, movedAt, nodeCornersAt, nodeMatrixAt, scaleFactor, scaleSetup, scaleTrackFor } from "../model/motion.ts";
import { useTime } from "../timeline.ts";
import { buildTargets, snapBox, snapPoint, type SnapLine, type SnapTargets } from "../model/snap.ts";
import { guideSnapLines, guidesFor } from "../model/guides.ts";
import { moveFrame, snapFramePosition } from "../model/frames.ts";
import { getNode, insertNode, moveNodes, newId, resizeMany, resizeNode, rotateMany, rotateNode, setLineEnds, topmost, type Command } from "../model/commands.ts";
import { caretRect, indexAtPoint, selectionRects, wordAt } from "../model/caret.ts";
import { fullText } from "../model/richtext.ts";
import { layoutFor, spaceAdvance } from "../textlayout.ts";
import {
  commit,
  finishEditing,
  fitView,
  frameOffsets,
  readOnlyReason,
  select,
  setDraft,
  startEditing,
  textBox,
  updateEditing,
  useEditor,
  visibleDoc,
  zoomAt,
} from "../store.ts";
import { FrameView, makeTimeContext, useRenderer } from "./FrameView.tsx";
import { TextInput } from "./TextInput.tsx";

type Drag =
  | { kind: "move"; start: Pt; frame: string; ids: string[]; startBox: Box; targets: SnapTargets; moved: boolean; clicked?: string; cmd?: Command }
  | { kind: "resize"; frame: string; ids: string[]; handle: Handle; single?: { id: string; box: Box; rotation: number; pm: Mat }; from: Box; targets: SnapTargets; cmd?: Command }
  | { kind: "rotate"; frame: string; ids: string[]; center: Pt; start: Pt; startRotation: number; cmd?: Command }
  | { kind: "line-end"; frame: string; id: string; end: 1 | 2; m: Mat; other: Pt; targets: SnapTargets; cmd?: Command }
  // `frame`: started inside that frame on its background (a layer covering the frame), so only
  // that frame's layers are picked and the layer under the start is not (see bgLike).
  | { kind: "marquee"; start: Pt; cur: Pt; additive: boolean; base: string[]; frame?: string; click?: string }
  | { kind: "frame-move"; frame: string; start: Pt; origin: Pt; moved: boolean; cmd?: Command }
  | { kind: "pan"; sx: number; sy: number; view: { x: number; y: number } }
  | { kind: "create"; tool: "text" | "rect" | "ellipse" | "line"; frame: string; start: Pt; cur: Pt }
  | { kind: "text-select"; id: string; anchor: number }
  // Animate mode (PLAN-motion.md §6.1): the same gestures write keyframes at the playhead.
  | { kind: "anim-move"; start: Pt; frame: string; ids: string[]; moved: boolean; clicked?: string; cmd?: Command }
  | { kind: "anim-scale"; frame: string; ids: string[]; track: TrackName; setups: Array<{ id: string } & ReturnType<typeof scaleSetup>>; cmd?: Command }
  | { kind: "anim-rotate"; frame: string; ids: string[]; center: Pt; start: Pt; cmd?: Command };

const SNAP_PX = 6;

export function Canvas() {
  const s = useEditor();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [, force] = useState(0);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const fitted = useRef<string | null>(null);
  const doc = visibleDoc(s);
  const fonts = s.fonts!;
  const renderer = useRenderer(fonts, doc!);
  const tb = textBox(s);
  const offs = doc ? frameOffsets(doc) : new Map<string, Pt>();
  const z = s.view.zoom;
  const ro = !!readOnlyReason(s);
  // The playhead (motion projects only): the canvas draws that moment, and the overlay and
  // clicks follow each layer to where it is drawn.
  const playhead = useTime((x) => x.t);
  const animateMode = useTime((x) => x.animate);
  const time = doc?.motion ? playhead : undefined;
  const animOn = animateMode && time !== undefined;
  const tc = useMemo(() => (doc ? makeTimeContext(fonts, doc, time) : undefined), [fonts, doc, time]);
  const hm: HitMotion | undefined = hitMotionAt(time, tb);

  // ---- size + first fit
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
      if (fitted.current !== s.projectId && r.width > 0) {
        fitted.current = s.projectId;
        fitView(r.width, r.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [s.projectId]);

  // ---- wheel: pan, Ctrl / ⌘ zooms at the cursor
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0025 * (e.deltaMode === 1 ? 30 : 1)), e.clientX - r.left, e.clientY - r.top);
      else useEditor.setState((st) => ({ view: { ...st.view, x: st.view.x - e.deltaX, y: st.view.y - e.deltaY } }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const local = useCallback((e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);
  const toWorld = (p: Pt): Pt => ({ x: (p.x - s.view.x) / z, y: (p.y - s.view.y) / z });
  const frameAt = (w: Pt): Frame | undefined => doc?.frames.find((f) => {
    const o = offs.get(f.id)!;
    return w.x >= o.x && w.x <= o.x + f.w && w.y >= o.y && w.y <= o.y + f.h;
  });
  const inFrame = (frame: string, w: Pt): Pt => ({ x: w.x - offs.get(frame)!.x, y: w.y - offs.get(frame)!.y });
  const scr = (frame: string, p: Pt): Pt => ({ x: s.view.x + (offs.get(frame)!.x + p.x) * z, y: s.view.y + (offs.get(frame)!.y + p.y) * z });

  if (!doc) return <div className="canvas" ref={ref} />;

  // ---- snapping targets for a frame, excluding the moving nodes (and their subtrees)
  const targetsFor = (frameId: string, exclude: string[]): SnapTargets => {
    const frame = doc.frames.find((f) => f.id === frameId)!;
    const ex = new Set(exclude);
    const siblings: Node[] = [];
    const scopeNode = s.scope ? getNode(doc, s.scope) : undefined;
    const pool = scopeNode?.type === "group" ? scopeNode.children : frame.children;
    for (const n of pool) if (!ex.has(n.id) && n.visible !== false) siblings.push(n);
    if (scopeNode && !ex.has(scopeNode.id)) siblings.push(scopeNode);
    const boxes = siblings.map((n) => nodeAabb(doc, n, tb));
    return buildTargets(frame, boxes, s.showGuides ? guideSnapLines(guidesFor(frame)) : { x: [], y: [] });
  };

  /** Where a layer is drawn now (the playhead moment of a motion project). */
  const cornersOf = (n: Node) => (time === undefined ? nodeCorners(doc, n, tb) : nodeCornersAt(doc, n, time, tb));
  const selAabb = (ids: string[]): Box => unionBoxes(ids.map((id) => getNode(doc, id)).filter((n): n is Node => !!n).map((n) => nodeAabb(doc, n, tb)));
  const frameOfId = (id: string) => findItem(doc, id)?.frame;
  /**
   * A layer that is the frame's background: it covers at least 90 % of the frame where it is
   * drawn now. Pressing on it and dragging draws a selection box (Figma's "drag on the frame");
   * a plain click still selects it, and once selected it drags like any layer.
   */
  const bgLike = (frame: Frame, id: string) => {
    const n = getNode(doc, id);
    if (!n) return false;
    const b = aabb(cornersOf(n));
    const iw = Math.max(0, Math.min(b.x + b.w, frame.w) - Math.max(b.x, 0));
    const ih = Math.max(0, Math.min(b.y + b.h, frame.h) - Math.max(b.y, 0));
    return iw * ih >= 0.9 * frame.w * frame.h;
  };

  // ---- pointer down on the canvas
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-ui]")) return;
    const ts = useTime.getState();
    if (ts.selectedKeys.length || ts.popover) useTime.setState({ selectedKeys: [], popover: null });
    const p = local(e);
    const w = toWorld(p);
    ref.current!.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || s.spaceDown || s.tool === "hand") {
      drag.current = { kind: "pan", sx: p.x, sy: p.y, view: { x: s.view.x, y: s.view.y } };
      return;
    }
    if (e.button !== 0) return;
    const frame = frameAt(w);

    if (s.editing) {
      const n = getNode(doc, s.editing.id) as TextNode | undefined;
      if (n && frame && frameOfId(n.id) === frame.id) {
        const q = textPoint(doc, n, inFrame(frame.id, w));
        if (q) {
          const text = fullText(s.editing.spans);
          const L = layoutFor(fonts, n, doc.lang);
          const idx = indexAtPoint(L, text, q, spaceAdvance(fonts, n, doc.lang));
          const anchor = e.shiftKey ? s.editing.sel[0] : idx;
          updateEditing({ sel: [Math.min(anchor, idx), Math.max(anchor, idx)] });
          drag.current = { kind: "text-select", id: n.id, anchor };
          return;
        }
      }
      finishEditing();
    }

    if (s.tool !== "select") {
      if (!frame || ro) return;
      const fp = inFrame(frame.id, w);
      drag.current = { kind: "create", tool: s.tool, frame: frame.id, start: fp, cur: fp };
      force((x) => x + 1);
      return;
    }

    if (frame) {
      const fp = inFrame(frame.id, w);
      const chain = hitTest(frame, fp, tb, 3 / z, hm);
      let scope = s.scope;
      if (scope && !chain.includes(scope)) {
        scope = null;
        useEditor.setState({ scope: null });
      }
      const target = pickFromChain(chain, scope, e.ctrlKey || e.metaKey);
      if (target && !e.shiftKey && !s.selection.includes(target) && bgLike(frame, target)) {
        // Background layer: wait. A drag becomes a selection box inside this frame; a click
        // (no drag) selects the background on pointer up.
        select([]);
        useEditor.setState({ activeFrame: frame.id, scope });
        drag.current = { kind: "marquee", start: w, cur: w, additive: false, base: [], frame: frame.id, click: target };
        return;
      }
      if (target) {
        let sel = s.selection;
        if (e.shiftKey) {
          select([target], "toggle");
          sel = useEditor.getState().selection;
        } else if (!sel.includes(target)) {
          select([target]);
          sel = [target];
        }
        if (!sel.includes(target) || ro) return;
        const ids = topmost(doc, sel).filter((id) => frameOfId(id) === frame.id && !getNode(doc, id)?.locked);
        if (animOn) {
          drag.current = { kind: "anim-move", start: fp, frame: frame.id, ids, moved: false, clicked: e.shiftKey ? undefined : target };
          return;
        }
        drag.current = { kind: "move", start: fp, frame: frame.id, ids, startBox: selAabb(ids), targets: targetsFor(frame.id, ids), moved: false, clicked: e.shiftKey ? undefined : target };
        return;
      }
      if (!e.shiftKey) {
        select([]);
        useEditor.setState({ activeFrame: frame.id, scope: null });
      }
    } else if (!e.shiftKey) select([]);
    drag.current = { kind: "marquee", start: w, cur: w, additive: e.shiftKey, base: e.shiftKey ? s.selection : [] };
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = local(e);
    const w = toWorld(p);
    const d = drag.current;
    if (!d) {
      // Hover outline.
      if (s.tool !== "select" || (e.target as HTMLElement).closest("[data-ui]")) return;
      const frame = frameAt(w);
      const chain = frame ? hitTest(frame, inFrame(frame.id, w), tb, 3 / z, hm) : [];
      const h = pickFromChain(chain, s.scope, e.ctrlKey || e.metaKey) ?? null;
      if (h !== s.hover) useEditor.setState({ hover: h });
      return;
    }
    const snapOn = s.snapping && !(e.ctrlKey || e.metaKey);
    const thr = SNAP_PX / z;
    // Drag commands are built from the committed document, never from the draft they replace
    // (the draft already holds the previous pointer move).
    const base = s.doc!;
    switch (d.kind) {
      case "pan":
        useEditor.setState({ view: { ...s.view, x: d.view.x + p.x - d.sx, y: d.view.y + p.y - d.sy } });
        return;
      case "marquee":
        d.cur = w;
        force((x) => x + 1);
        return;
      case "frame-move": {
        let dx = w.x - d.start.x;
        let dy = w.y - d.start.y;
        if (!d.moved && Math.hypot(dx, dy) * z < 3) return;
        d.moved = true;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        let p = { x: d.origin.x + dx, y: d.origin.y + dy };
        if (snapOn) p = snapFramePosition(base, d.frame, p, thr);
        const cmd = moveFrame(base, d.frame, p.x, p.y);
        if ("error" in cmd) return;
        d.cmd = cmd;
        setDraft(cmd);
        return;
      }
      case "create":
        d.cur = inFrame(d.frame, w);
        force((x) => x + 1);
        return;
      case "text-select": {
        const n = getNode(doc, d.id) as TextNode;
        const q = textPoint(doc, n, inFrame(frameOfId(d.id)!, w), true);
        if (!q || !s.editing) return;
        const idx = indexAtPoint(layoutFor(fonts, n, doc.lang), fullText(s.editing.spans), q, spaceAdvance(fonts, n, doc.lang));
        updateEditing({ sel: [Math.min(d.anchor, idx), Math.max(d.anchor, idx)] });
        return;
      }
      case "move": {
        const fp = inFrame(d.frame, w);
        let dx = fp.x - d.start.x;
        let dy = fp.y - d.start.y;
        if (!d.moved && Math.hypot(dx, dy) * z < 3) return;
        d.moved = true;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        let lines: SnapLine[] = [];
        if (snapOn) {
          const r = snapBox({ ...d.startBox, x: d.startBox.x + dx, y: d.startBox.y + dy }, d.targets, thr);
          dx += e.shiftKey && dx === 0 ? 0 : r.dx;
          dy += e.shiftKey && dy === 0 ? 0 : r.dy;
          lines = r.lines.map((l) => ({ ...l, frame: d.frame }));
        }
        d.cmd = moveNodes(base, d.ids, dx, dy);
        setDraft(d.cmd, lines);
        return;
      }
      case "anim-move": {
        const fp = inFrame(d.frame, w);
        let dx = fp.x - d.start.x;
        let dy = fp.y - d.start.y;
        if (!d.moved && Math.hypot(dx, dy) * z < 3) return;
        d.moved = true;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        d.cmd = { ops: animateMoveOps(base, d.ids, { x: dx, y: dy }, time!, tb) as Op[], label: `animate ${d.ids.join(", ")}: move at ${fmtTime(time!)}` };
        setDraft(d.cmd);
        return;
      }
      case "anim-scale": {
        const fp = inFrame(d.frame, w);
        const first = d.setups[0];
        const f = scaleFactor(d.track, applyPt(first.toRest, fp), first.handle, first.origin);
        const ops = d.setups.flatMap((su) => keyAtTime(base, su.id, d.track, su.sample[d.track] * f, time!));
        d.cmd = { ops: ops as Op[], label: `animate ${d.ids.join(", ")}: ${d.track} at ${fmtTime(time!)}` };
        setDraft(d.cmd);
        return;
      }
      case "anim-rotate": {
        const fp = inFrame(d.frame, w);
        const delta = rotateFromDrag(0, d.center, d.start, fp, e.shiftKey);
        d.cmd = { ops: animateRotateOps(base, d.ids, delta, time!) as Op[], label: `animate ${d.ids.join(", ")}: rotate at ${fmtTime(time!)}` };
        setDraft(d.cmd);
        return;
      }
      case "resize": {
        const fp = inFrame(d.frame, w);
        const opts = { keepAspect: e.shiftKey, fromCenter: e.altKey };
        if (d.single) {
          const { id, box, rotation, pm } = d.single;
          let pp = applyPt(inv(pm), fp);
          let nb = resizeBox(box, rotation, d.handle, pp, opts);
          let lines: SnapLine[] = [];
          if (snapOn && !rotation && isTranslationOnly(pm)) {
            const fb = { x: nb.x + pm[4], y: nb.y + pm[5], w: nb.w, h: nb.h };
            const edges = { x: d.handle.hx === 0.5 ? [] : [d.handle.hx === 0 ? 0 : 1], y: d.handle.hy === 0.5 ? [] : [d.handle.hy === 0 ? 0 : 1] } as { x: Array<0 | 1>; y: Array<0 | 1> };
            const r = snapBox(fb, d.targets, thr, edges);
            if (r.dx || r.dy) {
              pp = { x: pp.x + r.dx, y: pp.y + r.dy };
              nb = resizeBox(box, rotation, d.handle, pp, opts);
            }
            lines = r.lines.map((l) => ({ ...l, frame: d.frame }));
          }
          d.cmd = resizeNode(base, id, nb, tb);
          setDraft(d.cmd, lines);
        } else {
          const nb = resizeBox(d.from, 0, d.handle, fp, opts);
          d.cmd = resizeMany(base, d.ids, d.from, nb, tb);
          setDraft(d.cmd);
        }
        return;
      }
      case "rotate": {
        const fp = inFrame(d.frame, w);
        if (d.ids.length === 1) {
          const rot = rotateFromDrag(d.startRotation, d.center, d.start, fp, e.shiftKey);
          d.cmd = rotateNode(base, d.ids[0], rot);
        } else {
          const delta = rotateFromDrag(0, d.center, d.start, fp, e.shiftKey);
          d.cmd = rotateMany(base, d.ids, delta, d.center, tb);
        }
        setDraft(d.cmd);
        return;
      }
      case "line-end": {
        let fp = inFrame(d.frame, w);
        let lines: SnapLine[] = [];
        if (snapOn) {
          const r = snapPoint(fp, d.targets, thr);
          fp = { x: fp.x + r.dx, y: fp.y + r.dy };
          lines = r.lines.map((l) => ({ ...l, frame: d.frame }));
        }
        let q = applyPt(inv(d.m), fp);
        if (e.shiftKey) {
          // 45° steps.
          const ang = Math.atan2(q.y - d.other.y, q.x - d.other.x);
          const len = Math.hypot(q.x - d.other.x, q.y - d.other.y);
          const a = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
          q = { x: d.other.x + Math.cos(a) * len, y: d.other.y + Math.sin(a) * len };
        }
        d.cmd = d.end === 1 ? setLineEnds(base, d.id, q, d.other) : setLineEnds(base, d.id, d.other, q);
        setDraft(d.cmd, lines);
        return;
      }
    }
  };

  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    try {
      ref.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!d) return;
    switch (d.kind) {
      case "move":
        if (!d.moved) {
          if (d.clicked && s.selection.length > 1 && !e.shiftKey) select([d.clicked]);
          setDraft(null);
          return;
        }
        if (d.cmd) commit(d.cmd);
        return;
      case "anim-move":
        if (!d.moved) {
          if (d.clicked && s.selection.length > 1 && !e.shiftKey) select([d.clicked]);
          setDraft(null);
          return;
        }
        if (d.cmd) commit(d.cmd);
        else setDraft(null);
        return;
      case "anim-scale":
      case "anim-rotate":
      case "resize":
      case "rotate":
      case "line-end":
        if (d.cmd) commit(d.cmd);
        else setDraft(null);
        return;
      case "frame-move":
        if (d.moved && d.cmd) commit(d.cmd);
        else setDraft(null);
        return;
      case "marquee": {
        const r = { x: Math.min(d.start.x, d.cur.x), y: Math.min(d.start.y, d.cur.y), w: Math.abs(d.cur.x - d.start.x), h: Math.abs(d.cur.y - d.start.y) };
        if (r.w * z < 3 && r.h * z < 3) {
          if (d.click) select([d.click]);
          return force((x) => x + 1);
        }
        const hits: string[] = [];
        for (const f of doc.frames) {
          if (d.frame && f.id !== d.frame) continue;
          const o = offs.get(f.id)!;
          const fr = { x: r.x - o.x, y: r.y - o.y, w: r.w, h: r.h };
          const scopeNode = s.scope ? getNode(doc, s.scope) : undefined;
          const pool = scopeNode?.type === "group" && frameOfId(scopeNode.id) === f.id ? scopeNode.children : f.children;
          for (const n of pool) {
            if (n.visible === false || n.locked) continue;
            if (hm?.hidden(n)) continue;
            const b = aabb(cornersOf(n));
            // Started on the background: a layer the box lies completely inside is what he is
            // drawing on (the background, a big panel), not something he is drawing around.
            // (The part of the box outside the frame does not count.)
            if (d.frame) {
              const cx0 = Math.max(fr.x, 0);
              const cy0 = Math.max(fr.y, 0);
              const cx1 = Math.min(fr.x + fr.w, f.w);
              const cy1 = Math.min(fr.y + fr.h, f.h);
              if (b.x <= cx0 && b.y <= cy0 && b.x + b.w >= cx1 && b.y + b.h >= cy1) continue;
            }
            if (b.x <= fr.x + fr.w && fr.x <= b.x + b.w && b.y <= fr.y + fr.h && fr.y <= b.y + b.h) hits.push(n.id);
          }
        }
        select(d.additive ? [...new Set([...d.base, ...hits])] : hits);
        force((x) => x + 1);
        return;
      }
      case "create":
        createFromDrag(d, e.shiftKey);
        force((x) => x + 1);
        return;
      default:
        return;
    }
  };

  const createFromDrag = (d: Extract<Drag, { kind: "create" }>, shift: boolean) => {
    const frame = doc.frames.find((f) => f.id === d.frame)!;
    let w = d.cur.x - d.start.x;
    let h = d.cur.y - d.start.y;
    const dragged = Math.hypot(w, h) * z > 4;
    if (shift && d.tool !== "line") {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * m;
      h = Math.sign(h || 1) * m;
    }
    const x = Math.min(d.start.x, d.start.x + w);
    const y = Math.min(d.start.y, d.start.y + h);
    const r = (n: number) => Math.round(n * 100) / 100;
    let node: Node;
    if (d.tool === "text") {
      node = {
        id: newId(doc, "text"),
        type: "text",
        name: "Text",
        x: r(d.start.x),
        y: r(d.start.y),
        w: dragged ? r(Math.abs(w)) : 0,
        h: 0,
        box: dragged ? "fixed-width" : "auto-width",
        align: "left",
        style: { font: "IBM Plex Sans", weight: 600, size: 48, lineHeight: 1.2, fill: "#190F0B" },
        spans: [{ text: "" }],
      };
    } else if (d.tool === "line") {
      node = { id: newId(doc, "line"), type: "line", name: "Line", x: r(d.start.x), y: r(d.start.y), w: dragged ? r(w) : 200, h: dragged ? r(h) : 0, stroke: { color: "#190F0B", width: 4 } };
    } else {
      const size = dragged ? { w: r(Math.abs(w)), h: r(Math.abs(h)) } : { w: 200, h: 200 };
      const pos = dragged ? { x: r(x), y: r(y) } : { x: r(d.start.x - 100), y: r(d.start.y - 100) };
      node =
        d.tool === "rect"
          ? { id: newId(doc, "rect"), type: "rect", name: "Rectangle", ...pos, ...size, fill: "#E8E2D8" }
          : { id: newId(doc, "ellipse"), type: "ellipse", name: "Ellipse", ...pos, ...size, fill: "#AC1922" };
    }
    const parent = s.scope && frameOfId(s.scope) === frame.id ? s.scope : frame.id;
    if (parent !== frame.id) {
      const g = getNode(doc, parent)!;
      const local = applyPt(inv(mul(parentMatrix(doc, parent), translate(g.x, g.y))), { x: node.x, y: node.y });
      node.x = r(local.x);
      node.y = r(local.y);
    }
    if (commit(insertNode(doc, parent, node), { select: [node.id] })) {
      useEditor.setState({ tool: "select" });
      if (node.type === "text") startEditing(node.id, { created: true });
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-ui]") || ro) return;
    const w = toWorld(local(e));
    const frame = frameAt(w);
    if (!frame) return;
    const fp = inFrame(frame.id, w);
    if (s.editing) {
      const n = getNode(doc, s.editing.id) as TextNode;
      const q = textPoint(doc, n, fp);
      if (q) {
        const text = fullText(s.editing.spans);
        const idx = indexAtPoint(layoutFor(fonts, n, doc.lang), text, q, spaceAdvance(fonts, n, doc.lang));
        updateEditing({ sel: wordAt(text, idx) });
      }
      return;
    }
    const chain = hitTest(frame, fp, tb, 3 / z, hm);
    const target = pickFromChain(chain, s.scope, e.ctrlKey || e.metaKey);
    if (!target) return;
    const n = getNode(doc, target)!;
    if (n.type === "text") {
      const q = textPoint(doc, n, fp);
      const idx = q ? indexAtPoint(layoutFor(fonts, n, doc.lang), fullText(n.spans), q, spaceAdvance(fonts, n, doc.lang)) : undefined;
      startEditing(n.id, { at: idx });
      if (idx !== undefined) {
        const text = fullText(n.spans);
        updateEditing({ sel: wordAt(text, idx) });
      }
    } else if (n.type === "group") {
      const i = chain.indexOf(n.id);
      useEditor.setState({ scope: n.id });
      if (chain[i + 1]) select([chain[i + 1]]);
    }
  };

  /** Point in a text node's box coordinates, or undefined when outside (unless `clamp`). */
  function textPoint(d0: Document, n: TextNode, fp: Pt, clamp = false): Pt | undefined {
    const m = time === undefined ? nodeMatrix(d0, n, tb) : nodeMatrixAt(d0, n, time, tb);
    const q = applyPt(inv(m), fp);
    const b = nodeBox(n, tb);
    const p = { x: q.x - b.x, y: q.y - b.y };
    const pad = 4 / z;
    if (!clamp && (p.x < -pad || p.y < -pad || p.x > b.w + pad || p.y > b.h + pad)) return undefined;
    return p;
  }

  // ---- handle drags (start from the overlay)
  const startResize = (e: RPointerEvent, handle: Handle) => {
    e.stopPropagation();
    if (ro) return;
    ref.current!.setPointerCapture(e.pointerId);
    const ids = topmost(doc, s.selection).filter((id) => !getNode(doc, id)?.locked);
    if (!ids.length) return;
    const frame = frameOfId(ids[0])!;
    if (animOn) {
      const track = scaleTrackFor(handle.hx, handle.hy);
      drag.current = { kind: "anim-scale", frame, ids, track, setups: ids.map((id) => ({ id, ...scaleSetup(doc, getNode(doc, id)!, time!, tb, handle.hx, handle.hy) })) };
      return;
    }
    if (ids.length === 1) {
      const n = getNode(doc, ids[0])!;
      drag.current = { kind: "resize", frame, ids, handle, single: { id: n.id, box: nodeBox(n, tb), rotation: n.rotation ?? 0, pm: parentMatrix(doc, n.id) }, from: selAabb(ids), targets: targetsFor(frame, ids) };
    } else {
      drag.current = { kind: "resize", frame, ids, handle, from: selAabb(ids), targets: targetsFor(frame, ids) };
    }
  };

  const startRotate = (e: RPointerEvent) => {
    e.stopPropagation();
    if (ro) return;
    ref.current!.setPointerCapture(e.pointerId);
    const ids = topmost(doc, s.selection);
    const frame = frameOfId(ids[0])!;
    const w = toWorld(local(e));
    let center: Pt;
    if (ids.length === 1) {
      const cs = cornersOf(getNode(doc, ids[0])!);
      center = { x: (cs[0].x + cs[2].x) / 2, y: (cs[0].y + cs[2].y) / 2 };
    } else {
      const b = animOn ? aabb(ids.flatMap((id) => cornersOf(getNode(doc, id)!))) : selAabb(ids);
      center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    }
    if (animOn) {
      drag.current = { kind: "anim-rotate", frame, ids, center, start: inFrame(frame, w) };
      return;
    }
    drag.current = { kind: "rotate", frame, ids, center, start: inFrame(frame, w), startRotation: getNode(doc, ids[0])?.rotation ?? 0 };
  };

  const startLineEnd = (e: RPointerEvent, n: Extract<Node, { type: "line" }>, end: 1 | 2) => {
    e.stopPropagation();
    if (ro) return;
    ref.current!.setPointerCapture(e.pointerId);
    const frame = frameOfId(n.id)!;
    const m = mul(parentMatrix(doc, n.id), ownMatrix(n, tb));
    const other = end === 1 ? { x: n.x + n.w, y: n.y + n.h } : { x: n.x, y: n.y };
    drag.current = { kind: "line-end", frame, id: n.id, end, m, other, targets: targetsFor(frame, [n.id]) };
  };

  // ---------------------------------------------------------------- overlay
  const world = `translate(${s.view.x} ${s.view.y}) scale(${z})`;
  const sel = s.selection.map((id) => getNode(doc, id)).filter((n): n is Node => !!n);
  const polygon = (frame: string, pts: Pt[]) => pts.map((p) => { const q = scr(frame, p); return `${q.x},${q.y}`; }).join(" ");

  const overlay: React.ReactNode[] = [];
  // Guides
  if (s.showGuides) {
    for (const f of doc.frames) {
      const g = guidesFor(f);
      if (!g) continue;
      const o = offs.get(f.id)!;
      overlay.push(
        <g key={`guides-${f.id}`} className="guides" transform={`${world} translate(${o.x} ${o.y})`}>
          {g.zones.map((zn, i) => (
            <rect key={i} x={zn.x} y={zn.y} width={zn.w} height={zn.h} className={`guide-zone guide-${zn.kind}`} vectorEffect="non-scaling-stroke" />
          ))}
          {g.lines.map((l, i) =>
            l.axis === "x" ? (
              <line key={`l${i}`} x1={l.value} y1={0} x2={l.value} y2={f.h} className={`guide-line${l.dashed ? " dashed" : ""}`} vectorEffect="non-scaling-stroke" />
            ) : (
              <line key={`l${i}`} x1={0} y1={l.value} x2={f.w} y2={l.value} className={`guide-line${l.dashed ? " dashed" : ""}`} vectorEffect="non-scaling-stroke" />
            ),
          )}
        </g>,
      );
    }
  }
  // Agent changes
  if (s.agentChanges) {
    for (const c of s.agentChanges.items) {
      const n = c.kind !== "deleted" ? getNode(doc, c.id) : undefined;
      if (!n) continue;
      const f = frameOfId(n.id)!;
      overlay.push(<polygon key={`agent-${c.id}`} className="agent-change" points={polygon(f, cornersOf(n))} />);
    }
  }
  // Hover
  if (s.hover && !s.selection.includes(s.hover) && !drag.current) {
    const n = getNode(doc, s.hover);
    if (n) overlay.push(<polygon key="hover" className="hover" points={polygon(frameOfId(n.id)!, cornersOf(n))} />);
  }
  // Scope (entered group)
  if (s.scope) {
    const g = getNode(doc, s.scope);
    if (g) overlay.push(<polygon key="scope" className="scope" points={polygon(frameOfId(g.id)!, cornersOf(g))} />);
  }
  // Selection outlines
  // A thin ghost where the layer rests (its layout) when the playhead draws it elsewhere.
  for (const n of sel) if (movedAt(doc, n, time, tb)) overlay.push(<polygon key={`ghost-${n.id}`} className="rest-ghost" data-testid={`ghost-${n.id}`} points={polygon(frameOfId(n.id)!, nodeCorners(doc, n, tb))} />);
  for (const n of sel) overlay.push(<polygon key={`sel-${n.id}`} className="selection" points={polygon(frameOfId(n.id)!, cornersOf(n))} />);
  // Handles
  const showHandles = sel.length > 0 && !s.editing && !ro && !(drag.current && (drag.current.kind === "move" || drag.current.kind === "anim-move"));
  if (showHandles) {
    const frame = frameOfId(sel[0].id)!;
    const sameFrame = sel.every((n) => frameOfId(n.id) === frame);
    if (sel.length === 1 && sel[0].type === "line" && !animOn) {
      const n = sel[0];
      const m = mul(parentMatrix(doc, n.id), ownMatrix(n, tb));
      const ends = [applyPt(m, { x: n.x, y: n.y }), applyPt(m, { x: n.x + n.w, y: n.y + n.h })];
      ends.forEach((p, i) => {
        const q = scr(frame, p);
        overlay.push(<circle key={`end${i}`} data-ui="handle" className="handle" cx={q.x} cy={q.y} r={5} onPointerDown={(e) => startLineEnd(e, n, (i + 1) as 1 | 2)} />);
      });
    } else if (sameFrame) {
      // Animate off: the handles edit the layout, so they sit on the rest pose. Animate on: they
      // drive the motion at the playhead, so they sit where the layer is drawn.
      let cs: Pt[];
      if (sel.length === 1) cs = animOn ? cornersOf(sel[0]) : nodeCorners(doc, sel[0], tb);
      else {
        const b = animOn ? aabb(sel.flatMap((n) => cornersOf(n))) : selAabb(sel.map((n) => n.id));
        cs = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }];
        overlay.push(<polygon key="selbox" className="selection-box" points={polygon(frame, cs)} />);
      }
      const at = (hx: number, hy: number): Pt => {
        const top = { x: cs[0].x + (cs[1].x - cs[0].x) * hx, y: cs[0].y + (cs[1].y - cs[0].y) * hx };
        const bot = { x: cs[3].x + (cs[2].x - cs[3].x) * hx, y: cs[3].y + (cs[2].y - cs[3].y) * hx };
        return { x: top.x + (bot.x - top.x) * hy, y: top.y + (bot.y - top.y) * hy };
      };
      for (const h of HANDLES) {
        const q = scr(frame, at(h.hx, h.hy));
        overlay.push(
          <rect key={h.name} data-ui="handle" data-handle={h.name} className="handle" x={q.x - 4.5} y={q.y - 4.5} width={9} height={9} style={{ cursor: h.cursor }} onPointerDown={(e) => startResize(e, h)} />,
        );
      }
      // Rotate handle: 28 px outside the top edge, along the box's own "up".
      const topMid = scr(frame, at(0.5, 0));
      const mid = scr(frame, at(0.5, 0.5));
      const len = Math.hypot(topMid.x - mid.x, topMid.y - mid.y) || 1;
      const ux = (topMid.x - mid.x) / len;
      const uy = (topMid.y - mid.y) / len;
      const rh = { x: topMid.x + ux * 28, y: topMid.y + uy * 28 };
      overlay.push(<line key="rot-stem" className="rotate-stem" x1={topMid.x} y1={topMid.y} x2={rh.x} y2={rh.y} />);
      overlay.push(<circle key="rot" data-ui="handle" data-handle="rotate" className="handle rotate" cx={rh.x} cy={rh.y} r={6} onPointerDown={startRotate} />);
    }
  }
  // Snap lines
  for (const [i, l] of s.snapLines.entries()) {
    const frame = doc.frames.find((x) => x.id === l.frame) ?? doc.frames[0];
    const a = l.axis === "x" ? scr(frame.id, { x: l.value, y: 0 }) : scr(frame.id, { x: 0, y: l.value });
    const b = l.axis === "x" ? scr(frame.id, { x: l.value, y: frame.h }) : scr(frame.id, { x: frame.w, y: l.value });
    overlay.push(<line key={`snap${i}`} className={`snap-line snap-${l.kind}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />);
  }
  // Marquee / create preview
  const d = drag.current;
  if (d?.kind === "marquee") {
    const a = { x: s.view.x + d.start.x * z, y: s.view.y + d.start.y * z };
    const b = { x: s.view.x + d.cur.x * z, y: s.view.y + d.cur.y * z };
    overlay.push(<rect key="marquee" className="marquee" x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} />);
  }
  if (d?.kind === "create") {
    const a = scr(d.frame, d.start);
    const b = scr(d.frame, d.cur);
    overlay.push(
      d.tool === "line" ? (
        <line key="create" className="create-preview" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
      ) : d.tool === "ellipse" ? (
        <ellipse key="create" className="create-preview" cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} rx={Math.abs(b.x - a.x) / 2} ry={Math.abs(b.y - a.y) / 2} />
      ) : (
        <rect key="create" className="create-preview" x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} />
      ),
    );
  }
  // Text editing: selection + caret
  let caretScreen: Pt | undefined;
  let editBoxTop: Pt | undefined;
  if (s.editing) {
    const n = getNode(doc, s.editing.id) as TextNode | undefined;
    if (n) {
      const f = frameOfId(n.id)!;
      const b = nodeBox(n, tb);
      const m: Mat = mul(translate(offs.get(f)!.x, offs.get(f)!.y), mul(time === undefined ? nodeMatrix(doc, n, tb) : nodeMatrixAt(doc, n, time, tb), translate(b.x, b.y)));
      const L = layoutFor(fonts, n, doc.lang);
      const text = fullText(s.editing.spans);
      const sp = spaceAdvance(fonts, n, doc.lang);
      const [a, bb] = s.editing.sel;
      const rects = selectionRects(L, text, a, bb, sp);
      const c = caretRect(L, text, bb === a ? a : bb, sp);
      const t = `${world} matrix(${m.join(" ")})`;
      overlay.push(
        <g key="text-edit" transform={t} className="text-edit">
          <rect x={0} y={0} width={Math.max(b.w, 1)} height={Math.max(b.h, L.lineHeight)} className="text-edit-box" vectorEffect="non-scaling-stroke" />
          {rects.map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} className="text-selection" />
          ))}
          {a === bb ? <line x1={c.x} y1={c.top} x2={c.x} y2={c.bottom} className="caret" vectorEffect="non-scaling-stroke" /> : null}
        </g>,
      );
      const sc = applyPt(mul([z, 0, 0, z, s.view.x, s.view.y], m), { x: c.x, y: c.bottom });
      caretScreen = sc;
      editBoxTop = applyPt(mul([z, 0, 0, z, s.view.x, s.view.y], m), { x: 0, y: 0 });
    }
  }

  const cursor = s.spaceDown || s.tool === "hand" ? (drag.current?.kind === "pan" ? "grabbing" : "grab") : s.tool === "select" ? "default" : s.tool === "text" ? "text" : "crosshair";

  return (
    <div
      className={`canvas${animOn ? " animating" : ""}`}
      ref={ref}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      onPointerLeave={() => s.hover && useEditor.setState({ hover: null })}
      data-testid="canvas"
    >
      <svg className="stage" width={size.w} height={size.h}>
        <g transform={world}>
          {doc.frames.map((f) => (
            <FrameView key={f.id} frame={f} x={offs.get(f.id)!.x} y={offs.get(f.id)!.y} renderer={renderer} salt={`${doc.lang}|${s.assetsVersion}`} tc={tc} />
          ))}
        </g>
      </svg>
      <svg className="overlay" width={size.w} height={size.h}>
        {overlay}
      </svg>
      {doc.frames.map((f) => {
        const p = scr(f.id, { x: 0, y: 0 });
        return (
          <div
            key={f.id}
            data-ui="frame-label"
            className={`frame-label${s.activeFrame === f.id && !s.selection.length ? " active" : ""}${ro ? "" : " draggable"}`}
            data-testid={`frame-label-${f.id}`}
            title={ro ? undefined : "Drag to move this frame on the canvas"}
            style={{ left: p.x, top: p.y - 22 }}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (s.editing) finishEditing();
              select([]);
              useEditor.setState({ activeFrame: f.id, scope: null });
              // Drag the name label to move the frame (Figma-style). Read-only: just select.
              if (e.button !== 0 || ro || s.tool === "hand" || s.spaceDown) return;
              ref.current!.setPointerCapture(e.pointerId);
              drag.current = { kind: "frame-move", frame: f.id, start: toWorld(local(e)), origin: (s.doc ? frameOffsets(s.doc) : offs).get(f.id)!, moved: false };
            }}
          >
            {f.name} <span>{f.w}×{f.h}</span>
          </div>
        );
      })}
      {s.editing && caretScreen ? <TextInput caret={caretScreen} boxTop={editBoxTop!} /> : null}
    </div>
  );
}
