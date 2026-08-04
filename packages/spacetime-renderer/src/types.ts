/**
 * Spacetime / Warp Field — shared types, constants, and the pure math twins.
 *
 * Everything here is importable in plain node (no three.js, no DOM), which is
 * what makes the focus field, the time axis and the LUT sampling unit-testable.
 * The GLSL copies of `lnCosh` / `focusIntegral` / `timeAxisX` live in
 * WorldlineField.ts and MUST stay numerically identical — the worldline
 * ribbons are positioned on the GPU while event beads and picking use these
 * TS functions, and a drift between the two shears events off their lines.
 */

/** Relationship class of a worldline / participant, from the corpus's own
 *  distinction (encounters@2). Never re-derived here. */
export const SC = {
  /** the subject the field is built around */
  CENTER: 0,
  /** documented opposition only */
  OPPOSED: 1,
  /** documented tag partnership only */
  SAME: 2,
  /** documented as both — a genuinely different relationship */
  MIXED: 3,
  /** battle-royal co-presence — a weaker, separate class, never a rivalry */
  BR: 4,
  /** present in a match but unclassified for it (collapsed multi-way sides) */
  CONTEXT: 5,
} as const;
export type SpacetimeClass = (typeof SC)[keyof typeof SC];

/** Emphasis ladder; doubles as label priority. */
export const SE = {
  AMBIENT: 0,
  MEMBER: 1,
  HOVERED: 4,
  SELECTED: 6,
} as const;

export type SpacetimeMode = "exterior" | "bridge";

/** Result codes as packed by spacetime-projection@1 (flags bits 3-4). */
export const SR = { UNKNOWN: 0, WIN: 1, LOSS: 2, DRAW: 3 } as const;

/** One decoded documented match of the subject. */
export interface SpacetimeEvent {
  day: number;
  promoIdx: number;
  form: number;
  result: number;
  titleMatch: boolean;
  titleChange: boolean;
  apx: boolean;
  ppv: boolean;
  persona: number;
  unk: boolean;
  /** graph node indexes, classified via canonical evidence */
  same: Int32Array;
  opposed: Int32Array;
  context: Int32Array;
  matchRef: string;
  eventName: string;
  /** 0 = no reported rating (missing is not zero); else rating*100+1 */
  rating100p1: number;
}

export interface SpacetimeRelationship {
  p: string;
  n: string;
  nodeIdx: number;
  same: number;
  opposed: number;
  br: number;
  firstDay: number;
  lastDay: number;
  /** deterministic five-year evidence buckets [startYear, matches] */
  buckets: [number, number][];
}

export interface SpacetimePersona {
  id: string;
  label: string;
  nodeIdx: number;
  firstDay: number;
  lastDay: number;
}

export interface SpacetimeScope {
  subjectId: string;
  subjectLabel: string;
  nodeIdx: number;
  personas: SpacetimePersona[];
  events: SpacetimeEvent[];
  relationships: SpacetimeRelationship[];
  /** promoIdx is the dictionary index the adapter resolved for each promotion,
   *  so the layout can map an event's promoIdx to a sector without a lookup
   *  table of its own. */
  promos: { pr: string; n: string; count: number; firstDay: number; lastDay: number; promoIdx?: number }[];
  titles: { t: string; matches: number; changes: number }[];
  dayRange: [number, number];
}

export interface SpacetimeTierBudget {
  /** related worldlines drawn (the rest are counted, never silently lost) */
  worldlines: number;
  labels: number;
  packets: number;
  bloom: boolean;
  bubble: boolean;
  pixelRatioCap: number;
}

/** Each lever degrades individually; low is a coherent scene, not a broken
 *  one. Worldlines and events are ONE draw call each regardless of count, so
 *  the ladder cuts fill (bloom, bubble, DPR) before it cuts reading. */
export const SPACETIME_TIERS: Record<"low" | "medium" | "high", SpacetimeTierBudget> = {
  low: { worldlines: 48, labels: 80, packets: 12, bloom: false, bubble: false, pixelRatioCap: 1 },
  medium: { worldlines: 96, labels: 120, packets: 28, bloom: true, bubble: true, pixelRatioCap: 1.5 },
  high: { worldlines: 150, labels: 160, packets: 52, bloom: true, bubble: true, pixelRatioCap: 2 },
};
export type SpacetimeQualityTier = keyof typeof SPACETIME_TIERS;

export interface SpacetimePickResult {
  kind: "event" | "person";
  /** event index into scope.events, or relationship index */
  index: number;
  id: string;
}

/* ------------------------------------------------------------ focus field */

