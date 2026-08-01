import type { LayoutBounds } from "@kayfabe/morph-renderer";

/**
 * One world-space vocabulary for every Morph Lab layout.
 *
 * The organic tissue is scaled once into these units and every organized
 * board is built in them, so a node's journey between readings is a real
 * distance, not a projection trick. All layouts are pure and deterministic:
 * same corpus, same selection, same controls → byte-identical typed arrays.
 */

/** organic positions arrive normalized ~[-1,1]; the world multiplies by this */
export const ORGANIC_SCALE = 300;

/** loom geometry */
export const LOOM = {
  centerW: 150,
  centerH: 60,
  railX: 300, // opponent / partner rail spine distance from centre
  chipW: 118,
  chipH: 15,
  chipGap: 4.5,
  colGap: 130,
  busY: 296, // promotion context bus height
  goldY: 232, // championship bus height
  brY: -244, // battle-royal rail
  maxChips: 34, // full chips per rail before the compact grid takes over
  maxBr: 40,
} as const;

/** background compression shells around any organized board */
export const RACK = {
  margin: 120,
  promoShelfGap: 60,
  cell: 7.5,
  dimAlpha: 0.055,
  scale: 1.1,
} as const;

export const Z = {
  backplate: -8,
  rack: -6,
  rail: -4,
  trace: 0,
  node: 2,
  chip: 3,
  playhead: 30,
} as const;

export type LoomSort = "strength" | "first" | "latest" | "median" | "alpha";
export type BankGroup = "decade" | "activity" | "alpha" | "champ";

export interface MorphControlsState {
  sort: LoomSort;
  group: BankGroup;
  /** loom option: vertical position = first documented encounter date */
  timeAxis: boolean;
}

export const DEFAULT_MORPH_CONTROLS: MorphControlsState = {
  sort: "strength",
  group: "decade",
  timeAxis: false,
};

/** deterministic tie-break: primary desc/asc already applied, then id */
export function stableByIdTie(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function emptyBounds(): LayoutBounds {
  return { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
}

export function growBounds(b: LayoutBounds, x: number, y: number, pad = 0): void {
  if (x - pad < b.minX) b.minX = x - pad;
  if (x + pad > b.maxX) b.maxX = x + pad;
  if (y - pad < b.minY) b.minY = y - pad;
  if (y + pad > b.maxY) b.maxY = y + pad;
}

/** label priorities, aligned with the atlas ladder */
export const PRIORITY = {
  selected: 1000,
  hovered: 900,
  playback: 800,
  pinned: 700,
  header: 600,
  neighborBase: 100,
  neighborSpan: 400,
  context: 520,
  ambient: 10,
} as const;
