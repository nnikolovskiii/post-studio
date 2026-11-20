// The editor page: top bar, banners, tools, layers, canvas, properties / history, shortcuts.
import { useEffect, useRef, useState } from "react";
import { authorLabel } from "../api.ts";
import { addFile, insertSvg, looksLikeSvg } from "../insert.ts";
import { focusChips } from "../model/focus.ts";
import { AtChip, FocusChips, handoffMoment } from "./FocusChips.tsx";
import { waitingBanner } from "../model/dispatch.ts";
import { copyNodes, deleteNodes, duplicateNodes, getNode, groupNodes, moveNodes, pasteNodes, ungroup, zOrder, type ZMove } from "../model/commands.ts";
import {
  actualSize,
  approve,
  commit,
  dismissAgentChanges,
  finishEditing,
  fitView,
  flushSaves,
  getClipboard,
  handToAgent,
  loadProject,
  openHistory,
  previewRevision,
  readOnlyReason,
  redo,
  restoreRevision,
  retryDispatch,
  select,
  selectAllInFrame,
  setClipboard,
  startEditing,
  stopProject,
  takeBack,
  textBox,
  toast,
  undo,
  useEditor,
  zoomAt,
  type Tool,
} from "../store.ts";
import { Canvas } from "./Canvas.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { LayersPanel } from "./LayersPanel.tsx";
import { PropertiesPanel } from "./PropertiesPanel.tsx";
import { Toasts } from "./Toasts.tsx";
import { docPalette } from "../model/brand.ts";
import { Icon, type IconName } from "./Icons.tsx";
import { deviceIsPhoneLike } from "./viewmode.ts";
import { resetTime, stepFrames, stop as stopPlayback, togglePlay, useTime, seek, clampTime } from "../timeline.ts";
import { deleteSelectedKeys, Timeline } from "./Timeline.tsx";
import { AddMotionButton, VideoButton } from "./MotionPanel.tsx";

const TOOLS: Array<{ id: Tool; key: string; label: string; icon: IconName }> = [
  { id: "select", key: "V", label: "Select / move", icon: "select" },
  { id: "text", key: "T", label: "Text", icon: "text" },
  { id: "rect", key: "R", label: "Rectangle", icon: "rect" },
  { id: "ellipse", key: "O", label: "Ellipse", icon: "ellipse" },
  { id: "line", key: "L", label: "Line", icon: "line" },
  { id: "hand", key: "H", label: "Hand (or hold Space)", icon: "hand" },
];

function canvasSize() {
  const el = document.querySelector(".canvas");
  const r = el?.getBoundingClientRect();
  return { w: r?.width ?? 800, h: r?.height ?? 600, x: r?.left ?? 0, y: r?.top ?? 0 };
}

/** Several downloads in a row (one per frame); a short pause keeps browsers from dropping some. */
export function downloadAll(files: Array<{ url: string; name: string }>) {
  files.forEach((f, i) =>
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = f.url;
      a.download = f.name;
      a.dataset.testid = "export-download";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 400),
  );
}

/** Text our copy puts on the system clipboard ("these are Post Studio layers"). */
const CLIP_MARK = "post-studio/layers";
const clip: { copied: boolean; shift: boolean; timer?: ReturnType<typeof setTimeout> } = { copied: false, shift: false };

/** Paste the layers copied inside the editor into the active frame. */
function pasteLayers() {
  const s = useEditor.getState();
  const doc = s.doc;
  const items = getClipboard();
  if (!doc || !items.length) return;
  const frame = s.activeFrame ?? doc.frames[0].id;
  const p = pasteNodes(doc, items, frame);
  commit(p, { select: p.created });
}

