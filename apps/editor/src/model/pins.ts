// Soft pins in the editor (PLAN §3.6): everything Nikola changed since the agent's last
// checkpoint, as the server computes it. The agent cannot touch these until its next hand-back;
// an explicit pin ("Keep this") protects for good. Pure helpers, tested in model.test.ts.

export interface PinInfo {
  node: string;
  path: string;
  source: "explicit" | "soft";
  rev?: number;
}

export interface PinsState {
  /** Checkpoint the soft pins count from ('created' or 'agent-N'). */
  since: string;
  soft: PinInfo[];
}

/** Paths an agent can never write anyway; showing them as "protected" would only be noise. */
const ALWAYS_HUMAN = new Set(["pins", "locked"]);

/** Soft pins per node, minus the always-human paths and those covered by an explicit pin. */
export function softPinsByNode(soft: PinInfo[], explicit: (id: string) => string[] | undefined = () => undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of soft) {
    if (ALWAYS_HUMAN.has(p.path.split(".")[0])) continue;
    const ex = explicit(p.node) ?? [];
    if (ex.includes("*") || ex.includes(p.path)) continue;
    const list = out.get(p.node) ?? [];
    if (!list.includes(p.path)) list.push(p.path);
    out.set(p.node, list);
  }
  for (const list of out.values()) list.sort(comparePaths);
  return out;
}

const ORDER = ["#exists", "#parent", "x", "y", "w", "h", "rotation", "spans", "style", "fill", "stroke", "opacity", "visible", "name"];
function comparePaths(a: string, b: string): number {
  const ia = ORDER.indexOf(a.split(".")[0]);
  const ib = ORDER.indexOf(b.split(".")[0]);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
}

const LABELS: Record<string, string> = {
  "#exists": "the layer (you added it)",
  "#parent": "layer order / group",
  x: "x",
  y: "y",
  w: "width",
  h: "height",
  rotation: "rotation",
  opacity: "opacity",
  visible: "visibility",
  name: "name",
  spans: "text",
  fill: "fill",
  stroke: "stroke",
  box: "box mode",
  align: "alignment",
  recolor: "recolour",
  asset: "image / art file",
  fit: "fit",
  radius: "corner radius",
  "style.font": "font",
  "style.weight": "weight",
  "style.size": "font size",
  "style.lineHeight": "line height",
  "style.letterSpacing": "letter spacing",
  "style.fill": "text colour",
  background: "background",
  guides: "guides",
  title: "title",
};

/** "style.size" → "font size", "#exists" → "the layer (you added it)". Unknown paths stay as they are. */
export function pinLabel(path: string): string {
  if (LABELS[path]) return LABELS[path];
  const top = path.split(".")[0];
  return LABELS[top] ? `${LABELS[top]} (${path.slice(top.length + 1)})` : path;
}

/** One line for a tooltip: "x, y, font size". */
export function pinSummary(paths: string[]): string {
  const xy = paths.includes("x") && paths.includes("y");
  const labels = paths.filter((p) => !(xy && (p === "x" || p === "y"))).map(pinLabel);
  return [...(xy ? ["position"] : []), ...labels].join(", ");
}
