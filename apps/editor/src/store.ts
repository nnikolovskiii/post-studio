// Editor state (Zustand). The document is a local working copy: every action is an op batch
// from model/commands, applied here at once (packages/ops) and queued for autosave. Undo and
// redo apply inverse ops and send them as new revisions; history is never rewritten.
import { create } from "zustand";
import { apply, describe, type ItemDiff, type Op } from "@post-studio/ops";
import { findItem, SCHEMA_VERSION, type Document, type Frame, type Node, type TextNode } from "@post-studio/schema";
import type { FontRegistry } from "@post-studio/text";
import { api, ApiError, type HandoffState, type RevisionInfo } from "./api.ts";
import { ensureAssets } from "./assets.ts";
import { loadFonts } from "./fonts.ts";
import { Batch, commitText, deleteNodes, getNode, type ClipItem, type Command } from "./model/commands.ts";
import { addFrame as addFrameCmd, duplicateFrame as duplicateFrameCmd, frameOffsets } from "./model/frames.ts";
import { FRAME_PRESETS, type FramePreset } from "./model/guides.ts";
import type { PinsState } from "./model/pins.ts";
import { fullText, spansEqual, type Span } from "./model/richtext.ts";
import type { SnapLine } from "./model/snap.ts";
import { Outbox, type OutboxState } from "./sync.ts";
import { textBoxFn } from "./textlayout.ts";

export type Tool = "select" | "text" | "rect" | "ellipse" | "line" | "hand";

export interface UndoEntry {
  ops: Op[];
  inverse: Op[];
  label: string;
  mergeKey?: string;
  at: number;
}

export interface EditingText {
  id: string;
  spans: Span[];
  sel: [number, number];
  original: Span[];
  created: boolean;
}

export interface AgentChange {
  id: string;
  kind: ItemDiff["kind"];
  text: string;
  /** Property paths the agent changed (keyframes: anim.tracks.<track>.<key>…). */
  paths?: string[];
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export interface View {
  zoom: number;
  x: number;
  y: number;
}

export { FRAME_GAP, frameOffsets } from "./model/frames.ts";

export interface EditorState {
  fonts: FontRegistry | null;
  projectId: string | null;
  loadError: string | null;
  doc: Document | null;
  /** In-progress drag / text edit; drawn instead of `doc` until committed. */
  draft: Document | null;
  handoff: HandoffState | null;
  selection: string[];
  activeFrame: string | null;
  /** Entered group: clicks select its children. */
  scope: string | null;
  hover: string | null;
  tool: Tool;
  view: View;
  undo: UndoEntry[];
  redo: UndoEntry[];
  save: OutboxState;
  editing: EditingText | null;
  historyOpen: boolean;
  revisions: RevisionInfo[];
  preview: { rev: number; doc: Document; author: string; message: string; createdAt: string } | null;
  agentChanges: { checkpoint: string; since: string; summary: string; author: string; items: AgentChange[] } | null;
  /** Soft pins from the server: what the agent may not touch on its next turn. */
  pins: PinsState | null;
  snapLines: SnapLine[];
  showGuides: boolean;
  snapping: boolean;
  toasts: Toast[];
  assetsVersion: number;
  spaceDown: boolean;
}

const initial: EditorState = {
  fonts: null,
  projectId: null,
  loadError: null,
  doc: null,
  draft: null,
  handoff: null,
  selection: [],
  activeFrame: null,
  scope: null,
  hover: null,
  tool: "select",
  view: { zoom: 0.5, x: 40, y: 60 },
  undo: [],
  redo: [],
  save: { status: "saved", pending: 0, rev: 0 },
  editing: null,
  historyOpen: false,
  revisions: [],
  preview: null,
  agentChanges: null,
  pins: null,
  snapLines: [],
  showGuides: true,
  snapping: true,
  toasts: [],
  assetsVersion: 0,
  spaceDown: false,
};

export const useEditor = create<EditorState>(() => ({ ...initial }));
const set = useEditor.setState;
const get = useEditor.getState;

let outbox: Outbox | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
let clipboard: ClipItem[] = [];
let toastSeq = 0;
let reloadWanted = false;
let pinsTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------- derived

/** Why the editor is read-only right now (undefined = editable). */
export function readOnlyReason(s: EditorState = get()): string | undefined {
  if (!s.doc) return "loading";
  if (s.preview) return `viewing revision ${s.preview.rev}`;
  const l = s.handoff?.lease;
  if (l && l.holder !== "human") return `${l.holder.replace(/^agent:/, "")} is working on it`;
  return undefined;
}

export const visibleDoc = (s: EditorState = get()) => s.preview?.doc ?? s.draft ?? s.doc;

export function textBox(s: EditorState = get()) {
  const doc = visibleDoc(s);
  return textBoxFn(s.fonts!, doc?.lang ?? "mk");
}

export function selectedNodes(s: EditorState = get()): Node[] {
  const doc = visibleDoc(s);
  if (!doc) return [];
  return s.selection.map((id) => getNode(doc, id)).filter((n): n is Node => !!n);
}

export function frameFor(doc: Document, id: string | null): Frame | undefined {
  if (!id) return undefined;
  const loc = findItem(doc, id);
  return loc ? doc.frames.find((f) => f.id === loc.frame) : undefined;
}

// ---------------------------------------------------------------- toasts

export function toast(text: string, kind: Toast["kind"] = "info", ms?: number) {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms ?? (kind === "error" ? 7000 : 3500));
}

