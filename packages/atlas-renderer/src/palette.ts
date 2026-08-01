import * as THREE from "three";
import type { RGB } from "./types";

/**
 * ATLAS palette.
 *
 * Deliberately the SAME semantic system as the connectome — ember for opposed,
 * cyan for same-side, gold for championships, pale blue for promotions, a
 * muted olive for battle-royal contact. A second lens on one corpus that
 * recoloured the same facts would be a second corpus.
 *
 * What ATLAS adds is a structural tier the connectome has no use for: lane
 * platforms, rulers, dividers and zone backings. Those are all desaturated
 * blues so nothing structural can compete with anything semantic.
 */
export const A = {
  bg: new THREE.Color("#04060b"),

  // semantic — identical values to packages/renderer/src/palette.ts
  opposed: new THREE.Color("#ff7a45"),
  same: new THREE.Color("#3fd3ff"),
  br: new THREE.Color("#8f7a52"),
  gold: new THREE.Color("#ffd166"),
  promotion: new THREE.Color("#cfe0f4"),
  select: new THREE.Color("#ffffff"),
  caution: new THREE.Color("#b3ac6f"),

  // structure
  platform: new THREE.Color("#0e1522"),
  platformLit: new THREE.Color("#22314a"),
  rule: new THREE.Color("#1b2536"),
  ruleBright: new THREE.Color("#2c3c58"),
  dim: new THREE.Color("#5a6880"),
  text: new THREE.Color("#d6e2f0"),

  // gold family — a lineage needs more than one gold or every reign reads flat
  goldDeep: new THREE.Color("#a8792a"),
  goldHot: new THREE.Color("#ffeaa8"),
} as const;

export const rgb = (c: THREE.Color): RGB => [c.r, c.g, c.b];

/** Linear blend, allocation-free at the call site. */
export function mix(a: THREE.Color, b: THREE.Color, t: number): RGB {
  return [a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t];
}

export function scale(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/**
 * Community hue for a person, matching the connectome exactly so a wrestler is
 * the same colour in both lenses. Duplicated rather than imported because the
 * atlas renderer must not depend on the connectome renderer — they are
 * siblings, and one importing the other is how a "shared utility" becomes a
 * shared bug.
 */
export function communityColor(community: number): THREE.Color {
  if (community < 0) return A.promotion.clone();
  if (community % 7 === 3) return new THREE.Color().setHSL(0.075, 0.42, 0.6);
  const hue = (188 + ((community * 61) % 96)) / 360;
  const sat = 0.3 + 0.11 * (((community * 7) % 3) / 2);
  const light = 0.52 + 0.07 * ((community * 13) % 2);
  return new THREE.Color().setHSL(hue, sat, light);
}

/**
 * Activity brightness. Documented volume is long-tailed by three orders of
 * magnitude (a 3-card indie against 88,000 WWE matches), so a linear ramp
 * renders every promotion but six as black. Log, floored so the smallest
 * documented promotion is still visibly present rather than implied.
 */
export function activity01(value: number, ceiling: number): number {
  if (value <= 0) return 0;
  const t = Math.log1p(value) / Math.log1p(Math.max(1, ceiling));
  return Math.min(1, Math.max(0.06, t));
}
