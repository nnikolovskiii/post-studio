import type { Color } from "./types.ts";

/** Shortest stable decimal for SVG attributes (3 decimals, no trailing zeros). */
export function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Text content: escape and drop characters XML 1.0 cannot carry. */
export function escText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return esc(s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, ""));
}

export function attrs(a: Record<string, string | number | undefined | null | false>): string {
  let out = "";
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || v === null || v === false) continue;
    out += ` ${k}="${typeof v === "number" ? num(v) : esc(v)}"`;
  }
  return out;
}

export interface Paint {
  /** #RRGGBB or 'none'. */
  color: string;
  /** 0–1 when the source had an alpha byte below FF. */
  opacity?: number;
}

/** Hex or token → paint. `resolve` maps brand tokens; unresolved ones become magenta and are reported. */
export function paint(c: Color | null | undefined, resolve: (token: string) => string | undefined, warn: (msg: string) => void): Paint {
  if (c === null || c === undefined) return { color: "none" };
  let hex: string | undefined;
  if (typeof c === "string") hex = c;
  else {
    hex = resolve(c.token);
    if (!hex) {
      warn(`color token '${c.token}' is not in a brand kit; drawn magenta`);
      hex = "#FF00FF";
    }
  }
  const h = hex.toUpperCase();
  if (h.length === 9) {
    const a = parseInt(h.slice(7), 16) / 255;
    return a >= 1 ? { color: h.slice(0, 7) } : { color: h.slice(0, 7), opacity: Math.round(a * 1000) / 1000 };
  }
  return { color: h };
}

export function rotateAttr(rotation: number | undefined, cx: number, cy: number): string | undefined {
  if (!rotation) return undefined;
  return `rotate(${num(rotation)} ${num(cx)} ${num(cy)})`;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 without Node's Buffer (the editor runs this in the browser). */
export function base64(bytes: Uint8Array): string {
  const NodeBuffer = (globalThis as { Buffer?: { from(b: ArrayBufferLike, o: number, l: number): { toString(e: string): string } } }).Buffer;
  if (NodeBuffer) return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + "=";
  }
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");
export const utf8Bytes = (s: string): Uint8Array => enc.encode(s);
export const utf8Text = (b: Uint8Array): string => dec.decode(b);

export function dataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${base64(bytes)}`;
}
