/**
 * Arena Array shared types and the constants the spikes measured.
 *
 * Every number here is the answer to a question that was asked with a probe,
 * not a value that felt right. Where a constant is load-bearing the comment
 * says what breaks without it, because these are exactly the values a later
 * tidy-up would "simplify" back into a bug.
 */

/** Which semantic bank a card is seated in. Derived from the corpus's own
 *  distinction: documented opposition versus documented partnership, with a
 *  pair carrying both being a third thing rather than an average. */
export const AB = {
  /** the subject the arena is built around */
  CENTER: 0,
  /** documented opposition only */
  OPPOSED: 1,
  /** documented tag partnership only */
  SAME: 2,
  /** documented as both — a genuinely different relationship */
  MIXED: 3,
  /** a summary card standing for a group that exceeded the budget */
  AGGREGATE: 4,
  /** promotion / championship context */
  CONTEXT: 5,
} as const;
export type ArenaBank = (typeof AB)[keyof typeof AB];

/** Emphasis ladder. Doubles as the label-priority order. */
export const AE = {
  AMBIENT: 0,
  MEMBER: 1,
  PINNED: 2,
  PATH: 3,
  HOVERED: 4,
  FOCUSED: 5,
  SELECTED: 6,
} as const;
export type ArenaEmphasis = (typeof AE)[keyof typeof AE];

/** Card lifecycle within a formation change. */
export const CS = { ABSENT: 0, ENTER: 1, RETAIN: 2, LEAVE: 3 } as const;

/**
 * Deterministic transition ordering, from the brief. This is "semantic
 * stagger, not random stagger" expressed as a number.
 */
export const BAND = {
  CENTER: 0,
  SPINE: 1,
  DIRECT: 2,
  CONTEXT: 3,
  AGGREGATE: 4,
  ROUTE: 5,
  AMBIENT: 6,
} as const;
export const BAND_COUNT = 7;
export const bandDelay = (band: number): number => band / (BAND_COUNT - 1);

/**
 * Elements animate over this fraction of the clock; delays occupy the rest.
 * That is what makes "once settled, everything becomes still" true by
 * construction: every card lands on the SAME frame regardless of its delay.
 * Shrinking this without shrinking the delay range staggers the landing.
 */
export const FORMATION_WINDOW = 0.62;
export const FORMATION_DELAY_MAX = 1 - FORMATION_WINDOW;
/** The brief asks the assembly to read at 1.2–1.6 s. */
export const ARENA_MS = 1400;
export const ARENA_REDUCED_MS = 190;

/** quintic in-out — must match any GLSL copy exactly. */
export const easeQuintic = (t: number): number =>
  t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;

export const elementProgress = (raw: number, delay: number): number => {
  const t = (raw - delay * FORMATION_DELAY_MAX) / FORMATION_WINDOW;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
};

export const CARD_W = 1.55;
export const CARD_H = 0.92;

/**
 * Bounded prominence. An unbounded map from match count to size lets one
 * 170-match card dwarf the field and destroys the reading.
 */
export function prominence(strength: number, maxStrength: number): number {
  if (maxStrength <= 0) return 1;
  const t = Math.sqrt(Math.min(1, Math.max(0, strength / maxStrength)));
  return 0.82 + t * 0.62;
}

export type ArenaFormation = "echo" | "arena" | "index";

export interface ArenaCard {
  id: string;
  name: string;
  bank: ArenaBank;
  /** documented weight behind the seating, already combined */
  strength: number;
  /** decade key inside the active scope, NOT the person's global debut */
  era: string;
  firstYear: number;
  lastYear: number;
  /** canonical connectome position, for the Echo formation */
  pos: readonly [number, number, number] | null;
  /** documented reigns; drives championship context, never invented */
  reigns: number;
  /** set when this card summarises others rather than being a person */
  represents?: number;
}

export interface ArenaSection {
  key: string;
  label: string;
  /** angular span in radians, measured from centre stage */
  from: number;
  to: number;
  match: (card: ArenaCard) => boolean;
}

export interface ArenaLayoutResult {
  seated: number;
  dropped: number;
  layoutMs: number;
  /** Half-extent of the seated field in world units. The camera frames from
   *  this rather than from a fixed distance, because a 142-card bank grows far
   *  more tiers than a 31-card one and a constant camera lets the wide side
   *  run off the viewport. */
  extent: number;
  sections: { key: string; label: string; count: number }[];
  notes: string[];
}

export interface ArenaTierBudget {
  cards: number;
  labels: number;
  routes: number;
  pulses: number;
  bloom: boolean;
  pixelRatioCap: number;
}

/**
 * Quality tiers degrade INDIVIDUALLY — the brief forbids one binary switch
 * that either enables everything or breaks the scene. Each field is a separate
 * lever and the low tier is a coherent scene, not a broken one.
 */
export const ARENA_TIERS: Record<"low" | "medium" | "high", ArenaTierBudget> = {
  // Label budgets are a CEILING, not a target. Collision suppression decides
  // what actually fits, so a low ceiling silently caps the reading even when
  // there is room — which is what made a zoomed-in arena still show 48 names.
  // Labels barely move the frame — the pass measures 0.0-0.2 ms — so the tier
  // ladder cuts what is actually expensive (bloom, routes, fill, card count)
  // and leaves the names largely alone. Demoting the tier used to take names
  // away, which meant zooming in to read more of them produced fewer, and the
  // reader was punished for the thing they came to do.
  // Routes and pulses are priced very differently and the ladder now reflects
  // it. A fat route is ONE DRAW CALL EACH, so its budget stays small; the whole
  // pulse field is a single instanced draw, so it can be generous. The reading
  // lives in the pulses — how much documented evidence a relationship carries —
  // and the fibre is only there to say where the pulse is going.
  low: { cards: 160, labels: 80, routes: 10, pulses: 12, bloom: false, pixelRatioCap: 1 },
  medium: { cards: 360, labels: 120, routes: 22, pulses: 28, bloom: true, pixelRatioCap: 1.5 },
  high: { cards: 600, labels: 160, routes: 40, pulses: 52, bloom: true, pixelRatioCap: 2 },
};

export type ArenaQualityTier = keyof typeof ARENA_TIERS;

export interface ArenaPickResult {
  id: string;
  slot: number;
}
