// Full-screen zoom for one frame on the phone: pinch to zoom, drag to pan, double-tap toggles
// 1× / 2.5×. The maths is in model/phone.ts (zoomAbout, pinchStep, clampPan).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Document } from "@post-studio/schema";
import type { NodeRenderer } from "@post-studio/render";
import { clampPan, pinchStep, zoomAbout, type ZoomState } from "../../model/phone.ts";
import { FrameView, type TimeContext } from "../FrameView.tsx";
import { Icon } from "../Icons.tsx";

type Pt = { x: number; y: number };

export function ZoomViewer(props: {
  doc: Document;
  renderer: NodeRenderer;
  salt: string;
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Motion: the moment to draw, and the play / scrub controls under the frame. */
  tc?: TimeContext;
  transport?: ReactNode;
}) {
  const { doc, renderer, salt, index } = props;
  const frame = doc.frames[index] ?? doc.frames[0];
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: 360, h: 640 });
  const [z, setZ] = useState<ZoomState>({ k: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, Pt>());
  const lastTap = useRef<{ t: number; p: Pt } | null>(null);
  const moved = useRef(false);

  useLayoutEffect(() => {
    const measure = () => {
      const r = box.current?.getBoundingClientRect();
      if (r) setView({ w: r.width, h: r.height });
    };
    measure();
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, []);
  useEffect(() => setZ({ k: 1, x: 0, y: 0 }), [index]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [props.onClose]);

  // The frame at k = 1: as large as fits, centred.
  const fit = Math.min(view.w / frame.w, view.h / frame.h);
  const cw = frame.w * fit;
  const ch = frame.h * fit;
  const clamp = (s: ZoomState) => clampPan(s, cw, ch, view.w, view.h);
  const local = (e: React.PointerEvent): Pt => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const down = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    moved.current = false;
  };
  const move = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > 2) moved.current = true;
    if (pointers.current.size === 2) {
      const [ida, idb] = [...pointers.current.keys()];
      const other = e.pointerId === ida ? idb : ida;
      const o = pointers.current.get(other)!;
      setZ((s) => clamp(pinchStep(s, prev, o, p, o)));
    } else if (pointers.current.size === 1) {
      setZ((s) => clamp({ ...s, x: s.x + p.x - prev.x, y: s.y + p.y - prev.y }));
    }
    pointers.current.set(e.pointerId, p);
  };
  const up = (e: React.PointerEvent) => {
    const p = local(e);
    pointers.current.delete(e.pointerId);
    if (moved.current || pointers.current.size) return;
    const now = Date.now();
    const l = lastTap.current;
    if (l && now - l.t < 320 && Math.hypot(p.x - l.p.x, p.y - l.p.y) < 30) {
      lastTap.current = null;
      setZ((s) => clamp(s.k > 1.05 ? { k: 1, x: 0, y: 0 } : zoomAbout(s, 2.5, p.x, p.y)));
    } else lastTap.current = { t: now, p };
  };
  const wheel = (e: React.WheelEvent) => {
    const r = box.current!.getBoundingClientRect();
    setZ((s) => clamp(zoomAbout(s, Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top)));
  };

  const many = doc.frames.length > 1;
  return (
    <div className="ph-zoom" data-testid="zoom-viewer" role="dialog" aria-label={`${frame.name} zoomed`}>
      <div className="ph-zoom-bar">
        <span className="ph-zoom-name">
          {frame.name} {many ? <span className="ph-dim">{index + 1}/{doc.frames.length}</span> : null}
        </span>
        <span className="ph-dim" data-testid="zoom-level">{Math.round(z.k * 100)} %</span>
        <button className="ph-btn icon" aria-label="Close" data-testid="zoom-close" onClick={props.onClose}>
          <Icon name="close" size={20} />
        </button>
      </div>
      <div className="ph-zoom-stage" ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}>
        <div className="ph-zoom-layer" style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.k})` }}>
          <svg className="ph-zoom-frame" style={{ left: (view.w - cw) / 2, top: (view.h - ch) / 2 }} width={cw} height={ch} viewBox={`0 0 ${frame.w} ${frame.h}`}>
            <FrameView frame={frame} x={0} y={0} renderer={renderer} salt={salt} tc={props.tc} />
          </svg>
        </div>
      </div>
      {props.transport ? <div className="ph-zoom-transport">{props.transport}</div> : null}
      <div className="ph-zoom-foot">
        {many ? (
          <button className="ph-btn" disabled={index === 0} onClick={() => props.onIndex(index - 1)}>
            ‹ Previous
          </button>
        ) : null}
        <span className="ph-dim grow center">Pinch or double-tap to zoom</span>
        {many ? (
          <button className="ph-btn" disabled={index === doc.frames.length - 1} onClick={() => props.onIndex(index + 1)}>
            Next ›
          </button>
        ) : null}
      </div>
    </div>
  );
}
