// Template guides per lane: the hidden `guides` layer of the social-posts lane templates
// (templates/<lane>/*.svg): 6-column grid, safe column, art / chart well, headline and sub zones,
// footer baseline and the bottom-right keep-out. Shared by the editor (drawing, snapping) and the
// server (a frame's `guides` name must be one of these or 'none').
export interface GuideLine {
  axis: "x" | "y";
  value: number;
  label?: string;
  dashed?: boolean;
}

export interface GuideZone {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "column" | "margin" | "zone" | "well" | "keep-out";
  label?: string;
}

export interface GuideSet {
  id: string;
  name: string;
  w: number;
  h: number;
  lines: GuideLine[];
  zones: GuideZone[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function columns(x0: number, y0: number, w: number, h: number, count: number, gutter: number): GuideZone[] {
  const cw = (w - gutter * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => ({ x: round3(x0 + i * (cw + gutter)), y: y0, w: round3(cw), h, kind: "column" as const }));
}

/** The 1080² frame system every lane shares (DESIGN §1.2), plus the lane's own zones. */
function square(id: string, name: string, zones: GuideZone[], footer = true): GuideSet {
  return {
    id,
    name,
    w: 1080,
    h: 1080,
    lines: [
      { axis: "x", value: 135, label: "safe x 135", dashed: true },
      { axis: "x", value: 945, label: "safe x 945", dashed: true },
      ...(footer ? [{ axis: "y" as const, value: 1008, label: "footer baseline y 1008" }] : []),
    ],
    zones: [...columns(72, 72, 936, 936, 6, 24), { x: 72, y: 72, w: 936, h: 936, kind: "margin" }, ...zones, { x: 920, y: 960, w: 160, h: 120, kind: "keep-out", label: "keep-out" }],
  };
}

export const GUIDE_SETS: GuideSet[] = [
  // templates/lux/ig-1080.svg (the Phase 3 'lane/ig-1080' set)
  square("lane/ig-1080", "LUX · square 1080 (chart well)", [
    { x: 135, y: 136, w: 810, h: 132, kind: "zone", label: "headline 60/68 · ≤ 2 lines" },
    { x: 135, y: 312, w: 810, h: 560, kind: "well", label: "chart well 810×560" },
    { x: 135, y: 904, w: 810, h: 36, kind: "zone", label: "source 24" },
  ]),
  // templates/lux/li-1080x1350.svg
  {
    id: "lane/li-1350",
    name: "LinkedIn 1080×1350 (LUX chart well)",
    w: 1080,
    h: 1350,
    lines: [
      { axis: "x", value: 108, label: "safe x 108", dashed: true },
      { axis: "x", value: 972, label: "safe x 972", dashed: true },
      { axis: "y", value: 1270, label: "footer baseline y 1270" },
    ],
    zones: [
      ...columns(80, 96, 920, 1134, 6, 24),
      { x: 80, y: 96, w: 920, h: 1134, kind: "margin" },
      { x: 108, y: 144, w: 864, h: 208, kind: "zone", label: "headline 60/68 · ≤ 3 lines" },
      { x: 108, y: 360, w: 864, h: 740, kind: "well", label: "chart well 864×740" },
      { x: 108, y: 1148, w: 864, h: 40, kind: "zone", label: "source 24" },
      { x: 920, y: 1230, w: 160, h: 120, kind: "keep-out", label: "keep-out" },
    ],
  },
  // templates/kites/ig-1080.svg
  square("kites/ig-1080", "Kites · square 1080 (art well)", [
    { x: 72, y: 136, w: 936, h: 544, kind: "well", label: "art well 936×544" },
    { x: 135, y: 720, w: 810, h: 160, kind: "zone", label: "headline 72/80 · 2 lines" },
    { x: 135, y: 888, w: 810, h: 48, kind: "zone", label: "body 34 @ 920" },
  ]),
  // templates/studio/ig-1080.svg (old Web shop pack)
  square("studio/ig-1080", "Web shop · square 1080 (art well)", [
    { x: 72, y: 136, w: 936, h: 568, kind: "well", label: "art well 936×568" },
    { x: 135, y: 736, w: 810, h: 160, kind: "zone", label: "headline 72/80 · 2 lines" },
    { x: 135, y: 904, w: 810, h: 56, kind: "zone", label: "sub 36 @ 936 or chip" },
  ]),
  // Mosaic daily posts: headline on top (x 135, baselines 148 / 240 / 332 at 84/92), no footer
  // (PLAN-DAILY §7, daily-2026-10-26 copy.json layout). The art fills the rest of the margin box.
  square(
    "mosaic/ig-1080",
    "Mosaic · square 1080 (headline on top, no footer)",
    [
      { x: 135, y: 72, w: 810, h: 284, kind: "zone", label: "headline 84/92 · ≤ 3 lines" },
      { x: 72, y: 380, w: 936, h: 628, kind: "well", label: "art" },
    ],
    false,
  ),
  {
    id: "lane/story-1920",
    name: "Story 1080×1920 (no lane template yet)",
    w: 1080,
    h: 1920,
    lines: [
      { axis: "x", value: 108, label: "safe x 108", dashed: true },
      { axis: "x", value: 972, label: "safe x 972", dashed: true },
      { axis: "y", value: 250, label: "story UI top", dashed: true },
      { axis: "y", value: 1670, label: "story UI bottom", dashed: true },
    ],
    zones: [
      { x: 0, y: 0, w: 1080, h: 250, kind: "keep-out", label: "story header" },
      { x: 0, y: 1670, w: 1080, h: 250, kind: "keep-out", label: "reply bar" },
    ],
  },
];

/** Brand names that mean the same guide set. */
export const GUIDE_ALIASES: Record<string, string> = {
  "lux/ig-1080": "lane/ig-1080",
  "lux/li-1350": "lane/li-1350",
  "lux/li-1080x1350": "lane/li-1350",
};

/** The guide set for a frame: its `guides` name if known, else the one matching its size. */
export function guidesFor(frame: { w: number; h: number; guides?: string }): GuideSet | undefined {
  const named = frame.guides ? (GUIDE_ALIASES[frame.guides] ?? frame.guides) : undefined;
  if (named === "none") return undefined;
  return GUIDE_SETS.find((g) => g.id === named) ?? GUIDE_SETS.find((g) => g.w === frame.w && g.h === frame.h);
}

export function knownGuideSet(name: string): boolean {
  return name === "none" || GUIDE_SETS.some((g) => g.id === (GUIDE_ALIASES[name] ?? name));
}