// ---------------------------------------------------------------- load / reload

export async function loadProject(id: string): Promise<void> {
  stopProject();
  set({ ...initial, projectId: id });
  try {
    const fonts = await loadFonts();
    const [p, h] = await Promise.all([api("GET", `/v1/projects/${id}`), api<HandoffState>("GET", `/v1/projects/${id}/handoff`)]);
    await ensureAssets(p.doc);
    outbox = new Outbox({
      rev: p.head,
      post: async (base, ops, message) => {
        const r = await api("POST", `/v1/projects/${id}/ops`, { base, ops, message });
        return { rev: r.rev, rebased: r.rebased };
      },
      onChange: (save) => set({ save }),
      onSaved: (r) => {
        set((s) => ({ handoff: s.handoff ? { ...s.handoff, head: r.rev } : s.handoff }));
        if (r.rebased) reloadWanted = true;
        if (get().historyOpen) void refreshRevisions();
        schedulePins();
      },
      onRejected: (err, dropped) => {
        toast(`${dropped} change${dropped === 1 ? "" : "s"} not saved: ${err.message}`, "error");
        reloadWanted = true;
        void maybeReload(true);
        void refreshHandoff();
      },
      toError: (e) => (e instanceof ApiError ? e : new ApiError(0, "error", (e as Error).message)),
    });
    set({ fonts, doc: p.doc, handoff: h, save: outbox.snapshot(), activeFrame: p.doc.frames[0]?.id ?? null });
    document.title = `${p.doc.title} · Post Studio`;
    void checkAgentChanges(h);
    void refreshPins();
    poll = setInterval(() => void tick(), 2000);
  } catch (e) {
    set({ loadError: (e as Error).message });
  }
}

export function stopProject() {
  outbox?.stop();
  outbox = undefined;
  if (poll) clearInterval(poll);
  poll = undefined;
  if (pinsTimer) clearTimeout(pinsTimer);
  pinsTimer = undefined;
}

/** Soft pins come from the server (it decides what the agent may touch); refetched after saves. */
export async function refreshPins() {
  const id = get().projectId;
  if (!id) return;
  try {
    const p = await api<{ since: string; soft: PinsState["soft"] }>("GET", `/v1/projects/${id}/pins`);
    if (get().projectId === id) set({ pins: { since: p.since, soft: p.soft } });
  } catch {
    /* not fatal: the display catches up on the next save */
  }
}

function schedulePins() {
  if (pinsTimer) clearTimeout(pinsTimer);
  pinsTimer = setTimeout(() => void refreshPins(), 250);
}

async function refreshHandoff(): Promise<HandoffState | undefined> {
  const id = get().projectId;
  if (!id) return;
  try {
    const h = await api<HandoffState>("GET", `/v1/projects/${id}/handoff`);
    const before = get().handoff;
    set({ handoff: h });
    // Any refresh may be the first to see a new agent checkpoint (a hand-back can land before
    // the hand-off's own refresh returns), so the change card is checked here, not only in tick.
    if (h.agent && h.agent.name !== before?.agent?.name) void checkAgentChanges(h);
    return h;
  } catch {
    return undefined;
  }
}