/**
 * The paper's bubble shape function, applied to HISTORY: d is distance from
 * the playhead in years, R the high-detail window, sigma the wall sharpness.
 * 1 at the playhead, 0 in deep history. arXiv:1107.5650 Eq. 4.
 */
export function focusF(d: number, R: number, sigma: number): number {
  return (Math.tanh(sigma * (d + R)) - Math.tanh(sigma * (d - R))) / (2 * Math.tanh(sigma * R));
}

/** Numerically stable ln(cosh(u)) — naive cosh overflows past |u| ~ 710. */
export function lnCosh(u: number): number {
  const a = Math.abs(u);
  return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2;
}

/**
 * Antiderivative of focusF in its first argument. Closed form is what lets
 * the SAME lens be evaluated per-vertex in GLSL and per-event in TS with no
 * integration and no lookup: the tanh bubble has an exact ln-cosh integral.
 */
export function focusIntegral(s: number, R: number, sigma: number): number {
  return (lnCosh(sigma * (s + R)) - lnCosh(sigma * (s - R))) / (2 * sigma * Math.tanh(sigma * R));
}

export const DAYS_PER_YEAR = 365.25;

export interface TimeAxis {
  /** day the axis starts at (subject's first documented record) */
  day0: number;
  /** playhead, in days */
  playheadDay: number;
  /** high-detail window half-width, years */
  bubbleR: number;
  /** wall sharpness, 1/years */
  bubbleSigma: number;
  /** how much extra room the bubble wins, as a multiple of linear time */
  gain: number;
  /** world units per COMPRESSED year outside the bubble */
  scale: number;
}

export const TIME_AXIS_DEFAULTS = {
  bubbleR: 0.75,
  bubbleSigma: 1.4,
  gain: 6,
  scale: 1.6,
} as const;

/**
 * Day -> world X. Monotone by construction: dX/dday = scale*(1 + gain*f) > 0.
 * Inside the bubble a year occupies (1+gain)x the room of a deep-history
 * year; the transition follows the paper's wall profile exactly.
 */
export function timeAxisX(day: number, axis: TimeAxis): number {
  const y = (day - axis.day0) / DAYS_PER_YEAR;
  const p = (axis.playheadDay - axis.day0) / DAYS_PER_YEAR;
  return axis.scale * (
    y + axis.gain * (
      focusIntegral(y - p, axis.bubbleR, axis.bubbleSigma) -
      focusIntegral(-p, axis.bubbleR, axis.bubbleSigma)
    )
  );
}

/** Inverse of timeAxisX by bisection — picking and the readout need day-of-x.
 *  The map is strictly monotone, so 40 iterations pin a day to < 1 minute. */
export function timeAxisDay(x: number, axis: TimeAxis, dayLo: number, dayHi: number): number {
  let lo = dayLo, hi = dayHi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (timeAxisX(mid, axis) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/* -------------------------------------------------------------- LUT codec */

export const LUT_LOG_DELTA_MAX = 6.0;
export const LUT_LOG_MAG_MAX = 3.0;
export const LUT_V_MAX = 9.0;

/** Row coordinate [0,1] for a warp speed — matches spacetime_lut.py:
 *  v = (v_max+1)**t - 1  =>  t = ln(v+1)/ln(v_max+1). */
export function lutRowOfSpeed(v: number): number {
  const c = Math.max(0, Math.min(LUT_V_MAX, v));
  return Math.log(c + 1) / Math.log(LUT_V_MAX + 1);
}

export interface LutSample {
  thetaApp: number;
  delta: number;
  mag: number;
  vis: number;
}

/** Normalised channels -> physical quantities (decode_texel twin). */
export function lutDecode(r: number, g: number, b: number, a: number): LutSample {
  return {
    thetaApp: r * Math.PI,
    delta: Math.exp(g * 2 * LUT_LOG_DELTA_MAX - LUT_LOG_DELTA_MAX),
    mag: Math.pow(10, b * 2 * LUT_LOG_MAG_MAX - LUT_LOG_MAG_MAX),
    vis: a,
  };
}

/* ------------------------------------------------------------- animation */

/** quintic in-out — must match any GLSL copy exactly. */
export const easeQuintic = (t: number): number =>
  t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;

export const SPACETIME_MS = 1100;
export const SPACETIME_REDUCED_MS = 160;

/** A worldline visibly dissolves across undocumented gaps longer than this,
 *  so the geometry never implies activity the corpus does not record. */
export const GAP_DISSOLVE_DAYS = 730;

/** Warp speed shown in Bridge mode for a given playback speed. Documented
 *  mapping, not physics: one year of records per second reads as one c. */
export function warpSpeedOfPlayback(daysPerSecond: number): number {
  return Math.max(0, Math.min(LUT_V_MAX, daysPerSecond / DAYS_PER_YEAR));
}
