// Frame presets and template guides. The square and LinkedIn guides are the hidden `guides`
// layer of the social-posts lane templates (fixtures/social-posts/lux-1-leaderboard/post.svg and
// post-li.svg): 6-column grid, safe column, chart well, headline / source zones, footer
// baseline and the bottom-right keep-out. The story guides are new (no lane template yet).
export interface FramePreset {
  id: "ig" | "li" | "story";
  name: string;
  w: number;
  h: number;
  guides: string;
}

export const FRAME_PRESETS: FramePreset[] = [
  { id: "ig", name: "Instagram square", w: 1080, h: 1080, guides: "lane/ig-1080" },
  { id: "li", name: "LinkedIn", w: 1080, h: 1350, guides: "lane/li-1350" },
  { id: "story", name: "Story", w: 1080, h: 1920, guides: "lane/story-1920" },
];

export { GUIDE_SETS, guidesFor, type GuideLine, type GuideSet, type GuideZone } from "@post-studio/brand";
import type { GuideSet } from "@post-studio/brand";

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Lines that snapping uses: guide lines and the edges of zones (not every grid column). */
export function guideSnapLines(set: GuideSet | undefined): { x: number[]; y: number[] } {
  if (!set) return { x: [], y: [] };
  const x = new Set<number>();
  const y = new Set<number>();
  for (const l of set.lines) (l.axis === "x" ? x : y).add(l.value);
  for (const z of set.zones) {
    x.add(z.x);
    x.add(round3(z.x + z.w));
    if (z.kind !== "column") {
      y.add(z.y);
      y.add(round3(z.y + z.h));
    }
  }
  return { x: [...x].sort((a, b) => a - b), y: [...y].sort((a, b) => a - b) };
}