async function tick() {
  const before = get().handoff;
  const h = await refreshHandoff();
  if (!h || !outbox) return;
  if (h.head > outbox.rev) reloadWanted = true;
  await maybeReload();
  if (h.softPins !== before?.softPins || h.agent?.name !== before?.agent?.name || h.head !== before?.head) schedulePins();
}

/** Take the server's document when nothing local is pending. */
async function maybeReload(force = false) {
  const s = get();
  if (!reloadWanted || !outbox || !s.projectId) return;
  if (!force && (!outbox.idle || s.draft || s.editing)) return;
  reloadWanted = false;
  try {
    const p = await api("GET", `/v1/projects/${s.projectId}`);
    await ensureAssets(p.doc);
    outbox.resetRev(p.head);
    set((st) => ({
      doc: p.doc,
      draft: null,
      editing: null,
      selection: st.selection.filter((id) => !!findItem(p.doc, id)),
      assetsVersion: st.assetsVersion + 1,
    }));
    if (get().historyOpen) void refreshRevisions();
  } catch (e) {
    reloadWanted = true;
    if (!(e instanceof ApiError && e.retryable)) toast(`reload failed: ${(e as Error).message}`, "error");
  }
}

// ---------------------------------------------------------------- commit / undo / redo

export interface CommitOptions {
  select?: string[];
  /** Consecutive commits with the same key (within 1.5 s) form one undo step (colour pickers, nudges). */
  mergeKey?: string;
}

export function commit(cmd: Command | { error: string }, opts: CommitOptions = {}): boolean {
  const s = get();
  if ("error" in cmd) {
    toast(cmd.error, "error");
    set({ draft: null, snapLines: [] });
    return false;
  }
  const ro = readOnlyReason(s);
  if (ro) {
    toast(`Read-only: ${ro}`, "error");
    set({ draft: null, snapLines: [] });
    return false;
  }
  if (!cmd.ops.length) {
    set({ draft: null, snapLines: [], ...(opts.select ? { selection: opts.select } : {}) });
    return true;
  }
  let r: ReturnType<typeof apply>;
  try {
    r = apply(s.doc!, cmd.ops);
  } catch (e) {
    toast(`Not applied: ${(e as Error).message}`, "error");
    set({ draft: null, snapLines: [] });
    return false;
  }
  const now = Date.now();
  const last = s.undo[s.undo.length - 1];
  const undo =
    opts.mergeKey && last?.mergeKey === opts.mergeKey && now - last.at < 1500
      ? [...s.undo.slice(0, -1), { ops: [...last.ops, ...cmd.ops], inverse: [...r.inverse, ...last.inverse], label: last.label, mergeKey: opts.mergeKey, at: now }]
      : [...s.undo, { ops: cmd.ops, inverse: r.inverse, label: cmd.label, mergeKey: opts.mergeKey, at: now }].slice(-300);
  set({
    doc: r.doc,
    draft: null,
    snapLines: [],
    undo,
    redo: [],
    selection: (opts.select ?? s.selection).filter((id) => !!findItem(r.doc, id)),
  });
  outbox?.enqueue(cmd.ops, cmd.label);
  void ensureAssets(r.doc).then((changed) => changed && set((st) => ({ assetsVersion: st.assetsVersion + 1 })));
  return true;
}

function replay(from: "undo" | "redo") {
  const s = get();
  const ro = readOnlyReason(s);
  if (ro) return toast(`Read-only: ${ro}`, "error");
  if (s.editing) return;
  const stack = s[from];
  const entry = stack[stack.length - 1];
  if (!entry) return;
  const ops = from === "undo" ? entry.inverse : entry.ops;
  let r: ReturnType<typeof apply>;
  try {
    r = apply(s.doc!, ops);
  } catch (e) {
    set({ [from]: [] } as Partial<EditorState>);
    return toast(`Cannot ${from}: the document changed since (${(e as Error).message})`, "error");
  }
  const moved: UndoEntry = from === "undo" ? { ...entry, at: 0 } : { ops: entry.ops, inverse: r.inverse, label: entry.label, at: 0 };
  set({
    doc: r.doc,
    draft: null,
    [from]: stack.slice(0, -1),
    [from === "undo" ? "redo" : "undo"]: [...s[from === "undo" ? "redo" : "undo"], moved],
    selection: s.selection.filter((id) => !!findItem(r.doc, id)),
  } as Partial<EditorState>);
  outbox?.enqueue(ops, `${from}: ${entry.label}`);
  void ensureAssets(r.doc).then((changed) => changed && set((st) => ({ assetsVersion: st.assetsVersion + 1 })));
}

