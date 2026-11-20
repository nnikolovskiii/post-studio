// Ease presets (PLAN-motion.md §4.1): a fixed list, no curve editor. Each maps progress
// p ∈ [0, 1] to a share of the change; the endpoints are exact (0 → 0, 1 → 1).
import type { EaseName } from "@post-studio/schema";

/** Overshoot constant of `back-out`: the curve peaks at about 1.10 (10 % past the target). */
export const BACK_OUT_C1 = 1.70158;

const clamp01 = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : p);

export const EASE_FUNCTIONS: Readonly<Record<EaseName, (p: number) => number>> = {
  linear: (p) => p,
  in: (p) => p * p * p,
  out: (p) => 1 - (1 - p) ** 3,
  "in-out": (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  "back-out": (p) => {
    const c3 = BACK_OUT_C1 + 1;
    const q = p - 1;
    // Exact at the ends: the formula gives 1 + c3 − c1 − 1 = 0 at p = 0 only up to rounding.
    return p === 0 ? 0 : p === 1 ? 1 : 1 + c3 * q * q * q + BACK_OUT_C1 * q * q;
  },
  // Stays at the start value and jumps at the next keyframe.
  hold: (p) => (p >= 1 ? 1 : 0),
};

/** Eased progress. `p` is clamped to [0, 1]. */
export function ease(name: EaseName | undefined, p: number): number {
  const f = EASE_FUNCTIONS[name ?? "out"] ?? EASE_FUNCTIONS.out;
  return f(clamp01(p));
}