function useShortcuts() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, select, [contenteditable=true], dialog")) return;
      const s = useEditor.getState();
      const doc = s.doc;
      if (!doc) return;
      const mod = e.ctrlKey || e.metaKey;
      const sel = s.selection;
      const key = e.key.toLowerCase();
      const handled = () => e.preventDefault();
      if (e.key === " ") {
        if (!s.spaceDown) useEditor.setState({ spaceDown: true });
        return handled();
      }
      if (mod && key === "z") return handled(), e.shiftKey ? redo() : undo();
      if (mod && key === "y") return handled(), redo();
      if (mod && key === "s") return handled(), void flushSaves().then(() => toast("Saved"));
      if (mod && key === "a") return handled(), selectAllInFrame();
      if (mod && key === "d") {
        handled();
        if (!sel.length) return;
        const r = duplicateNodes(doc, sel);
        commit(r, { select: r.created });
        return;
      }
      // Copy / cut / paste leave the browser's own clipboard events running (no preventDefault):
      // the copy event marks the system clipboard as "our layers", the paste event sees what is on
      // it (Figma's Copy as SVG, an image) and decides. See onCopy / onPaste below.
      if (mod && key === "c" && !e.shiftKey) {
        if (!sel.length) return;
        setClipboard(copyNodes(doc, sel));
        clip.copied = true;
        toast(`Copied ${sel.length} layer${sel.length === 1 ? "" : "s"}`);
        return;
      }
      if (mod && key === "x") {
        if (!sel.length) return handled();
        setClipboard(copyNodes(doc, sel));
        clip.copied = true;
        commit(deleteNodes(doc, sel), { select: [] });
        return;
      }
      if (mod && key === "v") {
        // The paste event normally follows within a few ms; without one (no clipboard access),
        // paste our own layers.
        clip.shift = e.shiftKey;
        if (clip.timer) clearTimeout(clip.timer);
        clip.timer = setTimeout(() => {
          clip.timer = undefined;
          pasteLayers();
        }, 150);
        return;
      }
      if (mod && key === "g" && !e.shiftKey) {
        handled();
        if (!sel.length) return;
        const r = groupNodes(doc, sel, textBox(s));
        if ("error" in r) return toast(r.error, "error");
        commit(r, { select: [r.group] });
        return;
      }
      if (mod && key === "g" && e.shiftKey) {
        handled();
        for (const id of sel) {
          const n = getNode(useEditor.getState().doc!, id);
          if (n?.type === "group") {
            const r = ungroup(useEditor.getState().doc!, id, textBox(useEditor.getState()));
            if ("error" in r) toast(r.error, "error");
            else commit(r, { select: r.children });
          }
        }
        return;
      }
      if (mod && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        handled();
        const how: ZMove = e.code === "BracketRight" ? (e.shiftKey ? "front" : "forward") : e.shiftKey ? "back" : "backward";
        if (sel.length) commit(zOrder(doc, sel, how));
        return;
      }
      if (mod && (key === "0" || e.code === "Digit0")) return handled(), actualSize(s.activeFrame ?? undefined, canvasSize().w, canvasSize().h);
      if (mod && (key === "=" || key === "+")) return handled(), zoomAt(1.25, canvasSize().w / 2, canvasSize().h / 2);
      if (mod && key === "-") return handled(), zoomAt(0.8, canvasSize().w / 2, canvasSize().h / 2);
      if (mod) return;
      if (e.shiftKey && e.code === "Digit1") return handled(), fitView(canvasSize().w, canvasSize().h);
      if (e.shiftKey && e.code === "Digit2" && sel.length) return handled(), fitView(canvasSize().w, canvasSize().h, s.activeFrame ?? undefined);
      if (e.shiftKey && e.code === "Digit0") return handled(), actualSize(s.activeFrame ?? undefined, canvasSize().w, canvasSize().h);
      // Motion (PLAN-motion.md §6.1): K plays / pauses (Space already pans), , and . step one
      // frame (< and > ten), Home / End jump to the start / the last frame.
      if (doc.motion && !e.altKey) {
        if (key === "k") return handled(), togglePlay();
        if (e.key === "," || e.key === "<") return handled(), stepFrames(e.key === "<" ? -10 : -1);
        if (e.key === "." || e.key === ">") return handled(), stepFrames(e.key === ">" ? 10 : 1);
        if (e.key === "Home") return handled(), stopPlayback(), seek(0);
        if (e.key === "End") return handled(), stopPlayback(), seek(clampTime(doc.motion.duration));
      }
      if ((e.key === "Delete" || e.key === "Backspace") && useTime.getState().selectedKeys.length) return handled(), void deleteSelectedKeys();
      if (e.key.startsWith("Arrow")) {
        handled();
        if (!sel.length) return;
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        commit(moveNodes(doc, sel.filter((id) => !getNode(doc, id)?.locked), dx, dy, "nudge"), { mergeKey: `nudge:${sel.join(",")}` });
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") return handled(), sel.length && commit(deleteNodes(doc, sel), { select: [] });
      if (e.key === "Escape") {
        handled();
        if (s.preview) return void previewRevision(null);
        if (useTime.getState().popover || useTime.getState().selectedKeys.length) return void useTime.setState({ popover: null, selectedKeys: [] });
        if (s.scope) {
          const g = s.scope;
          useEditor.setState({ scope: null });
          return select([g]);
        }
        if (s.tool !== "select") return useEditor.setState({ tool: "select" });
        return select([]);
      }
      if (e.key === "Enter") {
        handled();
        if (sel.length !== 1) return;
        const n = getNode(doc, sel[0]);
        if (n?.type === "text") startEditing(n.id, { selectAll: true });
        else if (n?.type === "group" && n.children.length) {
          useEditor.setState({ scope: n.id });
          select([n.children[n.children.length - 1].id]);
        }
        return;
      }
      if (key === "'") return useEditor.setState({ showGuides: !s.showGuides });
      const tool = TOOLS.find((x) => x.key.toLowerCase() === key);
      if (tool && !e.altKey) return useEditor.setState({ tool: tool.id });
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") useEditor.setState({ spaceDown: false });
    };
    const blur = () => useEditor.setState({ spaceDown: false });
    const inField = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true], dialog");
    const onCopy = (e: ClipboardEvent) => {
      if (inField(e.target) || !clip.copied) return;
      clip.copied = false;
      // Mark the system clipboard as ours, so a later paste knows our layers are the newest copy.
      e.clipboardData?.setData("text/plain", `${CLIP_MARK} ${getClipboard().length}`);
      e.preventDefault();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (inField(e.target)) return;
      const timer = clip.timer;
      if (timer) clearTimeout(timer);
      clip.timer = undefined;
      const shiftHeld = clip.shift;
      clip.shift = false;
      const dt = e.clipboardData;
      if (!dt) return pasteLayers();
      e.preventDefault();
      const text = dt.getData("image/svg+xml") || dt.getData("text/plain");
      if (text && !text.startsWith(CLIP_MARK) && looksLikeSvg(text)) return void insertSvg(text, { name: "Pasted SVG", asPicture: shiftHeld });
      const file = Array.from(dt.files).find((f) => /^image\/(png|jpeg|webp|svg\+xml)$/.test(f.type));
      if (file && !(text ?? "").startsWith(CLIP_MARK)) return void addFile(file, { asPicture: shiftHeld });
      pasteLayers();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCopy);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCopy);
      window.removeEventListener("paste", onPaste);
      if (clip.timer) clearTimeout(clip.timer);
      clip.timer = undefined;
    };
  }, []);
}