export const undo = () => replay("undo");
export const redo = () => replay("redo");
export const flushSaves = () => outbox?.flush() ?? Promise.resolve();

/** Show an in-progress change (drag, live colour) without committing it. */
export function setDraft(cmd: Command | null, snapLines: SnapLine[] = []) {
  const s = get();
  if (!cmd || !s.doc) return set({ draft: null, snapLines: [] });
  try {
    set({ draft: apply(s.doc, cmd.ops, { validate: false }).doc, snapLines });
  } catch {
    /* an invalid intermediate state: keep the last draft */
  }
}

// ---------------------------------------------------------------- selection

export function select(ids: string[], mode: "replace" | "toggle" | "add" = "replace") {
  set((s) => {
    let sel: string[];
    if (mode === "replace") sel = ids;
    else if (mode === "add") sel = [...new Set([...s.selection, ...ids])];
    else {
      sel = [...s.selection];
      for (const id of ids) sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
    }
    const frame = sel.length && s.doc ? frameFor(s.doc, sel[sel.length - 1])?.id : undefined;
    return { selection: sel, activeFrame: frame ?? s.activeFrame };
  });
}

export function selectAllInFrame() {
  const s = get();
  const doc = s.doc;
  if (!doc) return;
  if (s.scope) {
    const g = getNode(doc, s.scope);
    if (g?.type === "group") return select(g.children.filter((c) => !c.locked && c.visible !== false).map((c) => c.id));
  }
  const frame = doc.frames.find((f) => f.id === s.activeFrame) ?? doc.frames[0];
  select(frame.children.filter((c) => !c.locked && c.visible !== false).map((c) => c.id));
}

// ---------------------------------------------------------------- clipboard

export function setClipboard(items: ClipItem[]) {
  clipboard = items;
}
export const getClipboard = () => clipboard;

// ---------------------------------------------------------------- text editing

export function startEditing(id: string, opts: { selectAll?: boolean; created?: boolean; at?: number } = {}) {
  const s = get();
  if (readOnlyReason(s) || !s.doc) return;
  const n = getNode(s.doc, id);
  if (!n || n.type !== "text") return;
  const len = fullText(n.spans).length;
  const at = opts.at ?? len;
  set({
    editing: { id, spans: structuredClone(n.spans), sel: opts.selectAll ? [0, len] : [at, at], original: structuredClone(n.spans), created: !!opts.created },
    selection: [id],
    tool: "select",
  });
  updateEditingDraft();
}

export function updateEditing(patch: Partial<Pick<EditingText, "spans" | "sel">>) {
  const e = get().editing;
  if (!e) return;
  set({ editing: { ...e, ...patch } });
  if (patch.spans) updateEditingDraft();
}

function updateEditingDraft() {
  const s = get();
  const e = s.editing;
  if (!e || !s.doc || !s.fonts) return;
  const b = new Batch(s.doc);
  const cmd = commitText(s.doc, e.id, e.spans, textBoxFn(s.fonts, s.doc.lang));
  for (const op of cmd.ops) b.push(op);
  set({ draft: b.doc });
}

export function finishEditing() {
  const s = get();
  const e = s.editing;
  if (!e || !s.doc || !s.fonts) return;
  set({ editing: null, draft: null });
  const empty = !fullText(e.spans).trim();
  if (empty && e.created) {
    commit(deleteNodes(s.doc, [e.id]), { select: [] });
    return;
  }
  if (spansEqual(e.spans, e.original)) return;
  if (empty) {
    toast("Empty text kept; delete the layer if you meant to remove it");
  }
  commit(commitText(s.doc, e.id, e.spans, textBoxFn(s.fonts, s.doc.lang)), { select: [e.id] });
}

