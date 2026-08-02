import * as THREE from "three";

/**
 * Morph Lab palette.
 *
 * The semantic colours are identical to the connectome's: a wrestler's
 * opposition is the same ember in every spatial reading, and the structure
 * structure stays desaturated so the relationship colours are always the
 * loudest thing on screen. Deliberately duplicated, not imported — one lens
 * importing another's palette is how a shared utility becomes a shared bug
 * (the same rule every renderer follows against the connectome).
 */
export const M = {
  bg: new THREE.Color("#04060b"),
  opposed: new THREE.Color("#ff7a45"),
  same: new THREE.Color("#3fd3ff"),
  br: new THREE.Color("#8f7a52"),
  gold: new THREE.Color("#ffd166"),
  promotion: new THREE.Color("#cfe0f4"),
  select: new THREE.Color("#ffffff"),
  caution: new THREE.Color("#b3ac6f"),

  // circuit-board structure — desaturated blues, never competing with semantics
  plate: new THREE.Color("#0d1420"),
  plateLit: new THREE.Color("#1d2b42"),
  rule: new THREE.Color("#1b2536"),
  ruleBright: new THREE.Color("#2c3c58"),
  dim: new THREE.Color("#5a6880"),
  text: new THREE.Color("#d6e2f0"),
  goldDeep: new THREE.Color("#a8792a"),
  goldHot: new THREE.Color("#ffeaa8"),
} as const;

export type RGB = [number, number, number];

export const rgb = (c: THREE.Color): RGB => [c.r, c.g, c.b];

export const mixRgb = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export const scaleRgb = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/**
 * Community hue — the connectome's exact function, so a wrestler's soma keeps
 * its colour when the tissue reorganises. Quiet teal→violet band with a warm
 * accent every seventh community; semantic colours stay loudest.
 */
export function communityColor(community: number): THREE.Color {
  if (community < 0) return M.promotion.clone();
  if (community % 7 === 3) return new THREE.Color().setHSL(0.075, 0.42, 0.6);
  const hue = (188 + ((community * 61) % 96)) / 360;
  const sat = 0.3 + 0.11 * (((community * 7) % 3) / 2);
  const light = 0.52 + 0.07 * ((community * 13) % 2);
  return new THREE.Color().setHSL(hue, sat, light);
}

/** Deterministic integer hash → [0,1). Same recipe as the connectome's. */
export function hash01(seed: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Blend of the relationship channels, weighted by observation share, pulled
 * toward gold by title share — the connectome's fiber colour recipe.
 */
export function relationColor(same: number, opposed: number, br: number, title: number): RGB {
  const total = Math.max(1, same + opposed + br);
  const out: RGB = [0, 0, 0];
  const add = (c: THREE.Color, w: number) => {
    out[0] += c.r * w;
    out[1] += c.g * w;
    out[2] += c.b * w;
  };
  add(M.same, same / total);
  add(M.opposed, opposed / total);
  add(M.br, br / total);
  const g = Math.min(0.45, title / total);
  return mixRgb(out, rgb(M.gold), g);
}

/** Log ramp for long-tailed activity values, floored so nothing vanishes. */
export function activity01(value: number, ceiling: number): number {
  if (ceiling <= 0) return 0.06;
  return Math.max(0.06, Math.log1p(Math.max(0, value)) / Math.log1p(ceiling));
}
