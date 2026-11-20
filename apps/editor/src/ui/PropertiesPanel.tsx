// Properties of the selection (PLAN §3.7): geometry, opacity, fill / stroke, text font, weight,
// size, line height, letter spacing, alignment, box mode; image fit; SVG recolour map; pins.
// With nothing selected: the active frame (size, background, guides, presets).
import { useEffect, useMemo, useState } from "react";
import { layoutFor } from "../textlayout.ts";
import { findItem, type Document, type Frame, type Node, type NodeType, type Sketch, type TextNode } from "@post-studio/schema";
import { matchingIds, type FieldKey } from "@post-studio/ops";
import { getAsset, uploadAsset } from "../assets.ts";
import { weightsOf } from "../fonts.ts";
import { nodeBox } from "../model/geometry.ts";
import { FRAME_PRESETS, GUIDE_SETS, guidesFor } from "../model/guides.ts";
import { pinLabel, softPinsByNode } from "../model/pins.ts";
import { Batch, getNode, groupNodes, resizeNode, rotateNode, setProps, setTextProps, ungroup, type Command } from "../model/commands.ts";
import { addFrame, commit, duplicateFrame, readOnlyReason, removeFrame, select, textBox, toast, useEditor, visibleDoc } from "../store.ts";
import { getKit, listKits } from "@post-studio/brand";
import { Icon } from "./Icons.tsx";
import { MotionSection } from "./MotionPanel.tsx";
import { colorHexOf, colorName, docPalette, kitOf, offPalette, type Color } from "../model/brand.ts";
import { isSketchable, reseedSketch, resetSketch, setSketchOn, setSketchOption, type SketchKey } from "../model/sketch.ts";
import { sketchParams, SKETCH_FILLS } from "@post-studio/render";
import { alignNodes, countLabel, distributeNodes, setShared, setSharedSize, sharedFields, sizeValues, typeCounts, type AlignHow } from "../model/shared.ts";
import type { FontRegistry } from "@post-studio/text";
import type { TextBoxFn } from "../model/geometry.ts";

/** #RRGGBB for an <input type=color>. Tokens resolve through the brand kits; unknown ones show magenta. */
export function colorHex(c: Color | null | undefined): string {
  return (colorHexOf(c) ?? "#FF00FF").toLowerCase();
}

const round = (n: number) => Math.round(n * 100) / 100;

function NumberField(props: { label: string; value: number | undefined; onCommit: (v: number) => void; step?: number; min?: number; max?: number; disabled?: boolean; title?: string; testid?: string; mixed?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (props.value === undefined || props.mixed ? "" : String(round(props.value)));
  const commitText = (t: string) => {
    setText(null);
    const v = Number(t.replace(",", "."));
    if (!Number.isFinite(v) || t.trim() === "") return;
    let x = v;
    if (props.min !== undefined) x = Math.max(props.min, x);
    if (props.max !== undefined) x = Math.min(props.max, x);
    if (props.mixed || props.value === undefined || Math.abs(x - props.value) > 1e-9) props.onCommit(x);
  };
  return (
    <label className={`field${props.mixed ? " mixed" : ""}`} title={props.title ?? (props.mixed ? "The selected layers differ. A new value sets them all." : undefined)}>
      <span>{props.label}</span>
      <input
        data-testid={props.testid}
        data-mixed={props.mixed ? "true" : undefined}
        placeholder={props.mixed ? "Mixed" : undefined}
        type="text"
        inputMode="decimal"
        disabled={props.disabled}
        value={shown}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commitText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            setText(null);
            (e.target as HTMLInputElement).blur();
          } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && props.value !== undefined && !props.mixed) {
            e.preventDefault();
            const step = (props.step ?? 1) * (e.shiftKey ? 10 : 1);
            commitText(String(props.value + (e.key === "ArrowUp" ? step : -step)));
          }
        }}
      />
    </label>
  );
}

