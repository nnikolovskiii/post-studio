// A line-for-line port of social-posts/tools/check_palette.py (DESIGN §1.4, §2.1, §3.1, §4.1).
// Same rules, same messages, same order, so a test can compare it with the Python tool on real
// posts. Do not "improve" a rule here without changing the Python side the same way.
import { scanXml, XmlError } from "./xml.ts";

export interface PaletteLane {
  /** Name used in messages ('lux', 'kites', …). */
  name: string;
  paper: string;
  accent: string;
  /** Upper-case #RRGGBB values allowed in this lane. */
  colors: Set<string> | Map<string, unknown>;
}

export interface SvgCheckOptions {
  /** Art-only SVG: no paper background required. */
  art?: boolean;
  /** Path used in messages (check_palette prints the path it was given). */
  path?: string;
  /** Post Studio: the whole SVG sits inside the frame's accent object, so the accent is allowed anywhere. */
  insideAccent?: boolean;
}

export interface SvgCheckResult {
  ok: boolean;
  errors: string[];
  /** Number of <g id="accent"> groups. */
  accentGroups: number;
}

const COLOR_PROPS = ["fill", "stroke", "stop-color", "color", "flood-color", "lighting-color"];
const KEYWORDS = new Set(["none", "transparent", "currentcolor", "inherit"]);
const BANNED_TAGS = new Set(["lineargradient", "radialgradient", "filter"]);
const NON_PAINT = new Set(["defs", "title", "desc", "metadata", "style", "symbol", "clippath", "mask"]);

export function normHex(v: string): string | undefined {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(pyStrip(v));
  if (!m) return undefined;
  let h = m[1].toUpperCase();
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return "#" + h;
}

/** Python str.strip() (Unicode whitespace). */
// eslint-disable-next-line no-control-regex -- Python str.strip() also strips \x1c–\x1f
const PY_SPACE = /[\s\u001c-\u001f\u0085]/u;
function pyStrip(s: string): string {
  // A loop, not /\s+$/: a trailing-space regex is quadratic on 300 kB data URIs.
  let a = 0;
  let b = s.length;
  while (a < b && PY_SPACE.test(s[a])) a++;
  while (b > a && PY_SPACE.test(s[b - 1])) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** Python repr() of a str, enough for the 'not a hex' message. */
function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), `\\${q}`) + q;
}

function parseStyle(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i >= 0) out.set(pyStrip(decl.slice(0, i)).toLowerCase(), pyStrip(decl.slice(i + 1)));
  }
  return out;
}

const local = (tag: string) => tag.split(":").pop()!.split("}").pop()!.toLowerCase();

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const m = /^\s*(-?[\d.]+)(px)?\s*$/.exec(v);
  return m ? Number(m[1]) : undefined;
}

const WORD = /[\p{L}\p{N}_-]/u;
const DECL = /([\p{L}\p{N}_-]+)\s*:\s*([^;}{]+)/uy;

/**
 * re.findall(r"([\w-]+)\s*:\s*([^;}{]+)", text) without its quadratic backtracking on long
 * word runs (an embedded base64 @font-face is one 300 kB run). A match can only start where a
 * run of word characters starts: a later start inside the same run ends at the same place, so it
 * fails the same way. Trying each run start once (sticky) gives the same matches in linear time.
 */
export function cssDecls(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  while (i < text.length) {
    if (!WORD.test(text[i])) {
      i++;
      continue;
    }
    DECL.lastIndex = i;
    const m = DECL.exec(text);
    if (m) {
      out.push([m[1], m[2]]);
      i = DECL.lastIndex;
      continue;
    }
    while (i < text.length && WORD.test(text[i])) i++;
  }
  return out;
}

