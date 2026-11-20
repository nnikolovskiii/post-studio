// The timeline strip under the canvas (PLAN-motion.md §6.1): transport, ruler with a draggable
// playhead, one row per animated layer (plus the selected ones) with a bar from its first to
// its last keyframe, expandable track rows with keyframe diamonds, drag to retime (snapping),
// Shift-click to select several, drag a bar to shift, Alt-drag its end to stretch, a keyframe
// popover (time, value, ease, pin, delete), the Animate (record) toggle and presets.
//
// Every edit is an ordinary op batch through the store's commit (one revision, undo / redo,
// autosave, soft pins). Playing and scrubbing only touch the time store: they never write.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { EASES, FPS_VALUES, MOTION_LIMITS, findItem, type Document, type EaseName, type Node, type TrackName } from "@post-studio/schema";
import type { Op } from "@post-studio/ops";
import {
  EASE_FUNCTIONS,
  PRESETS,
  deleteKeyframe,
  editKeyframe,
  fpsOf,
  moveKeyframe,
  presetOps,
  readingOrder,
  removeMotion,
  shiftKeyframes,
  sortedKeyframes,
  stretchKeyframes,
  type MotionOp,
} from "@post-studio/motion";
import { getNode, setProps } from "../model/commands.ts";
import { TRACK_LABELS, cleanValue, fmtTime, keyframeChanged, keyframePin, snapTime, timelineRows, trackUnit, type TimelineRow } from "../model/motion.ts";
import { commit, readOnlyReason, select, setDraft, toast, useEditor, visibleDoc } from "../store.ts";
import { keyId, seek, stepFrames, stop, togglePlay, useTime, type KeyRef } from "../timeline.ts";
import { Icon } from "./Icons.tsx";

const LABEL_W = 190;
const SNAP_PX = 6;

const run = (ops: MotionOp[] | Op[], label: string) => commit({ ops: ops as Op[], label });

function tryOps(make: () => MotionOp[]): MotionOp[] | undefined {
  try {
    return make();
  } catch (e) {
    toast((e as Error).message, "error");
    return undefined;
  }
}

