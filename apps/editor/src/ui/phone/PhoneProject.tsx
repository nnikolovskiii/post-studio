// Phone review view of one project (PLAN Phase 8). Same store, API and rules as the desktop
// editor (turns, leases, soft pins are enforced by the server): preview with swipe and zoom,
// status and what the agent changed, text edits, approve, hand to agent / take back, history.
// Layout editing stays on the desktop editor.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Document, Frame } from "@post-studio/schema";
import { posterTime } from "@post-studio/motion";
import { ago, authorLabel, type RevisionInfo } from "../../api.ts";
import { commitText, getNode } from "../../model/commands.ts";
import { nodeAabb } from "../../model/geometry.ts";
import { hitTest } from "../../model/hit.ts";
import { hitMotionAt, nodeBoxAt } from "../../model/motion.ts";
import { waitingBanner } from "../../model/dispatch.ts";
import { FOCUS_MAX, togglePointed } from "../../model/focus.ts";
import { applyPlainEdit, layerLabel, textLayers, textNodeById, phoneEditBlock, type TextLayer } from "../../model/phone.ts";
import { fullText, type Span } from "../../model/richtext.ts";
import { setSketchOn, sketchCandidates, sketchLook } from "../../model/sketch.ts";
import { countLabel, phoneEditable, setSharedMany, sharedFields, typeCounts, type FieldKey } from "../../model/shared.ts";
import { matchingIds } from "@post-studio/ops";
import { weightsOf } from "../../fonts.ts";
import { colorHexOf, colorName, kitOf, type Color } from "../../model/brand.ts";
import type { Node, NodeType } from "@post-studio/schema";
import {
  approve,
  commit,
  dismissAgentChanges,
  flushSaves,
  handToAgent,
  loadProject,
  readOnlyReason,
  refreshRevisions,
  restoreRevision,
  retryDispatch,
  revertRevision,
  stopProject,
  takeBack,
  textBox,
  toast,
  useEditor,
} from "../../store.ts";
import { colorHex } from "../PropertiesPanel.tsx";
import { AtChip, FocusChips, handoffMoment } from "../FocusChips.tsx";
import { resetTime, useTime } from "../../timeline.ts";
import { PhoneTransport, PhoneVideoCard, useMoment, usePauseWhen } from "./PhonePlayback.tsx";
import { FrameView, makeTimeContext, useRenderer } from "../FrameView.tsx";
import { Icon } from "../Icons.tsx";
import { Toasts } from "../Toasts.tsx";
import { turnLabel } from "./PhoneProjects.tsx";
import { ZoomViewer } from "./ZoomViewer.tsx";

type Sheet = { kind: "text"; id: string } | { kind: "handoff" } | { kind: "approve" } | { kind: "history" } | { kind: "sketch" } | { kind: "together" } | null;