export function cancelEditing() {
  const e = get().editing;
  set({ editing: null, draft: null });
  if (e?.created && !fullText(e.original).trim()) {
    const doc = get().doc;
    if (doc && getNode(doc, e.id)) commit(deleteNodes(doc, [e.id]), { select: [] });
  }
}

// ---------------------------------------------------------------- frames

/** Make a frame the active one (no selection) and bring it into view on the canvas. */
export function showFrame(id: string) {
  set({ selection: [], activeFrame: id, scope: null });
  const reveal = () => revealFrame(id);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(reveal);
  else reveal();
}

/** Pan (or, if it does not fit at this zoom, fit) so the whole frame is on screen. */
export function revealFrame(id: string) {
  const doc = get().doc;
  const el = typeof document !== "undefined" ? document.querySelector(".canvas") : null;
  if (!doc || !el) return;
  const r = el.getBoundingClientRect();
  const f = doc.frames.find((x) => x.id === id);
  const o = frameOffsets(doc).get(id);
  if (!f || !o || r.width <= 0 || r.height <= 0) return;
  const { zoom, x, y } = get().view;
  const left = x + o.x * zoom;
  const top = y + o.y * zoom;
  const pad = 40;
  if (left >= 0 && top >= 0 && left + f.w * zoom <= r.width && top + f.h * zoom <= r.height) return;
  if (f.w * zoom > r.width - pad * 2 || f.h * zoom > r.height - pad * 2 - 30) return fitView(r.width, r.height, id);
  set({ view: { zoom, x: Math.round((r.width - f.w * zoom) / 2 - o.x * zoom), y: Math.round((r.height - f.h * zoom) / 2 + 15 - o.y * zoom) } });
}

/**
 * "+ Frame": a new empty frame at the end like the active frame (size, background, guides),
 * or a preset size from the Frames section. One revision; undo removes it.
 */
export function addFrame(preset?: FramePreset): boolean {
  const s = get();
  if (!s.doc) return false;
  if (s.editing) finishEditing();
  const cmd = addFrameCmd(get().doc!, s.activeFrame ?? undefined, preset);
  if (!commit(cmd, { select: [] }) || "error" in cmd) return false;
  showFrame(cmd.frame);
  return true;
}

/** A copy of a frame with all its layers (fresh ids) right after it. */
export function duplicateFrame(frameId: string): boolean {
  const s = get();
  if (!s.doc) return false;
  if (s.editing) finishEditing();
  const cmd = duplicateFrameCmd(get().doc!, frameId);
  if (!commit(cmd, { select: [] }) || "error" in cmd) return false;
  showFrame(cmd.frame);
  return true;
}

/** Remove a frame and its layers (undo brings it back). The last frame cannot go. */
export function removeFrame(frameId: string): boolean {
  const doc = get().doc;
  if (!doc) return false;
  const i = doc.frames.findIndex((f) => f.id === frameId);
  if (i < 0) return false;
  if (doc.frames.length < 2) return commit({ error: "A post needs at least one frame" });
  if (!commit({ ops: [{ op: "frame", action: "remove", frame: frameId }], label: `remove frame ${frameId}` })) return false;
  const next = get().doc!.frames[Math.min(i, get().doc!.frames.length - 1)];
  if (get().activeFrame === frameId) set({ activeFrame: next.id });
  return true;
}

export function newProjectDoc(title: string, presetId: FramePreset["id"]): Document {
  const p = FRAME_PRESETS.find((x) => x.id === presetId) ?? FRAME_PRESETS[0];
  return {
    schema: SCHEMA_VERSION,
    id: "prj_new0",
    title,
    lang: "mk",
    frames: [{ id: p.id === "ig" ? "square" : p.id, name: p.name, w: p.w, h: p.h, background: { color: "#FCFAF6" }, guides: p.guides, children: [] }],
  };
}

// ---------------------------------------------------------------- history

export async function openHistory(open = true) {
  set({ historyOpen: open });
  if (open) await refreshRevisions();
  else set({ preview: null });
}

export async function refreshRevisions() {
  const id = get().projectId;
  if (!id) return;
  try {
    const r = await api<{ revisions: RevisionInfo[] }>("GET", `/v1/projects/${id}/revisions`);
    set({ revisions: r.revisions.reverse() });
  } catch (e) {
    toast(`history: ${(e as Error).message}`, "error");
  }
}

