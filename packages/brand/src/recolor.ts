// The `svg` node recolour map (hex → hex), shared by the renderer and the palette check.

function normHex3(h: string): string {
  let s = h.toUpperCase();
  if (s.length === 4) s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  return s;
}

export function recolorMap(recolor?: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(recolor ?? {})) map.set(k.toUpperCase().slice(0, 7), v.toUpperCase());
  return map;
}

/** Replace hex colors in a string by the recolor map (keys/values #RRGGBB, case-insensitive; #RGB matches too). */
export function recolorText(text: string, map: Map<string, string>): string {
  if (!map.size) return text;
  return text.replace(/#([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})(?![0-9A-Fa-f])/g, (m, hex: string) => {
    if (hex.length === 8) {
      const to = map.get(("#" + hex.slice(0, 6)).toUpperCase());
      return to ? to.slice(0, 7) + hex.slice(6) : m;
    }
    return map.get(normHex3(m)) ?? m;
  });
}
