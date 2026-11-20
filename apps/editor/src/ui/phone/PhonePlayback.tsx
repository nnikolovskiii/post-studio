// Motion on the phone (PLAN-motion.md §6.2): play / pause, a touch scrubber and the time under
// the preview and in the zoom viewer, and Download video. Review only: nothing here writes the
// document. The playhead is the same store as the desktop timeline (src/timeline.ts), so the
// preview shows exactly the export's frame times.
//
// "Rest": until he plays or scrubs, a post whose poster is "rest" shows the layout as designed
// (what post.png is), not the first frame (where intro animations are usually invisible).
import { useEffect, useRef, useState } from "react";
import type { Document } from "@post-studio/schema";
import { fpsOf } from "@post-studio/motion";
import { fmtTime } from "../../model/motion.ts";
import { toast, useEditor } from "../../store.ts";
import { clampTime, play, seek, stepFrames, stop, useTime } from "../../timeline.ts";
import { Icon } from "../Icons.tsx";
import { useVideoJob, videoProgress, type VideoJob } from "../MotionPanel.tsx";

/** The moment to draw: undefined = the rest pose (a still post, or before he played / scrubbed). */
export function useMoment(doc: Document, rest: boolean): number | undefined {
  const t = useTime((x) => x.t);
  return doc.motion && !rest ? t : undefined;
}

/** Play / pause, scrubber, time. `onLive` leaves the rest pose (first play or scrub). */
export function PhoneTransport(props: { doc: Document; rest: boolean; onLive: () => void; testid: string }) {
  const { doc, rest, onLive, testid } = props;
  const playing = useTime((x) => x.playing);
  const t = useTime((x) => x.t);
  const m = doc.motion;
  if (!m) return null;
  const fps = fpsOf(m);
  const toggle = () => {
    if (playing) return stop();
    if (rest) {
      onLive();
      seek(0);
    }
    play();
  };
  return (
    <div className="ph-transport" data-testid={`${testid}-transport`}>
      <button className="ph-btn icon" aria-label={playing ? "Pause" : "Play"} data-testid={`${testid}-play`} data-playing={playing ? "1" : "0"} onClick={toggle}>
        <Icon name={playing ? "pause" : "play"} size={20} />
      </button>
      <Scrubber duration={m.duration} t={rest ? 0 : t} testid={testid} onStart={() => (stop(), rest ? onLive() : undefined)} />
      <span className="ph-time" data-testid={`${testid}-time`} data-t={rest ? "" : t} title={rest ? "The layout as designed (the still image). Play or scrub to see the motion." : `frame ${Math.round((t * fps) / 1000)}`}>
        {rest ? "Layout" : (t / 1000).toFixed(2)}
        <span className="ph-dim"> / {fmtTime(m.duration)}</span>
      </span>
    </div>
  );
}

/** A touch scrubber: a 44 px tall strip; touch or drag anywhere on it to seek (snaps to frames). */
function Scrubber(props: { duration: number; t: number; testid: string; onStart: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const seekAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    seek(clampTime(f * props.duration));
  };
  const pct = Math.max(0, Math.min(100, (props.t / props.duration) * 100));
  return (
    <div
      ref={ref}
      className="ph-scrub"
      role="slider"
      tabIndex={0}
      aria-label="Time"
      aria-valuemin={0}
      aria-valuemax={props.duration}
      aria-valuenow={props.t}
      aria-valuetext={fmtTime(props.t)}
      data-testid={`${props.testid}-scrub`}
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        dragging.current = true;
        props.onStart();
        seekAt(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && seekAt(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          props.onStart();
          stepFrames(e.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      <div className="ph-scrub-track">
        <div className="ph-scrub-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="ph-scrub-thumb" style={{ left: `${pct}%` }} />
    </div>
  );
}

/** Stop playback when the phone project closes; pause while a sheet covers the preview. */
export function usePauseWhen(covered: boolean) {
  useEffect(() => {
    if (covered) stop();
  }, [covered]);
  useEffect(() => () => stop(), []);
}

/**
 * Download video (phone): the MP4 of the saved revision of the frame on screen. While the server
 * renders it shows progress; then Download (saves the file: share it to Instagram from the
 * Downloads notification or the gallery), Share (the phone's share sheet with the file, where the
 * browser can) and Play (opens it in the browser).
 */
export function PhoneVideoCard({ doc, frameId }: { doc: Document; frameId: string }) {
  const projectId = useEditor((s) => s.projectId);
  const { job, busy, start } = useVideoJob();
  const [ready, setReady] = useState<{ job: VideoJob; frame: string; file?: File } | null>(null);
  const frame = doc.frames.find((f) => f.id === frameId) ?? doc.frames[0];
  const m = doc.motion;
  // A different frame, or a new revision, needs a new file.
  const rev = useEditor((s) => s.save.rev);
  useEffect(() => setReady(null), [frameId, rev]);
  if (!m || !projectId) return null;
  const run = async () => {
    const j = await start(projectId, frame.id);
    if (!j) return;
    setReady({ job: j, frame: frame.id });
    toast(`Video ready: ${j.filename}`);
    // Fetch the bytes now, so Share opens at once (the share sheet needs a fresh tap).
    if (canShareFiles()) {
      try {
        const blob = await (await fetch(j.url, { credentials: "same-origin" })).blob();
        const file = new File([blob], j.filename, { type: "video/mp4" });
        if (navigator.canShare?.({ files: [file] })) setReady({ job: j, frame: frame.id, file });
      } catch {
        // Share stays hidden; Download still works.
      }
    }
  };
  const share = async () => {
    if (!ready?.file) return;
    try {
      await navigator.share({ files: [ready.file], title: doc.title });
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast(`Share failed: ${(e as Error).message}`, "error");
    }
  };
  return (
    <section className="ph-card ph-video" data-testid="phone-video" data-status={job?.status ?? ""}>
      <div className="ph-video-head">
        <b>Video</b>
        <span className="ph-dim">
          {frame.name} · {fmtTime(m.duration)} · {fpsOf(m)} fps
        </span>
      </div>
      {busy ? (
        <div className="ph-progress" data-testid="phone-video-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((job?.progress ?? 0) * 100)}>
          <div className="ph-progress-bar" style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }} />
          <span>Making the video: {videoProgress(job)}</span>
        </div>
      ) : ready ? (
        <div className="ph-row-buttons" data-testid="phone-video-ready">
          <a className="ph-btn primary" href={ready.job.url} download={ready.job.filename} data-testid="phone-video-download">
            <Icon name="video" size={18} /> Download
          </a>
          {ready.file ? (
            <button className="ph-btn" data-testid="phone-video-share" onClick={() => void share()}>
              Share
            </button>
          ) : null}
          <a className="ph-btn" href={`${ready.job.url}?inline=1`} target="_blank" rel="noopener" data-testid="phone-video-play">
            Play
          </a>
        </div>
      ) : (
        <button className="ph-btn wide" data-testid="phone-video-make" onClick={() => void run()}>
          <Icon name="video" size={18} /> Download video
        </button>
      )}
    </section>
  );
}

function canShareFiles(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof navigator.canShare === "function";
}