export async function previewRevision(rev: number | null) {
  const s = get();
  if (rev === null || !s.projectId) return set({ preview: null });
  if (s.editing) finishEditing();
  const info = s.revisions.find((r) => r.rev === rev);
  const p = await api("GET", `/v1/projects/${s.projectId}?rev=${rev}`);
  await ensureAssets(p.doc);
  set((st) => ({ preview: { rev, doc: p.doc, author: info?.author ?? "", message: info?.message ?? "", createdAt: info?.createdAt ?? "" }, assetsVersion: st.assetsVersion + 1, draft: null }));
}

export async function restoreRevision(rev: number) {
  const s = get();
  if (!s.projectId || !outbox) return;
  set({ preview: null });
  await outbox.flush();
  try {
    const r = await api("POST", `/v1/projects/${s.projectId}/restore`, { rev, message: `restore to rev ${rev}` });
    reloadWanted = true;
    await maybeReload(true);
    set({ undo: [], redo: [] });
    toast(`Restored revision ${rev} as new revision ${r.rev}`);
    await refreshRevisions();
    schedulePins();
  } catch (e) {
    toast(`Restore failed: ${(e as Error).message}`, "error");
  }
}

/**
 * Undo one past revision as a new revision (PLAN Phase 4). Later changes stay; when a later
 * revision changed the same thing the server refuses and says which one.
 */
export async function revertRevision(rev: number): Promise<boolean> {
  const s = get();
  if (!s.projectId || !outbox) return false;
  const ro = readOnlyReason({ ...s, preview: null });
  if (ro) {
    toast(`Read-only: ${ro}`, "error");
    return false;
  }
  if (s.editing) finishEditing();
  await outbox.flush();
  try {
    const r = await api("POST", `/v1/projects/${s.projectId}/revert`, { rev });
    set({ preview: null });
    reloadWanted = true;
    await maybeReload(true);
    // Local undo steps may no longer line up with the document; History keeps everything.
    set({ undo: [], redo: [] });
    toast(`Reverted revision ${rev} as new revision ${r.rev}`);
    await refreshRevisions();
    schedulePins();
    return true;
  } catch (e) {
    toast(`Revert failed: ${(e as Error).message}`, "error");
    return false;
  }
}

// ---------------------------------------------------------------- hand-off, approve

/**
 * Hand over with a note and, optionally, the ids he is pointing at ("change this") and, for a
 * motion project, the playhead moment he means ("here", ms).
 */
export async function handToAgent(note: string, focus: string[] = [], at?: number): Promise<boolean> {
  const s = get();
  if (!s.projectId) return false;
  if (s.editing) finishEditing();
  await flushSaves();
  try {
    const withAt = at !== undefined && !!get().doc?.motion;
    await api("POST", `/v1/projects/${s.projectId}/handoff`, { note, ...(focus.length ? { focus } : {}), ...(withAt ? { at: Math.round(at) } : {}) });
    // He has seen the last turn's card by now; the next hand-back brings a new one.
    if (get().agentChanges) dismissAgentChanges();
    await refreshHandoff();
    toast(focus.length ? `Handed to the agent, pointing at ${focus.length} element${focus.length === 1 ? "" : "s"}. An agent job starts in a moment.` : "Handed to the agent. An agent job starts in a moment.");
    return true;
  } catch (e) {
    toast(`Hand-off failed: ${(e as Error).message}`, "error");
    return false;
  }
}

/** Ask the dispatcher again to start the agent job for the latest hand-off (after a failed start). */
export async function retryDispatch(): Promise<boolean> {
  const s = get();
  if (!s.projectId) return false;
  try {
    await api("POST", `/v1/projects/${s.projectId}/handoff/retry-dispatch`, {});
    await refreshHandoff();
    toast("Trying again to start the agent.");
    return true;
  } catch (e) {
    toast(`Retry failed: ${(e as Error).message}`, "error");
    return false;
  }
}

/** Cancel a hand-off the agent has not started (the server refuses while it holds a lease). */
export async function takeBack(): Promise<boolean> {
  const s = get();
  if (!s.projectId) return false;
  try {
    await api("POST", `/v1/projects/${s.projectId}/handoff/take-back`, {});
    await refreshHandoff();
    toast("Taken back: it is your turn again.");
    return true;
  } catch (e) {
    toast(`Take back failed: ${(e as Error).message}`, "error");
    return false;
  }
}