export function PhoneProject({ id, navigate, toDesktop }: { id: string; navigate: (path: string) => void; toDesktop: () => void }) {
  const s = useEditor();
  const [frameIdx, setFrameIdx] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [focus, setFocus] = useState<string | null>(null);
  // Point mode: taps on the preview pick the elements his hand-off note means by "this".
  const [pointing, setPointing] = useState(false);
  const [pointed, setPointed] = useState<string[]>([]);
  const [note, setNote] = useState("");
  // Motion: the layout as designed until he plays or scrubs (a "rest" poster), see PhonePlayback.
  const [rest, setRest] = useState(true);

  useEffect(() => {
    setRest(true);
    void loadProject(id).then(() => {
      resetTime();
      setRest(posterTime(useEditor.getState().doc?.motion) === undefined);
    });
    return () => void flushSaves().then(stopProject);
  }, [id]);
  usePauseWhen(!!sheet);
  const head = s.handoff?.head ?? s.save.rev;
  // The status line and the undo button need the newest revisions; the store only refreshes them for the desktop panel.
  useEffect(() => {
    if (s.doc) void refreshRevisions();
  }, [head, !!s.doc]);

  if (s.loadError) {
    return (
      <div className="phone">
        <p className="ph-message">Could not open this project: {s.loadError}</p>
        <button className="ph-btn" onClick={() => navigate("/")}>All projects</button>
      </div>
    );
  }
  if (!s.doc || !s.fonts) return <div className="phone"><p className="ph-message">Loading the post…</p></div>;
  const doc = s.doc;
  const ro = readOnlyReason({ ...s, preview: null });
  const idx = Math.min(frameIdx, doc.frames.length - 1);
  const frame = doc.frames[idx];
  const canPoint = !ro && s.handoff?.turn !== "agent";
  const live = pointed.filter((nid) => !!getNode(doc, nid));

  return (
    <div className={`phone${ro ? " read-only" : ""}`} data-testid="phone-project">
      <header className="ph-top">
        <a className="ph-btn ghost icon" href="/" aria-label="All projects" data-testid="phone-back" onClick={(e) => (e.preventDefault(), navigate("/"))}>
          <Icon name="back" size={20} />
        </a>
        <span className="ph-title" title={doc.title}>{doc.title}</span>
        <SaveDot />
        <button className="ph-btn ghost" data-testid="to-desktop" onClick={toDesktop}>
          Desktop
        </button>
      </header>
      <StatusBanner />
      <Preview
        doc={doc}
        index={idx}
        onIndex={setFrameIdx}
        onText={(tid) => setSheet({ kind: "text", id: tid })}
        onZoom={() => setZoom(idx)}
        focus={focus}
        pointing={pointing && canPoint}
        pointed={live}
        onPoint={(nid) => setPointed((p) => togglePointed(p.filter((x) => !!getNode(doc, x)), nid))}
        onPointMode={canPoint ? () => setPointing((x) => !x) : undefined}
        rest={rest}
        onLive={() => setRest(false)}
      />
      {pointing && canPoint ? (
        <PointBar
          count={live.length}
          onClear={() => setPointed([])}
          onDone={() => setPointing(false)}
          onHand={() => (setPointing(false), setSheet({ kind: "handoff" }))}
          onEdit={() => setSheet({ kind: "together" })}
        />
      ) : null}
      {doc.motion ? <PhoneVideoCard doc={doc} frameId={frame.id} /> : null}
      <StatusCard onFocus={(nid) => {
        setFocus(nid);
        const fi = doc.frames.findIndex((f) => !!findIn(f, nid));
        if (fi >= 0) setFrameIdx(fi);
        document.querySelector('[data-testid="phone-preview"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
      }} />
      <TextList frame={frame} onOpen={(tid) => setSheet({ kind: "text", id: tid })} />
      <SketchCard frame={frame} onOpen={() => setSheet({ kind: "sketch" })} />
      {canPoint ? (
        <TogetherCard
          count={live.length}
          onStart={() => {
            if (live.length) return setSheet({ kind: "together" });
            setPointing(true);
            document.querySelector('[data-testid="phone-preview"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        />
      ) : null}
      <div className="ph-spacer" />
      <ActionBar onSheet={setSheet} pointed={live.length} />
      {zoom !== null ? <ZoomPage index={zoom} onIndex={(i) => (setZoom(i), setFrameIdx(i))} onClose={() => setZoom(null)} rest={rest} onLive={() => setRest(false)} /> : null}
      {sheet?.kind === "text" ? <TextSheet id={sheet.id} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === "handoff" ? (
        <HandoffSheet
          rest={rest}
          note={note}
          onNote={setNote}
          pointed={live}
          onUnpoint={(nid) => setPointed((p) => p.filter((x) => x !== nid))}
          onPointMore={() => (setSheet(null), setPointing(true), document.querySelector('[data-testid="phone-preview"]')?.scrollIntoView({ block: "start" }))}
          onClose={() => setSheet(null)}
          onSent={() => (setSheet(null), setNote(""), setPointed([]), setPointing(false))}
        />
      ) : null}
      {sheet?.kind === "approve" ? <ApproveSheet onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === "history" ? <HistorySheet frame={frame.id} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === "sketch" ? <SketchSheet frame={frame} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === "together" ? <TogetherSheet ids={live} onClose={() => setSheet(null)} onPicked={setPointed} /> : null}
      <Toasts />
    </div>
  );
}

function findIn(frame: Frame, id: string): boolean {
  const walk = (ns: Frame["children"]): boolean => ns.some((n) => n.id === id || (n.type === "group" && walk(n.children)));
  return walk(frame.children);
}

function SaveDot() {
  const v = useEditor((s) => s.save);
  const text = v.status === "saved" ? `rev ${v.rev}` : v.status === "saving" || v.status === "waiting" ? "Saving…" : v.status === "retrying" ? "Offline, retrying" : "Not saved";
  return (
    <span className={`ph-save save-${v.status}`} data-testid="save-status" data-rev={v.rev} data-status={v.status} title={v.error}>
      {text}
    </span>
  );
}

// ---------------------------------------------------------------- banner + status

function StatusBanner() {
  const h = useEditor((s) => s.handoff);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const l = h?.lease;
  if (l && l.holder !== "human") {
    const left = Math.max(0, Math.round((Date.parse(l.expiresAt) - Date.now()) / 1000));
    return (
      <div className="ph-banner lease" data-testid="banner">
        <Icon name="agent" size={18} />
        <span>
          <b>{l.holder.replace(/^agent:/, "")}</b> is working on this post. Read-only until it hands back (lease ends in {left >= 60 ? `${Math.round(left / 60)} min` : `${left} s`}).
        </span>
      </div>
    );
  }
  if (h?.turn === "agent") {
    const w = waitingBanner(h);
    const pointed = h.handoff?.focus?.length ?? 0;
    return (
      <div className={`ph-banner waiting${w.failed ? " failed" : ""}`} data-testid="banner" data-dispatch={w.state}>
        <span className="grow">
          Handed to the agent{h.handoff?.note && h.handoff.note !== "(no note)" ? <> with the note “{h.handoff.note}”</> : null}
          {pointed ? <>, pointing at {pointed} element{pointed === 1 ? "" : "s"}</> : null}
          {h.handoff?.atText ? <span data-testid="handoff-at">, at {h.handoff.atText}</span> : null}.{" "}
          <b data-testid="dispatch-status">{w.text}</b>
        </span>
        {w.retry ? (
          <button className={`ph-btn${w.failed ? " primary" : ""}`} data-testid="retry-dispatch" onClick={() => void retryDispatch()}>
            {w.retry}
          </button>
        ) : null}
      </div>
    );
  }
  return null;
}

function StatusCard({ onFocus }: { onFocus: (id: string) => void }) {
  const s = useEditor();
  const h = s.handoff;
  const [confirmUndo, setConfirmUndo] = useState(false);
  if (!h) return null;
  const t = turnLabel({ turn: h.turn, lease: h.lease });
  const last: RevisionInfo | undefined = s.revisions[0];
  const ro = readOnlyReason({ ...s, preview: null });
  const undoable = last && last.rev > 0 && last.rev === h.head && last.opCount > 0;
  const a = s.agentChanges;
  const kept = s.pins?.soft.filter((p) => p.path !== "pins" && p.path !== "locked").length ?? 0;
  return (
    <section className="ph-card" data-testid="phone-status">
      <div className="ph-chips">
        <span className={`turn turn-${t.cls}`} data-testid="phone-turn">{t.text}</span>
        {h.approved ? (
          <span className={`chip approved${h.approved.current ? "" : " stale"}`} data-testid="approved-chip">
            {h.approved.current ? <><Icon name="check" size={12} /> Approved · rev {h.approved.rev}</> : `Approved rev ${h.approved.rev} · changed since`}
          </span>
        ) : null}
        {kept ? <span className="chip soft" title="What you changed since the agent's last turn: it cannot undo these">{kept} kept</span> : null}
      </div>
      {last ? (
        <p className="ph-last" data-testid="phone-last">
          <b>rev {last.rev}</b> · {authorLabel(last.author)} · {ago(last.createdAt)}
          <br />
          <span className="ph-dim">{last.message}</span>
        </p>
      ) : null}
      {undoable ? (
        confirmUndo ? (
          <div className="ph-row-buttons">
            <button className="ph-btn danger" data-testid="undo-last-confirm" disabled={!!ro} onClick={async () => { setConfirmUndo(false); await revertRevision(last.rev); }}>
              Undo rev {last.rev}
            </button>
            <button className="ph-btn" onClick={() => setConfirmUndo(false)}>Cancel</button>
          </div>
        ) : (
          <button className="ph-btn wide" data-testid="undo-last" disabled={!!ro} onClick={() => setConfirmUndo(true)}>
            <Icon name="revert" size={16} /> Undo last change
          </button>
        )
      ) : null}
      {a ? (
        <div className="ph-agent" data-testid="agent-changes">
          <div className="ph-agent-head">
            <b>What the agent changed</b>
            <span className="ph-dim">{a.checkpoint} · {authorLabel(a.author)}</span>
          </div>
          {a.summary ? <p>“{a.summary}”</p> : null}
          <ul>
            {a.items.map((i) => (
              <li key={i.id}>
                <button className="ph-link" data-change={i.id} disabled={i.kind === "deleted"} onClick={() => onFocus(i.id)}>
                  <code>{i.id}</code> {i.text}
                </button>
              </li>
            ))}
            {!a.items.length ? <li>No changes.</li> : null}
          </ul>
          <button className="ph-btn wide" data-testid="agent-changes-ok" onClick={dismissAgentChanges}>Got it</button>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- preview

function Preview(props: {
  doc: Document;
  index: number;
  onIndex: (i: number) => void;
  onText: (id: string) => void;
  onZoom: () => void;
  focus: string | null;
  pointing: boolean;
  pointed: string[];
  onPoint: (id: string) => void;
  /** Undefined when pointing is not possible (agent's turn, read-only). */
  onPointMode?: () => void;
  rest: boolean;
  onLive: () => void;
}) {
  const { doc, index } = props;
  const s = useEditor();
  const time = useMoment(doc, props.rest);
  const tc = useMemo(() => makeTimeContext(s.fonts!, doc, time), [s.fonts, doc, time]);
  const renderer = useRenderer(s.fonts!, doc);
  const salt = `${doc.lang}|${s.assetsVersion}`;
  const strip = useRef<HTMLDivElement>(null);
  const tb = textBox(s);
  const highlight = useMemo(() => new Set([...(s.agentChanges?.items.filter((i) => i.kind !== "deleted").map((i) => i.id) ?? []), ...(props.focus ? [props.focus] : [])]), [s.agentChanges, props.focus]);

  // Keep the strip on the chosen frame (tabs, zoom viewer, a change tapped in the status card).
  useEffect(() => {
    const el = strip.current;
    if (el && Math.round(el.scrollLeft / Math.max(1, el.clientWidth)) !== index) el.scrollTo({ left: index * el.clientWidth, behavior: "smooth" });
  }, [index]);

  const onScroll = () => {
    const el = strip.current!;
    const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
    if (i !== index && i >= 0 && i < doc.frames.length) props.onIndex(i);
  };

  const tap = (e: React.MouseEvent<SVGSVGElement>, frame: Frame) => {
    const svg = e.currentTarget;
    const ctm = svg.getScreenCTM();
    if (!ctm) return props.onZoom();
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const scale = frame.w / svg.getBoundingClientRect().width;
    // Layers are hit where they are drawn at this moment (and not at all while invisible).
    const chain = hitTest(frame, { x: pt.x, y: pt.y }, tb, 8 * scale, hitMotionAt(time, tb));
    if (props.pointing) {
      // The deepest element under the finger (a chart bar, not the whole chart); nothing = no-op.
      const leaf = chain[chain.length - 1];
      if (leaf) props.onPoint(leaf);
      return;
    }
    const text = [...chain].reverse().find((nid) => getNode(doc, nid)?.type === "text");
    if (text) props.onText(text);
    else props.onZoom();
  };

  return (
    <section className="ph-preview" data-testid="phone-preview">
      {doc.frames.length > 1 ? (
        <div className="ph-tabs" role="tablist">
          {doc.frames.map((f, i) => (
            <button key={f.id} role="tab" aria-selected={i === index} className={`ph-tab${i === index ? " on" : ""}`} data-testid={`frame-tab-${f.id}`} onClick={() => props.onIndex(i)}>
              {f.name} <span className="ph-dim">{f.w}×{f.h}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="ph-strip" ref={strip} onScroll={onScroll} data-testid="phone-strip">
        {doc.frames.map((f) => (
          <div className="ph-slide" key={f.id}>
            <svg
              className={`ph-frame${props.pointing ? " pointing" : ""}`}
              data-phone-frame={f.id}
              viewBox={`0 0 ${f.w} ${f.h}`}
              style={{ aspectRatio: `${f.w} / ${f.h}` }}
              onClick={(e) => tap(e, f)}
              role="img"
              aria-label={props.pointing ? `${f.name}: tap the elements you mean` : `${f.name}: tap a text to edit it, elsewhere to zoom`}
            >
              <FrameView frame={f} x={0} y={0} renderer={renderer} salt={salt} tc={tc} />
              {[...highlight].map((nid) => {
                const n = getNode(doc, nid);
                if (!n || !findIn(f, nid)) return null;
                const b = time === undefined ? nodeAabb(doc, n, tb) : nodeBoxAt(doc, n, time, tb);
                const pad = 6;
                return <rect key={nid} className={nid === props.focus ? "ph-focus" : "agent-change"} x={b.x - pad} y={b.y - pad} width={b.w + pad * 2} height={b.h + pad * 2} vectorEffect="non-scaling-stroke" />;
              })}
              {props.pointed.map((nid, i) => {
                const n = getNode(doc, nid);
                if (!n || !findIn(f, nid)) return null;
                const b = time === undefined ? nodeAabb(doc, n, tb) : nodeBoxAt(doc, n, time, tb);
                const pad = 8;
                const r = Math.max(18, f.w / 28);
                return (
                  <g key={`p-${nid}`} className="ph-pointed" data-pointed={nid}>
                    <rect x={b.x - pad} y={b.y - pad} width={b.w + pad * 2} height={b.h + pad * 2} vectorEffect="non-scaling-stroke" />
                    <circle cx={b.x - pad} cy={b.y - pad} r={r} />
                    <text x={b.x - pad} y={b.y - pad} dy="0.35em" textAnchor="middle" fontSize={r * 1.15}>
                      {i + 1}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        ))}
      </div>
      {doc.motion ? <PhoneTransport doc={doc} rest={props.rest} onLive={props.onLive} testid="ph" /> : null}
      <div className="ph-preview-foot">
        {doc.frames.length > 1 ? (
          <span className="ph-dots" aria-hidden>
            {doc.frames.map((f, i) => <i key={f.id} className={i === index ? "on" : ""} />)}
          </span>
        ) : null}
        <span className="ph-dim grow">
          {props.pointing ? "Tap the elements you mean · tap again to drop" : `Tap a text to edit · elsewhere to zoom${doc.frames.length > 1 ? " · swipe for the next" : ""}`}
        </span>
        {props.onPointMode ? (
          <button className={`ph-btn${props.pointing ? " on" : ""}`} aria-pressed={props.pointing} data-testid="point-mode" onClick={props.onPointMode}>
            <Icon name="point" size={18} /> Point
          </button>
        ) : null}
        <button className="ph-btn icon" aria-label="Zoom" data-testid="zoom-open" onClick={props.onZoom}>
          <Icon name="plus" size={20} />
        </button>
      </div>
    </section>
  );
}

function ZoomPage(props: { index: number; onIndex: (i: number) => void; onClose: () => void; rest: boolean; onLive: () => void }) {
  const s = useEditor();
  const doc = s.doc!;
  const renderer = useRenderer(s.fonts!, doc);
  const time = useMoment(doc, props.rest);
  const tc = useMemo(() => makeTimeContext(s.fonts!, doc, time), [s.fonts, doc, time]);
  return (
    <ZoomViewer
      doc={doc}
      renderer={renderer}
      salt={`${doc.lang}|${s.assetsVersion}`}
      index={props.index}
      onIndex={props.onIndex}
      onClose={props.onClose}
      tc={tc}
      transport={doc.motion ? <PhoneTransport doc={doc} rest={props.rest} onLive={props.onLive} testid="zoom" /> : null}
    />
  );
}

// ---------------------------------------------------------------- text list + edit

function TextList({ frame, onOpen }: { frame: Frame; onOpen: (id: string) => void }) {
  const layers = useMemo(() => textLayers(frame), [frame]);
  const [more, setMore] = useState(false);
  if (!layers.length) return null;
  const main = layers.filter((l) => !l.inGroup);
  const nested = layers.filter((l) => l.inGroup);
  const row = (l: TextLayer) => (
    <li key={l.id}>
      <button className="ph-text-row" data-testid={`text-${l.id}`} onClick={() => onOpen(l.id)}>
        {l.label || l.blocked ? (
          <span className="ph-text-label">
            {l.label}
            {l.blocked ? <Icon name="lock" size={14} /> : null}
          </span>
        ) : null}
        <span className="ph-text-snippet">{l.text || <i>(empty)</i>}</span>
      </button>
    </li>
  );
  return (
    <section className="ph-card" data-testid="phone-texts">
      <h2>Text on {frame.name}</h2>
      <ul className="ph-texts">
        {main.map(row)}
        {more ? nested.map(row) : null}
      </ul>
      {nested.length ? (
        <button className="ph-btn wide" data-testid="texts-more" onClick={() => setMore((m) => !m)}>
          {more ? "Hide the text inside groups" : `Show ${nested.length} more (inside groups, e.g. chart labels)`}
        </button>
      ) : null}
    </section>
  );
}

/** Spans drawn with their emphasis, so he sees which words are bold / coloured before editing. */
function SpanPreview({ spans, baseWeight }: { spans: Span[]; baseWeight: number }) {
  return (
    <p className="ph-spans" data-testid="span-preview">
      {spans.map((sp, i) => {
        const bold = (sp.weight ?? baseWeight) > baseWeight;
        const color = sp.fill !== undefined ? colorHex(sp.fill) : undefined;
        return (
          <span key={i} className={bold || color ? "ph-em" : undefined} style={{ fontWeight: bold ? 700 : undefined, color, background: color ? "#ffffff" : undefined }}>
            {sp.text}
          </span>
        );
      })}
    </p>
  );
}

function TextSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useEditor();
  const node = s.doc ? textNodeById(s.doc, id) : undefined;
  const [original] = useState(() => (node ? fullText(node.spans) : ""));
  const [value, setValue] = useState(original);
  const [warn, setWarn] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const ro = readOnlyReason({ ...s, preview: null });
  if (!node) {
    return (
      <SheetFrame title="Edit text" onClose={onClose}>
        <p className="ph-message">This layer is gone (the document changed).</p>
      </SheetFrame>
    );
  }
  const blocked = phoneEditBlock(node) ?? (s.doc ? lockedAbove(s.doc, id) : undefined);
  const save = async (force = false) => {
    const cur = textNodeById(useEditor.getState().doc!, id);
    if (!cur) return toast("This layer is gone (the document changed).", "error");
    if (fullText(cur.spans) !== original) {
      setWarn(null);
      return toast("Someone changed this text while you were typing. Copy your text, close and open it again.", "error");
    }
    const r = applyPlainEdit(cur.spans, value, cur.style.weight);
    if (!r.changed) return onClose();
    if (r.emphasisLost.length && !force) return setWarn(r.emphasisLost);
    setBusy(true);
    const st = useEditor.getState();
    const ok = commit(commitText(st.doc!, id, r.spans, textBox(st)), { select: [] });
    if (ok) await flushSaves();
    setBusy(false);
    if (ok && useEditor.getState().save.status !== "error") {
      toast(`Text saved (rev ${useEditor.getState().save.rev})`);
      onClose();
    }
  };
  return (
    <SheetFrame
      title={layerLabel(node) ? `Edit text · ${layerLabel(node)}` : "Edit text"}
      onClose={onClose}
      action={
        !blocked ? (
          <button className="ph-btn primary" data-testid="text-save" disabled={busy || !!ro} onClick={() => void save()}>
            Save
          </button>
        ) : undefined
      }
    >
      {ro ? <p className="ph-note warn">Read-only: {ro}.</p> : null}
      {blocked ? (
        <>
          <p className="ph-note warn" data-testid="text-blocked">{blocked}</p>
          <SpanPreview spans={node.spans} baseWeight={node.style.weight} />
        </>
      ) : (
        <>
          <textarea
            className="ph-textarea"
            data-testid="text-input"
            value={value}
            disabled={!!ro}
            rows={Math.min(10, Math.max(3, value.split("\n").length + 1))}
            onChange={(e) => (setValue(e.target.value), setWarn(null))}
            autoFocus
            spellCheck
          />
          {warn ? (
            <div className="ph-note warn" data-testid="emphasis-warning">
              Your change replaces styled words (“{warn.join("”, “")}”). The new text takes one style, so that emphasis goes away.
              <div className="ph-row-buttons">
                <button className="ph-btn danger" data-testid="text-save-anyway" onClick={() => void save(true)}>Save anyway</button>
                <button className="ph-btn" onClick={() => setWarn(null)}>Keep editing</button>
              </div>
            </div>
          ) : null}
          {node.spans.length > 1 ? (
            <>
              <p className="ph-dim small">Styled words keep their bold / colour when you change the words around them. New words take the style of the word they replace. Bold and colour themselves are changed on the desktop editor. How it will look:</p>
              <SpanPreview spans={applyPlainEdit(node.spans, value, node.style.weight).spans} baseWeight={node.style.weight} />
            </>
          ) : null}
          <p className="ph-dim small">Saved as your normal revision: the agent cannot undo it on its next turn.</p>
        </>
      )}
    </SheetFrame>
  );
}

// ---------------------------------------------------------------- hand-drawn shapes

/** Under the texts: how many shapes of this frame are hand-drawn, and the way to change it. */
function SketchCard({ frame, onOpen }: { frame: Frame; onOpen: () => void }) {
  const shapes = useMemo(() => sketchCandidates(frame), [frame]);
  if (!shapes.length) return null;
  const drawn = shapes.filter((n) => n.sketch).length;
  return (
    <section className="ph-card" data-testid="phone-sketch">
      <h2>Hand-drawn shapes</h2>
      <p className="ph-dim small" data-testid="sketch-count">
        {drawn ? `${drawn} of ${shapes.length} shapes on ${frame.name} are hand-drawn.` : `${shapes.length} shapes on ${frame.name} (bars, boxes, lines). Make them look drawn by hand: wobbly edges and a pen-hatched fill.`}
      </p>
      <button className="ph-btn wide" data-testid="sketch-open" onClick={onOpen}>
        {drawn ? "Change the hand-drawn look" : "Make shapes hand-drawn"}
      </button>
    </section>
  );
}

const PHONE_FILLS = [
  { id: "hachure", label: "Hatch" },
  { id: "cross-hatch", label: "Cross" },
  { id: "solid", label: "Solid" },
] as const;

function SketchSheet({ frame, onClose }: { frame: Frame; onClose: () => void }) {
  const s = useEditor();
  const ro = readOnlyReason({ ...s, preview: null });
  const shapes = sketchCandidates(frame);
  const firstDrawn = shapes.find((n) => n.sketch);
  const [picked, setPicked] = useState<string[]>(() => (firstDrawn ? shapes.filter((n) => n.sketch) : shapes).map((n) => n.id));
  const [fill, setFill] = useState<"hachure" | "cross-hatch" | "solid">(firstDrawn?.sketch?.fill ?? "hachure");
  const [rough, setRough] = useState(firstDrawn?.sketch?.roughness ?? 1);
  const [busy, setBusy] = useState(false);
  const save = async (on: boolean) => {
    const doc = useEditor.getState().doc!;
    const ids = picked.filter((id) => !!getNode(doc, id));
    if (!ids.length) return toast("Pick at least one shape.", "error");
    const c = on ? sketchLook(doc, ids, { fill, roughness: rough }) : setSketchOn(doc, ids, false);
    if (!c.ops.length) return onClose();
    setBusy(true);
    const ok = commit(c, { select: [] });
    if (ok) await flushSaves();
    setBusy(false);
    if (ok && useEditor.getState().save.status !== "error") {
      toast(on ? `Hand-drawn: ${ids.length} shape${ids.length === 1 ? "" : "s"} (rev ${useEditor.getState().save.rev})` : `Plain again: ${ids.length} shape${ids.length === 1 ? "" : "s"}`);
      onClose();
    }
  };
  const all = picked.length === shapes.length;
  return (
    <SheetFrame
      title="Hand-drawn shapes"
      testid="sketch-sheet"
      onClose={onClose}
      action={
        <button className="ph-btn primary" data-testid="sketch-apply" disabled={busy || !!ro || !picked.length} onClick={() => void save(true)}>
          Apply
        </button>
      }
    >
      {ro ? <p className="ph-note warn">Read-only: {ro}.</p> : null}
      <div className="ph-field">
        <span className="ph-dim small">Fill</span>
        <div className="ph-seg">
          {PHONE_FILLS.map((f) => (
            <button key={f.id} className={`ph-btn${fill === f.id ? " primary" : ""}`} data-testid={`sketch-fill-${f.id}`} onClick={() => setFill(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <label className="ph-field">
        <span className="ph-dim small">
          Roughness <b data-testid="sketch-rough-value">{rough.toFixed(1)}</b> (0 straight · 1 steady hand · 3 scribble)
        </span>
        <input type="range" className="ph-range" data-testid="sketch-roughness" min={0} max={4} step={0.1} value={rough} onChange={(e) => setRough(Number(e.target.value))} />
      </label>
      <div className="ph-field">
        <span className="ph-dim small">
          Shapes ({picked.length} of {shapes.length}){" "}
          <button className="ph-link inline" data-testid="sketch-pick-all" onClick={() => setPicked(all ? [] : shapes.map((n) => n.id))}>
            {all ? "none" : "all"}
          </button>
        </span>
        <ul className="ph-texts" data-testid="sketch-shapes">
          {shapes.map((n) => (
            <li key={n.id}>
              <label className="ph-check">
                <input type="checkbox" checked={picked.includes(n.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, n.id] : p.filter((x) => x !== n.id)))} />
                <span>{n.name ?? n.id}</span>
                {n.sketch ? <span className="ph-dim small">hand-drawn</span> : null}
              </label>
            </li>
          ))}
        </ul>
      </div>
      {shapes.some((n) => n.sketch && picked.includes(n.id)) ? (
        <button className="ph-btn wide danger" data-testid="sketch-off" disabled={busy || !!ro} onClick={() => void save(false)}>
          Make the picked shapes plain again
        </button>
      ) : null}
      <p className="ph-dim small">Pen width, hatch gap, angle and tint are on the desktop editor (Hand-drawn section). Saved as your normal revision; the export draws exactly the same lines.</p>
    </SheetFrame>
  );
}

// ---------------------------------------------------------------- edit together (multi-select)

/** Card under the texts: edit several elements at once (pick them with Point first). */
function TogetherCard({ count, onStart }: { count: number; onStart: () => void }) {
  return (
    <section className="ph-card" data-testid="phone-together">
      <h2>Edit several at once</h2>
      <p className="ph-dim small">Tap Point, pick the elements on the post (all the bars, all the labels), then Edit: one colour, text size, weight or opacity for all of them, saved as one change.</p>
      <button className="ph-btn wide" data-testid="together-open" onClick={onStart}>
        {count ? `Edit the ${count} picked` : "Pick elements"}
      </button>
    </section>
  );
}

const ALIGN_LABEL = { left: "Left", center: "Centre", right: "Right" } as const;

/**
 * The phone's shared-property sheet for the picked elements. Every field shows the value they share
 * or "Mixed"; changes wait in the sheet and Apply saves all of them as ONE revision (one undo).
 */
function TogetherSheet({ ids, onClose, onPicked }: { ids: string[]; onClose: () => void; onPicked: (ids: string[]) => void }) {
  const s = useEditor();
  const doc = s.doc!;
  const ro = readOnlyReason({ ...s, preview: null });
  const [picked, setPicked] = useState(ids);
  const [changes, setChanges] = useState<Partial<Record<FieldKey, unknown>>>({});
  const [busy, setBusy] = useState(false);
  const { ok, blocked } = phoneEditable(doc, picked);
  const nodes = ok.map((id) => getNode(doc, id)).filter((n): n is Node => !!n);
  const fields = new Map(sharedFields(nodes).map((f) => [f.key, f]));
  const counts = typeCounts(nodes);
  const kit = kitOf(doc);
  const fonts = s.fonts!;
  const texts = nodes.filter((n) => n.type === "text");
  const weights = [...new Set(texts.flatMap((n) => weightsOf(fonts, (n as any).style.font as string)))].sort((a, b) => a - b);
  const shown = (k: FieldKey): { value: any; mixed: boolean; changed: boolean } | undefined => {
    const f = fields.get(k);
    if (!f) return undefined;
    if (k in changes) return { value: changes[k], mixed: false, changed: true };
    return f.value.mixed ? { value: undefined, mixed: true, changed: false } : { value: f.value.value, mixed: false, changed: false };
  };
  const stage = (k: FieldKey, v: unknown) => setChanges((c) => ({ ...c, [k]: v }));
  const of = (k: FieldKey) => {
    const f = fields.get(k);
    return f && !f.all ? ` · ${f.ids.length} of ${nodes.length}` : "";
  };
  const byType = matchingIds(doc, ok, "type");
  const byFill = matchingIds(doc, ok, "fill");
  const grow = (list: string[]) => {
    const next = phoneEditable(doc, list).ok;
    setPicked(next);
    onPicked(next.slice(0, 20));
  };
  const n = Object.keys(changes).length;
  const save = async () => {
    const st = useEditor.getState();
    const live = phoneEditable(st.doc!, picked).ok;
    if (!live.length) return toast("Pick at least one element.", "error");
    const c = setSharedMany(st.doc!, live, Object.entries(changes) as Array<[FieldKey, unknown]>, textBox(st), (f) => weightsOf(fonts, f));
    if (!c.ops.length) return onClose();
    setBusy(true);
    const done = commit(c, { select: [] });
    if (done) await flushSaves();
    setBusy(false);
    if (done && useEditor.getState().save.status !== "error") {
      toast(`Changed ${live.length} element${live.length === 1 ? "" : "s"} in one step (rev ${useEditor.getState().save.rev})`);
      onClose();
    }
  };
  const fill = shown("fill");
  const size = shown("size");
  const weight = shown("weight");
  const align = shown("align");
  const opacity = shown("opacity");
  const types = Object.keys(counts) as NodeType[];
  return (
    <SheetFrame
      title={`Edit ${nodes.length} together`}
      testid="together-sheet"
      onClose={onClose}
      action={
        <button className="ph-btn primary" data-testid="together-apply" disabled={busy || !!ro || !n || !nodes.length} onClick={() => void save()}>
          Apply{n ? ` (${n})` : ""}
        </button>
      }
    >
      {ro ? <p className="ph-note warn">Read-only: {ro}.</p> : null}
      <p className="ph-dim small" data-testid="together-types">
        {types.map((t) => countLabel(counts[t]!, t)).join(" · ") || "Nothing picked"}. Mixed = they differ; a new value sets them all.
      </p>
      {blocked.length ? (
        <p className="ph-note warn" data-testid="together-blocked">
          Left out: {blocked.map((b) => `${b.id} (${b.reason})`).join(", ")}.
        </p>
      ) : null}
      {byType.length > ok.length || byFill.length > ok.length ? (
        <div className="ph-row-buttons">
          {byType.length > ok.length ? (
            <button className="ph-btn" data-testid="together-match-type" onClick={() => grow(byType)}>
              + all of this type ({byType.length})
            </button>
          ) : null}
          {byFill.length > ok.length ? (
            <button className="ph-btn" data-testid="together-match-fill" onClick={() => grow(byFill)}>
              + same colour ({byFill.length})
            </button>
          ) : null}
        </div>
      ) : null}

      {fill ? (
        <div className="ph-field" data-testid="together-fill" data-mixed={fill.mixed ? "true" : undefined}>
          <span className="ph-dim small">
            {counts.text && types.length === 1 ? "Text colour" : counts.text ? "Colour (fill and text)" : "Fill"}
            {of("fill")}: <b data-testid="together-fill-value">{fill.mixed ? "Mixed" : fill.value === null ? "none" : colorName(fill.value as Color)}</b>
          </span>
          <div className="ph-swatches">
            {kit?.colors.map((c) => {
              const t = `${kit.id}.${c.name}`;
              const on = !fill.mixed && fill.value && (typeof fill.value === "string" ? fill.value.toUpperCase() === c.hex.toUpperCase() : (fill.value as { token: string }).token === t);
              return <button key={t} className={`ph-swatch${on ? " on" : ""}`} data-token={t} style={{ background: c.hex }} aria-label={c.label} title={`${c.label} · ${t}`} onClick={() => stage("fill", { token: t })} />;
            })}
            <label className="ph-swatch pick" title="Any colour">
              <input type="color" data-testid="together-fill-picker" value={(colorHexOf(fill.value as Color) ?? "#888888").slice(0, 7).toLowerCase()} onChange={(e) => stage("fill", e.target.value.toUpperCase())} />
            </label>
          </div>
        </div>
      ) : null}

      {texts.length ? (
        <>
          <div className="ph-field" data-testid="together-size" data-mixed={size?.mixed ? "true" : undefined}>
            <span className="ph-dim small">Text size{of("size")}</span>
            <div className="ph-stepper">
              <button className="ph-btn icon" aria-label="Smaller" data-testid="together-size-down" disabled={size?.value === undefined} onClick={() => stage("size", Math.max(1, Math.round((size!.value as number) - 2)))}>
                <Icon name="minus" size={18} />
              </button>
              <input
                type="number"
                inputMode="decimal"
                data-testid="together-size-input"
                placeholder={size?.mixed ? "Mixed" : undefined}
                value={size?.value ?? ""}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (e.target.value === "") setChanges((c) => { const x = { ...c }; delete x.size; return x; });
                  else if (Number.isFinite(v) && v >= 1 && v <= 2000) stage("size", Math.round(v * 100) / 100);
                }}
              />
              <button className="ph-btn icon" aria-label="Bigger" data-testid="together-size-up" disabled={size?.value === undefined} onClick={() => stage("size", Math.round((size!.value as number) + 2))}>
                <Icon name="plus" size={18} />
              </button>
            </div>
          </div>
          <label className="ph-field" data-mixed={weight?.mixed ? "true" : undefined}>
            <span className="ph-dim small">Weight{of("weight")}</span>
            <select className="ph-select" data-testid="together-weight" value={weight?.value ?? ""} onChange={(e) => e.target.value && stage("weight", Number(e.target.value))}>
              {weight?.mixed ? <option value="">Mixed</option> : null}
              {weights.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <div className="ph-field" data-mixed={align?.mixed ? "true" : undefined}>
            <span className="ph-dim small">Align{of("align")}{align?.mixed ? ": Mixed" : ""}</span>
            <div className="ph-seg">
              {(["left", "center", "right"] as const).map((a) => (
                <button key={a} className={`ph-btn${align?.value === a ? " primary" : ""}`} data-testid={`together-align-${a}`} onClick={() => stage("align", a)}>
                  {ALIGN_LABEL[a]}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {opacity ? (
        <label className="ph-field" data-mixed={opacity.mixed ? "true" : undefined}>
          <span className="ph-dim small">
            Opacity <b data-testid="together-opacity-value">{opacity.mixed ? "Mixed" : `${Math.round((opacity.value as number) * 100)}%`}</b>
          </span>
          <input type="range" className="ph-range" data-testid="together-opacity" min={0} max={100} step={5} value={opacity.mixed ? 100 : Math.round((opacity.value as number) * 100)} onChange={(e) => stage("opacity", Number(e.target.value) / 100)} />
        </label>
      ) : null}

      {n ? (
        <button className="ph-link" data-testid="together-reset" onClick={() => setChanges({})}>
          Forget my changes here
        </button>
      ) : null}
      <p className="ph-dim small">Apply saves every change above on the {nodes.length} picked as one revision; Undo last change (or History) takes it back in one step. Fonts, strokes, widths and lining elements up are on the desktop editor.</p>
    </SheetFrame>
  );
}

function lockedAbove(doc: Document, id: string): string | undefined {
  const blocked = doc.frames.flatMap((f) => textLayers(f)).find((l) => l.id === id)?.blocked;
  return blocked;
}

// ---------------------------------------------------------------- action bar + sheets

/** Under the preview while point mode is on: how many are picked, and the way on. */
function PointBar(props: { count: number; onClear: () => void; onDone: () => void; onHand: () => void; onEdit: () => void }) {
  return (
    <div className="ph-pointbar" data-testid="point-bar">
      <span className="grow">
        {props.count ? (
          <>
            <b data-testid="point-count">{props.count}</b> picked{props.count >= FOCUS_MAX ? " (max)" : ""}
          </>
        ) : (
          "Tap what you mean"
        )}
      </span>
      {props.count ? (
        <button className="ph-btn ghost" data-testid="point-clear" onClick={props.onClear}>
          Clear
        </button>
      ) : null}
      <button className="ph-btn" data-testid="point-done" onClick={props.onDone}>
        Done
      </button>
      {props.count ? (
        <button className="ph-btn" data-testid="point-edit" title="Change colour, text size, weight or opacity of everything picked, in one step" onClick={props.onEdit}>
          Edit
        </button>
      ) : null}
      {props.count ? (
        <button className="ph-btn primary" data-testid="point-hand" onClick={props.onHand}>
          Hand to agent
        </button>
      ) : null}
    </div>
  );
}

function ActionBar({ onSheet, pointed }: { onSheet: (s: Sheet) => void; pointed: number }) {
  const s = useEditor();
  const h = s.handoff;
  const ro = readOnlyReason({ ...s, preview: null });
  const agentTurn = h?.turn === "agent";
  const leased = !!(h?.lease && h.lease.holder !== "human");
  return (
    <nav className="ph-actions" data-testid="phone-actions">
      <button className="ph-btn" data-testid="history-open" onClick={() => onSheet({ kind: "history" })}>
        History
      </button>
      <button className="ph-btn" data-testid="approve" disabled={!!ro || agentTurn || !!h?.approved?.current} onClick={() => onSheet({ kind: "approve" })}>
        {h?.approved?.current ? "Approved" : "Approve"}
      </button>
      {agentTurn ? (
        <button className="ph-btn primary" data-testid="take-back" disabled={leased} title={leased ? "The agent is working; wait for it to hand back" : undefined} onClick={() => void takeBack()}>
          Take it back
        </button>
      ) : (
        <button className="ph-btn primary" data-testid="handoff" disabled={!!ro} onClick={() => onSheet({ kind: "handoff" })}>
          Hand to agent{pointed ? ` (${pointed})` : ""}
        </button>
      )}
    </nav>
  );
}

function SheetFrame(props: { title: string; onClose: () => void; action?: React.ReactNode; children: React.ReactNode; testid?: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    addEventListener("keydown", key);
    document.documentElement.classList.add("ph-locked");
    return () => {
      removeEventListener("keydown", key);
      document.documentElement.classList.remove("ph-locked");
    };
  }, [props.onClose]);
  return (
    <div className="ph-sheet" role="dialog" aria-label={props.title} data-testid={props.testid ?? "sheet"}>
      <header className="ph-sheet-head">
        <button className="ph-btn ghost" data-testid="sheet-close" onClick={props.onClose}>
          Cancel
        </button>
        <h2>{props.title}</h2>
        {props.action ?? <span className="ph-btn-space" />}
      </header>
      <div className="ph-sheet-body">{props.children}</div>
    </div>
  );
}

function HandoffSheet(props: {
  rest: boolean;
  note: string;
  onNote: (s: string) => void;
  pointed: string[];
  onUnpoint: (id: string) => void;
  onPointMore: () => void;
  onClose: () => void;
  onSent: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Paused away from the start of a motion post: "At 1.20 s" (what "here" means), removable.
  const [at, setAt] = useState<number | undefined>(() => {
    const ts = useTime.getState();
    return props.rest ? undefined : handoffMoment(useEditor.getState().doc, ts.t, ts.playing);
  });
  return (
    <SheetFrame
      title="Hand to agent"
      testid="handoff-sheet"
      onClose={props.onClose}
      action={
        <button
          className="ph-btn primary"
          data-testid="handoff-send"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await handToAgent(props.note, props.pointed, at);
            setBusy(false);
            if (ok) props.onSent();
          }}
        >
          Send
        </button>
      }
    >
      <FocusChips ids={props.pointed} onRemove={props.onUnpoint} />
      <AtChip at={at} onRemove={() => setAt(undefined)} />
      <textarea
        className="ph-textarea"
        data-testid="handoff-note"
        rows={5}
        autoFocus
        placeholder={props.pointed.length ? "e.g. make this shorter, keep my layout" : "e.g. make the headline shorter, keep my layout"}
        value={props.note}
        onChange={(e) => props.onNote(e.target.value)}
      />
      <button className="ph-btn wide" data-testid="point-more" onClick={props.onPointMore}>
        <Icon name="point" size={18} /> {props.pointed.length ? "Point at more" : "Point at elements on the post"}
      </button>
      <p className="ph-dim small">
        The agent sees your note{props.pointed.length ? ", what you point at," : ""} and exactly what you changed. Everything you changed since its last turn is pinned: it can edit on top, but not undo your tweaks. An agent job starts by itself, and OptiBot tells you on Telegram when it starts and when it is done.
      </p>
    </SheetFrame>
  );
}

function ApproveSheet({ onClose }: { onClose: () => void }) {
  const rev = useEditor((s) => s.save.rev);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <SheetFrame
      title={`Approve rev ${rev}`}
      testid="approve-sheet"
      onClose={onClose}
      action={
        <button className="ph-btn primary" data-testid="approve-send" disabled={busy} onClick={async () => { setBusy(true); const ok = await approve(note); setBusy(false); if (ok) onClose(); }}>
          Approve
        </button>
      }
    >
      <textarea className="ph-textarea" data-testid="approve-note" rows={3} placeholder="optional note, e.g. ready for LinkedIn" value={note} onChange={(e) => setNote(e.target.value)} />
      <p className="ph-dim small">Marks this version as done (checkpoint “approved”). Agents export the approved version. You can keep editing and approve again later.</p>
    </SheetFrame>
  );
}

function HistorySheet({ frame, onClose }: { frame: string; onClose: () => void }) {
  const s = useEditor();
  const [open, setOpen] = useState<number | null>(null);
  const [limit, setLimit] = useState(30);
  const head = s.handoff?.head ?? s.save.rev;
  const ro = readOnlyReason({ ...s, preview: null });
  useEffect(() => void refreshRevisions(), []);
  const list = s.revisions.slice(0, limit);
  return (
    <SheetFrame title="History" testid="history-sheet" onClose={onClose}>
      {ro ? <p className="ph-note warn">Read-only: {ro}. You can look, not restore.</p> : null}
      <ul className="ph-revs">
        {list.map((r) => {
          const isOpen = open === r.rev;
          return (
            <li key={r.rev} className={`ph-rev${r.rev === head ? " current" : ""} ${r.author === "human" ? "by-human" : "by-agent"}`} data-testid={`rev-${r.rev}`}>
              <button className="ph-rev-head" onClick={() => setOpen(isOpen ? null : r.rev)} aria-expanded={isOpen}>
                <span>
                  <b>rev {r.rev}</b> <span className="who">{authorLabel(r.author)}</span>
                  {r.rev === head ? <span className="chip">current</span> : null}
                </span>
                <span className="ph-dim">{ago(r.createdAt)}</span>
                <span className="ph-rev-msg">{r.message}</span>
              </button>
              {isOpen ? (
                <div className="ph-rev-open">
                  <img alt={`rev ${r.rev}`} src={`/v1/projects/${useEditor.getState().projectId}/render?format=png&scale=0.35&frame=${encodeURIComponent(frame)}&rev=${r.rev}`} />
                  <div className="ph-row-buttons">
                    {r.rev !== head ? (
                      <button className="ph-btn primary" data-testid="restore" disabled={!!ro} onClick={async () => { await restoreRevision(r.rev); onClose(); }}>
                        Restore this version
                      </button>
                    ) : null}
                    {r.rev > 0 && r.opCount > 0 ? (
                      <button className="ph-btn" data-testid={`revert-${r.rev}`} disabled={!!ro} onClick={async () => { if (await revertRevision(r.rev)) onClose(); }}>
                        Undo just this change
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {s.revisions.length > limit ? <button className="ph-btn wide" onClick={() => setLimit((l) => l + 30)}>Show older</button> : null}
    </SheetFrame>
  );
}
