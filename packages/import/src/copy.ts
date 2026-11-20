// copy.json → role candidates. The visible copy keys of social-posts templates become node roles.
const ROLE_KEYS = ["kicker", "headline", "sub", "chip", "emphasis", "source", "footer", "status", "cta"] as const;

export interface CopyLine {
  role: string;
  text: string;
  /** Line number inside the role (headline line 1, 2 …). */
  index: number;
  count: number;
}

export const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function lineText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.spans)) return o.spans.map((s: any) => (typeof s?.text === "string" ? s.text : "")).join("");
    if (typeof o.text === "string") return o.text;
  }
  return undefined;
}

export function copyLines(copy: Record<string, unknown> | undefined): CopyLine[] {
  if (!copy) return [];
  const out: CopyLine[] = [];
  for (const role of ROLE_KEYS) {
    const v = copy[role];
    if (v === null || v === undefined) continue;
    const lines = (Array.isArray(v) ? v.map(lineText) : [lineText(v)]).filter((s): s is string => !!s && !!norm(s));
    lines.forEach((text, index) => out.push({ role, text: norm(text), index, count: lines.length }));
  }
  return out;
}

/** Matches text on the canvas to copy.json lines; each line is used once per frame. */
export class RoleMatcher {
  private used = new Set<CopyLine>();
  constructor(private readonly lines: CopyLine[]) {}

  private find(text: string): CopyLine | undefined {
    const t = norm(text);
    if (!t) return undefined;
    const free = this.lines.filter((l) => !this.used.has(l));
    return free.find((l) => l.text === t) ?? (t.length >= 6 ? free.find((l) => l.text.startsWith(t) || t.startsWith(l.text)) : undefined);
  }

  peek(text: string): CopyLine | undefined {
    return this.find(text);
  }

  take(text: string): CopyLine | undefined {
    const l = this.find(text);
    if (l) this.used.add(l);
    return l;
  }
}
