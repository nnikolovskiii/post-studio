// Putting outside things on the canvas: image files, SVG files and SVG markup from the clipboard
// (Figma's "Copy as SVG"). SVG becomes real layers (packages/import/paste) inside one group;
// what has no layer equivalent stays a small picture. Every byte goes through POST /v1/assets,
// so the server's sanitizer still sees all SVG; layers are plain document data the server
// validates like any other edit.
import type { Node } from "@post-studio/schema";
import { makeGroup, PasteError, shift, svgToNodes, TooComplex, type PasteReport, type PasteResult, type SvgElementLike } from "@post-studio/import/paste";
import { getAsset, uploadAsset } from "./assets.ts";
import { allIds, insertNode, newId } from "./model/commands.ts";
import { commit, readOnlyReason, toast, useEditor } from "./store.ts";

/** Most separate picture layers one SVG may turn into; past this it goes in as one picture. */
export const MAX_PIECES = 60;

export const isSvgFile = (f: File) => f.type === "image/svg+xml" || f.name.toLowerCase().endsWith(".svg");

/** SVG markup (what Figma's Copy as SVG puts on the clipboard), not any text that mentions svg. */
export const looksLikeSvg = (text: string) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text);

async function naturalSize(file: File, ref: string): Promise<{ w: number; h: number }> {
  if (isSvgFile(file)) {
    const a = getAsset(ref.replace(/^sha256:/, ""));
    const text = a ? new TextDecoder().decode(a.bytes) : "";
    const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
    const vb = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
    if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
    const w = parseFloat(svg.getAttribute("width") ?? "");
    const h = parseFloat(svg.getAttribute("height") ?? "");
    return w > 0 && h > 0 ? { w, h } : { w: 400, h: 400 };
  }
  try {
    const bmp = await createImageBitmap(file);
    const r = { w: bmp.width, h: bmp.height };
    bmp.close();
    return r;
  } catch {
    return { w: 400, h: 400 };
  }
}

/**
 * A file from the image / SVG buttons or a drop. SVG becomes editable layers unless
 * `asPicture` (Shift held), then it is one `svg` layer as before.
 */
export async function addFile(file: File, opts: { asPicture?: boolean; onlySvg?: boolean } = {}) {
  const s = useEditor.getState();
  if (readOnlyReason(s) || !s.doc) return toast(`Read-only: ${readOnlyReason(s)}`, "error");
  if (isSvgFile(file) && !opts.asPicture) return void (await insertSvg(await file.text(), { name: file.name }));
  try {
    const up = await uploadAsset(file);
    if (opts.onlySvg && up.mime !== "image/svg+xml") return toast("That file is not an SVG", "error");
    await addPicture(up, file, up.mime === "image/svg+xml" ? "svg" : "image");
    if (up.sanitized?.length) toast(`SVG cleaned: removed ${up.sanitized.slice(0, 4).join(", ")}${up.sanitized.length > 4 ? "…" : ""}`);
  } catch (e) {
    toast(`Upload failed: ${(e as Error).message}`, "error");
  }
}

/** One image or one whole-SVG picture layer, 60 % of the frame at most, centred. */
async function addPicture(up: { ref: string }, file: File, kind: "image" | "svg") {
  const s = useEditor.getState();
  const doc = s.doc!;
  const frame = doc.frames.find((f) => f.id === s.activeFrame) ?? doc.frames[0];
  const nat = await naturalSize(file, up.ref);
  const k = Math.min(1, (frame.w * 0.6) / nat.w, (frame.h * 0.6) / nat.h);
  const w = Math.round(nat.w * k * 100) / 100;
  const h = Math.round(nat.h * k * 100) / 100;
  const base = file.name.replace(/\.[a-z0-9]+$/i, "").toLowerCase() || kind;
  const node: Node =
    kind === "svg"
      ? { id: newId(doc, base), type: "svg", name: file.name, asset: up.ref, x: Math.round((frame.w - w) / 2), y: Math.round((frame.h - h) / 2), w, h }
      : { id: newId(doc, base), type: "image", name: file.name, asset: up.ref, fit: "contain", x: Math.round((frame.w - w) / 2), y: Math.round((frame.h - h) / 2), w, h };
  commit(insertNode(doc, frame.id, node), { select: [node.id] });
}

function dataUriBytes(href: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(href);
  if (!m) throw new Error("not a base64 data URI");
  const bin = atob(m[2].replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: m[1] };
}

/** One line for the toast: what came in as layers, what stayed a picture, which fonts changed. */
export function pasteSummary(name: string, r: Pick<PasteResult, "nodes"> & { report: PasteReport }): string {
  const parts = [`Inserted “${name}” as ${r.report.layers} layer${r.report.layers === 1 ? "" : "s"}${r.report.texts ? ` (${r.report.texts} editable text${r.report.texts === 1 ? "" : "s"})` : ""}.`];
  const pics = Object.entries(r.report.pictures);
  if (pics.length) parts.push(`Kept as picture: ${pics.map(([k, n]) => `${n} × ${k}`).join(", ")}.`);
  if (r.report.fonts.length) parts.push(`Fonts: ${r.report.fonts.slice(0, 4).join(", ")}${r.report.fonts.length > 4 ? "…" : ""}.`);
  if (r.report.skipped.length) parts.push(`Left out: ${r.report.skipped.slice(0, 3).join(", ")}${r.report.skipped.length > 3 ? "…" : ""}.`);
  parts.push("Ctrl+Shift+V (or Shift while dropping) inserts it as one picture.");
  return parts.join(" ");
}

