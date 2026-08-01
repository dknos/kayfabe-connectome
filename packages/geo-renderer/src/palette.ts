/**
 * A restrained archival palette. The globe is a reading surface for documented
 * records, not a light show: dark oceans, subtle land, one accent for activity
 * and one for evidence-backed title changes.
 *
 * Colours are plain [r,g,b] 0..1 so this module stays free of any Cesium
 * import — the engine converts them once, at the boundary.
 */
export type RGB = readonly [number, number, number];

export const GEO_COLORS = {
  /** Active card beacon — cool white-cyan, reads at 1px against dark land. */
  beacon: [0.62, 0.86, 1.0] as RGB,
  beaconHot: [0.86, 0.96, 1.0] as RGB,
  /** Expanding ripple, same hue, lower energy. */
  ring: [0.42, 0.72, 0.96] as RGB,
  /** Vertical light column. */
  column: [0.5, 0.8, 1.0] as RGB,
  /** Documented title change. Gold is reserved for this and nothing else. */
  gold: [1.0, 0.82, 0.35] as RGB,
  goldCore: [1.0, 0.93, 0.72] as RGB,
  /** Chronological record connection — deliberately dim, it proves nothing. */
  arc: [0.45, 0.55, 0.72] as RGB,
  /** Accumulated geographic footprint. */
  heatLow: [0.18, 0.34, 0.52] as RGB,
  heatHigh: [0.95, 0.62, 0.32] as RGB,
  /** Selected / pinned place. */
  select: [1.0, 0.45, 0.35] as RGB,
  label: [0.85, 0.91, 0.98] as RGB,
  labelHalo: [0.02, 0.04, 0.07] as RGB,
} as const;

/** Linear blend used for the heat ramp; keeps the ramp inspectable in tests. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/**
 * Heat ramp over a 0..1 weight. Square-rooted because card counts per place
 * are extremely long-tailed (Korakuen Hall holds 2,402 cards while the median
 * place holds 4) — a linear ramp would leave every place but a handful black.
 */
export function heatColor(t: number): RGB {
  return mix(GEO_COLORS.heatLow, GEO_COLORS.heatHigh, Math.sqrt(t < 0 ? 0 : t > 1 ? 1 : t));
}
