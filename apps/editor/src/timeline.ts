// Playhead, playback and timeline UI state (PLAN-motion.md §6.1). Kept apart from the document
// store on purpose: playing and scrubbing change only this store, never the document, so they
// can never write a revision, an undo step or an autosave.
import { create } from "zustand";
import type { TrackName } from "@post-studio/schema";
import { frameCount, frameTime, fpsOf, posterTime } from "@post-studio/motion";
import { useEditor } from "./store.ts";

export interface KeyRef {
  node: string;
  track: TrackName;
  key: string;
}

export const keyId = (k: KeyRef) => `${k.node}/${k.track}/${k.key}`;

export interface TimeState {
  /** Playhead, ms. Always a frame time except while a free scrub is under way. */
  t: number;
  playing: boolean;
  /** Timeline strip expanded (false = only its header). */
  open: boolean;
  height: number;
  /** Animate (record) mode: canvas edits write keyframes at the playhead. */
  animate: boolean;
  expanded: Record<string, boolean>;
  selectedKeys: KeyRef[];
  popover: KeyRef | null;
}

const initial: TimeState = { t: 0, playing: false, open: true, height: 220, animate: false, expanded: {}, selectedKeys: [], popover: null };

export const useTime = create<TimeState>(() => ({ ...initial }));

/** Paint counter for the playback measurement (FrameView bumps it after each commit). */
export const perf: { paints: Record<string, number>; lastPaint: number } = { paints: {}, lastPaint: 0 };

let raf = 0;

const motionOf = () => useEditor.getState().doc?.motion;

/** Fresh state for a newly opened project: the playhead on the poster moment (or 0). */
export function resetTime() {
  stop();
  const m = motionOf();
  useTime.setState({ ...initial, t: (m && posterTime(m)) ?? 0, open: useTime.getState().open, height: useTime.getState().height });
}

/** Snap a time to a frame of the current motion and keep it inside one pass. */
export function clampTime(t: number): number {
  const m = motionOf();
  if (!m) return 0;
  const fps = fpsOf(m);
  const last = frameTime(Math.max(0, frameCount(m) - 1), fps);
  const i = Math.round((Math.max(0, t) * fps) / 1000);
  return Math.min(last, frameTime(i, fps));
}

export function seek(t: number) {
  useTime.setState({ t: clampTime(t) });
}

/** Step whole frames (negative = back). */
export function stepFrames(n: number) {
  const m = motionOf();
  if (!m) return;
  stop();
  const fps = fpsOf(m);
  const i = Math.round((useTime.getState().t * fps) / 1000) + n;
  const count = frameCount(m);
  seek(frameTime(Math.max(0, Math.min(count - 1, i)), fps));
}

export function play() {
  const m = motionOf();
  if (!m || useTime.getState().playing) return;
  const fps = fpsOf(m);
  const count = frameCount(m);
  let startFrame = Math.round((useTime.getState().t * fps) / 1000);
  if (startFrame >= count - 1 && !m.loop) startFrame = 0;
  const t0 = performance.now();
  useTime.setState({ playing: true, popover: null });
  const tick = (now: number) => {
    const mm = motionOf();
    if (!mm || !useTime.getState().playing) return stop();
    const f = fpsOf(mm);
    const n = frameCount(mm);
    let i = startFrame + Math.floor(((now - t0) * f) / 1000);
    if (i >= n) {
      if (mm.loop) i %= n;
      else {
        useTime.setState({ t: frameTime(n - 1, f) });
        return stop();
      }
    }
    const t = frameTime(i, f);
    // Only a new frame re-renders: preview frames are exactly the export's frame times.
    if (t !== useTime.getState().t) useTime.setState({ t });
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

export function stop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (useTime.getState().playing) useTime.setState({ playing: false });
}

export const togglePlay = () => (useTime.getState().playing ? stop() : play());

/** The playhead to draw the canvas at: undefined for a still post. */
export function canvasTime(doc: { motion?: unknown } | null | undefined, t: number): number | undefined {
  return doc?.motion ? t : undefined;
}
