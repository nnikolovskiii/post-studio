// A small, strict XML scanner with expat-like events and line numbers. It exists so the palette
// check sees an SVG exactly the way social-posts/tools/check_palette.py (pyexpat) does: the line
// of each start tag, attribute values with XML whitespace normalisation, and character data
// delivered one line at a time (pyexpat reports a newline as its own chunk). No namespaces, no DTD.

export interface XmlHandlers {
  start(name: string, attrs: Map<string, string>, line: number): void;
  end(name: string, line: number): void;
  chars?(data: string, line: number): void;
}

export class XmlError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly column: number,
  ) {
    super(message);
  }
}

const NAME = /[A-Za-z_:À-￿][-A-Za-z0-9_:.·À-￿]*/y;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string, line: number): string {
  return s.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    const v = ENTITIES[e];
    if (v === undefined) throw new XmlError(`undefined entity: ${m}`, line, 0);
    return v;
  });
}

export function scanXml(text: string, h: XmlHandlers): void {
  let i = 0;
  let line = 1;
  const n = text.length;
  const stack: string[] = [];
  let seenRoot = false;
  const advance = (to: number) => {
    for (let k = i; k < to; k++) if (text.charCodeAt(k) === 10) line++;
    i = to;
  };
  const fail = (msg: string): never => {
    throw new XmlError(msg, line, 0);
  };
  const emitChars = (raw: string, startLine: number) => {
    if (!h.chars || !raw) return;
    // One chunk per line piece, the newline itself as its own chunk (pyexpat without buffer_text).
    let l = startLine;
    const parts = raw.split("\n");
    parts.forEach((p, k) => {
      if (p) h.chars!(decode(p, l), l);
      if (k < parts.length - 1) {
        h.chars!("\n", l);
        l++;
      }
    });
  };

  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      const rest = text.slice(i);
      if (stack.length) emitChars(rest, line);
      else if (rest.trim()) fail("junk after document element");
      advance(n);
      break;
    }
    if (lt > i) {
      const raw = text.slice(i, lt);
      if (stack.length) emitChars(raw, line);
      else if (raw.trim()) fail("text outside the document element");
      advance(lt);
    }
    if (text.startsWith("<!--", i)) {
      const e = text.indexOf("-->", i + 4);
      if (e < 0) fail("unclosed comment");
      advance(e + 3);
    } else if (text.startsWith("<![CDATA[", i)) {
      const e = text.indexOf("]]>", i + 9);
      if (e < 0) fail("unclosed CDATA section");
      if (h.chars) {
        const raw = text.slice(i + 9, e);
        let l = line;
        const parts = raw.split("\n");
        parts.forEach((p, k) => {
          if (p) h.chars!(p, l);
          if (k < parts.length - 1) {
            h.chars!("\n", l);
            l++;
          }
        });
      }
      advance(e + 3);
    } else if (text.startsWith("<?", i)) {
      const e = text.indexOf("?>", i + 2);
      if (e < 0) fail("unclosed processing instruction");
      advance(e + 2);
    } else if (text.startsWith("<!DOCTYPE", i) || text.startsWith("<!doctype", i)) {
      let k = i + 9;
      let depth = 0;
      for (; k < n; k++) {
        const c = text[k];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      advance(k + 1);
    } else if (text[i + 1] === "/") {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(text);
      if (!m) fail("bad end tag");
      const name = m![0];
      const startLine = line;
      const gt = text.indexOf(">", i);
      if (gt < 0) fail("unclosed end tag");
      if (stack.pop() !== name) fail(`mismatched tag: </${name}>`);
      advance(gt + 1);
      h.end(name, startLine);
    } else {
      NAME.lastIndex = i + 1;
      const m = NAME.exec(text);
      if (!m) fail("not well-formed (invalid token)");
      if (!stack.length && seenRoot) fail("junk after document element");
      const name = m![0];
      const startLine = line;
      let k = i + 1 + name.length;
      const attrs = new Map<string, string>();
      let selfClose = false;
      for (;;) {
        while (k < n && /\s/.test(text[k])) k++;
        if (k >= n) fail("unclosed start tag");
        if (text[k] === ">") {
          k++;
          break;
        }
        if (text[k] === "/" && text[k + 1] === ">") {
          selfClose = true;
          k += 2;
          break;
        }
        NAME.lastIndex = k;
        const an = NAME.exec(text);
        if (!an) fail("not well-formed (invalid token)");
        k += an![0].length;
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] !== "=") fail("not well-formed (invalid token)");
        k++;
        while (k < n && /\s/.test(text[k])) k++;
        const q = text[k];
        if (q !== '"' && q !== "'") fail("not well-formed (invalid token)");
        const e = text.indexOf(q, k + 1);
        if (e < 0) fail("unclosed attribute value");
        const raw = text.slice(k + 1, e);
        if (raw.includes("<")) fail("not well-formed (invalid token)");
        if (attrs.has(an![0])) fail("duplicate attribute");
        // XML attribute-value normalisation: literal tab / CR / LF become spaces (entities stay).
        attrs.set(an![0], decode(raw.replace(/[\t\r\n]/g, " "), startLine));
        k = e + 1;
      }
      advance(k);
      seenRoot = true;
      h.start(name, attrs, startLine);
      if (selfClose) h.end(name, startLine);
      else stack.push(name);
    }
  }
  if (stack.length) fail("no element found");
  if (!seenRoot) fail("no element found");
}