function SaveStatus() {
  const s = useEditor();
  const v = s.save;
  const text =
    v.status === "saved"
      ? `Saved · rev ${v.rev}`
      : v.status === "waiting"
        ? `Unsaved changes…`
        : v.status === "saving"
          ? "Saving…"
          : v.status === "retrying"
            ? `Offline: ${v.pending} change${v.pending === 1 ? "" : "s"} waiting, retrying in ${Math.round((v.retryInMs ?? 0) / 1000)} s`
            : `Not saved: ${v.error}`;
  return (
    <span className={`save save-${v.status}`} data-testid="save-status" data-rev={v.rev} data-status={v.status} title={v.error}>
      {text}
    </span>
  );
}

function HandoffDialog({ onClose }: { onClose: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // What is selected when he presses Hand to agent is what "this" means; he can drop any of it.
  const [focus, setFocus] = useState<string[]>(() => {
    const s = useEditor.getState();
    return s.doc ? focusChips(s.doc, s.selection).map((c) => c.id) : [];
  });
  // A motion project paused away from the start: the playhead is the moment "here" means.
  const [at, setAt] = useState<number | undefined>(() => {
    const ts = useTime.getState();
    return handoffMoment(useEditor.getState().doc, ts.t, ts.playing);
  });
  return (
    <div className="modal-back" data-ui="modal" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()} data-testid="handoff-dialog">
        <h3>Hand to agent</h3>
        <p className="hint">The agent sees your note and exactly what you changed. Everything you changed since its last turn is pinned: it can edit on top, but not undo your tweaks. An agent job starts by itself.</p>
        <FocusChips ids={focus} onRemove={(id) => setFocus((f) => f.filter((x) => x !== id))} />
        <AtChip at={at} onRemove={() => setAt(undefined)} />
        <textarea
          autoFocus
          data-testid="handoff-note"
          rows={5}
          placeholder={focus.length ? "e.g. make this shorter, keep my layout" : "e.g. make the headline shorter, keep my layout"}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="row end">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            data-testid="handoff-send"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const doc = useEditor.getState().doc;
              // Only layers that still exist (one deleted while the dialog was open would be refused).
              const ok = await handToAgent(note, doc ? focusChips(doc, focus).map((c) => c.id) : [], at);
              setBusy(false);
              if (ok) onClose();
            }}
          >
            Hand to agent
          </button>
        </div>
      </div>
    </div>
  );
}

