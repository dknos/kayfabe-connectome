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

/** Relationship Array geometry. Internal `loom` mode ids remain URL-stable. */
export const LOOM = {
  railX: 300,
  railDepth: 360,
  bankHeight: 520,
  shelfGap: 72,
  busY: 310,
  goldY: 238,
  brY: -285,
  maxChips: 190,
  maxBr: 100,
} as const;

/** background compression shells around any organized board */
export const RACK = {
  margin: 260,
  promoShelfGap: 120,
  cell: 11,
  dimAlpha: 0.018,
  scale: 0.85,
} as const;

export const Z = {
  backplate: -42,
  rack: -620,
  rail: -18,
  trace: 0,
  node: 12,
  chip: 18,
  playhead: 48,
} as const;

export type LoomSort = "strength" | "first" | "latest" | "median" | "alpha";
export type BankGroup = "decade" | "activity" | "alpha" | "champ";

export interface MorphControlsState {
  sort: LoomSort;
  group: BankGroup;
  /** loom option: vertical position = first documented encounter date */
  timeAxis: boolean;
  /** distant, low-exposure corpus shell around an organized reading */
  context?: boolean;
}

export const DEFAULT_MORPH_CONTROLS: MorphControlsState = {
  sort: "strength",
  group: "decade",
  timeAxis: false,
  context: true,
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

/** label priorities shared across organized morphology layouts */
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
