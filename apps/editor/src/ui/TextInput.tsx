// In-place text editing: a hidden <textarea> takes the keyboard (typing, IME, paste, native
// undo inside the edit) and its changes are replayed onto the rich spans. Caret, selection and
// line moves come from the packages/text layout, so they match the glyphs drawn on the canvas.
import { useLayoutEffect, useRef } from "react";
import type { TextNode } from "@post-studio/schema";
import { weightsOf } from "../fonts.ts";
import { lineEnd, lineStart, verticalMove } from "../model/caret.ts";
import { getNode } from "../model/commands.ts";
import { attrsAt, fullText, replaceRange, setRangeAttr, textDiff, toggleBold, type SpanColor } from "../model/richtext.ts";
import { cancelEditing, finishEditing, toast, updateEditing, useEditor, visibleDoc } from "../store.ts";
import { layoutFor, spaceAdvance } from "../textlayout.ts";
import { colorHex } from "./PropertiesPanel.tsx";
import { kitOf } from "../model/brand.ts";
import { Icon } from "./Icons.tsx";

export function TextInput(props: { caret: { x: number; y: number }; boxTop: { x: number; y: number } }) {
  const s = useEditor();
  const e = s.editing!;
  const ref = useRef<HTMLTextAreaElement>(null);
  const preferredX = useRef<number | undefined>(undefined);
  const doc = visibleDoc(s)!;
  const node = getNode(doc, e.id) as TextNode;
  const text = fullText(e.spans);

  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    if (ta.value !== text) ta.value = text;
    if (ta.selectionStart !== e.sel[0] || ta.selectionEnd !== e.sel[1]) ta.setSelectionRange(e.sel[0], e.sel[1], ta.selectionDirection);
    if (document.activeElement !== ta && !(document.activeElement as HTMLElement | null)?.closest?.("[data-text-toolbar]")) ta.focus({ preventScroll: true });
  });

  if (!node) return null;
  const base = { weight: node.style.weight };

  const syncSel = () => {
    const ta = ref.current!;
    updateEditing({ sel: [ta.selectionStart, ta.selectionEnd] });
  };

  const onInput = () => {
    const ta = ref.current!;
    const d = textDiff(text, ta.value);
    const spans = replaceRange(e.spans, d.start, d.end, d.insert, base);
    preferredX.current = undefined;
    updateEditing({ spans, sel: [ta.selectionStart, ta.selectionEnd] });
  };

  const bold = () => {
    const [a, b] = e.sel;
    if (a === b) return;
    const ws = weightsOf(s.fonts!, node.style.font);
    const max = Math.max(...ws);
    const boldWeight = ws.find((w) => w >= Math.max(700, node.style.weight + 100)) ?? (max > node.style.weight ? max : undefined);
    if (!boldWeight) return toast(`${node.style.font} has no weight above ${node.style.weight}`, "error");
    updateEditing({ spans: toggleBold(e.spans, a, b, node.style.weight, boldWeight) });
  };

  const color = (hex: SpanColor | null) => {
    const [a, b] = e.sel;
    if (a === b) return;
    updateEditing({ spans: setRangeAttr(e.spans, a, b, "fill", hex, base) });
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    ev.stopPropagation();
    const ta = ref.current!;
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.key === "Escape") {
      ev.preventDefault();
      finishEditing();
      return;
    }
    if (mod && ev.key === "Enter") {
      ev.preventDefault();
      finishEditing();
      return;
    }
    if (mod && ev.key.toLowerCase() === "b") {
      ev.preventDefault();
      bold();
      return;
    }
    if (mod && (ev.key === "z" || ev.key === "Z" || ev.key === "y")) return; // the textarea's own undo
    const L = layoutFor(s.fonts!, node, doc.lang);
    const sp = spaceAdvance(s.fonts!, node, doc.lang);
    const backward = ta.selectionDirection === "backward";
    const anchor = backward ? ta.selectionEnd : ta.selectionStart;
    const focus = backward ? ta.selectionStart : ta.selectionEnd;
    const place = (idx: number) => {
      ev.preventDefault();
      const a = ev.shiftKey ? anchor : idx;
      ta.setSelectionRange(Math.min(a, idx), Math.max(a, idx), idx < a ? "backward" : "forward");
      updateEditing({ sel: [Math.min(a, idx), Math.max(a, idx)] });
    };
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      const m = verticalMove(L, text, focus, ev.key === "ArrowUp" ? -1 : 1, preferredX.current, sp);
      preferredX.current = m.x;
      return place(m.index);
    }
    preferredX.current = undefined;
    if (ev.key === "Home" && !mod) return place(lineStart(L, text, focus));
    if (ev.key === "End" && !mod) return place(lineEnd(L, text, focus));
  };

  const kit = kitOf(doc);
  const [a, b] = e.sel;
  const at = attrsAt(e.spans, a === b ? a : a + 1);
  const curFill = at.fill ?? node.style.fill;
  const isBold = a !== b && (at.weight ?? node.style.weight) > node.style.weight;

  return (
    <>
      <textarea
        ref={ref}
        data-ui="text-input"
        data-testid="text-input"
        className="text-input"
        style={{ left: props.caret.x, top: props.caret.y - 16 }}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        onInput={onInput}
        onSelect={syncSel}
        onKeyDown={onKeyDown}
        onKeyUp={syncSel}
        lang={doc.lang}
      />
      <div data-ui="text-toolbar" data-text-toolbar className="text-toolbar" style={{ left: props.boxTop.x, top: Math.max(4, props.boxTop.y - 42) }} onPointerDown={(ev) => ev.stopPropagation()}>
        <button className={isBold ? "on" : ""} title="Bold selection (Ctrl+B)" disabled={a === b} onMouseDown={(ev) => ev.preventDefault()} onClick={bold}>
          <b>B</b>
        </button>
        <label title="Colour of the selected text" className={a === b ? "disabled" : ""}>
          <input type="color" disabled={a === b} value={colorHex(curFill)} onChange={(ev) => color(ev.target.value.toUpperCase())} />
        </label>
        {kit
          ? kit.colors
              .filter((c) => c.name !== kit.paper)
              .map((c) => (
                <button key={c.name} className="kit-swatch" data-token={`${kit.id}.${c.name}`} title={`${c.label} · ${kit.id}.${c.name}`} disabled={a === b} style={{ background: c.hex }} onMouseDown={(ev) => ev.preventDefault()} onClick={() => color({ token: `${kit.id}.${c.name}` })} />
              ))
          : null}
        <button title="Clear span styling" disabled={a === b} onMouseDown={(ev) => ev.preventDefault()} onClick={() => updateEditing({ spans: setRangeAttr(setRangeAttr(e.spans, a, b, "fill", null, base), a, b, "weight", null, base) })}>
          <Icon name="clearStyle" size={14} /> style
        </button>
        <span className="sep" />
        <button title="Done (Esc)" onMouseDown={(ev) => ev.preventDefault()} onClick={() => finishEditing()}>
          Done
        </button>
        <button title="Cancel the edit" onMouseDown={(ev) => ev.preventDefault()} onClick={() => cancelEditing()}>
          Cancel
        </button>
      </div>
    </>
  );
}