function ApproveDialog({ onClose }: { onClose: () => void }) {
  const s = useEditor();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const head = s.save.rev;
  return (
    <div className="modal-back" data-ui="modal" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()} data-testid="approve-dialog">
        <h3>Approve revision {head}</h3>
        <p className="hint">Marks this version as done (checkpoint “approved”). Agents export the approved version with <code>--rev last-approved</code>. You can keep editing and approve again later.</p>
        <textarea autoFocus data-testid="approve-note" rows={3} placeholder="optional note, e.g. ready for LinkedIn" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row end">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            data-testid="approve-send"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await approve(note);
              setBusy(false);
              if (ok) onClose();
            }}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

function ApprovalChip() {
  const s = useEditor();
  const a = s.handoff?.approved;
  if (!a) return null;
  return a.current ? (
    <span className="chip approved" data-testid="approved-chip" title={`${a.name}${a.note ? `: “${a.note}”` : ""}`}>
      <Icon name="check" size={12} /> Approved · rev {a.rev}
    </span>
  ) : (
    <span className="chip approved stale" data-testid="approved-chip" title={`${a.name} is rev ${a.rev}; you changed it since`}>
      Approved rev {a.rev} · edited since
    </span>
  );
}

/** Brand-kit verdict: OK, or the number of palette problems (click → the frame panel lists them). */
function PaletteChip() {
  const doc = useEditor((st) => st.doc);
  const v = useEditor((st) => st.assetsVersion);
  if (!doc) return null;
  const pal = docPalette(doc, v);
  if (!pal) return null;
  const n = pal.issues.length;
  const title = n ? pal.issues.map((i) => i.message).slice(0, 8).join("\n") : `Every colour is in the ${pal.kit} kit, one accent per frame${doc.strictPalette ? " · strict" : ""}`;
  return (
    <button className={`chip palette${n ? " bad" : " ok"}`} data-testid="palette-chip" title={title} onClick={() => select([])}>
      {n ? `${n} palette problem${n === 1 ? "" : "s"}` : `${pal.kit} palette OK`}
      {doc.strictPalette ? " · strict" : ""}
    </button>
  );
}