/**
 * SVG markup → layers in a new group in the active frame. An SVG the size of the frame (a whole
 * Figma frame) lands at 0,0; anything else is centred. One revision; undo removes it.
 */
export async function insertSvg(text: string, opts: { name?: string; asPicture?: boolean } = {}): Promise<boolean> {
  const name = (opts.name ?? "Pasted SVG").slice(0, 120);
  const fileName = /\.svg$/i.test(name) ? name : `${name.replace(/[^\w.-]+/g, "-") || "pasted"}.svg`;
  const asPicture = async (why?: string) => {
    if (why) toast(why);
    await addFile(new File([text], fileName, { type: "image/svg+xml" }), { asPicture: true, onlySvg: true });
    return true;
  };
  const s = useEditor.getState();
  const ro = readOnlyReason(s);
  if (ro || !s.doc || !s.fonts) {
    toast(`Read-only: ${ro}`, "error");
    return false;
  }
  if (opts.asPicture) return asPicture();
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.localName !== "svg" || parsed.getElementsByTagName("parsererror").length) {
    toast("That is not valid SVG markup", "error");
    return false;
  }
  let r: PasteResult;
  try {
    const ser = new XMLSerializer();
    r = svgToNodes(root as unknown as SvgElementLike, { fonts: s.fonts, lang: s.doc.lang, taken: allIds(s.doc), serialize: (el) => ser.serializeToString(el as unknown as Element) });
  } catch (e) {
    if (e instanceof TooComplex) return asPicture(`${(e as Error).message}: inserted as one picture.`);
    toast(e instanceof PasteError ? e.message : `Could not read the SVG: ${(e as Error).message}`, "error");
    return false;
  }
  if (!r.nodes.length) {
    toast("Nothing visible to insert in that SVG", "error");
    return false;
  }
  if (r.pieces.length > MAX_PIECES) return asPicture(`More than ${MAX_PIECES} parts would stay pictures: inserted as one picture.`);
  const cleaned = new Set<string>();
  try {
    for (const [i, p] of r.pieces.entries()) {
      const up = await uploadAsset(new File([p.markup], `${fileName.replace(/\.svg$/i, "")}-part-${i + 1}.svg`, { type: "image/svg+xml" }));
      if (up.mime !== "image/svg+xml") throw new Error("a picture part was not accepted as SVG");
      p.node.asset = up.ref;
      for (const c of up.sanitized ?? []) cleaned.add(c);
    }
    for (const [i, ra] of r.rasters.entries()) {
      const d = dataUriBytes(ra.href);
      const up = await uploadAsset(new File([d.bytes as BlobPart], `${fileName.replace(/\.svg$/i, "")}-image-${i + 1}.${d.mime.split("/")[1] ?? "png"}`, { type: d.mime }));
      if (!/^image\/(png|jpeg|webp)$/.test(up.mime)) throw new Error("an embedded image is not PNG, JPEG or WebP");
      ra.node.asset = up.ref;
    }
  } catch (e) {
    toast(`Upload failed: ${(e as Error).message}`, "error");
    return false;
  }
  // The document may have moved on while uploading (autosave, polling): place into the current one.
  const st = useEditor.getState();
  const doc = st.doc!;
  const frame = doc.frames.find((f) => f.id === st.activeFrame) ?? doc.frames[0];
  const [vx, vy, vw, vh] = r.viewBox;
  const whole = Math.abs(vw - frame.w) < 0.5 && Math.abs(vh - frame.h) < 0.5;
  const ox = whole ? 0 : Math.round((frame.w - vw) / 2);
  const oy = whole ? 0 : Math.round((frame.h - vh) / 2);
  const taken = allIds(doc);
  const clash = [...collectIds(r.nodes)].some((id) => taken.has(id));
  if (clash) {
    toast("The document changed while uploading; paste again", "error");
    return false;
  }
  for (const id of collectIds(r.nodes)) taken.add(id);
  const gid = newId(taken, name.replace(/\.svg$/i, "") || "svg");
  const group = makeGroup(
    gid,
    r.nodes.map((n) => shift(n, ox - vx, oy - vy)),
    { name: name.replace(/\.svg$/i, ""), meta: { insertedFrom: "svg" } },
  );
  if (!commit(insertNode(doc, frame.id, group), { select: [group.id] })) return false;
  toast(pasteSummary(name, r) + (cleaned.size ? ` SVG cleaned: removed ${[...cleaned].slice(0, 3).join(", ")}.` : ""), "info", 9000);
  return true;
}

function collectIds(nodes: Node[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    out.add(n.id);
    if (n.type === "group") collectIds(n.children, out);
  }
  return out;
}