function ColorField(props: { label: string; value: Color | null | undefined; onChange: (c: Color) => void; onClear?: () => void; disabled?: boolean; testid?: string; mixed?: boolean; note?: string }) {
  const v = props.mixed ? undefined : props.value;
  const kit = useEditor((st) => kitOf(st.doc ?? undefined));
  const token = v && typeof v !== "string" ? v.token : undefined;
  const [hex, setHex] = useState<string | null>(null);
  const alpha = typeof v === "string" && v.length === 9 ? v.slice(7) : "";
  const off = !props.mixed && offPalette(kit, v);
  const curHex = colorHexOf(v);
  return (
    <div className={`color-block${props.mixed ? " mixed" : ""}`} data-mixed={props.mixed ? "true" : undefined}>
      <div className="field color">
        <span title={props.note}>{props.label}</span>
        <input type="color" data-testid={props.testid} disabled={props.disabled} value={props.mixed ? "#888888" : colorHex(v)} onChange={(e) => props.onChange((e.target.value + alpha).toUpperCase())} />
        <input
          type="text"
          className="hex"
          data-testid={props.testid ? `${props.testid}-text` : undefined}
          disabled={props.disabled}
          title={token ? `${token} = ${curHex ?? "unknown token"}` : undefined}
          placeholder={props.mixed ? "Mixed" : undefined}
          value={hex ?? (props.mixed ? "" : token ? token : typeof v === "string" ? v : "none")}
          onChange={(e) => setHex(e.target.value)}
          onBlur={(e) => {
            setHex(null);
            const t = e.target.value.trim().replace(/^token\s+/, "");
            if (/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(t)) props.onChange(("#" + t.replace(/^#/, "")).toUpperCase());
            else if (/^[a-z0-9-]+\.[a-z0-9-]+$/.test(t) && t !== token) {
              if (colorHexOf({ token: t })) props.onChange({ token: t });
              else toast(`unknown colour token ${t}`, "error");
            } else if (props.mixed && !t) return;
            else if (t !== (typeof v === "string" ? v : (token ?? "none"))) toast("colours are #RRGGBB, #RRGGBBAA or a kit token (lux.ink)", "error");
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        {props.onClear && (v || props.mixed) ? (
          <button className="mini" title="Remove" disabled={props.disabled} onClick={props.onClear}>
            ×
          </button>
        ) : null}
      </div>
      {kit ? (
        <div className="kit-swatches" data-testid={props.testid ? `${props.testid}-kit` : undefined}>
          {kit.colors.map((c) => {
            const t = `${kit.id}.${c.name}`;
            const on = token === t || (!token && curHex === c.hex);
            return (
              <button
                key={c.name}
                className={`kit-swatch${on ? " on" : ""}`}
                data-token={t}
                disabled={props.disabled}
                style={{ background: c.hex }}
                title={`${c.label} · ${t} · ${c.hex}${c.note ? ` (${c.note})` : ""}`}
                onClick={() => props.onChange({ token: t })}
              />
            );
          })}
          {off ? (
            <span className="off-palette" data-testid="off-palette" title={`${colorName(v)} is not a ${kit.name} colour`}>
              off palette
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Hex colours used in an SVG asset, most frequent first. */
function svgColors(sha: string): string[] {
  const a = getAsset(sha);
  if (!a) return [];
  const text = new TextDecoder().decode(a.bytes);
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g)) {
    let h = m[1].toUpperCase();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    counts.set("#" + h, (counts.get("#" + h) ?? 0) + 1);
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([c]) => c).slice(0, 24);
}

export function PropertiesPanel() {
  const s = useEditor();
  const doc = visibleDoc(s)!;
  const ro = !!readOnlyReason(s);
  const tb = textBox(s);
  const nodes = s.selection.map((id) => getNode(doc, id)).filter((n): n is Node => !!n);
  const run = (c: Command | { error: string }, mergeKey?: string) => commit(c, { mergeKey });

  if (!nodes.length) {
    const frame = doc.frames.find((f) => f.id === s.activeFrame) ?? doc.frames[0];
    return <FrameProps doc={doc} frame={frame} ro={ro} />;
  }
  if (nodes.length > 1) return <MultiProps doc={doc} nodes={nodes} ro={ro} />;

  const n = nodes[0];
  const id = n.id;
  const box = nodeBox(n, tb);
  const loc = findItem(doc, id);
  const explicitPins = n.pins ?? [];
  const wholePinned = explicitPins.includes("*");

  return (
    <div className="props" data-testid="props">
      <h3>
        <span className={`type-icon t-${n.type}`} />
        <input
          className="name"
          key={id}
          defaultValue={n.name ?? id}
          disabled={ro}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== (n.name ?? id)) run(setProps(doc, [id], "name", v, `rename ${id} to ${v}`));
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </h3>
      <div className="meta-line">
        <code>{id}</code>
        {n.role ? <span className="role">role {n.role}</span> : null}
        {loc && loc.parent !== loc.frame ? <span className="role">in {loc.parent}</span> : null}
      </div>
      <MatchRow doc={doc} nodes={[n]} />

      <section>
        <h4>Position and size</h4>
        <div className="grid2">
          {n.type === "line" ? (
            <>
              <NumberField label="X1" value={n.x} disabled={ro} onCommit={(v) => run(setProps(doc, [id], "x", round(v), `move ${id}`))} />
              <NumberField label="Y1" value={n.y} disabled={ro} onCommit={(v) => run(setProps(doc, [id], "y", round(v), `move ${id}`))} />
              <NumberField label="X2" value={n.x + n.w} disabled={ro} onCommit={(v) => run(setProps(doc, [id], "w", round(v - n.x), `reshape ${id}`))} />
              <NumberField label="Y2" value={n.y + n.h} disabled={ro} onCommit={(v) => run(setProps(doc, [id], "h", round(v - n.y), `reshape ${id}`))} />
            </>
          ) : (
            <>
              <NumberField label="X" testid="prop-x" value={n.x} disabled={ro} onCommit={(v) => run(setProps(doc, [id], "x", round(v), `move ${id}`))} />
              <NumberField label="Y" testid="prop-y" value={n.y} disabled={ro} onCommit={(v) => run(setProps(doc, [id], "y", round(v), `move ${id}`))} />
              <NumberField label="W" testid="prop-w" value={box.w} min={0} disabled={ro} onCommit={(v) => run(resizeNode(doc, id, { ...box, w: v }, tb))} />
              <NumberField label="H" testid="prop-h" value={box.h} min={0} disabled={ro} title={n.type === "text" && n.box !== "fixed" ? "the text decides the height; changing it makes the box fixed" : undefined} onCommit={(v) => run(resizeNode(doc, id, { ...box, h: v }, tb))} />
            </>
          )}
          <NumberField label="Rotate °" testid="prop-rotation" value={n.rotation ?? 0} disabled={ro} onCommit={(v) => run(rotateNode(doc, id, Math.round(v * 1000) / 1000))} />
          <NumberField label="Opacity %" testid="prop-opacity" value={Math.round((n.opacity ?? 1) * 1000) / 10} min={0} max={100} disabled={ro} onCommit={(v) => run(setProps(doc, [id], "opacity", v >= 100 ? undefined : Math.round(v * 10) / 1000, `opacity ${v}% on ${id}`))} />
        </div>
        {loc && loc.kind === "node" ? <AlignRow doc={doc} ids={[id]} ro={ro} /> : null}
      </section>

      {n.type === "text" ? <TextProps doc={doc} n={n} ro={ro} /> : null}

      {n.type === "rect" || n.type === "ellipse" || n.type === "path" ? (
        <section>
          <h4>Fill</h4>
          <ColorField label="Fill" testid="prop-fill" value={n.fill} disabled={ro} onChange={(c) => run(setProps(doc, [id], "fill", c, `fill ${id} ${colorName(c)}`), `fill:${id}`)} onClear={() => run(setProps(doc, [id], "fill", null, `no fill on ${id}`))} />
          {n.type === "rect" ? <NumberField label="Radius" value={n.radius ?? 0} min={0} disabled={ro} onCommit={(v) => run(setProps(doc, [id], "radius", v ? v : undefined, `radius ${v} on ${id}`))} /> : null}
        </section>
      ) : null}

      {n.type === "rect" || n.type === "ellipse" || n.type === "path" || n.type === "line" ? <StrokeProps doc={doc} n={n} ro={ro} /> : null}

      <SketchProps doc={doc} nodes={[n]} ro={ro} />

      {n.type === "image" ? (
        <section>
          <h4>Image</h4>
          <label className="field">
            <span>Fit</span>
            <select value={n.fit} disabled={ro} onChange={(e) => run(setProps(doc, [id], "fit", e.target.value, `fit ${e.target.value} on ${id}`))}>
              <option value="contain">contain</option>
              <option value="cover">cover</option>
              <option value="fill">stretch</option>
            </select>
          </label>
          <ReplaceAsset id={id} accept="image/png,image/jpeg,image/webp" ro={ro} />
        </section>
      ) : null}

      {n.type === "svg" ? <RecolorProps doc={doc} n={n} ro={ro} /> : null}

      {n.type === "group" ? (
        <section>
          <h4>Group</h4>
          <p className="hint">{n.children.length} layers. Double-click to select inside.</p>
          <button disabled={ro} onClick={() => run(ungroup(doc, id, tb))}>
            Ungroup (Ctrl+Shift+G)
          </button>
        </section>
      ) : null}

      <MotionSection doc={doc} n={n} ro={ro} />

      <NodeBrand doc={doc} n={n} ro={ro} />

      <section>
        <h4>Pins</h4>
        <p className="hint">Pinned layers and properties are kept when the agent edits, until you unpin them. Your own changes are kept for the agent's next turn anyway (below).</p>
        <label className="check">
          <input type="checkbox" data-testid="prop-pin" checked={wholePinned} disabled={ro} onChange={(e) => run(setProps(doc, [id], "pins", e.target.checked ? [...new Set([...explicitPins, "*"])] : explicitPins.filter((p) => p !== "*").length ? explicitPins.filter((p) => p !== "*") : undefined, e.target.checked ? `pin ${id}` : `unpin ${id}`))} />
          Keep this layer (pin everything)
        </label>
        {explicitPins.filter((p) => p !== "*").map((p) => (
          <div key={p} className="pin-row">
            <Icon name="pin" size={12} /> <code>{p}</code>
            <button className="mini" disabled={ro} onClick={() => run(setProps(doc, [id], "pins", explicitPins.filter((x) => x !== p).length ? explicitPins.filter((x) => x !== p) : undefined, `unpin ${id}.${p}`))}>
              ×
            </button>
          </div>
        ))}
        <SoftPins id={id} explicit={explicitPins} ro={ro} />
      </section>

      {n.meta && Object.keys(n.meta).length ? (
        <section>
          <h4>Meta (kept for agents)</h4>
          <pre className="meta">{JSON.stringify(n.meta, null, 1).slice(0, 1200)}</pre>
        </section>
      ) : null}
    </div>
  );
}

/** The kit type style a text is set in exactly (font, weight, size and colour token), if any. */
function typeStyleOf(doc: Document, n: TextNode) {
  const kit = kitOf(doc);
  const fillToken = typeof n.style.fill === "string" ? undefined : n.style.fill.token;
  return kit?.type.find((t) => t.font === n.style.font && t.weight === n.style.weight && Math.abs(t.size - n.style.size) < 0.01 && fillToken === `${kit.id}.${t.fill}`);
}

/** A kit type style (TYPE-SCALE.md) on one or several texts: one command. */
function typeStyleCommand(doc: Document, ids: string[], name: string, fonts: FontRegistry, tb: TextBoxFn): Command | { error: string } {
  const kit = kitOf(doc);
  const t = kit?.style(name);
  if (!kit || !t) return { error: `no type style ${name}` };
  const ws = weightsOf(fonts, t.font);
  if (!ws.includes(t.weight)) return { error: `${t.font} ${t.weight} is not a registered font` };
  const texts = ids.map((id) => getNode(doc, id)).filter((x): x is TextNode => x?.type === "text");
  const ops: Command["ops"] = [];
  let cur = doc;
  for (const n of texts) {
    const style = { ...n.style, font: t.font, weight: t.weight, size: t.size, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, fill: { token: `${kit.id}.${t.fill}` } };
    if (style.letterSpacing === undefined) delete style.letterSpacing;
    const b = setTextProps(cur, [n.id], "style", style, tb);
    const spans = n.spans.map((sp) => ({ ...sp, ...(t.case === "upper" ? { text: sp.text.toLocaleUpperCase(doc.lang) } : t.case === "lower" ? { text: sp.text.toLocaleLowerCase(doc.lang) } : {}), ...(sp.weight !== undefined && !ws.includes(sp.weight) ? { weight: undefined } : {}) })).map((sp) => JSON.parse(JSON.stringify(sp)));
    if (JSON.stringify(spans) !== JSON.stringify(n.spans)) b.ops.push({ op: "set", node: n.id, path: "spans", value: spans });
    ops.push(...b.ops);
    cur = applyOps(cur, b.ops);
  }
  return { ops, label: `style ${kit.id}.${t.name} on ${texts.length === 1 ? texts[0].id : `${texts.length} texts`}` };
}

function applyOps(doc: Document, ops: Command["ops"]): Document {
  const b = new Batch(doc);
  for (const op of ops) b.push(op);
  return b.doc;
}

/**
 * Several layers selected: the properties they share (Figma style). A field the layers disagree on
 * shows "Mixed"; a new value sets it on all of them as one revision (one Ctrl+Z). Fields only some
 * of them have (fill on texts and bars, but not on an image) say "N of M".
 */
function MultiProps({ doc, nodes, ro }: { doc: Document; nodes: Node[]; ro: boolean }) {
  const s = useEditor();
  const tb = textBox(s);
  const fonts = s.fonts!;
  const ids = nodes.map((n) => n.id);
  const fields = new Map(sharedFields(nodes).map((f) => [f.key, f]));
  const wf = (fam: string) => weightsOf(fonts, fam);
  const mkey = (k: string) => `${k}:${ids.join(",")}`;
  const set = (key: FieldKey, value: unknown, merge = false) => commit(setShared(doc, fields.get(key)?.ids ?? ids, key, value, tb, wf), { mergeKey: merge ? mkey(key) : undefined });
  const counts = typeCounts(nodes);
  const types = Object.keys(counts) as NodeType[];
  const only = (...t: NodeType[]) => types.every((x) => t.includes(x));
  const allText = only("text");
  const v = (key: FieldKey) => fields.get(key)?.value;
  const mixed = (key: FieldKey) => !!v(key)?.mixed;
  const val = (key: FieldKey): any => {
    const x = v(key);
    return x && !x.mixed ? x.value : undefined;
  };
  const of = (key: FieldKey) => {
    const f = fields.get(key);
    return f && !f.all ? ` (${f.ids.length} of ${nodes.length})` : "";
  };
  const ws = (vals: number[]) => ({ value: vals[0], mixed: vals.some((x) => Math.abs(x - vals[0]) > 0.005) });
  const W = ws(sizeValues(nodes, tb, "w"));
  const H = ws(sizeValues(nodes, tb, "h"));
  const fill = fields.get("fill");
  const stroke = fields.get("stroke.color");
  const strokeAll = only("rect", "ellipse", "path", "line");
  const anyStroke = nodes.some((n) => (n as any).stroke);

  return (
    <div className="props multi" data-testid="props" data-multi={nodes.length}>
      <h3 data-testid="multi-title">{nodes.length} layers</h3>
      <div className="meta-line type-chips" data-testid="multi-types">
        {types.length === 1 ? (
          <span>all {countLabel(nodes.length, types[0]).replace(/^\d+ /, "")}</span>
        ) : (
          types.map((t) => (
            <button key={t} className="chip" data-testid={`select-type-${t}`} title={`Select only the ${TYPE_PLURAL(t)} (to edit what only they have)`} onClick={() => select(nodes.filter((n) => n.type === t).map((n) => n.id))}>
              {countLabel(counts[t]!, t)}
            </button>
          ))
        )}
      </div>
      <p className="hint pad" data-testid="multi-hint">A change here applies to all {nodes.length} as one step (Ctrl+Z undoes it). Mixed = they differ.</p>
      <MatchRow doc={doc} nodes={nodes} />
      <section>
        <h4>Align{ids.length >= 3 ? " and space" : ""}</h4>
        <AlignRow doc={doc} ids={ids} ro={ro} />
      </section>

      <section>
        <h4>Layer</h4>
        <div className="grid2">
          {W.value !== undefined ? <NumberField label="W" testid="multi-w" value={W.value} mixed={W.mixed} min={0} disabled={ro} onCommit={(x) => commit(setSharedSize(doc, ids, "w", round(x), tb))} /> : null}
          {H.value !== undefined ? <NumberField label="H" testid="multi-h" value={H.value} mixed={H.mixed} min={0} disabled={ro} onCommit={(x) => commit(setSharedSize(doc, ids, "h", round(x), tb))} /> : null}
          <NumberField label="Rotate °" testid="multi-rotation" value={val("rotation")} mixed={mixed("rotation")} disabled={ro} onCommit={(x) => set("rotation", Math.round(x * 1000) / 1000)} />
          <NumberField label="Opacity %" testid="multi-opacity" value={val("opacity") === undefined ? undefined : Math.round(val("opacity") * 1000) / 10} mixed={mixed("opacity")} min={0} max={100} disabled={ro} onCommit={(x) => set("opacity", x >= 100 ? undefined : Math.round(x * 10) / 1000)} />
        </div>
      </section>

      {fill && !allText ? (
        <section>
          <h4>{counts.text ? "Fill and text colour" : "Fill"}{of("fill")}</h4>
          <ColorField
            label="Fill"
            testid="multi-fill"
            value={val("fill")}
            mixed={mixed("fill")}
            disabled={ro}
            onChange={(c) => set("fill", c, true)}
            onClear={fill.ids.some((id) => getNode(doc, id)?.type !== "text") ? () => set("fill", null) : undefined}
          />
          {mixed("fill") ? <SwatchList values={(v("fill") as any).values} /> : null}
        </section>
      ) : null}

      {allText ? <MultiTextProps doc={doc} nodes={nodes as TextNode[]} ro={ro} set={set} val={val} mixed={mixed} /> : null}

      {only("rect") ? (
        <section>
          <h4>Corners</h4>
          <NumberField label="Radius" testid="multi-radius" value={val("radius")} mixed={mixed("radius")} min={0} disabled={ro} onCommit={(x) => set("radius", x)} />
        </section>
      ) : null}

      {stroke && strokeAll ? (
        <section>
          <h4>Stroke</h4>
          {anyStroke ? (
            <>
              <ColorField label="Colour" testid="multi-stroke" value={val("stroke.color")} mixed={mixed("stroke.color")} disabled={ro} onChange={(c) => set("stroke.color", c, true)} onClear={types.includes("line") ? undefined : () => set("stroke.color", null)} />
              <NumberField label="Width" testid="multi-stroke-width" value={val("stroke.width") ?? undefined} mixed={mixed("stroke.width")} min={0.1} max={1000} step={0.5} disabled={ro} onCommit={(x) => set("stroke.width", x)} />
            </>
          ) : (
            <button disabled={ro} data-testid="multi-add-stroke" onClick={() => set("stroke.color", "#190F0B")}>
              + Stroke on all {nodes.length}
            </button>
          )}
        </section>
      ) : null}

      <SketchProps doc={doc} nodes={nodes} ro={ro} />

      {only("image") ? (
        <section>
          <h4>Image</h4>
          <label className="field">
            <span>Fit</span>
            <select data-testid="multi-fit" value={val("fit") ?? ""} disabled={ro} onChange={(e) => e.target.value && set("fit", e.target.value)}>
              {mixed("fit") ? <option value="">Mixed</option> : null}
              <option value="contain">contain</option>
              <option value="cover">cover</option>
              <option value="fill">stretch</option>
            </select>
          </label>
        </section>
      ) : null}

      <div className="row">
        <button
          disabled={ro}
          onClick={() => {
            const r = groupNodes(doc, ids, tb);
            if ("error" in r) return toast(r.error, "error");
            commit(r, { select: [r.group] });
          }}
        >
          Group (Ctrl+G)
        </button>
      </div>
    </div>
  );
}

const TYPE_PLURAL = (t: NodeType) => countLabel(2, t).replace(/^2 /, "");

/** The different values of a Mixed colour, as small swatches (hover = name). */
function SwatchList({ values }: { values: unknown[] }) {
  return (
    <div className="mixed-swatches" data-testid="mixed-swatches">
      <span className="hint">now</span>
      {values.slice(0, 12).map((c, i) => (
        <span key={i} className="kit-swatch static" style={{ background: c === null ? "transparent" : colorHex(c as Color) }} title={c === null ? "none" : colorName(c as Color)} />
      ))}
      {values.length > 12 ? <span className="hint">+{values.length - 12}</span> : null}
    </div>
  );
}

/** Text properties for several texts: font, weight, size, spacing, alignment, box, colour, kit style. */
function MultiTextProps(props: { doc: Document; nodes: TextNode[]; ro: boolean; set: (k: FieldKey, v: unknown, merge?: boolean) => void; val: (k: FieldKey) => any; mixed: (k: FieldKey) => boolean }) {
  const { doc, nodes, ro, set, val, mixed } = props;
  const s = useEditor();
  const fonts = s.fonts!;
  const tb = textBox(s);
  const families = fonts.families();
  const fams = [...new Set(nodes.map((n) => n.style.font))];
  const weights = [...new Set(fams.flatMap((f) => weightsOf(fonts, f)))].sort((a, b) => a - b);
  const kit = kitOf(doc);
  const styles = nodes.map((n) => typeStyleOf(doc, n)?.name ?? "");
  const current = styles.every((x) => x === styles[0]) ? styles[0] : null;
  const ids = nodes.map((n) => n.id);
  return (
    <section data-testid="multi-text">
      <h4>Text · {nodes.length} texts</h4>
      {kit && kit.type.length ? (
        <label className="field">
          <span>Style</span>
          <select
            data-testid="multi-type-style"
            value={current ?? ""}
            disabled={ro}
            onChange={(e) => {
              if (!e.target.value) return;
              const c = typeStyleCommand(doc, ids, e.target.value, fonts, tb);
              if ("error" in c) return toast(c.error, "error");
              commit(c);
            }}
          >
            <option value="">{current === null ? "Mixed" : current ? "" : "custom"}</option>
            {kit.type.map((t) => (
              <option key={t.name} value={t.name}>
                {t.label} · {t.size}
                {t.assumed ? " (assumed)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className={`field${mixed("font") ? " mixed" : ""}`}>
        <span>Font</span>
        <select data-testid="multi-font" value={val("font") ?? ""} disabled={ro} onChange={(e) => e.target.value && set("font", e.target.value)}>
          {mixed("font") ? <option value="">Mixed</option> : null}
          {families.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <div className="grid2">
        <label className={`field${mixed("weight") ? " mixed" : ""}`}>
          <span>Weight</span>
          <select data-testid="multi-weight" value={val("weight") ?? ""} disabled={ro} onChange={(e) => e.target.value && set("weight", Number(e.target.value))}>
            {mixed("weight") ? <option value="">Mixed</option> : null}
            {weights.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <NumberField label="Size" testid="multi-size" value={val("size")} mixed={mixed("size")} min={1} max={2000} disabled={ro} onCommit={(x) => set("size", round(x))} />
        <NumberField label="Line height" testid="multi-lineheight" value={val("lineHeight")} mixed={mixed("lineHeight")} step={0.01} min={0.5} max={10} disabled={ro} onCommit={(x) => set("lineHeight", Math.round(x * 1000) / 1000)} />
        <NumberField label="Letter sp." testid="multi-letterspacing" value={val("letterSpacing")} mixed={mixed("letterSpacing")} step={0.1} disabled={ro} onCommit={(x) => set("letterSpacing", round(x))} />
      </div>
      <div className="field">
        <span>Align</span>
        <div className="seg" data-mixed={mixed("align") ? "true" : undefined}>
          {(["left", "center", "right"] as const).map((a) => (
            <button key={a} data-testid={`multi-align-${a}`} className={val("align") === a ? "on" : ""} disabled={ro} onClick={() => set("align", a)}>
              <Icon name={a === "left" ? "alignLeft" : a === "center" ? "alignCenter" : "alignRight"} />
            </button>
          ))}
        </div>
      </div>
      <label className={`field${mixed("box") ? " mixed" : ""}`}>
        <span>Box</span>
        <select data-testid="multi-box" value={val("box") ?? ""} disabled={ro} onChange={(e) => e.target.value && set("box", e.target.value)}>
          {mixed("box") ? <option value="">Mixed</option> : null}
          <option value="auto-width">auto width</option>
          <option value="fixed-width">fixed width (wraps)</option>
          <option value="fixed">fixed (overflow shown)</option>
        </select>
      </label>
      <ColorField label="Colour" testid="multi-text-fill" value={val("fill")} mixed={mixed("fill")} disabled={ro} onChange={(c) => set("fill", c, true)} />
      <p className="hint">Bold or coloured words keep their own style.</p>
    </section>
  );
}

/** "Select matching": the other layers in the same frame of the same type, or with the same fill. */
function MatchRow({ doc, nodes }: { doc: Document; nodes: Node[] }) {
  const ids = nodes.map((n) => n.id);
  const byType = matchingIds(doc, ids, "type");
  const byFill = matchingIds(doc, ids, "fill");
  const types = [...new Set(nodes.map((n) => n.type))];
  if (byType.length <= ids.length && byFill.length <= ids.length) return null;
  return (
    <div className="row wrap match-row" data-testid="match-row">
      <span className="hint">Select all</span>
      {byType.length > ids.length ? (
        <button className="mini-btn" data-testid="match-type" title={`Every visible, unlocked ${types.map(TYPE_PLURAL).join(" / ")} in this frame`} onClick={() => select(byType)}>
          same type ({byType.length})
        </button>
      ) : null}
      {byFill.length > ids.length ? (
        <button className="mini-btn" data-testid="match-fill" title="Every visible, unlocked layer in this frame with the same fill or text colour" onClick={() => select(byFill)}>
          same colour ({byFill.length})
        </button>
      ) : null}
    </div>
  );
}

const ALIGNS: Array<{ how: AlignHow; icon: string; label: string }> = [
  { how: "left", icon: "objLeft", label: "Align left edges" },
  { how: "hcenter", icon: "objHCenter", label: "Align centres (horizontally)" },
  { how: "right", icon: "objRight", label: "Align right edges" },
  { how: "top", icon: "objTop", label: "Align top edges" },
  { how: "vcenter", icon: "objVCenter", label: "Align middles (vertically)" },
  { how: "bottom", icon: "objBottom", label: "Align bottom edges" },
];

/** Align (several layers: to each other; one layer: to its frame) and space evenly (3 or more). */
function AlignRow({ doc, ids, ro }: { doc: Document; ids: string[]; ro: boolean }) {
  const s = useEditor();
  const tb = textBox(s);
  const loc = ids.length === 1 ? findItem(doc, ids[0]) : undefined;
  const frame = loc ? doc.frames.find((f) => f.id === loc.frame) : undefined;
  const frameBox = frame ? { x: 0, y: 0, w: frame.w, h: frame.h } : undefined;
  return (
    <div className={`align-row${ids.length === 1 ? " field" : ""}`} data-testid="align-row">
      {ids.length === 1 ? <span>To frame</span> : null}
      <div className="seg">
        {ALIGNS.map((a) => (
          <button key={a.how} data-testid={`align-obj-${a.how}`} title={ids.length === 1 ? `${a.label} with the frame` : a.label} disabled={ro} onClick={() => commit(alignNodes(doc, ids, a.how, tb, frameBox))}>
            <Icon name={a.icon} />
          </button>
        ))}
        {ids.length >= 3 ? (
          <>
            <button data-testid="distribute-h" title="Space evenly across (equal gaps, left to right)" disabled={ro} onClick={() => commit(distributeNodes(doc, ids, "h", tb))}>
              <Icon name="distH" />
            </button>
            <button data-testid="distribute-v" title="Space evenly down (equal gaps, top to bottom)" disabled={ro} onClick={() => commit(distributeNodes(doc, ids, "v", tb))}>
              <Icon name="distV" />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function TextProps({ doc, n, ro }: { doc: Document; n: TextNode; ro: boolean }) {
  const s = useEditor();
  const tb = textBox(s);
  const fonts = s.fonts!;
  const families = fonts.families();
  const weights = weightsOf(fonts, n.style.font);
  const id = n.id;
  const runText = (path: string, value: unknown, label: string, mergeKey?: string) => commit(setTextProps(doc, [id], path, value, tb, label), { mergeKey });
  const kit = kitOf(doc);
  const current = typeStyleOf(doc, n);
  const applyStyle = (name: string) => {
    const c = typeStyleCommand(doc, [id], name, fonts, tb);
    if ("error" in c) return toast(c.error, "error");
    commit(c);
  };
  return (
    <section>
      <h4>Text</h4>
      {kit && kit.type.length ? (
        <label className="field" title={current ? current.source : "choose a type style of the kit (TYPE-SCALE.md)"}>
          <span>Style</span>
          <select data-testid="prop-type-style" value={current?.name ?? ""} disabled={ro} onChange={(e) => e.target.value && applyStyle(e.target.value)}>
            <option value="">{current ? "" : "custom"}</option>
            {kit.type.map((t) => (
              <option key={t.name} value={t.name}>
                {t.label} · {t.size}
                {t.assumed ? " (assumed)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="field">
        <span>Font</span>
        <select
          data-testid="prop-font"
          value={n.style.font}
          disabled={ro}
          onChange={(e) => {
            const fam = e.target.value;
            const ws = weightsOf(fonts, fam);
            const w = ws.includes(n.style.weight) ? n.style.weight : ws.reduce((a, b) => (Math.abs(b - n.style.weight) < Math.abs(a - n.style.weight) ? b : a));
            const b = setTextProps(doc, [id], "style", { ...n.style, font: fam, weight: w }, tb, `font ${fam} ${w} on ${id}`);
            // Span weights outside the new family's range are dropped.
            const spans = n.spans.map((sp) => (sp.weight !== undefined && !ws.includes(sp.weight) ? { ...sp, weight: undefined } : sp)).map((sp) => JSON.parse(JSON.stringify(sp)));
            if (JSON.stringify(spans) !== JSON.stringify(n.spans)) b.ops.push({ op: "set", node: id, path: "spans", value: spans });
            commit(b);
          }}
        >
          {families.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <div className="grid2">
        <label className="field">
          <span>Weight</span>
          <select data-testid="prop-weight" value={n.style.weight} disabled={ro} onChange={(e) => runText("style.weight", Number(e.target.value), `weight ${e.target.value} on ${id}`)}>
            {weights.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <NumberField label="Size" testid="prop-size" value={n.style.size} min={1} max={2000} disabled={ro} onCommit={(v) => runText("style.size", round(v), `size ${round(v)} on ${id}`)} />
        <NumberField label="Line height" testid="prop-lineheight" value={n.style.lineHeight ?? 1.2} step={0.01} min={0.5} max={10} disabled={ro} onCommit={(v) => runText("style.lineHeight", Math.round(v * 1000) / 1000, `line height ${v} on ${id}`)} />
        <NumberField label="Letter sp." testid="prop-letterspacing" value={n.style.letterSpacing ?? 0} step={0.1} disabled={ro} onCommit={(v) => runText("style.letterSpacing", v ? round(v) : undefined, `letter spacing ${v} on ${id}`)} />
      </div>
      <div className="field">
        <span>Align</span>
        <div className="seg">
          {(["left", "center", "right"] as const).map((a) => (
            <button key={a} data-testid={`align-${a}`} className={n.align === a ? "on" : ""} disabled={ro} onClick={() => runText("align", a, `align ${a} on ${id}`)}>
              <Icon name={a === "left" ? "alignLeft" : a === "center" ? "alignCenter" : "alignRight"} />
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Box</span>
        <select value={n.box} disabled={ro} onChange={(e) => runText("box", e.target.value, `box ${e.target.value} on ${id}`)}>
          <option value="auto-width">auto width</option>
          <option value="fixed-width">fixed width (wraps)</option>
          <option value="fixed">fixed (overflow shown)</option>
        </select>
      </label>
      <ColorField label="Colour" testid="prop-text-fill" value={n.style.fill} disabled={ro} onChange={(c) => runText("style.fill", c, `text colour ${colorName(c)} on ${id}`, `tfill:${id}`)} />
      <TextOverflow n={n} />
      <p className="hint">Double-click the text to edit it. Select words, then Ctrl+B or the colour swatch for emphasis.</p>
    </section>
  );
}

function TextOverflow({ n }: { n: TextNode }) {
  const s = useEditor();
  const doc = visibleDoc(s)!;
  const L = layoutFor(s.fonts!, n, doc.lang);
  const over = L.overflowX > 0.5 || L.overflowY > 0.5;
  return (
    <p className={`hint${over ? " warn" : ""}`} data-testid="text-metrics">
      {L.lines.length} line{L.lines.length === 1 ? "" : "s"} · {round(L.width)} px wide
      {over ? ` · overflows by ${round(L.overflowX)} × ${round(L.overflowY)} px` : ""}
      {L.missingGlyphs.length ? ` · no glyph for ${L.missingGlyphs.join(" ")}` : ""}
    </p>
  );
}

function StrokeProps({ doc, n, ro }: { doc: Document; n: Extract<Node, { type: "rect" | "ellipse" | "path" | "line" }>; ro: boolean }) {
  const id = n.id;
  const st = n.stroke ?? undefined;
  const run = (c: Command, mk?: string) => commit(c, { mergeKey: mk });
  return (
    <section>
      <h4>Stroke</h4>
      {st ? (
        <>
          <ColorField label="Colour" testid="prop-stroke" value={st.color} disabled={ro} onChange={(c) => run(setProps(doc, [id], "stroke.color", c, `stroke ${colorName(c)} on ${id}`), `stroke:${id}`)} onClear={n.type === "line" ? undefined : () => run(setProps(doc, [id], "stroke", null, `no stroke on ${id}`))} />
          <div className="grid2">
            <NumberField label="Width" value={st.width} min={0.1} max={1000} step={0.5} disabled={ro} onCommit={(v) => run(setProps(doc, [id], "stroke.width", v, `stroke width ${v} on ${id}`))} />
            <label className="field">
              <span>Dash</span>
              <input
                type="text"
                defaultValue={st.dash?.join(" ") ?? ""}
                key={`${id}-${st.dash?.join(" ")}`}
                disabled={ro}
                placeholder="e.g. 12 8"
                onBlur={(e) => {
                  const parts = e.target.value.trim() ? e.target.value.trim().split(/[\s,]+/).map(Number) : [];
                  if (parts.some((x) => !Number.isFinite(x) || x < 0)) return toast("dash is a list of numbers", "error");
                  run(setProps(doc, [id], "stroke.dash", parts.length ? parts : undefined, `dash on ${id}`));
                }}
              />
            </label>
          </div>
          {n.type === "line" ? (
            <label className="field">
              <span>Cap</span>
              <select value={st.cap ?? "butt"} disabled={ro} onChange={(e) => run(setProps(doc, [id], "stroke.cap", e.target.value === "butt" ? undefined : e.target.value, `cap on ${id}`))}>
                <option value="butt">butt</option>
                <option value="round">round</option>
                <option value="square">square</option>
              </select>
            </label>
          ) : null}
        </>
      ) : (
        <button disabled={ro} onClick={() => run(setProps(doc, [id], "stroke", { color: "#190F0B", width: 2 }, `add stroke to ${id}`))}>
          + Stroke
        </button>
      )}
    </section>
  );
}

const FILL_LABEL = { hachure: "Hatch", "cross-hatch": "Cross", solid: "Solid" } as const;

/**
 * Hand-drawn look (node.sketch) for one or several shapes: wobbly pen outline and a hatched or
 * solid fill, drawn by the same renderer as the export (seeded, so it never jitters between renders).
 */
function SketchProps({ doc, nodes, ro }: { doc: Document; nodes: Node[]; ro: boolean }) {
  const shapes = nodes.filter(isSketchable);
  if (!shapes.length) return null;
  const ids = shapes.map((n) => n.id);
  const drawn = shapes.filter((n) => n.sketch);
  const on = drawn.length === shapes.length;
  const first = drawn[0];
  const P = first ? sketchParams(first) : undefined;
  // Several hand-drawn shapes that differ in an option show it as Mixed (a new value sets them all).
  const all = drawn.map((n) => sketchParams(n));
  const mx = (k: "fill" | "roughness" | "weight" | "gap" | "angle" | "tint") => all.some((p) => p[k] !== all[0][k]);
  const mk = `sketch:${ids.join(",")}`;
  const opt = <K extends SketchKey>(key: K, value: Sketch[K] | undefined, merge = false) => commit(setSketchOption(doc, ids, key, value), { mergeKey: merge ? `${mk}:${key}` : undefined });
  const hatch = all.some((p) => p.fill !== "solid");
  return (
    <section data-testid="sketch-section">
      <h4>Hand-drawn</h4>
      <label className="check" title="Wobbly pen outline and a hatched fill, like a marker sketch. Same in the export (PNG, SVG, video).">
        <input
          type="checkbox"
          data-testid="prop-sketch"
          checked={on}
          ref={(el) => {
            if (el) el.indeterminate = drawn.length > 0 && !on;
          }}
          disabled={ro}
          onChange={(e) => commit(setSketchOn(doc, ids, e.target.checked))}
        />
        Hand-drawn{shapes.length > 1 ? ` (${drawn.length} of ${shapes.length})` : ""}
      </label>
      {first && P ? (
        <>
          <div className="field">
            <span>Fill</span>
            <div className="seg">
              {SKETCH_FILLS.map((f) => (
                <button key={f} data-testid={`sketch-fill-${f}`} className={!mx("fill") && P.fill === f ? "on" : ""} disabled={ro} onClick={() => opt("fill", f === "hachure" ? undefined : f)}>
                  {FILL_LABEL[f]}
                </button>
              ))}
            </div>
          </div>
          <label className="field" title="How far edges and lines wander: 0 = straight, 1 = a steady hand, 3+ = a quick scribble">
            <span>Rough</span>
            <input type="range" data-testid="sketch-roughness" min={0} max={5} step={0.1} value={P.roughness} disabled={ro} onChange={(e) => opt("roughness", Number(e.target.value), true)} />
            <code className="range-value" data-mixed={mx("roughness") ? "true" : undefined}>{mx("roughness") ? "Mixed" : P.roughness.toFixed(1)}</code>
          </label>
          <div className="grid2">
            <NumberField label="Pen px" testid="sketch-weight" value={P.weight} mixed={mx("weight")} min={0.25} max={50} step={0.5} disabled={ro} title="Width of the pen (hatch lines and outline). Default follows the shape size." onCommit={(v) => opt("weight", round(v))} />
            {hatch ? <NumberField label="Gap px" testid="sketch-gap" value={P.gap} mixed={mx("gap")} min={1} max={500} step={0.5} disabled={ro} title="Distance between hatch lines" onCommit={(v) => opt("gap", round(v))} /> : null}
            {hatch ? <NumberField label="Angle °" testid="sketch-angle" value={P.angle} mixed={mx("angle")} min={-360} max={360} disabled={ro} title="Direction of the hatch lines" onCommit={(v) => opt("angle", round(v))} /> : null}
            {hatch ? <NumberField label="Tint %" testid="sketch-tint" value={Math.round(P.tint * 100)} mixed={mx("tint")} min={0} max={100} disabled={ro} title="A light flat fill under the lines so the shape reads as one block (0 = lines only)" onCommit={(v) => opt("tint", Math.round(v) / 100)} /> : null}
          </div>
          <div className="row wrap">
            <button disabled={ro} data-testid="sketch-reseed" title="Draw it again with a different hand (a new random seed); the look stays the same in every export" onClick={() => commit(reseedSketch(doc, ids))}>
              Redraw
            </button>
            <button
              disabled={ro}
              title="Pen width, gap, angle, tint and roughness back to their defaults"
              data-testid="sketch-defaults"
              onClick={() => commit(resetSketch(doc, ids))}
            >
              Defaults
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function RecolorProps({ doc, n, ro }: { doc: Document; n: Extract<Node, { type: "svg" }>; ro: boolean }) {
  const s = useEditor();
  const sha = n.asset.replace(/^sha256:/, "");
  const colors = useMemo(() => svgColors(sha), [sha, s.assetsVersion]);
  const map = n.recolor ?? {};
  const setMap = (next: Record<string, string>, label: string, mk?: string) => commit(setProps(doc, [n.id], "recolor", Object.keys(next).length ? next : undefined, label), { mergeKey: mk });
  return (
    <section>
      <h4>SVG art · recolour</h4>
      {colors.length ? null : <p className="hint">No hex colours found in this SVG.</p>}
      {colors.map((c) => {
        const to = map[c] ?? Object.entries(map).find(([k]) => k.toUpperCase() === c)?.[1];
        return (
          <div className="field color recolor" key={c}>
            <span className="swatch" style={{ background: c }} title={c} />
            <span className="arrow"><Icon name="arrowRight" size={12} /></span>
            <input type="color" data-testid={`recolor-${c.slice(1)}`} value={colorHex(to ?? c)} disabled={ro} onChange={(e) => setMap({ ...map, [c]: e.target.value.toUpperCase() }, `recolour ${c} → ${e.target.value.toUpperCase()} on ${n.id}`, `recolor:${n.id}:${c}`)} />
            <code>{to ?? c}</code>
            {to ? (
              <button
                className="mini"
                disabled={ro}
                onClick={() => {
                  const next = { ...map };
                  delete next[c];
                  setMap(next, `reset ${c} on ${n.id}`);
                }}
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
      <ReplaceAsset id={n.id} accept="image/svg+xml,.svg" ro={ro} />
    </section>
  );
}

function ReplaceAsset({ id, accept, ro }: { id: string; accept: string; ro: boolean }) {
  return (
    <label className="button-like">
      Replace file…
      <input
        type="file"
        accept={accept}
        disabled={ro}
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            const r = await uploadAsset(f);
            const doc = useEditor.getState().doc!;
            commit(setProps(doc, [id], "asset", r.ref, `replace ${id} with ${f.name}`));
          } catch (err) {
            toast(`Upload failed: ${(err as Error).message}`, "error");
          }
        }}
      />
    </label>
  );
}

function FrameProps({ doc, frame, ro }: { doc: Document; frame: Frame; ro: boolean }) {
  const run = (ops: Command["ops"], label: string, mk?: string) => commit({ ops, label }, { mergeKey: mk });
  const set = (path: string, value: unknown, label: string, mk?: string) => run([value === undefined ? { op: "unset", node: frame.id, path } : { op: "set", node: frame.id, path, value }], label, mk);
  const g = guidesFor(frame);
  const [, force] = useState(0);
  useEffect(() => force((x) => x + 1), [frame.id]);
  return (
    <div className="props" data-testid="props">
      <h3>
        <span className="type-icon t-frame" />
        <input className="name" key={frame.id} defaultValue={frame.name} disabled={ro} onBlur={(e) => e.target.value.trim() && e.target.value !== frame.name && set("name", e.target.value.trim(), `rename frame ${frame.id}`)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      </h3>
      <div className="meta-line">
        <code>{frame.id}</code> frame · {frame.children.length} layers
      </div>
      <BrandSection doc={doc} ro={ro} />
      <section>
        <h4>Size</h4>
        <div className="grid2">
          <NumberField label="W" value={frame.w} min={1} max={20000} disabled={ro} onCommit={(v) => set("w", Math.round(v), `frame ${frame.id} width ${Math.round(v)}`)} />
          <NumberField label="H" value={frame.h} min={1} max={20000} disabled={ro} onCommit={(v) => set("h", Math.round(v), `frame ${frame.id} height ${Math.round(v)}`)} />
        </div>
        <div className="row wrap">
          {FRAME_PRESETS.map((p) => (
            <button key={p.id} disabled={ro} className={frame.w === p.w && frame.h === p.h ? "on" : ""} onClick={() => run([{ op: "set", node: frame.id, path: "w", value: p.w }, { op: "set", node: frame.id, path: "h", value: p.h }], `frame ${frame.id} → ${p.name}`)}>
              {p.name} {p.w}×{p.h}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h4>Background</h4>
        <ColorField label="Colour" value={frame.background?.color} disabled={ro} onChange={(c) => set("background", { color: c }, `background ${colorName(c)}`, `bg:${frame.id}`)} onClear={() => set("background", null, "no background")} />
      </section>
      <section>
        <h4>Guides</h4>
        <label className="field">
          <span>Set</span>
          <select value={frame.guides ?? ""} disabled={ro} onChange={(e) => set("guides", e.target.value || undefined, `guides ${e.target.value || "auto"} on ${frame.id}`)}>
            <option value="">auto (by size){!frame.guides && g ? ` → ${g.name}` : ""}</option>
            {GUIDE_SETS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
            <option value="none">none</option>
          </select>
        </label>
      </section>
      <section>
        <h4>Frames</h4>
        <div className="row wrap">
          {FRAME_PRESETS.map((p) => (
            <button key={p.id} disabled={ro} data-testid={`add-frame-${p.id}`} title={`Add a ${p.w}×${p.h} frame at the end`} onClick={() => addFrame(p)}>
              + {p.name}
            </button>
          ))}
        </div>
        <div className="row wrap">
          <button disabled={ro} data-testid="prop-duplicate-frame" title="A copy of this frame with all its layers, right after it" onClick={() => duplicateFrame(frame.id)}>
            Duplicate this frame
          </button>
          {doc.frames.length > 1 ? (
            <button
              className="danger"
              disabled={ro}
              onClick={() => {
                if (confirm(`Remove frame “${frame.name}” and its ${frame.children.length} layers? (Undo brings it back.)`)) removeFrame(frame.id);
              }}
            >
              Remove this frame
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** Accent object flag + palette issues on this layer. */
function NodeBrand({ doc, n, ro }: { doc: Document; n: Node; ro: boolean }) {
  const v = useEditor((st) => st.assetsVersion);
  const kit = kitOf(doc);
  if (!kit) return null;
  const pal = docPalette(doc, v);
  const mine = [...(pal?.issues ?? []), ...(pal?.advice ?? [])].filter((i) => i.node === n.id);
  const viaRole = n.accent !== true && (n.role === "accent" || (n.type === "group" && n.id === "accent"));
  return (
    <section>
      <h4>Brand · {kit.name}</h4>
      <label className="check" title={`The one ${kit.name} accent (${kit.accentHex}) of a frame lives in this layer; export wraps it in <g id="accent">`}>
        <input type="checkbox" data-testid="prop-accent" checked={n.accent === true || viaRole} disabled={ro || viaRole} onChange={(e) => commit(setProps(doc, [n.id], "accent", e.target.checked ? true : undefined, e.target.checked ? `accent object ${n.id}` : `not the accent object: ${n.id}`))} />
        Accent object{viaRole ? (n.role === "accent" ? " (role accent)" : " (group id accent)") : ""}
      </label>
      <IssueList issues={mine} />
    </section>
  );
}

type PaletteIssue = { node?: string; path: string; code: string; message: string };

function IssueList({ issues, advice = [], clickable }: { issues: PaletteIssue[]; advice?: PaletteIssue[]; clickable?: (id: string) => boolean }) {
  if (!issues.length && !advice.length) return null;
  const item = (i: PaletteIssue, k: number, kind: string) => {
    const can = !!i.node && !!clickable?.(i.node);
    return (
      <li key={kind + k} className={`palette-issue ${kind}`} data-code={i.code}>
        {can ? (
          <button className="link" onClick={() => select([i.node!])} title="select this layer">
            {i.message}
          </button>
        ) : (
          i.message
        )}
      </li>
    );
  };
  return (
    <ul className="palette-issues" data-testid="palette-issues">
      {issues.map((i, k) => item(i, k, "issue"))}
      {advice.map((i, k) => item(i, k, "advice"))}
    </ul>
  );
}

/** Project-level brand kit, strict mode and the palette verdict (shown with nothing selected). */
function BrandSection({ doc, ro }: { doc: Document; ro: boolean }) {
  const v = useEditor((st) => st.assetsVersion);
  const kit = kitOf(doc);
  const pal = docPalette(doc, v);
  const pickKit = (id: string) => {
    const k = getKit(id);
    const ops: Command["ops"] = [id ? { op: "set", node: "$doc", path: "brandKit", value: id } : { op: "unset", node: "$doc", path: "brandKit" }];
    // The kit's guides for frames of a size it knows (LUX square → the chart-well guides).
    if (k) for (const f of doc.frames) {
      const g = k.guides[`${f.w}x${f.h}`];
      if (g && f.guides !== g) ops.push({ op: "set", node: f.id, path: "guides", value: g });
    }
    commit({ ops, label: id ? `brand kit ${id}` : "no brand kit" });
  };
  return (
    <section data-testid="brand-section">
      <h4>Brand kit</h4>
      <label className="field">
        <span>Kit</span>
        <select data-testid="brand-kit" value={doc.brandKit ?? ""} disabled={ro} onChange={(e) => pickKit(e.target.value)}>
          <option value="">none</option>
          {listKits().map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
          {doc.brandKit && !kit ? <option value={doc.brandKit}>{doc.brandKit} (unknown)</option> : null}
        </select>
      </label>
      {kit ? (
        <>
          <label className="check" title="Off-palette colours and accent mistakes block a change instead of only warning. Problems that were already there stay warnings.">
            <input type="checkbox" data-testid="strict-palette" checked={doc.strictPalette === true} disabled={ro} onChange={(e) => commit({ ops: [e.target.checked ? { op: "set", node: "$doc", path: "strictPalette", value: true } : { op: "unset", node: "$doc", path: "strictPalette" }], label: e.target.checked ? "strict palette on" : "strict palette off" })} />
            Strict palette (block off-palette changes)
          </label>
          <p className={`hint${pal && !pal.ok ? " warn" : ""}`} data-testid="palette-status">
            {pal?.ok ? `Palette OK${pal.frames.length ? ` · accent ${pal.frames.map((f) => `${f.frame} ${f.accentObjects}`).join(", ")}` : ""}` : `${pal?.issues.length ?? 0} palette problem${pal?.issues.length === 1 ? "" : "s"} (check_palette.py would fail the export)`}
          </p>
          <IssueList issues={pal?.issues ?? []} advice={pal?.advice ?? []} clickable={(id) => !doc.frames.some((f) => f.id === id) && !!getNode(doc, id)} />
        </>
      ) : null}
    </section>
  );
}

/** His changes since the agent's last checkpoint: the agent cannot touch them on its next turn. */
function SoftPins({ id, explicit, ro }: { id: string; explicit: string[]; ro: boolean }) {
  const s = useEditor();
  const doc = s.doc!;
  const paths = softPinsByNode(s.preview ? [] : (s.pins?.soft ?? []), (x) => (x === id ? explicit : undefined)).get(id);
  if (!paths) return null;
  return (
    <div className="soft-pins" data-testid="soft-pins">
      <p className="hint">
        Kept from the agent's next turn (you changed them since {s.pins!.since}). Pin one to keep it after that too:
      </p>
      {paths.map((p) => (
        <div key={p} className="pin-row soft" data-soft-pin={p}>
          <span className="soft-pin">
            <Icon name="pin" size={12} />
          </span>{" "}
          {pinLabel(p)} {pinLabel(p) !== p ? <code>{p}</code> : null}
          <button className="mini" title="Pin for good" disabled={ro} data-testid={`pin-for-good-${p}`} onClick={() => commit(setProps(doc, [id], "pins", [...new Set([...explicit, p])], `pin ${id}.${p}`))}>
            Pin
          </button>
        </div>
      ))}
    </div>
  );
}