function ProtectedChip() {
  const s = useEditor();
  const n = s.pins?.soft.filter((p) => p.path !== "pins" && p.path !== "locked").length ?? 0;
  if (!n) return null;
  return (
    <span className="chip soft" data-testid="softpin-count" title={`You changed ${n} propert${n === 1 ? "y" : "ies"} since ${s.pins!.since}. The agent can't change them on its next turn (dashed pin in Layers).`}>
      <Icon name="pin" size={12} /> {n} kept
    </span>
  );
}

function Banner() {
  const s = useEditor();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (s.preview) {
    return (
      <div className="banner preview" data-testid="banner">
        Viewing revision {s.preview.rev} · {authorLabel(s.preview.author)} · “{s.preview.message}” — read-only.
        <button className="primary" onClick={() => void restoreRevision(s.preview!.rev)}>
          Restore this version
        </button>
        <button onClick={() => void previewRevision(null)}>Back to current</button>
      </div>
    );
  }
  const h = s.handoff;
  const l = h?.lease;
  if (l && l.holder !== "human") {
    const left = Math.max(0, Math.round((Date.parse(l.expiresAt) - Date.now()) / 1000));
    return (
      <div className="banner lease" data-testid="banner">
        <Icon name="agent" /> <b>{l.holder.replace(/^agent:/, "")}</b> is working on this project. The editor is read-only until it hands back (lease ends in {left >= 60 ? `${Math.round(left / 60)} min` : `${left} s`}).
      </div>
    );
  }
  if (h?.turn === "agent") {
    const w = waitingBanner(h);
    const pointed = h.handoff?.focus?.length ?? 0;
    return (
      <div className={`banner waiting${w.failed ? " failed" : ""}`} data-testid="banner" data-dispatch={w.state}>
        <span className="grow">
          Handed to the agent{h.handoff?.note && h.handoff.note !== "(no note)" ? <> with the note “{h.handoff.note}”</> : null}
          {pointed ? <>, pointing at {pointed} element{pointed === 1 ? "" : "s"}</> : null}
          {h.handoff?.atText ? <span data-testid="handoff-at">, at {h.handoff.atText}</span> : null}. <b data-testid="dispatch-status">{w.text}</b> You can still edit (your edits stay pinned).
        </span>
        {w.retry ? (
          <button className={w.failed ? "primary" : undefined} data-testid="retry-dispatch" onClick={() => void retryDispatch()}>
            {w.retry}
          </button>
        ) : null}
        <button data-testid="take-back" onClick={() => void takeBack()}>
          Take it back
        </button>
      </div>
    );
  }
  return null;
}

function AgentChanges() {
  const s = useEditor();
  const a = s.agentChanges;
  if (!a) return null;
  return (
    <div className="agent-card" data-ui="agent" data-testid="agent-changes">
      <div className="agent-card-head">
        <b>What the agent changed</b> <span>{a.checkpoint} · {authorLabel(a.author)}</span>
        <button className="mini" onClick={dismissAgentChanges} title="Dismiss">
          ×
        </button>
      </div>
      {a.summary ? <p>“{a.summary}”</p> : null}
      <p className="hint">Since {a.since}. Click a line to select the layer.</p>
      <ul>
        {a.items.map((i) => (
          <li key={i.id} data-change={i.id} onClick={() => i.kind !== "deleted" && select([i.id])} className={`k-${i.kind}`} title={i.kind === "deleted" ? undefined : "Select this layer"}>
            <code>{i.id}</code> {i.text}
          </li>
        ))}
        {!a.items.length ? <li>No changes.</li> : null}
      </ul>
    </div>
  );
}

