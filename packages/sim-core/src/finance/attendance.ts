/**
 * attendance-demand@1 — how many people show up, and why.
 *
 * Full derivation and calibration of every constant lives in
 * docs/simulator/rules/finance.md. Two determinism constraints shape the
 * math here:
 *  - Math.sqrt is the only non-arithmetic function used: unlike exp/pow it
 *    is exactly specified by IEEE 754, so demand is bit-identical across JS
 *    engines (state-hash stability). Soft curves are built from divisions.
 *  - rng is optional: null yields the pure expectation (forecasts, AI
 *    planning); a stream adds bounded noise for actual show nights.
 */

import type {
  CompanyState,
  EraProfile,
  Market,
  MarketId,
  ShowForecast,
  ShowPlan,
  ShowType,
  Standing,
  Venue,
  WorkerState,
} from "@kayfabe/sim-contract";
import type { RngStream } from "../rng";
import { scaleCents } from "../money";

export const ATTENDANCE_METHOD = "attendance-demand@1";

/** Fraction of the aware+interested population a baseline show converts. */
const CONVERSION = 0.003;
/** Per-event audience ceiling, as a fraction of raw market population. */
const POOL_FRACTION = 0.003;
/** Show-night attendance noise, uniform in ±8%. */
const NOISE_BAND = 0.08;
/** Forecast attendance band, ±15% around the expectation. */
const FORECAST_BAND = 0.15;
/** Raw demand above this share of the pool means the market is nearly tapped. */
const SATURATION_WARN_SHARE = 0.7;
/** Expected crowd below this share of capacity reads as an empty building. */
const OVERSIZED_VENUE_SHARE = 0.4;
/** Pre-clamp demand above capacity × this flags a likely sellout. */
const SELLOUT_DEMAND_RATIO = 1.05;

const SHOW_TYPE_FACTOR: Record<ShowType, number> = { house: 0.6, tv: 1.0, ppv: 1.15 };

