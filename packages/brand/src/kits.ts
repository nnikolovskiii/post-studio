// Brand kits (PLAN Phase 5): one per social-posts lane, as data in brand-kits/<id>.json.
// Tokens are '<kit>.<name>' (e.g. { "token": "lux.ink" }); aliases ('lux.accent' → 'lux.mark')
// resolve to the same hex. Pure module: the JSON is bundled, so the editor uses the same kits.
import { z } from "zod";
import lux from "../../../brand-kits/lux.json" with { type: "json" };
import kites from "../../../brand-kits/kites.json" with { type: "json" };
import mosaic from "../../../brand-kits/mosaic.json" with { type: "json" };
import studio from "../../../brand-kits/studio.json" with { type: "json" };

const Hex6 = z.string().regex(/^#[0-9A-F]{6}$/, "kit colours are upper-case #RRGGBB");
const TokenName = z.string().regex(/^[a-z][a-z0-9-]*$/);
const PerFrame = z.object({ square: z.number().optional(), li: z.number().optional() }).strict();

export const KitColorSchema = z.object({ name: TokenName, hex: Hex6, label: z.string(), source: z.string(), note: z.string().optional() }).strict();

export const TypeStyleSchema = z
  .object({
    name: TokenName,
    label: z.string(),
    font: z.string(),
    weight: z.number().int(),
    size: z.number().positive(),
    lineHeight: z.number().positive(),
    letterSpacing: z.number().optional(),
    /** A colour token name in the same kit. */
    fill: TokenName,
    case: z.enum(["upper", "lower"]).optional(),
    min: z.number().positive().optional(),
    maxLines: PerFrame.optional(),
    baseline: PerFrame.optional(),
    source: z.string(),
    /** True when a size is not written down in social-posts and was chosen here. */
    assumed: z.boolean().optional(),
  })
  .strict();

export const BrandKitSchema = z
  .object({
    id: TokenName,
    name: z.string(),
    lane: z.string(),
    description: z.string(),
    sources: z.array(z.string()).min(1),
    /** The lane name in social-posts/tools/check_palette.py, or null when it has none (yet). */
    checkPaletteLane: z.string().nullable(),
    paper: TokenName,
    accent: TokenName,
    colors: z.array(KitColorSchema).min(2),
    aliases: z.record(TokenName, TokenName),
    type: z.array(TypeStyleSchema),
    /** '<w>x<h>' → guide set id. */
    guides: z.record(z.string().regex(/^\d+x\d+$/), z.string()),
    rules: z.record(z.string(), z.string()),
  })
  .strict();

export type KitColor = z.infer<typeof KitColorSchema>;
export type TypeStyle = z.infer<typeof TypeStyleSchema>;
export type BrandKitData = z.infer<typeof BrandKitSchema>;

export interface BrandKit extends BrandKitData {
  /** Upper-case hex → colour entry. */
  byHex: Map<string, KitColor>;
  /** Resolved hex of the paper and the accent. */
  paperHex: string;
  accentHex: string;
  /** Token name (incl. aliases) → hex. */
  hex(name: string): string | undefined;
  style(name: string): TypeStyle | undefined;
}

function build(data: unknown): BrandKit {
  const k = BrandKitSchema.parse(data);
  const byName = new Map(k.colors.map((c) => [c.name, c]));
  const byHex = new Map<string, KitColor>();
  for (const c of k.colors) {
    if (byHex.has(c.hex)) throw new Error(`kit ${k.id}: ${c.hex} listed twice`);
    byHex.set(c.hex, c);
  }
  const hex = (name: string) => byName.get(name)?.hex ?? (k.aliases[name] ? byName.get(k.aliases[name])?.hex : undefined);
  for (const [a, t] of Object.entries(k.aliases)) if (!byName.has(t)) throw new Error(`kit ${k.id}: alias ${a} → unknown colour ${t}`);
  for (const s of k.type) if (!hex(s.fill)) throw new Error(`kit ${k.id}: type style ${s.name} uses unknown colour ${s.fill}`);
  const paperHex = hex(k.paper);
  const accentHex = hex(k.accent);
  if (!paperHex || !accentHex) throw new Error(`kit ${k.id}: paper / accent must be colours of the kit`);
  const styles = new Map(k.type.map((s) => [s.name, s]));
  return { ...k, byHex, paperHex, accentHex, hex, style: (n) => styles.get(n) };
}

const KITS = new Map<string, BrandKit>([lux, mosaic, kites, studio].map((d) => build(d)).map((k) => [k.id, k]));

export function listKits(): BrandKit[] {
  return [...KITS.values()];
}

export function getKit(id: string | null | undefined): BrandKit | undefined {
  return id ? KITS.get(id) : undefined;
}

/** '<kit>.<name>' → #RRGGBB, for any registered kit. Undefined when unknown. */
export function resolveBrandToken(token: string): string | undefined {
  const dot = token.indexOf(".");
  if (dot < 1) return undefined;
  return KITS.get(token.slice(0, dot))?.hex(token.slice(dot + 1));
}

/** The token name of a hex in a kit (first name wins), e.g. '#190F0B' → 'lux.ink'. */
export function tokenFor(kit: BrandKit, hex: string): string | undefined {
  const c = kit.byHex.get(hex.slice(0, 7).toUpperCase());
  return c ? `${kit.id}.${c.name}` : undefined;
}

/** Plain data for the API / editor (no Maps or functions). */
export function kitJson(kit: BrandKit): BrandKitData & { paperHex: string; accentHex: string } {
  const { byHex: _b, hex: _h, style: _s, ...data } = kit;
  return data;
}
