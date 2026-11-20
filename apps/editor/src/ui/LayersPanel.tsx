// Layers (PLAN §3.7): the frame / group tree, topmost first like Figma. Click selects
// (Shift adds), double-click renames, eye / lock / pin toggles, drag to reorder or regroup.
import { useEffect, useState } from "react";
import { findItem, type Document, type Frame, type Node } from "@post-studio/schema";
import { reorder, setProps } from "../model/commands.ts";
import { pinSummary, softPinsByNode } from "../model/pins.ts";
import { addFrame, commit, duplicateFrame, readOnlyReason, removeFrame, select, showFrame, textBox, useEditor, visibleDoc } from "../store.ts";
import { Icon } from "./Icons.tsx";

type DropPos = "above" | "below" | "inside";

const snippet = (n: Node) => (n.type === "text" ? n.spans.map((s) => s.text).join("").replace(/\s+/g, " ").slice(0, 40) : "");
const label = (n: Node) => (n.name && n.name !== n.id ? n.name : snippet(n) || n.id);

export function LayersPanel() {
  const s = useEditor();
  const doc = visibleDoc(s)!;
  const ro = !!readOnlyReason(s);
  const [open, setOpen] = useState<Set<string>>(() => new Set(doc.frames.map((f) => f.id)));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: DropPos } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const changed = new Set(s.agentChanges?.items.map((i) => i.id) ?? []);
  // What the agent may not touch on its next turn: his changes since its last checkpoint.
  const soft = softPinsByNode(s.preview ? [] : (s.pins?.soft ?? []), (id) => (findItem(doc, id)?.item as Node | undefined)?.pins);
  const softMark = (id: string) => {
    const paths = soft.get(id);
    if (!paths) return null;
    return (
      <span className="soft-pin" data-testid={`softpin-${id}`} data-paths={paths.join(" ")} title={`You changed ${pinSummary(paths)} since ${s.pins!.since}: the agent keeps it on its next turn`}>
        <Icon name="pin" size={12} />
      </span>
    );
  };

  // Reveal the selection: open every ancestor of a selected layer.
  useEffect(() => {
    const need: string[] = [];
    for (const id of s.selection) {
      let loc = findItem(doc, id);
      while (loc && loc.kind === "node") {
        need.push(loc.parent);
        loc = findItem(doc, loc.parent);
      }
    }
    if (need.some((x) => !open.has(x))) setOpen((o) => new Set([...o, ...need]));
    const el = s.selection.length ? document.querySelector(`[data-layer="${CSS.escape(s.selection[s.selection.length - 1])}"]`) : null;
    (el as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  }, [s.selection.join(","), doc]);

  // Close the frame menu on any click elsewhere, Escape or scroll.
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && (e.target as HTMLElement | null)?.closest?.(".frame-menu")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("wheel", close, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("wheel", close, true);
    };
  }, [menu]);

  // A new frame opens in the list so its layers show as he adds them.
  const added = (ok: boolean) => {
    const id = useEditor.getState().activeFrame;
    if (ok && id) setOpen((o) => new Set([...o, id]));
  };

  const toggle = (id: string) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const onDrop = (target: string, pos: DropPos) => {
    setDrop(null);
    const d = dragId;
    setDragId(null);
    if (!d || d === target || ro) return;
    const tl = findItem(doc, target);
    const dl = findItem(doc, d);
    if (!tl || !dl) return;
    let parent: string;
    let index: number;
    if (pos === "inside") {
      parent = target;
      const kids = (tl.item as Frame).children;
      index = kids.length - (dl.parent === target ? 1 : 0);
    } else {
      parent = tl.parent;
      index = pos === "above" ? tl.index + 1 : tl.index;
      if (dl.parent === parent && dl.index < index) index -= 1;
    }
    commit(reorder(doc, d, parent, Math.max(0, index), textBox(s)));
  };

  const rows: React.ReactNode[] = [];
  const pushNode = (n: Node, depth: number) => {
    const selected = s.selection.includes(n.id);
    const isGroup = n.type === "group";
    const expanded = open.has(n.id);
    const pinned = n.pins?.includes("*");
    rows.push(
      <div
        key={n.id}
        data-layer={n.id}
        data-testid={`layer-${n.id}`}
        className={`layer${selected ? " selected" : ""}${n.visible === false ? " hidden" : ""}${changed.has(n.id) ? " agent-changed" : ""}${drop?.id === n.id ? ` drop-${drop.pos}` : ""}${s.hover === n.id ? " hovered" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!ro && renaming !== n.id}
        onDragStart={(e) => {
          setDragId(n.id);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", n.id);
        }}
        onDragEnd={() => {
          setDragId(null);
          setDrop(null);
        }}
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const f = (e.clientY - r.top) / r.height;
          const pos: DropPos = isGroup && f > 0.3 && f < 0.7 ? "inside" : f < 0.5 ? "above" : "below";
          if (drop?.id !== n.id || drop.pos !== pos) setDrop({ id: n.id, pos });
        }}
        onDragLeave={() => drop?.id === n.id && setDrop(null)}
        onDrop={(e) => {
          e.preventDefault();
          onDrop(n.id, drop?.pos ?? "above");
        }}
        onClick={(e) => {
          const loc = findItem(doc, n.id);
          useEditor.setState({ scope: loc && loc.parent !== loc.frame ? loc.parent : null });
          select([n.id], e.shiftKey || e.metaKey || e.ctrlKey ? "toggle" : "replace");
        }}
        onMouseEnter={() => useEditor.setState({ hover: n.id })}
        onMouseLeave={() => useEditor.getState().hover === n.id && useEditor.setState({ hover: null })}
        onDoubleClick={() => !ro && setRenaming(n.id)}
      >
        <span className={`twisty${isGroup ? "" : " none"}`} onClick={(e) => (e.stopPropagation(), toggle(n.id))}>
          {isGroup ? <Icon name={expanded ? "caretDown" : "caretRight"} size={12} /> : null}
        </span>
        <span className={`type-icon t-${n.type}`} />
        {renaming === n.id ? (
          <input
            autoFocus
            className="rename"
            defaultValue={n.name ?? n.id}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setRenaming(null);
              const v = e.target.value.trim();
              if (v && v !== (n.name ?? n.id)) commit(setProps(doc, [n.id], "name", v, `rename ${n.id} to ${v}`));
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <span className="layer-name" title={`${n.id}${n.role ? ` · role ${n.role}` : ""}`}>
            {label(n)}
            {n.type === "text" && n.name && n.name !== n.id ? <span className="snippet"> {snippet(n)}</span> : null}
            {n.role && n.role !== n.id ? <em> {n.role}</em> : null}
          </span>
        )}
        {softMark(n.id)}
        <span className="layer-tools">
          <button title={pinned ? "Pinned: the agent keeps this layer" : "Pin (the agent keeps it)"} data-testid={`pin-${n.id}`} className={`mini${pinned ? " on" : " dim"}`} disabled={ro} onClick={(e) => (e.stopPropagation(), commit(setProps(doc, [n.id], "pins", pinned ? (n.pins!.filter((p) => p !== "*").length ? n.pins!.filter((p) => p !== "*") : undefined) : [...(n.pins ?? []), "*"], pinned ? `unpin ${n.id}` : `pin ${n.id}`)))}>
            <Icon name="pin" size={14} />
          </button>
          <button title={n.locked ? "Unlock" : "Lock (not clickable on the canvas)"} data-testid={`lock-${n.id}`} className={`mini${n.locked ? " on" : " dim"}`} disabled={ro} onClick={(e) => (e.stopPropagation(), commit(setProps(doc, [n.id], "locked", n.locked ? undefined : true, n.locked ? `unlock ${n.id}` : `lock ${n.id}`)))}>
            <Icon name={n.locked ? "lock" : "unlock"} size={14} />
          </button>
          <button title={n.visible === false ? "Show" : "Hide"} data-testid={`eye-${n.id}`} className={`mini${n.visible === false ? " on" : " dim"}`} disabled={ro} onClick={(e) => (e.stopPropagation(), commit(setProps(doc, [n.id], "visible", n.visible === false ? undefined : false, n.visible === false ? `show ${n.id}` : `hide ${n.id}`)))}>
            <Icon name={n.visible === false ? "eyeOff" : "eye"} size={14} />
          </button>
        </span>
      </div>,
    );
    if (isGroup && expanded) for (const c of [...n.children].reverse()) pushNode(c, depth + 1);
  };

  doc.frames.forEach((f, i) => {
    const openMenu = (x: number, y: number) => setMenu({ id: f.id, x, y });
    rows.push(
      <div
        key={`frame-${f.id}`}
        data-frame-row={f.id}
        data-testid={`frame-row-${f.id}`}
        className={`layer frame-row${s.activeFrame === f.id && !s.selection.length ? " selected" : ""}${drop?.id === f.id ? " drop-inside" : ""}${menu?.id === f.id ? " menu-open" : ""}`}
        title={`Frame ${i + 1} of ${doc.frames.length}. Right-click (or ⋯) to duplicate or remove it.`}
        onClick={() => showFrame(f.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!s.preview) openMenu(e.clientX, e.clientY);
        }}
        onDoubleClick={() => !ro && setRenaming(f.id)}
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          if (drop?.id !== f.id) setDrop({ id: f.id, pos: "inside" });
        }}
        onDrop={(e) => {
          e.preventDefault();
          onDrop(f.id, "inside");
        }}
      >
        <span className="twisty" onClick={(e) => (e.stopPropagation(), toggle(f.id))}>
          <Icon name={open.has(f.id) ? "caretDown" : "caretRight"} size={12} />
        </span>
        <span className="type-icon t-frame" />
        {renaming === f.id ? (
          <input
            autoFocus
            className="rename"
            data-testid={`rename-frame-${f.id}`}
            defaultValue={f.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setRenaming(null);
              const v = e.target.value.trim();
              if (v && v !== f.name) commit(setProps(doc, [f.id], "name", v.slice(0, 200), `rename frame ${f.id} to ${v}`));
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <span className="layer-name">
            {f.name} <em>{f.w}×{f.h}</em>
          </span>
        )}
        {softMark(f.id)}
        <span className="layer-tools">
          <button
            title="Frame actions: duplicate, remove"
            data-testid={`frame-menu-${f.id}`}
            className="mini dim"
            disabled={!!s.preview}
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              if (menu?.id === f.id) setMenu(null);
              else openMenu(r.left, r.bottom + 2);
            }}
          >
            <Icon name="more" size={14} />
          </button>
        </span>
      </div>,
    );
    if (open.has(f.id)) for (const n of [...f.children].reverse()) pushNode(n, 1);
  });

  const menuFrame = menu ? doc.frames.find((f) => f.id === menu.id) : undefined;
  return (
    <div className="layers" data-testid="layers">
      <h3>
        <span className="grow">Layers</span>
        <button
          className="add-frame"
          data-testid="add-frame"
          disabled={ro}
          title={ro ? `Read-only: ${readOnlyReason(s)}` : "Add a new empty frame (slide) at the end, the same size and background as this one"}
          onClick={() => added(addFrame())}
        >
          <Icon name="plus" size={12} /> Frame
        </button>
      </h3>
      <div className="layer-list">{rows}</div>
      {menu && menuFrame ? (
        <div className="menu-list frame-menu" data-testid="frame-menu" style={{ position: "fixed", left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 120), right: "auto", width: 220 }}>
          <button
            className="menu-item"
            data-testid="frame-duplicate"
            disabled={ro}
            onClick={() => {
              setMenu(null);
              added(duplicateFrame(menuFrame.id));
            }}
          >
            Duplicate frame
          </button>
          <button
            className="menu-item"
            data-testid="frame-rename"
            disabled={ro}
            onClick={() => {
              setMenu(null);
              setRenaming(menuFrame.id);
            }}
          >
            Rename
          </button>
          <button
            className="menu-item danger"
            data-testid="frame-remove"
            disabled={ro || doc.frames.length < 2}
            title={doc.frames.length < 2 ? "A post needs at least one frame" : undefined}
            onClick={() => {
              setMenu(null);
              if (confirm(`Remove frame “${menuFrame.name}” and its ${menuFrame.children.length} layers? (Undo brings it back.)`)) removeFrame(menuFrame.id);
            }}
          >
            Remove frame
          </button>
        </div>
      ) : null}
    </div>
  );
}

export type { Document };