export interface AttendanceInputs {
  company: CompanyState;
  show: ShowPlan;
  venue: Venue;
  market: Market;
  advertisedWorkers: WorkerState[];
  era: EraProfile;
  rng: RngStream | null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** National standing plus the sparse per-market delta, clamped to range. */
export function effectiveStanding(
  standing: Standing,
  marketId: MarketId,
): { awareness: number; affinity: number } {
  const delta = standing.marketDelta[marketId];
  return {
    awareness: clamp(standing.awarenessNational + (delta ? delta.awareness : 0), 0, 100),
    affinity: clamp(standing.affinityNational + (delta ? delta.affinity : 0), -100, 100),
  };
}

/** −100 → 0.35 (a hated company still draws some), +100 → 1.0. */
export function affinityFactor(affinity: number): number {
  return 0.35 + 0.65 * ((clamp(affinity, -100, 100) + 100) / 200);
}

/**
 * Card appeal from the advertised names: per-worker draw score
 * awareness × (0.4 + 0.6·|affinity|) — absolute affinity, because a hated
 * act can be famous and heels sell tickets — top-3 weighted 0.5/0.3/0.2.
 * Result is 0..1; a lone name caps at 0.5 (thin cards draw less than
 * stacked ones by construction).
 */
function cardAppeal01(advertised: WorkerState[], marketId: MarketId): number {
  const scores = advertised.map((w) => {
    const s = effectiveStanding(w.standing, marketId);
    return {
      score: (s.awareness / 100) * (0.4 + 0.6 * (Math.abs(s.affinity) / 100)),
      id: w.personId,
    };
  });
  scores.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const weights = [0.5, 0.3, 0.2] as const;
  let total = 0;
  for (let i = 0; i < Math.min(3, scores.length); i++) {
    total += scores[i]!.score * weights[i]!;
  }
  return clamp(total, 0, 1);
}

/**
 * Price response versus the era-typical ticket adjusted for local economics.
 * Overpricing follows 1/ratio (double the reference price halves demand);
 * underpricing is a mild linear boost capped at +15% for free tickets.
 */
function priceCurve(
  ticketPriceCents: number,
  era: EraProfile,
  market: Market,
): { factor: number; ratio: number } {
  const reference = era.ticketPriceTypicalCents * (0.7 + 0.6 * (clamp(market.economicStrength, 0, 100) / 100));
  const ratio = reference > 0 ? ticketPriceCents / reference : 1;
  const factor = ratio <= 1 ? 1 + 0.15 * (1 - ratio) : 1 / ratio;
  return { factor, ratio };
}

interface DemandBreakdown {
  /** Saturation-dampened expectation: float, pre-noise, pre-capacity-clamp. */
  demand: number;
  rawDemand: number;
  pool: number;
  priceRatio: number;
  appeal01: number;
}

function computeDemand(inputs: AttendanceInputs): DemandBreakdown {
  const { company, show, market, era } = inputs;
  const standing = effectiveStanding(company.standing, market.id);
  const appeal01 = cardAppeal01(inputs.advertisedWorkers, market.id);
  const appealFactor = 0.3 + 0.7 * Math.sqrt(appeal01);
  const price = priceCurve(show.ticketPriceCents, era, market);
  const rawDemand =
    market.population *
    CONVERSION *
    (standing.awareness / 100) *
    (clamp(market.wrestlingInterest, 0, 100) / 100) *
    affinityFactor(standing.affinity) *
    appealFactor *
    price.factor *
    SHOW_TYPE_FACTOR[show.showType];
  const pool = market.population * POOL_FRACTION;
  // Michaelis–Menten dampening: linear while raw ≪ pool, asymptotic to pool.
  const demand = pool > 0 ? rawDemand / (1 + rawDemand / pool) : 0;
  return { demand, rawDemand, pool, priceRatio: price.ratio, appeal01 };
}

/**
 * Expected attendance: integer in 0..venue.capacity. rng null yields the
 * deterministic expectation; a stream applies uniform ±8% show-night noise.
 */
export function estimateAttendance(inputs: AttendanceInputs): number {
  let demand = computeDemand(inputs).demand;
  if (inputs.rng) {
    demand *= 1 + (inputs.rng.next() * 2 - 1) * NOISE_BAND;
  }
  const capacity = Math.max(0, Math.floor(inputs.venue.capacity));
  return clamp(Math.round(demand), 0, capacity);
}

/**
 * Pre-show forecast: ranges, never false precision. Always built from the
 * rng-null expectation, so the range contains what estimateAttendance would
 * return for the same inputs without noise.
 */
export function forecastShow(inputs: AttendanceInputs): ShowForecast {
  const breakdown = computeDemand(inputs);
  const expectation = estimateAttendance({ ...inputs, rng: null });
  const capacity = Math.max(0, Math.floor(inputs.venue.capacity));
  const lo = clamp(Math.floor(expectation * (1 - FORECAST_BAND)), 0, capacity);
  const hi = clamp(Math.ceil(expectation * (1 + FORECAST_BAND)), 0, capacity);
  const quality = clamp(Math.round(30 + 55 * Math.sqrt(breakdown.appeal01)), 0, 100);

  const warnings: string[] = [];
  if (inputs.advertisedWorkers.length === 0) {
    warnings.push("No advertised names — attendance relies on walk-in interest only.");
  }
  if (breakdown.priceRatio > 1.3) {
    warnings.push("Ticket price is high for this market's economics.");
  }
  if (capacity > 0 && expectation < capacity * OVERSIZED_VENUE_SHARE) {
    warnings.push("Venue looks too big for the expected crowd.");
  }
  if (breakdown.pool > 0 && breakdown.rawDemand > breakdown.pool * SATURATION_WARN_SHARE) {
    warnings.push("Market saturation: this audience is close to tapped out.");
  }
  if (capacity > 0 && breakdown.demand > capacity * SELLOUT_DEMAND_RATIO) {
    warnings.push("Likely sellout — expected demand exceeds venue capacity.");
  }

  return {
    attendanceRange: [lo, hi],
    gateCentsRange: [
      scaleCents(inputs.show.ticketPriceCents, lo),
      scaleCents(inputs.show.ticketPriceCents, hi),
    ],
    qualityRange: [clamp(quality - 12, 0, 100), clamp(quality + 12, 0, 100)],
    warnings,
  };
}