export function checkSvgPalette(svg: string, lane: PaletteLane, opts: SvgCheckOptions = {}): SvgCheckResult {
  const path = opts.path ?? "post.svg";
  const allowed = lane.colors;
  const accent = lane.accent;
  const errors: string[] = [];
  const stack: Array<[string, string | undefined]> = [];
  const state: { accentGroups: number; canvas: [number, number, number, number] | null; bgOk: boolean | null; inStyle: boolean } = { accentGroups: 0, canvas: null, bgOk: null, inStyle: false };
  const styleText: Array<[number, string]> = [];
  let line = 1;
  const where = () => `${path}:${line}`;
  const inAccent = () => !!opts.insideAccent || stack.some(([t, i]) => t === "g" && i === "accent");

  const checkValue = (prop: string, value: string, tag: string): string | undefined => {
    const v = pyStrip(value);
    if (KEYWORDS.has(v.toLowerCase())) return undefined;
    if (v.toLowerCase().startsWith("url(")) {
      errors.push(`${where()}: <${tag}> ${prop}=${v}: paint servers are not allowed (flat color only)`);
      return undefined;
    }
    const h = normHex(v);
    if (h === undefined) {
      errors.push(`${where()}: <${tag}> ${prop}=${pyRepr(v)}: not a hex or allowed keyword`);
      return undefined;
    }
    if (!allowed.has(h)) errors.push(`${where()}: <${tag}> ${prop}=${v}: ${h} is not in the ${lane.name} palette`);
    if (h === accent && !inAccent()) errors.push(`${where()}: <${tag}> ${prop}=${v}: lane accent outside <g id="accent">`);
    return h;
  };

  try {
    scanXml(svg, {
      start(name, attrs, l) {
        line = l;
        const tag = local(name);
        const eid = attrs.get("id");
        if (BANNED_TAGS.has(tag)) errors.push(`${where()}: <${tag}> is not allowed (no gradients or filters)`);
        if (tag === "g" && eid === "accent") {
          state.accentGroups++;
          if (state.accentGroups > 1 && !opts.insideAccent) errors.push(`${where()}: more than one <g id="accent">`);
        }
        // dict semantics: attribute order, then style= keys (an existing key keeps its place).
        const props = new Map<string, string>();
        for (const [k, v] of attrs) if (COLOR_PROPS.includes(k.toLowerCase())) props.set(k.toLowerCase(), v);
        if (attrs.has("style")) {
          const st = parseStyle(attrs.get("style")!);
          for (const [k, v] of st) if (COLOR_PROPS.includes(k)) props.set(k, v);
          if (st.has("filter") && st.get("filter")!.toLowerCase() !== "none") errors.push(`${where()}: <${tag}> style filter: is not allowed`);
        }
        if (attrs.has("filter") && pyStrip(attrs.get("filter")!).toLowerCase() !== "none") errors.push(`${where()}: <${tag}> filter= is not allowed`);
        const resolved = new Map<string, string | undefined>();
        for (const [k, v] of props) resolved.set(k, checkValue(k, v, tag));

        if (tag === "svg" && !stack.length) {
          const vb = attrs.get("viewBox");
          if (vb) {
            const p = pyStrip(vb).split(/[\s,]+/).map(Number);
            state.canvas = [p[0], p[1], p[2], p[3]];
          } else state.canvas = [0, 0, num(attrs.get("width")) || 0, num(attrs.get("height")) || 0];
        } else if (stack.length === 1 && state.bgOk === null && !NON_PAINT.has(tag)) {
          const [cx, cy, cw, ch] = state.canvas ?? [0, 0, 0, 0];
          let ok = tag === "rect";
          if (ok) {
            const w = attrs.get("width") ?? "";
            const h = attrs.get("height") ?? "";
            const x = num(attrs.get("x") ?? "0") || 0;
            const y = num(attrs.get("y") ?? "0") || 0;
            const fullW = pyStrip(w) === "100%" || (num(w) || 0) >= cw;
            const fullH = pyStrip(h) === "100%" || (num(h) || 0) >= ch;
            ok = fullW && fullH && x <= cx && y <= cy && resolved.get("fill") === lane.paper;
          }
          state.bgOk = ok;
        }
        if (tag === "style") state.inStyle = true;
        stack.push([tag, eid]);
      },
      end() {
        const [tag] = stack.pop()!;
        if (tag === "style") state.inStyle = false;
      },
      chars(data, l) {
        if (state.inStyle) styleText.push([l, data]);
      },
    });
  } catch (e) {
    if (e instanceof XmlError) return { ok: false, errors: [`${path}: XML parse error: ${e.message}: line ${e.line}`], accentGroups: state.accentGroups };
    throw e;
  }

  for (const [l, text] of styleText) {
    for (const [prop, value] of cssDecls(text)) {
      if (!COLOR_PROPS.includes(prop.toLowerCase())) continue;
      const v = pyStrip(value);
      const h = normHex(v);
      if (KEYWORDS.has(v.toLowerCase())) continue;
      if (h === undefined || !allowed.has(h)) errors.push(`${path}:${l}: <style> ${prop}: ${v} is not in the ${lane.name} palette`);
      else if (h === accent && !opts.insideAccent) errors.push(`${path}:${l}: <style> ${prop}: lane accent in a stylesheet (use <g id="accent">)`);
    }
    if (/(^|[;{\s])filter\s*:/.test(text)) errors.push(`${path}:${l}: <style> filter is not allowed`);
  }

  if (!opts.art && !state.bgOk) {
    errors.push(`${path}: first painted element must be a full-canvas <rect> filled ${lane.paper} (the ${lane.name} paper); use --art for art-only files`);
  }
  return { ok: errors.length === 0, errors, accentGroups: state.accentGroups };
}
