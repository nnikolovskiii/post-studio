// Motion pieces outside the timeline strip (PLAN-motion.md §6.1, §6.2): "Add motion" in the top
// bar, the Motion section of the properties panel (origin, reveal mode, tracks, presets, clear),
// the Animate-mode opacity field, and Download video (the server's MP4 job API from Part 2).
import { useEffect, useRef, useState } from "react";
import { REVEAL_BY, type Document, type Node, type OriginName } from "@post-studio/schema";
import type { Op } from "@post-studio/ops";
import { activeTracks, addMotion, clearNodeMotion, sampleNode, setOrigin, type MotionOp } from "@post-studio/motion";
import { api } from "../api.ts";
import { TRACK_LABELS, fmtTime, keyAtTime } from "../model/motion.ts";
import { commit, flushSaves, readOnlyReason, toast, useEditor } from "../store.ts";
import { resetTime, useTime } from "../timeline.ts";
import { AddAnimationMenu } from "./Timeline.tsx";
import { Icon } from "./Icons.tsx";

const run = (ops: MotionOp[], label: string) => commit({ ops: ops as Op[], label });

/** Top bar: turns a still post into a motion project (6 s, 30 fps, loop) and opens the timeline. */
export function AddMotionButton() {
  const doc = useEditor((s) => s.doc);
  const ro = useEditor((s) => !!readOnlyReason(s));
  if (!doc || doc.motion) return null;
  return (
    <button
      data-testid="add-motion"
      disabled={ro}
      title="Make this a motion post: a timeline with keyframes (6 s, 30 fps). Remove it again from the timeline's ⋯ menu."
      onClick={() => {
        if (run(addMotion(doc), "add motion (6 s, 30 fps, loop)")) {
          resetTime();
          useTime.setState({ open: true });
        }
      }}
    >
      Add motion
    </button>
  );
}

const ORIGIN_TITLES: Record<OriginName, string> = {
  "top-left": "top left",
  top: "top",
  "top-right": "top right",
  left: "left",
  center: "centre",
  right: "right",
  "bottom-left": "bottom left",
  bottom: "bottom",
  "bottom-right": "bottom right",
};