/** A tiny picture of an ease curve (the menu in the keyframe popover). */
export function EaseCurve({ ease, size = 26 }: { ease: EaseName; size?: number }) {
  const h = Math.round(size * 0.7);
  const pts: string[] = [];
  for (let i = 0; i <= 24; i++) {
    const p = i / 24;
    const v = EASE_FUNCTIONS[ease](p);
    pts.push(`${(p * size).toFixed(1)},${(h - 2 - v * (h - 6)).toFixed(1)}`);
  }
  return (
    <svg width={size} height={h} className="ease-curve" aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

// ---------------------------------------------------------------- presets

/** "+ Add animation": a preset on the selected layers at the playhead, staggered when several. */
export function AddAnimationMenu({ testid = "tl-add", label = "+ Add animation", down = false }: { testid?: string; label?: string; down?: boolean }) {
  const [open, setOpen] = useState(false);
  const [dur, setDur] = useState("0.6");
  const [stagger, setStagger] = useState("0.08");
  const selection = useEditor((s) => s.selection);
  const ro = useEditor((s) => !!readOnlyReason(s));
  const apply = (preset: string) => {
    const s = useEditor.getState();
    const doc = s.doc;
    if (!doc || !s.selection.length) return toast("Select one or more layers first", "error");
    const ids = s.selection.filter((id) => getNode(doc, id));
    const order = ids.length > 1 ? readingOrder(doc, ids) : ids;
    const d = Math.round(Number(dur.replace(",", ".")) * 1000);
    const st = ids.length > 1 ? Math.round(Number(stagger.replace(",", ".")) * 1000) : 0;
    const at = useTime.getState().t;
    const ops = tryOps(() => presetOps(doc, order, preset, { at, dur: d > 0 ? d : 600, stagger: st > 0 ? st : 0 }));
    if (!ops) return;
    const p = PRESETS.find((x) => x.id === preset)!;
    if (run(ops, `animation “${p.label}” on ${order.join(", ")} at ${fmtTime(at)}${st && ids.length > 1 ? `, stagger ${fmtTime(st)}` : ""}`)) {
      setOpen(false);
      useTime.setState((ts) => ({ open: true, expanded: { ...ts.expanded } }));
    }
  };
  return (
    <div className="menu">
      <button data-testid={testid} disabled={ro || !selection.length} title={selection.length ? "Put a preset on the selected layers, starting at the playhead" : "Select layers first"} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open ? (
        <div className={`menu-list presets${down ? "" : " up"}`} data-testid={`${testid}-menu`}>
          <div className="row">
            <label className="field mini-field">
              <span>Length s</span>
              <input type="text" data-testid="preset-dur" value={dur} onChange={(e) => setDur(e.target.value)} />
            </label>
            {selection.length > 1 ? (
              <label className="field mini-field" title="Each next layer (in reading order) starts this much later">
                <span>Stagger s</span>
                <input type="text" data-testid="preset-stagger" value={stagger} onChange={(e) => setStagger(e.target.value)} />
              </label>
            ) : null}
          </div>
          {PRESETS.map((p) => (
            <button key={p.id} className="menu-item" data-testid={`preset-${p.id}`} onClick={() => apply(p.id)}>
              <EaseCurve ease={p.ease} size={22} /> {p.label}
            </button>
          ))}
          <p className="hint">Writes ordinary keyframes at the playhead; drag them afterwards.</p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- small pieces that follow the playhead

function Readout({ duration }: { duration: number }) {
  const t = useTime((x) => x.t);
  const fps = useEditor((s) => fpsOf(s.doc?.motion));
  return (
    <span className="tl-readout" data-testid="tl-time" data-t={t}>
      {fmtTime(t)} / {fmtTime(duration)} <span className="dim">· frame {Math.round((t * fps) / 1000)}</span>
    </span>
  );
}

function Playhead({ width, duration }: { width: number; duration: number }) {
  const t = useTime((x) => x.t);
  const x = LABEL_W + (Math.min(t, duration) / duration) * width;
  return <div className="tl-playhead" data-testid="tl-playhead" style={{ left: x }} />;
}

function PlayButton() {
  const playing = useTime((x) => x.playing);
  return (
    <button data-testid="tl-play" title="Play / pause (K)" onClick={togglePlay}>
      <Icon name={playing ? "pause" : "play"} />
    </button>
  );
}

// ---------------------------------------------------------------- the strip

type Drag =
  | { kind: "scrub" }
  | { kind: "keys"; x0: number; grabbed: KeyRef; keys: KeyRef[]; orig: Map<string, number>; moved: boolean; cmd?: { ops: Op[]; label: string } }
  | { kind: "bar"; x0: number; node: string; range: [number, number]; stretch?: { anchor: number; end: number }; moved: boolean; cmd?: { ops: Op[]; label: string } }
  | { kind: "resize"; y0: number; h0: number };

export function Timeline() {
  const doc = useEditor((s) => visibleDoc(s));
  const base = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const pins = useEditor((s) => s.pins);
  const preview = useEditor((s) => !!s.preview);
  const agentChanges = useEditor((s) => s.agentChanges);
  const ro = useEditor((s) => !!readOnlyReason(s));
  const open = useTime((x) => x.open);
  const height = useTime((x) => x.height);
  const animate = useTime((x) => x.animate);
  const expanded = useTime((x) => x.expanded);
  const selectedKeys = useTime((x) => x.selectedKeys);
  const popover = useTime((x) => x.popover);
  const lane = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [width, setWidth] = useState(600);
  const [more, setMore] = useState(false);

  useLayoutEffect(() => {
    const el = lane.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setWidth(Math.max(100, el.getBoundingClientRect().width)));
    obs.observe(el);
    return () => obs.disconnect();
  }, [open, !!doc?.motion]);

  // Keyframes that no longer exist (undo, the agent's edits) drop out of the selection.
  useEffect(() => {
    if (!doc) return;
    const exists = (k: KeyRef) => !!(getNode(doc, k.node)?.anim?.tracks?.[k.track]?.[k.key]);
    const ts = useTime.getState();
    if (ts.selectedKeys.some((k) => !exists(k)) || (ts.popover && !exists(ts.popover))) {
      useTime.setState({ selectedKeys: ts.selectedKeys.filter(exists), popover: ts.popover && exists(ts.popover) ? ts.popover : null });
    }
  }, [doc]);

  // A shorter motion pulls the playhead back inside it.
  const len = doc?.motion?.duration;
  useEffect(() => {
    if (len !== undefined && useTime.getState().t >= len) seek(useTime.getState().t);
  }, [len]);

  if (!doc?.motion) return null;
  const motion = doc.motion;
  const duration = motion.duration;
  const fps = fpsOf(motion);
  const pxPerMs = width / duration;
  const xOf = (t: number) => Math.min(t, duration) * pxPerMs;
  const rows = timelineRows(doc, selection);
  const softByNode = new Map<string, string[]>();
  for (const p of preview ? [] : (pins?.soft ?? [])) softByNode.set(p.node, [...(softByNode.get(p.node) ?? []), p.path]);
  const changedByNode = new Map<string, string[]>();
  for (const i of agentChanges?.items ?? []) changedByNode.set(i.id, i.paths ?? []);
  const isSel = (k: KeyRef) => selectedKeys.some((x) => keyId(x) === keyId(k));
  const laneX = (clientX: number) => clientX - (lane.current?.getBoundingClientRect().left ?? 0);
  const allKeyTimes = (except: Set<string>) => {
    const out: number[] = [];
    for (const r of rows) {
      const n = getNode(doc, r.id);
      for (const tr of r.tracks) for (const [key, k] of Object.entries(n?.anim?.tracks?.[tr] ?? {})) if (!except.has(`${r.id}/${tr}/${key}`)) out.push(k.t);
    }
    return out;
  };
  const snapOpts = (except: Set<string>, free: boolean) => ({ fps, candidates: [...allKeyTimes(except), useTime.getState().t], threshold: SNAP_PX / pxPerMs, free, max: MOTION_LIMITS.maxTime });

  // ---- pointer handling (captured on the strip)
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "resize") {
      useTime.setState({ height: Math.max(120, Math.min(window.innerHeight * 0.7, d.h0 + (d.y0 - e.clientY))) });
      return;
    }
    if (d.kind === "scrub") {
      seek(laneX(e.clientX) / pxPerMs);
      return;
    }
    const b = base!;
    const dms = (e.clientX - d.x0) / pxPerMs;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
    d.moved = true;
    const free = e.ctrlKey || e.metaKey;
    if (d.kind === "keys") {
      const except = new Set(d.keys.map(keyId));
      const g0 = d.orig.get(keyId(d.grabbed))!;
      let delta = snapTime(g0 + dms, snapOpts(except, free)) - g0;
      const min = Math.min(...d.orig.values());
      if (min + delta < 0) delta = -min;
      const ops = tryOps(() => d.keys.flatMap((k) => moveKeyframe(b, k.node, k.track, k.key, d.orig.get(keyId(k))! + delta)));
      if (!ops) return;
      d.cmd = { ops: ops as Op[], label: `retime ${d.keys.length === 1 ? `${d.keys[0].node} ${d.keys[0].track} ${d.keys[0].key}` : `${d.keys.length} keyframes`} ${delta >= 0 ? "+" : "−"}${fmtTime(Math.abs(delta))}` };
      setDraft(d.cmd);
      return;
    }
    const except = new Set<string>();
    const n = getNode(b, d.node);
    for (const tr of Object.keys(n?.anim?.tracks ?? {})) for (const key of Object.keys(n?.anim?.tracks?.[tr as TrackName] ?? {})) except.add(`${d.node}/${tr}/${key}`);
    if (d.stretch) {
      const { anchor, end } = d.stretch;
      const newEnd = snapTime(end + dms, snapOpts(except, free));
      const factor = (newEnd - anchor) / (end - anchor);
      if (!(factor > 0.02)) return;
      const ops = tryOps(() => stretchKeyframes(b, d.node, factor, anchor));
      if (!ops) return;
      d.cmd = { ops: ops as Op[], label: `stretch ${d.node}'s motion ×${factor.toFixed(2)}` };
    } else {
      let delta = Math.round(snapTime(d.range[0] + dms, snapOpts(except, free)) - d.range[0]);
      if (d.range[0] + delta < 0) delta = -d.range[0];
      const ops = tryOps(() => shiftKeyframes(b, d.node, delta));
      if (!ops) return;
      d.cmd = { ops: ops as Op[], label: `shift ${d.node}'s motion ${delta >= 0 ? "+" : "−"}${fmtTime(Math.abs(delta))}` };
    }
    setDraft(d.cmd);
  };
  const onUp = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!d || d.kind === "scrub" || d.kind === "resize") return;
    if (d.moved && d.cmd?.ops.length) {
      commit(d.cmd);
      return;
    }
    setDraft(null);
    if (d.kind === "keys" && !d.moved && !e.shiftKey) useTime.setState({ popover: d.grabbed });
  };
  const capture = (e: RPointerEvent) => (e.currentTarget.closest(".timeline") as HTMLElement).setPointerCapture(e.pointerId);

  const onRulerDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    stop();
    capture(e);
    drag.current = { kind: "scrub" };
    useTime.setState({ popover: null });
    seek(laneX(e.clientX) / pxPerMs);
  };

  const onKeyDown = (e: RPointerEvent, ref: KeyRef) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    let sel = useTime.getState().selectedKeys;
    if (e.shiftKey) sel = isSel(ref) ? sel.filter((x) => keyId(x) !== keyId(ref)) : [...sel, ref];
    else if (!isSel(ref)) sel = [ref];
    useTime.setState({ selectedKeys: sel, popover: null });
    if (!useEditor.getState().selection.includes(ref.node) && !e.shiftKey) select([ref.node]);
    if (ro || !sel.some((x) => keyId(x) === keyId(ref))) return;
    capture(e);
    const orig = new Map<string, number>();
    for (const k of sel) {
      const kf = getNode(base!, k.node)?.anim?.tracks?.[k.track]?.[k.key];
      if (kf) orig.set(keyId(k), kf.t);
    }
    drag.current = { kind: "keys", x0: e.clientX, grabbed: ref, keys: sel.filter((k) => orig.has(keyId(k))), orig, moved: false };
  };

  const onBarDown = (e: RPointerEvent, row: TimelineRow, end?: "start" | "end") => {
    e.stopPropagation();
    if (e.button !== 0 || !row.range) return;
    select([row.id], e.shiftKey ? "toggle" : "replace");
    useTime.setState({ popover: null, selectedKeys: [] });
    if (ro) return;
    capture(e);
    const [a, b] = row.range;
    let stretch: { anchor: number; end: number } | undefined;
    if (e.altKey && b > a) {
      // Alt-drag an end: stretch the times around the other end (the nearer end when on the bar).
      const which = end ?? (laneX(e.clientX) > (xOf(a) + xOf(b)) / 2 ? "end" : "start");
      stretch = which === "end" ? { anchor: a, end: b } : { anchor: b, end: a };
    }
    drag.current = { kind: "bar", x0: e.clientX, node: row.id, range: row.range, stretch, moved: false };
  };

  const setMotion = (path: string, value: unknown, label: string) => run([{ op: "set", node: "$doc", path: `motion.${path}`, value }], label);

  const diamond = (n: Node, track: TrackName, key: string, t: number, cls = "") => {
    const ref = { node: n.id, track, key };
    const pin = keyframePin(n, softByNode.get(n.id) ?? [], track, key);
    const changed = keyframeChanged(changedByNode.get(n.id) ?? [], track, key);
    return (
      <div
        key={`${track}/${key}`}
        className={`kf${isSel(ref) ? " sel" : ""}${pin ? ` pin-${pin}` : ""}${changed ? " agent-changed" : ""}${t > duration ? " after-end" : ""} ${cls}`}
        data-testid={`kf-${n.id}-${track}-${key}`}
        data-t={t}
        data-pin={pin ?? ""}
        title={`${TRACK_LABELS[track]} ${key} · ${fmtTime(t)}${pin === "soft" ? " · you changed it (the agent keeps it next turn)" : pin === "explicit" ? " · pinned" : ""}${changed ? " · changed by the agent" : ""}${t > duration ? " · after the end: never plays" : ""}`}
        style={{ left: xOf(t) }}
        onPointerDown={(e) => onKeyDown(e, ref)}
      />
    );
  };

  const rowView = (r: TimelineRow) => {
    const n = getNode(doc, r.id)!;
    const exp = !!expanded[r.id];
    const pinnedAll = (n.pins ?? []).some((p) => p === "*" || p === "anim");
    const changedAny = (changedByNode.get(r.id) ?? []).some((p) => p === "anim" || p.startsWith("anim."));
    const times = [...new Set(r.tracks.flatMap((tr) => Object.values(n.anim?.tracks?.[tr] ?? {}).map((k) => k.t)))];
    return (
      <div key={r.id} className="tl-group">
        <div className={`tl-row${selection.includes(r.id) ? " selected" : ""}`} data-testid={`tl-row-${r.id}`}>
          <div className="tl-label" style={{ paddingLeft: 4 + r.depth * 12 }} onPointerDown={(e) => (e.stopPropagation(), select([r.id], e.shiftKey ? "toggle" : "replace"))}>
            <button className="mini" data-testid={`tl-expand-${r.id}`} disabled={!r.tracks.length} onPointerDown={(e) => e.stopPropagation()} onClick={() => useTime.setState((ts) => ({ expanded: { ...ts.expanded, [r.id]: !exp } }))}>
              <Icon name={exp ? "caretDown" : "caretRight"} size={12} />
            </button>
            <span className="tl-name" title={r.id}>
              {r.name}
            </span>
            {r.tracks.length ? (
              <button
                className={`mini${pinnedAll ? " on" : " dim"}`}
                data-testid={`tl-pin-${r.id}`}
                title={pinnedAll ? "This layer's motion is pinned: the agent keeps it" : "Pin this layer's motion (the agent keeps it)"}
                disabled={ro}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => togglePin(useEditor.getState().doc!, r.id, "anim")}
              >
                <Icon name="pin" size={12} />
              </button>
            ) : (
              <span className="dim small">no motion</span>
            )}
          </div>
          <div className="tl-lane-row">
            {r.range ? (
              <div className={`tl-bar${changedAny ? " agent-changed" : ""}`} data-testid={`tl-bar-${r.id}`} style={{ left: xOf(r.range[0]), width: Math.max(2, xOf(r.range[1]) - xOf(r.range[0])) }} onPointerDown={(e) => onBarDown(e, r)} title="Drag to shift this layer's motion · Alt-drag an end to stretch it">
                <div className="tl-bar-end start" onPointerDown={(e) => onBarDown(e, r, "start")} />
                <div className="tl-bar-end end" data-testid={`tl-bar-end-${r.id}`} onPointerDown={(e) => onBarDown(e, r, "end")} />
              </div>
            ) : null}
            {!exp ? times.map((t) => <div key={t} className="kf mini-kf" style={{ left: xOf(t) }} />) : null}
          </div>
        </div>
        {exp
          ? r.tracks.map((tr) => (
              <div key={tr} className="tl-row track" data-testid={`tl-track-${r.id}-${tr}`}>
                <div className="tl-label" style={{ paddingLeft: 26 + r.depth * 12 }}>
                  <span className="tl-name">{TRACK_LABELS[tr]}</span>
                </div>
                <div className="tl-lane-row">{sortedKeyframes(n.anim?.tracks?.[tr]).map((k) => diamond(n, tr, k.key, k.t))}</div>
              </div>
            ))
          : null}
      </div>
    );
  };

  const ticks: number[] = [];
  const step = duration <= 3000 ? 250 : duration <= 12000 ? 500 : duration <= 30000 ? 1000 : 5000;
  for (let t = 0; t <= duration; t += step) ticks.push(t);

  return (
    <div
      className={`timeline${open ? "" : " collapsed"}${animate ? " animating" : ""}`}
      data-testid="timeline"
      data-ui="timeline"
      style={{ height: open ? height : undefined }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {open ? (
        <div
          className="tl-resize"
          title="Drag to resize"
          onPointerDown={(e) => {
            capture(e);
            drag.current = { kind: "resize", y0: e.clientY, h0: height };
          }}
        />
      ) : null}
      <div className="tl-head">
        <button title="Jump to start (Home)" data-testid="tl-start" onClick={() => (stop(), seek(0))}>
          <Icon name="toStart" />
        </button>
        <button title="One frame back (, · < = ten)" data-testid="tl-back" onClick={() => stepFrames(-1)}>
          <Icon name="frameBack" />
        </button>
        <PlayButton />
        <button title="One frame forward (. · > = ten)" data-testid="tl-fwd" onClick={() => stepFrames(1)}>
          <Icon name="frameFwd" />
        </button>
        <Readout duration={duration} />
        <span className="sep" />
        <label className="field mini-field" title={`Length of the motion, ${MOTION_LIMITS.minDuration / 1000}–${MOTION_LIMITS.maxDuration / 1000} s`}>
          <span>Length s</span>
          <SecondsInput
            testid="tl-duration"
            value={duration}
            disabled={ro}
            onCommit={(ms) => {
              const v = Math.max(MOTION_LIMITS.minDuration, Math.min(MOTION_LIMITS.maxDuration, ms));
              if (v !== duration) setMotion("duration", v, `motion length ${fmtTime(duration)} → ${fmtTime(v)}`);
            }}
          />
        </label>
        <label className="field mini-field">
          <span>fps</span>
          <select data-testid="tl-fps" value={fps} disabled={ro} onChange={(e) => setMotion("fps", Number(e.target.value), `motion ${e.target.value} fps`)}>
            {FPS_VALUES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="check" title="The preview loops (the video is always one pass)">
          <input type="checkbox" data-testid="tl-loop" checked={!!motion.loop} disabled={ro} onChange={(e) => setMotion("loop", e.target.checked, e.target.checked ? "motion loops" : "motion plays once")} /> Loop
        </label>
        <span className="sep" />
        <button
          className={`animate-toggle${animate ? " on" : ""}`}
          data-testid="tl-animate"
          disabled={ro}
          title={animate ? "Animate is on: moving, scaling, rotating and opacity write keyframes at the playhead" : "Animate is off: canvas edits change the layout (the whole animation follows)"}
          onClick={() => useTime.setState({ animate: !animate })}
        >
          <span className="rec-dot" /> Animate
        </button>
        <AddAnimationMenu />
        <span className="grow" />
        <div className="menu">
          <button data-testid="tl-more" onClick={() => setMore((m) => !m)} title="More: still image, remove motion">
            <Icon name="more" />
          </button>
          {more ? (
            <div className="menu-list up" onClick={() => setMore(false)}>
              <label className="field">
                <span>Still image</span>
                <select
                  data-testid="tl-poster"
                  value={motion.poster === undefined || motion.poster === "rest" ? "rest" : "playhead"}
                  disabled={ro}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => (e.target.value === "rest" ? setMotion("poster", "rest", "still image: the layout as designed") : setMotion("poster", useTime.getState().t, `still image at ${fmtTime(useTime.getState().t)}`))}
                >
                  <option value="rest">the layout as designed</option>
                  <option value="playhead">{motion.poster !== undefined && motion.poster !== "rest" ? `at ${fmtTime(motion.poster)}` : `at the playhead (${fmtTime(useTime.getState().t)})`}</option>
                </select>
              </label>
              <button
                className="danger"
                data-testid="tl-remove-motion"
                disabled={ro}
                onClick={() => {
                  if (!window.confirm("Remove the motion and every keyframe of every layer? (Undo brings it back.)")) return;
                  stop();
                  run(removeMotion(useEditor.getState().doc!), "remove motion");
                }}
              >
                Remove motion
              </button>
            </div>
          ) : null}
        </div>
        <button data-testid="tl-collapse" title={open ? "Collapse the timeline" : "Open the timeline"} onClick={() => useTime.setState({ open: !open })}>
          <Icon name={open ? "caretDown" : "caretUp"} />
        </button>
      </div>
      {open ? (
        <div className="tl-body">
          <div className="tl-ruler-row">
            <div className="tl-label head">{rows.length ? `${rows.length} layer${rows.length === 1 ? "" : "s"}` : "No animated layers yet"}</div>
            <div className="tl-ruler" ref={lane} data-testid="tl-ruler" onPointerDown={onRulerDown}>
              {ticks.map((t) => (
                <div key={t} className="tl-tick" style={{ left: xOf(t) }}>
                  <span>{t % 1000 === 0 ? `${t / 1000}s` : ""}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="tl-rows" onPointerDown={() => useTime.setState({ selectedKeys: [], popover: null })}>
            {rows.map(rowView)}
            {!rows.length ? <p className="hint tl-empty">Select layers and use “+ Add animation”, or switch Animate on and move a layer.</p> : null}
          </div>
          <Playhead width={width} duration={duration} />
        </div>
      ) : null}
      {open && popover ? <KeyPopover key={keyId(popover)} doc={doc} k={popover} x={LABEL_W + xOf(getNode(doc, popover.node)?.anim?.tracks?.[popover.track]?.[popover.key]?.t ?? 0)} ro={ro} soft={softByNode.get(popover.node) ?? []} /> : null}
    </div>
  );
}

function SecondsInput({ value, onCommit, disabled, testid }: { value: number; onCommit: (ms: number) => void; disabled?: boolean; testid?: string }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      type="text"
      data-testid={testid}
      disabled={disabled}
      value={text ?? String(Math.round(value) / 1000)}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        setText(null);
        const v = Number(e.target.value.replace(",", "."));
        if (Number.isFinite(v) && e.target.value.trim()) onCommit(Math.round(v * 1000));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(null);
      }}
    />
  );
}

