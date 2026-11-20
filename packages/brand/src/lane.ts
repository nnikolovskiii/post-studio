import type { BrandKit } from "./kits.ts";
import type { PaletteLane } from "./check-svg.ts";

/** The check_palette.py lane for a kit (its lane name in messages, paper, accent and colours). */
export function paletteLane(kit: BrandKit): PaletteLane {
  return { name: kit.checkPaletteLane ?? kit.id, paper: kit.paperHex, accent: kit.accentHex, colors: kit.byHex };
}