/** Properties panel → Motion (one selected layer of a motion project). */
export function MotionSection({ doc, n, ro }: { doc: Document; n: Node; ro: boolean }) {
  if (!doc.motion) return null;
  const tracks = activeTracks(n);
  const origin = n.anim?.origin ?? "center";
  return (
    <section data-testid="motion-section">
      <h4>Motion</h4>
      <div className="row">
        <div className="origin-grid" title="Scale and rotate around this point of the layer">
          {(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] as OriginName[]).map((o) => (
            <button key={o} className={`origin-cell${o === origin ? " on" : ""}`} data-testid={`origin-${o}`} disabled={ro} title={ORIGIN_TITLES[o]} onClick={() => run(setOrigin(doc, n.id, o), `${n.id} motion origin ${ORIGIN_TITLES[o]}`)} />
          ))}
        </div>
        <div className="hint" style={{ margin: 0 }}>
          Origin: <b>{ORIGIN_TITLES[origin]}</b>
          <br />
          scale and rotate pivot
        </div>
      </div>
      {n.type === "text" ? (
        <label className="field">
          <span>Reveal by</span>
          <select data-testid="prop-reveal-by" value={n.anim?.revealBy ?? "char"} disabled={ro} onChange={(e) => run([{ op: "set", node: n.id, path: "anim.revealBy", value: e.target.value }], `${n.id} reveal by ${e.target.value}`)}>
            {REVEAL_BY.map((r) => (
              <option key={r} value={r}>
                {r === "char" ? "letter" : r}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <ul className="track-list" data-testid="motion-tracks">
        {tracks.map((t) => {
          const keys = Object.values(n.anim?.tracks?.[t] ?? {});
          const ts = keys.map((k) => k.t);
          return (
            <li key={t}>
              <b>{TRACK_LABELS[t]}</b> · {keys.length} keyframe{keys.length === 1 ? "" : "s"} · {fmtTime(Math.min(...ts))}–{fmtTime(Math.max(...ts))}
            </li>
          );
        })}
        {!tracks.length ? <li className="dim">No keyframes on this layer.</li> : null}
      </ul>
      <div className="row wrap">
        <AddAnimationMenu testid="prop-add-animation" label="+ Add animation" down />
        {tracks.length ? (
          <button data-testid="prop-clear-motion" disabled={ro} onClick={() => run(clearNodeMotion(doc, n.id), `clear motion on ${n.id}`)}>
            Clear motion on this layer
          </button>
        ) : null}
      </div>
      <AnimOpacityField doc={doc} n={n} ro={ro} />
    </section>
  );
}

/** Animate mode: opacity at the playhead as a keyframe (the layer's own opacity stays its layout). */
function AnimOpacityField({ doc, n, ro }: { doc: Document; n: Node; ro: boolean }) {
  const t = useTime((x) => (x.animate ? x.t : -1));
  const [text, setText] = useState<string | null>(null);
  if (t < 0) return null;
  const v = Math.round(sampleNode(n, t).opacity * 1000) / 10;
  return (
    <label className="field anim-field" title="Writes an opacity keyframe at the playhead (Animate is on)">
      <span>
        <span className="rec-dot" /> Opacity % at {fmtTime(t)}
      </span>
      <input
        type="text"
        data-testid="prop-anim-opacity"
        disabled={ro}
        value={text ?? String(v)}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          setText(null);
          const x = Number(e.target.value.replace(",", "."));
          if (!Number.isFinite(x) || !e.target.value.trim() || Math.abs(x - v) < 1e-9) return;
          run(keyAtTime(doc, n.id, "opacity", Math.max(0, Math.min(100, x)) / 100, t), `animate ${n.id}: opacity ${x}% at ${fmtTime(t)}`);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

export interface VideoJob {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  position?: number;
  error?: string;
  url: string;
  filename: string;
  frames: number;
  done: number;
}

/**
 * The server's MP4 job for one frame of the saved revision (Part 2's job API): start (or reuse a
 * cached file), follow the progress, resolve with the finished job. Shared by the desktop Video
 * button and the phone's Download video.
 */
export function useVideoJob() {
  const [job, setJob] = useState<VideoJob | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const start = async (projectId: string, frameId: string): Promise<VideoJob | undefined> => {
    setBusy(true);
    setJob(null);
    try {
      await flushSaves();
      const rev = useEditor.getState().save.rev;
      let j = (await api<{ job: VideoJob }>("GET", `/v1/projects/${projectId}/video?rev=${rev}&frame=${encodeURIComponent(frameId)}`)).job;
      if (alive.current) setJob(j);
      while (alive.current && (j.status === "queued" || j.status === "running")) {
        await new Promise((r) => setTimeout(r, 600));
        j = (await api<{ job: VideoJob }>("GET", `/v1/video-jobs/${j.id}`)).job;
        if (alive.current) setJob(j);
      }
      if (!alive.current) return undefined;
      if (j.status === "failed") throw new Error(j.error ?? "the video failed");
      return j;
    } catch (e) {
      toast(`Video failed: ${(e as Error).message}`, "error");
      return undefined;
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return { job, busy, start };
}

/** "Video 40 %", "Video: waiting (#2)…" while a job runs. */
export function videoProgress(job: VideoJob | null): string {
  if (!job) return "starting…";
  if (job.status === "queued") return `waiting${job.position ? ` (#${job.position})` : ""}…`;
  if (job.status === "running") return `${Math.round(job.progress * 100)} %`;
  return "…";
}

/**
 * Download video: asks the server for the MP4 of the saved revision (active frame), shows the
 * progress, then downloads the file. Finished videos are cached on the server, so a second
 * click is instant.
 */
export function VideoButton() {
  const projectId = useEditor((s) => s.projectId);
  const doc = useEditor((s) => s.doc);
  const activeFrame = useEditor((s) => s.activeFrame);
  const { job, busy, start } = useVideoJob();
  if (!doc?.motion || !projectId) return null;
  const frame = doc.frames.find((f) => f.id === activeFrame) ?? doc.frames[0];
  const run = async () => {
    const j = await start(projectId, frame.id);
    if (!j) return;
    const a = document.createElement("a");
    a.href = j.url;
    a.download = j.filename;
    a.dataset.testid = "video-link";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`Video ready: ${j.filename}`);
  };
  const label = !busy ? "Video" : job?.status === "running" ? `Video ${videoProgress(job)}` : `Video: ${videoProgress(job)}`;
  return (
    <button
      data-testid="download-video"
      data-status={job?.status ?? ""}
      data-job={job?.id ?? ""}
      data-url={job?.status === "done" ? job.url : ""}
      disabled={busy}
      title={`Download the MP4 of ${frame.name} (saved revision; 1 pass of ${fmtTime(doc.motion.duration)}). The server renders it; a second click is instant.`}
      onClick={() => void run()}
    >
      <Icon name="video" /> {label}
    </button>
  );
}