/** Explicit pins on motion paths: add or remove one path in node.pins. */
function togglePin(doc: Document, id: string, path: string) {
  const n = getNode(doc, id);
  if (!n) return;
  const cur = n.pins ?? [];
  const on = cur.includes(path);
  const next = on ? cur.filter((p) => p !== path) : [...cur, path];
  commit(setProps(doc, [id], "pins", next.length ? next : undefined, on ? `unpin ${id}.${path}` : `pin ${id}.${path}`));
}

function KeyPopover({ doc, k, x, ro, soft }: { doc: Document; k: KeyRef; x: number; ro: boolean; soft: string[] }) {
  const n = getNode(doc, k.node);
  const kf = n?.anim?.tracks?.[k.track]?.[k.key];
  const [val, setVal] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  if (!n || !kf) return null;
  const close = () => useTime.setState({ popover: null });
  const base = () => useEditor.getState().doc!;
  const kp = `anim.tracks.${k.track}.${k.key}`;
  const pin = keyframePin(n, soft, k.track, k.key);
  const explicit = n.pins ?? [];
  const ease = kf.ease ?? "out";
  const isLast = sortedKeyframes(n.anim?.tracks?.[k.track]).at(-1)?.key === k.key;
  const label = `${k.node} ${TRACK_LABELS[k.track]} ${k.key}`;
  return (
    <div className="kf-popover" data-ui="popover" data-testid="kf-popover" style={{ left: Math.max(8, x - 120) }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="kf-pop-head">
        <b>{n.name ?? n.id}</b> · {TRACK_LABELS[k.track]} <code>{k.key}</code>
        <span className="grow" />
        <button className="mini" onClick={close} title="Close">
          ×
        </button>
      </div>
      <div className="grid2">
        <label className="field">
          <span>Time s</span>
          <input
            type="text"
            data-testid="kf-time"
            disabled={ro}
            value={time ?? String(kf.t / 1000)}
            onChange={(e) => setTime(e.target.value)}
            onBlur={(e) => {
              setTime(null);
              const v = Math.round(Number(e.target.value.replace(",", ".")) * 1000);
              if (!Number.isFinite(v) || v === kf.t) return;
              const ops = tryOps(() => moveKeyframe(base(), k.node, k.track, k.key, Math.max(0, v)));
              if (ops) run(ops, `retime ${label} → ${fmtTime(v)}`);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </label>
        <label className="field" title={trackUnit(k.track)}>
          <span>Value {trackUnit(k.track)}</span>
          <input
            type="text"
            data-testid="kf-value"
            disabled={ro}
            value={val ?? String(kf.v)}
            onChange={(e) => setVal(e.target.value)}
            onBlur={(e) => {
              setVal(null);
              const v = Number(e.target.value.replace(",", "."));
              if (!Number.isFinite(v) || !e.target.value.trim()) return;
              const ops = tryOps(() => editKeyframe(base(), k.node, k.track, k.key, { v: cleanValue(k.track, v) }));
              if (ops?.length) run(ops, `${label} value ${kf.v} → ${cleanValue(k.track, v)}`);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </label>
      </div>
      <div className="ease-list" title={isLast ? "The last keyframe's ease is not used (nothing comes after it)" : "The curve from this keyframe to the next"}>
        {EASES.map((e) => (
          <button key={e} className={`ease-btn${e === ease ? " on" : ""}`} data-testid={`kf-ease-${e}`} disabled={ro} onClick={() => e !== ease && run(editKeyframe(base(), k.node, k.track, k.key, { ease: e }), `${label} ease ${e}`)}>
            <EaseCurve ease={e} />
            <span>{e}</span>
          </button>
        ))}
      </div>
      {pin === "soft" ? <p className="hint">You changed this keyframe since the agent's last turn: it keeps it on its next turn.</p> : null}
      <div className="kf-pins">
        <label className="check">
          <input type="checkbox" data-testid="kf-pin" disabled={ro} checked={explicit.includes(kp)} onChange={() => togglePin(base(), k.node, kp)} /> Pin keyframe
        </label>
        <label className="check">
          <input type="checkbox" data-testid="kf-pin-track" disabled={ro} checked={explicit.includes(`anim.tracks.${k.track}`)} onChange={() => togglePin(base(), k.node, `anim.tracks.${k.track}`)} /> Pin track
        </label>
        <label className="check">
          <input type="checkbox" data-testid="kf-pin-anim" disabled={ro} checked={explicit.includes("anim")} onChange={() => togglePin(base(), k.node, "anim")} /> Pin all its motion
        </label>
      </div>
      <div className="row end">
        <button
          className="danger"
          data-testid="kf-delete"
          disabled={ro}
          onClick={() => {
            const ops = tryOps(() => deleteKeyframe(base(), k.node, k.track, k.key));
            if (ops && run(ops, `delete ${label}`)) close();
          }}
        >
          Delete keyframe
        </button>
      </div>
    </div>
  );
}

/** Delete the keyframes selected in the timeline (Delete / Backspace while some are selected). */
export function deleteSelectedKeys(): boolean {
  const ts = useTime.getState();
  const doc = useEditor.getState().doc;
  if (!doc || !ts.selectedKeys.length) return false;
  const ops: MotionOp[] = [];
  for (const k of ts.selectedKeys) if (findItem(doc, k.node) && getNode(doc, k.node)?.anim?.tracks?.[k.track]?.[k.key]) ops.push(...deleteKeyframe(doc, k.node, k.track, k.key));
  useTime.setState({ selectedKeys: [], popover: null });
  if (ops.length) run(ops, `delete ${ops.length} keyframe${ops.length === 1 ? "" : "s"}`);
  return true;
}