/** Nikola says it is done: checkpoint 'approved' at the saved head (human only, his turn). */
export async function approve(note: string): Promise<boolean> {
  const s = get();
  if (!s.projectId) return false;
  if (s.editing) finishEditing();
  await flushSaves();
  try {
    const r = await api<{ checkpoint: string; rev: number }>("POST", `/v1/projects/${s.projectId}/approve`, { note });
    await refreshHandoff();
    toast(`Approved revision ${r.rev} (${r.checkpoint}).`);
    return true;
  } catch (e) {
    toast(`Approve failed: ${(e as Error).message}`, "error");
    return false;
  }
}

const seenKey = (project: string) => `post-studio:seen-agent:${project}`;

async function checkAgentChanges(h: HandoffState) {
  const s = get();
  if (!s.projectId || !h.agent || h.turn !== "human") return;
  if (localStorage.getItem(seenKey(s.projectId)) === h.agent.name) return;
  // Compare with where this agent turn started (its hand-off, or the previous agent turn), so a
  // second hand-off never lists the first turn's edits again.
  const since = h.agent.since;
  if (!since || since.rev > h.agent.rev) return;
  try {
    const d = await api<{ items: ItemDiff[] }>("GET", `/v1/projects/${s.projectId}/diff?since=${encodeURIComponent(since.name)}&to=${encodeURIComponent(h.agent.name)}`);
    const items = d.items
      .filter((i) => i.authors?.some((a) => a.startsWith("agent:")) ?? true)
      .map((i) => ({ id: i.id, kind: i.kind, text: describe(i), paths: i.changes.map((c) => c.path) }));
    if (get().projectId !== s.projectId) return;
    set({ agentChanges: { checkpoint: h.agent.name, since: since.name, summary: h.agent.note ?? "", author: h.agent.author, items } });
  } catch {
    /* not fatal */
  }
}

export function dismissAgentChanges() {
  const s = get();
  if (s.projectId && s.agentChanges) localStorage.setItem(seenKey(s.projectId), s.agentChanges.checkpoint);
  set({ agentChanges: null });
}

// ---------------------------------------------------------------- view

export function fitView(width: number, height: number, frameId?: string) {
  const doc = get().doc;
  if (!doc || width <= 0 || height <= 0) return;
  const offs = frameOffsets(doc);
  const frames = frameId ? doc.frames.filter((f) => f.id === frameId) : doc.frames;
  if (!frames.length) return;
  const x0 = Math.min(...frames.map((f) => offs.get(f.id)!.x));
  const x1 = Math.max(...frames.map((f) => offs.get(f.id)!.x + f.w));
  const y0 = Math.min(...frames.map((f) => offs.get(f.id)!.y));
  const y1 = Math.max(...frames.map((f) => offs.get(f.id)!.y + f.h));
  const pad = 60;
  const zoom = Math.max(0.05, Math.min(4, (width - pad * 2) / (x1 - x0), (height - pad * 2 - 30) / (y1 - y0)));
  const z = Math.round(zoom * 1000) / 1000;
  set({ view: { zoom: z, x: Math.round((width - (x1 - x0) * z) / 2 - x0 * z), y: Math.round((height - (y1 - y0) * z) / 2 + 15 - y0 * z) } });
}

export function zoomAt(factor: number, sx: number, sy: number) {
  set((s) => {
    const zoom = Math.max(0.05, Math.min(8, s.view.zoom * factor));
    const k = zoom / s.view.zoom;
    return { view: { zoom, x: sx - (sx - s.view.x) * k, y: sy - (sy - s.view.y) * k } };
  });
}

/** 100 % with integer pan, so frame pixels land on screen pixels (used by the export check). */
export function actualSize(frameId: string | undefined, width: number, height: number) {
  const doc = get().doc;
  if (!doc) return;
  const offs = frameOffsets(doc);
  const f = doc.frames.find((x) => x.id === frameId) ?? doc.frames[0];
  const o = offs.get(f.id)!;
  set({ view: { zoom: 1, x: Math.round(Math.max(20, (width - f.w) / 2) - o.x), y: Math.round(Math.max(40, (height - f.h) / 2) - o.y) } });
}

export type { TextNode };