export function EditorPage({ id, toPhone }: { id: string; toPhone?: () => void }) {
  const s = useEditor();
  const [handoff, setHandoff] = useState(false);
  const [approving, setApproving] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const svgInput = useRef<HTMLInputElement>(null);
  const svgAsPicture = useRef(false);
  useShortcuts();

  useEffect(() => {
    stopPlayback();
    void loadProject(id).then(resetTime);
    const before = (e: BeforeUnloadEvent) => {
      const st = useEditor.getState();
      if (st.save.pending > 0 || st.editing) {
        if (st.editing) finishEditing();
        void flushSaves();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", before);
    return () => {
      window.removeEventListener("beforeunload", before);
      stopPlayback();
      void flushSaves().then(stopProject);
    };
  }, [id]);

  if (s.loadError) {
    return (
      <div className="page-message">
        <p>Could not open this project: {s.loadError}</p>
        <a href="/">All projects</a>
      </div>
    );
  }
  if (!s.doc || !s.fonts) return <div className="page-message">Loading fonts and the document…</div>;
  const ro = readOnlyReason(s);
  const frame = s.activeFrame ?? s.doc.frames[0].id;
  const head = s.handoff?.head ?? s.save.rev;
  const renderUrl = (fmt: string, f: string) => `/v1/projects/${id}/render?format=${fmt}&frame=${encodeURIComponent(f)}&rev=${head}`;

  return (
    <div className={`editor${ro ? " read-only" : ""}`} data-testid="editor">
      <header className="topbar">
        <a href="/" className="home" title="All projects">
          <Icon name="logo" /> Post Studio
        </a>
        {toPhone && deviceIsPhoneLike() ? (
          <button data-testid="to-phone" onClick={toPhone} title="Back to the phone review view">
            Phone view
          </button>
        ) : null}
        <input
          className="title"
          key={s.doc.title}
          defaultValue={s.doc.title}
          disabled={!!ro}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== s.doc!.title) commit({ ops: [{ op: "set", node: "$doc", path: "title", value: v }], label: `rename to “${v}”` });
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <SaveStatus />
        <AddMotionButton />
        <ProtectedChip />
        <ApprovalChip />
        <PaletteChip />
        <span className="grow" />
        <button title="Undo (Ctrl+Z)" data-testid="undo" disabled={!s.undo.length || !!ro} onClick={undo}>
          <Icon name="undo" />
        </button>
        <button title="Redo (Ctrl+Shift+Z)" data-testid="redo" disabled={!s.redo.length || !!ro} onClick={redo}>
          <Icon name="redo" />
        </button>
        <span className="sep" />
        <button title="Zoom out (Ctrl −)" onClick={() => zoomAt(0.8, canvasSize().w / 2, canvasSize().h / 2)}>
          <Icon name="minus" />
        </button>
        <button className="zoom" title="Fit all frames (Shift+1); 100 % with Shift+0" data-testid="zoom" onClick={() => fitView(canvasSize().w, canvasSize().h)}>
          {Math.round(s.view.zoom * 100)} %
        </button>
        <button title="Zoom in (Ctrl +)" onClick={() => zoomAt(1.25, canvasSize().w / 2, canvasSize().h / 2)}>
          <Icon name="plus" />
        </button>
        <button title="Actual size of the active frame (Shift+0)" data-testid="zoom-100" onClick={() => actualSize(frame, canvasSize().w, canvasSize().h)}>
          1:1
        </button>
        <label className="check" title="Template guides (')">
          <input type="checkbox" data-testid="toggle-guides" checked={s.showGuides} onChange={(e) => useEditor.setState({ showGuides: e.target.checked })} /> Guides
        </label>
        <label className="check" title="Snapping (hold Ctrl / ⌘ while dragging to skip)">
          <input type="checkbox" checked={s.snapping} onChange={(e) => useEditor.setState({ snapping: e.target.checked })} /> Snap
        </label>
        <span className="sep" />
        <div className="menu">
          <button data-testid="export" onClick={() => setExportOpen((o) => !o)}>
            Export <Icon name="caretDown" size={12} />
          </button>
          {exportOpen ? (
            <div className="menu-list export" onClick={() => setExportOpen(false)}>
              {s.doc.frames.map((f) => (
                <div key={f.id} className="menu-group">
                  <b>{f.name}</b>
                  <a href={renderUrl("png", f.id)} download={`${f.id}-rev${head}.png`} data-testid={`export-png-${f.id}`}>
                    PNG
                  </a>
                  <a href={renderUrl("jpg", f.id)} download={`${f.id}-rev${head}.jpg`}>
                    JPG
                  </a>
                  <a href={renderUrl("svg", f.id)} download={`${f.id}-rev${head}.svg`} title="For browsers and the web: every letter placed exactly, fonts embedded">
                    SVG
                  </a>
                  <a href={renderUrl("figma", f.id)} download={`${f.id}-rev${head}.figma.svg`} data-testid={`export-figma-${f.id}`} title="For Figma: live text (one line = one text run), no embedded fonts. Drag the file into Figma.">
                    SVG for Figma
                  </a>
                </div>
              ))}
              {s.doc.frames.length > 1 ? (
                <button
                  className="menu-item"
                  data-testid="export-figma-all"
                  title="Downloads one SVG for Figma per frame (the browser may ask once to allow several downloads)"
                  onClick={() => downloadAll(s.doc!.frames.map((f) => ({ url: renderUrl("figma", f.id), name: `${f.id}-rev${head}.figma.svg` })))}
                >
                  All frames: SVG for Figma
                </button>
              ) : null}
              <p className="hint">Rendered by the server from the saved revision {head} (save first if you just changed something). For Figma use “SVG for Figma” and drag the files onto the Figma canvas.</p>
            </div>
          ) : null}
        </div>
        <VideoButton />
        <button data-testid="history-toggle" className={s.historyOpen ? "on" : ""} onClick={() => void openHistory(!s.historyOpen)}>
          History
        </button>
        <button
          data-testid="approve"
          disabled={!!ro || s.handoff?.turn === "agent" || !!s.handoff?.approved?.current}
          title={s.handoff?.approved?.current ? "This revision is approved" : "Mark the saved revision as done"}
          onClick={() => setApproving(true)}
        >
          Approve
        </button>
        <button className="primary" data-testid="handoff" disabled={!!ro || s.handoff?.turn === "agent"} onClick={() => setHandoff(true)}>
          Hand to agent
        </button>
      </header>
      <Banner />
      <div className="main">
        <aside className="left">
          <div className="tools" data-testid="tools">
            {TOOLS.map((t) => (
              <button key={t.id} data-testid={`tool-${t.id}`} className={s.tool === t.id ? "on" : ""} title={`${t.label} (${t.key})`} onClick={() => useEditor.setState({ tool: t.id })}>
                <Icon name={t.icon} />
              </button>
            ))}
            <button title="Add an image (PNG, JPEG, WebP)" data-testid="add-image" disabled={!!ro} onClick={() => imageInput.current?.click()}>
              <Icon name="image" />
            </button>
            <button
              title="Add an SVG as editable layers (Shift+click: as one picture)"
              data-testid="add-svg"
              disabled={!!ro}
              onClick={(e) => {
                svgAsPicture.current = e.shiftKey;
                svgInput.current?.click();
              }}
            >
              <Icon name="svg" />
            </button>
            <input ref={imageInput} data-testid="image-input" type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void addFile(f, { asPicture: true }); }} />
            <input ref={svgInput} data-testid="svg-input" type="file" accept="image/svg+xml,.svg" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; const pic = svgAsPicture.current; svgAsPicture.current = false; if (f) void addFile(f, { asPicture: pic, onlySvg: true }); }} />
          </div>
          <LayersPanel />
        </aside>
        <section
          className="center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            // An SVG becomes editable layers; hold Shift while dropping to keep it one picture.
            for (const f of Array.from(e.dataTransfer.files)) void addFile(f, { asPicture: e.shiftKey });
          }}
        >
          <div className="canvas-wrap">
            <Canvas />
            <AgentChanges />
          </div>
          <Timeline />
        </section>
        <aside className="right">{s.historyOpen ? <HistoryPanel /> : <PropertiesPanel />}</aside>
      </div>
      {handoff ? <HandoffDialog onClose={() => setHandoff(false)} /> : null}
      {approving ? <ApproveDialog onClose={() => setApproving(false)} /> : null}
      <Toasts />
    </div>
  );
}
