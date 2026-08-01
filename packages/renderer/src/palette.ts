import * as THREE from "three";

/** Semantic color system — mirrors the CSS tokens. Data meaning only, no decoration. */
export const COLORS = {
  bg: new THREE.Color("#04060b"),
  opposed: new THREE.Color("#ff7a45"),
  same: new THREE.Color("#3fd3ff"),
  br: new THREE.Color("#8f7a52"),
  gold: new THREE.Color("#ffd166"),
  promotion: new THREE.Color("#cfe0f4"),
  select: new THREE.Color("#ffffff"),
  caution: new THREE.Color("#b3ac6f"),
};

/**
 * Community hues: a restrained teal → blue → violet band, with one warm accent
 * every seventh community.
 *
 * The previous walk was a full golden-angle sweep of the colour wheel, so
 * community hue competed with the SEMANTIC fiber colours — ember for opposed,
 * cyan for same-side, gold for a title change. Those three have to stay the
 * loudest thing on screen, because they carry meaning; a community index does
 * not. Constraining the band to 96° and dropping saturation gives community a
 * legible identity without letting it shout over the semantics.
 */
export function communityColor(community: number): THREE.Color {
  if (community < 0) return COLORS.promotion.clone();
  // A periodic warm accent keeps neighbouring communities separable inside a
  // narrow band — without it a 96° sweep reads as one colour at low saturation.
  if (community % 7 === 3) return new THREE.Color().setHSL(0.075, 0.42, 0.6);
  const hue = (188 + ((community * 61) % 96)) / 360;
  const sat = 0.3 + 0.11 * (((community * 7) % 3) / 2);
  const light = 0.52 + 0.07 * ((community * 13) % 2);
  return new THREE.Color().setHSL(hue, sat, light);
}

export function edgeColor(
  same: number,
  opposed: number,
  br: number,
  title: number,
): THREE.Color {
  const total = same + opposed + br || 1;
  const c = new THREE.Color(0, 0, 0);
  const mix = (col: THREE.Color, k: number) => {
    c.r += col.r * k;
    c.g += col.g * k;
    c.b += col.b * k;
  };
  mix(COLORS.same, same / total);
  mix(COLORS.opposed, opposed / total);
  mix(COLORS.br, br / total);
  if (title > 0) c.lerp(COLORS.gold, Math.min(0.45, title / total));
  return c;
}

/** Deterministic per-edge scalar in [0,1) from stable ids — used for curve bowing. */
export function hash01(seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}
