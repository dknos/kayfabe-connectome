/**
 * Contract negotiation (negotiation@1).
 *
 * An explainable utility model: the worker weighs an offer against their
 * deterministic asking price, then company standing, contract stability,
 * loyalty to a current employer, market heat, and product fit. Callers see
 * plain-language reasons only — the utility math never leaks. Full design:
 * docs/simulator/rules/negotiation.md.
 */

import type {
  CompanySizeTier,
  CompanyState,
  ContractKind,
  ContractState,
  DnaAxis,
  EraProfile,
  OfferOutcome,
  WorkerState,
  WorkerStyle,
} from "@kayfabe/sim-contract";
import { assertCents, scaleCents, type Cents } from "../money";
import type { RngStream } from "../rng";

export interface OfferTerms {
  kind: ContractKind;
  lengthMonths: number;
  perAppearanceCents: number;
  weeklyDownsideCents: number;
  exclusive: boolean;
}

export interface OfferContext {
  worker: WorkerState;
  company: CompanyState;
  offer: OfferTerms;
  era: EraProfile;
  /** 0–100 how hot the market is for this worker. */
  rivalInterest: number;
  currentContract: ContractState | null;
  rng: RngStream;
}

/** Assumed appearance cadence used to compare deals on weekly value. */
const APPEARANCES_PER_WEEK = 2;
/** An exclusive lock-in demands ~1.4x the money of the same deal without it. */
const EXCLUSIVITY_PREMIUM = 1.4;
const ACCEPT_THRESHOLD = 52;
const COUNTER_THRESHOLD = 42;
/** gaussish(0, 0.7) is bounded to ±2.1 by construction (Bates ±3σ). */
const WOBBLE_STDDEV = 0.7;

const PLAUSIBLE_LENGTHS = [3, 6, 12, 18, 24, 36] as const;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Nearest whole dollar, never below $1 — quoted terms stay displayable. */
function round100(cents: number): Cents {
  return Math.max(100, Math.round(cents / 100) * 100);
}

/** Whole dollar rounded down, floored at $1 — used when fitting a budget cap. */
function floor100(cents: number): Cents {
  return Math.max(100, Math.floor(cents / 100) * 100);
}

function weeklyValueCents(perAppearanceCents: Cents, weeklyDownsideCents: Cents): Cents {
  return weeklyDownsideCents + APPEARANCES_PER_WEEK * perAppearanceCents;
}

/**
 * Term shape per contract kind, as multiples of the worker's base rate.
 * Per-shot deals carry a no-guarantee risk premium; at the assumed cadence
 * their weekly value equals a written deal (2.5×base). Exclusive is written
 * ×1.4 — the premium is baked into the kind.
 */
const KIND_SHAPE: Record<ContractKind, { perApp: number; downside: number }> = {
  handshake: { perApp: 1.25, downside: 0 },
  appearance: { perApp: 1.25, downside: 0 },
  written: { perApp: 0.5, downside: 1.5 },
  exclusive: { perApp: 0.7, downside: 2.1 },
};

const KIND_LABEL: Record<ContractKind, string> = {
  handshake: "handshake",
  appearance: "per-appearance",
  written: "written",
  exclusive: "exclusive",
};

/**
 * What the worker believes they are worth, era-scaled. Deterministic:
 * marketability (awareness-led, prestige, momentum) sets a base rate off the
 * era's typical ticket price; the kind shapes it into per-appearance vs
 * guarantee. Quadratic in marketability so names cost multiples of unknowns.
 */
export function askingPrice(
  worker: WorkerState,
  era: EraProfile,
  kind: ContractKind,
): { perAppearanceCents: number; weeklyDownsideCents: number } {
  const momentum01 = clamp((worker.momentum + 100) / 2, 0, 100);
  const marketability = clamp(
    0.45 * worker.standing.awarenessNational + 0.35 * worker.prestige + 0.2 * momentum01,
    0,
    100,
  );
  const base = scaleCents(era.ticketPriceTypicalCents, 2 + (marketability / 100) ** 2 * 400);
  const shape = KIND_SHAPE[kind];
  return {
    perAppearanceCents: round100(scaleCents(base, shape.perApp)),
    weeklyDownsideCents:
      shape.downside === 0 ? 0 : round100(scaleCents(base, shape.downside)),
  };
}

/** allrounder fits anywhere and is deliberately absent. */
const STYLE_AXIS: Partial<Record<WorkerStyle, DnaAxis>> = {
  technician: "athleticCompetition",
  highflyer: "athleticCompetition",
  brawler: "violence",
  hardcore: "violence",
  entertainer: "characterSpectacle",
  powerhouse: "starDriven",
};

function productFitScore(worker: WorkerState, company: CompanyState): number {
  let sum = 0;
  let n = 0;
  for (const style of worker.styles) {
    const axis = STYLE_AXIS[style];
    if (!axis) continue;
    sum += (company.productDna[axis] - 50) / 50;
    n += 1;
  }
  return n === 0 ? 0 : 3 * (sum / n);
}

/** −1 (rising star, hates being tied down) .. +1 (veteran wanting security). */
function stabilityPreference(worker: WorkerState): number {
  const age = clamp((worker.experienceYears - 8) / 12, -1, 1);
  const trajectory = clamp(-worker.momentum / 60, -1, 1);
  return 0.5 * age + 0.5 * trajectory;
}

/** Signed pull toward the current employer; positive = wants to stay. */
function loyaltyPull(worker: WorkerState): number {
  return ((worker.morale - 50) / 50) * (3 + 7 * (worker.attributes.loyalty / 100));
}

interface Deficit {
  points: number;
  phrase: string;
}

function shortfallReasons(args: {
  ratio: number;
  ratioNoPremium: number;
  exclusivityDemanded: boolean;
  offer: OfferTerms;
  effAsk: { perAppearanceCents: Cents; weeklyDownsideCents: Cents };
  poaching: boolean;
  pull: number;
  rivalInterest: number;
  stabilityScore: number;
  pref: number;
}): string[] {
  const deficits: Deficit[] = [];
  const moneyPoints = (1 - Math.min(args.ratio, 1)) * 50;
  if (moneyPoints > 2) {
    const downShort = Math.max(
      0,
      args.effAsk.weeklyDownsideCents - args.offer.weeklyDownsideCents,
    );
    const appShort = Math.max(
      0,
      (args.effAsk.perAppearanceCents - args.offer.perAppearanceCents) * APPEARANCES_PER_WEEK,
    );
    const term = downShort >= appShort ? "guarantee" : "per-appearance money";
    const phrase =
      args.ratio < 0.85
        ? `the ${term} is well below what similar names earn`
        : `the ${term} is close, but not quite there`;
    deficits.push({ points: moneyPoints, phrase });
  }
  if (args.exclusivityDemanded) {
    const exclPoints = (Math.min(args.ratioNoPremium, 1) - Math.min(args.ratio, 1)) * 50;
    if (exclPoints > 2) {
      deficits.push({ points: exclPoints, phrase: "an exclusive deal has to pay a real premium" });
    }
  }
  if (args.poaching && args.pull > 2) {
    deficits.push({ points: args.pull, phrase: "wants to stay where they are" });
  }
  if (args.rivalInterest >= 40) {
    deficits.push({ points: args.rivalInterest * 0.12, phrase: "a rival is offering more" });
  }
  if (args.stabilityScore < -2) {
    deficits.push({
      points: -args.stabilityScore,
      phrase:
        args.pref > 0
          ? "wants the security of a longer deal"
          : "doesn't want to be locked in that long",
    });
  }
  deficits.sort((a, b) => b.points - a.points);
  const phrases = deficits.slice(0, 3).map((d) => d.phrase);
  return phrases.length > 0 ? phrases : ["the overall package doesn't move them"];
}

function acceptReasons(
  ratio: number,
  reSigning: boolean,
  pull: number,
  company: CompanyState,
): string[] {
  const reasons: string[] = [];
  if (ratio >= 1.15) reasons.push("the money is too good to pass up");
  else if (ratio >= 0.97) reasons.push("the money is right");
  else if (reSigning && pull > 2) reasons.push("taking a little less to stay put");
  else reasons.push("the situation outweighs the money");
  if (reSigning && pull > 2) reasons.push("happy where they are");
  if (company.sizeTier === "national" && company.prestige >= 70) {
    reasons.push("it's the biggest stage in the business");
  }
  return reasons;
}

function counterTerm(offerCents: Cents, askCents: Cents): Cents {
  if (offerCents >= askCents) return offerCents; // never counter a term downward
  const blended = round100(0.6 * askCents + 0.4 * offerCents);
  return clamp(blended, offerCents, askCents);
}

function buildCounter(
  offer: OfferTerms,
  effAsk: { perAppearanceCents: Cents; weeklyDownsideCents: Cents },
  pref: number,
): { perAppearanceCents: number; weeklyDownsideCents: number; lengthMonths: number } {
  const preferred = clamp(Math.round(12 + pref * 12), 6, 24);
  const rawLen = (offer.lengthMonths + preferred) / 2;
  let bestLen: number = PLAUSIBLE_LENGTHS[0];
  let bestDist = Infinity;
  for (const len of PLAUSIBLE_LENGTHS) {
    const d = Math.abs(len - rawLen);
    if (d < bestDist) {
      bestDist = d;
      bestLen = len; // ties keep the shorter length (list is ascending)
    }
  }
  return {
    perAppearanceCents: counterTerm(offer.perAppearanceCents, effAsk.perAppearanceCents),
    weeklyDownsideCents:
      effAsk.weeklyDownsideCents === 0 && offer.weeklyDownsideCents === 0
        ? 0
        : counterTerm(offer.weeklyDownsideCents, effAsk.weeklyDownsideCents),
    lengthMonths: bestLen,
  };
}

const TIER_BONUS: Record<CompanySizeTier, number> = { national: 5, regional: 2.5, indie: 0 };

export function evaluateOffer(ctx: OfferContext): OfferOutcome {
  const { worker, company, offer, era, currentContract } = ctx;
  assertCents(offer.perAppearanceCents, "offer.perAppearanceCents");
  assertCents(offer.weeklyDownsideCents, "offer.weeklyDownsideCents");
  const rivalInterest = clamp(ctx.rivalInterest, 0, 100);

  // Era gates return before any rng draw, so gated evaluations never
  // perturb the negotiation stream.
  if (!era.allowedContractKinds.includes(offer.kind)) {
    return {
      accepted: false,
      reasons: [`${KIND_LABEL[offer.kind]} deals aren't part of how business is done in this era`],
      counter: null,
    };
  }
  if (offer.exclusive && !era.allowedContractKinds.includes("exclusive")) {
    return {
      accepted: false,
      reasons: ["an exclusive lock-in isn't how deals work in this era"],
      counter: null,
    };
  }

  const ask = askingPrice(worker, era, offer.kind);
  // The exclusive kind already carries the premium in its asking shape; an
  // exclusive flag on any other kind raises the bar here instead.
  const premiumOnTop = offer.exclusive && offer.kind !== "exclusive";
  const effAsk = premiumOnTop
    ? {
        perAppearanceCents: round100(scaleCents(ask.perAppearanceCents, EXCLUSIVITY_PREMIUM)),
        weeklyDownsideCents:
          ask.weeklyDownsideCents === 0
            ? 0
            : round100(scaleCents(ask.weeklyDownsideCents, EXCLUSIVITY_PREMIUM)),
      }
    : ask;

  const offerWeekly = weeklyValueCents(offer.perAppearanceCents, offer.weeklyDownsideCents);
  const askWeekly = weeklyValueCents(effAsk.perAppearanceCents, effAsk.weeklyDownsideCents);
  const ratio = offerWeekly / askWeekly;
  const exclusivityDemanded = offer.exclusive || offer.kind === "exclusive";
  const ratioNoPremium = exclusivityDemanded
    ? offerWeekly / (askWeekly / EXCLUSIVITY_PREMIUM)
    : ratio;

  const compScore = 50 * Math.min(ratio, 1) + 15 * clamp((ratio - 1) / 0.5, 0, 1);
  const prestigeScore = (company.prestige / 100) * 7 + TIER_BONUS[company.sizeTier];
  const pref = stabilityPreference(worker);
  const lengthNorm = clamp((offer.lengthMonths - 12) / 24, -0.75, 1);
  const stabilityScore = 8 * pref * lengthNorm;
  const pull = loyaltyPull(worker);
  const reSigning = currentContract !== null && currentContract.companyId === company.id;
  const poaching = currentContract !== null && currentContract.companyId !== company.id;
  const loyaltyScore = reSigning ? pull : poaching ? -pull : 0;
  const rivalScore = -rivalInterest * 0.12;
  const fitScore = productFitScore(worker, company);
  const wobble = ctx.rng.gaussish(0, WOBBLE_STDDEV);

  const utility =
    compScore + prestigeScore + stabilityScore + loyaltyScore + rivalScore + fitScore + wobble;

  if (utility >= ACCEPT_THRESHOLD) {
    return { accepted: true, reasons: acceptReasons(ratio, reSigning, pull, company), counter: null };
  }
  const reasons = shortfallReasons({
    ratio,
    ratioNoPremium,
    exclusivityDemanded,
    offer,
    effAsk,
    poaching,
    pull,
    rivalInterest,
    stabilityScore,
    pref,
  });
  if (utility >= COUNTER_THRESHOLD) {
    return { accepted: false, reasons, counter: buildCounter(offer, effAsk, pref) };
  }
  return { accepted: false, reasons, counter: null };
}

/** Kind preference by company scale; filtered to what the era allows. */
const AI_KIND_PREF: Record<CompanySizeTier, readonly ContractKind[]> = {
  national: ["exclusive", "written", "appearance", "handshake"],
  regional: ["written", "appearance", "exclusive", "handshake"],
  indie: ["appearance", "handshake", "written", "exclusive"],
};

const AI_KIND_LENGTH: Record<ContractKind, number> = {
  handshake: 3,
  appearance: 6,
  written: 24,
  exclusive: 36,
};

/**
 * What an AI company puts on the table when re-signing or poaching.
 * Deterministic (no rng): era-allowed kinds only, opening a touch under
 * asking, and sanity-capped so the weekly commitment of this one deal never
 * exceeds 1/26th of company cash (26 weeks of runway).
 */
export function aiOfferFor(
  worker: WorkerState,
  company: CompanyState,
  era: EraProfile,
): {
  kind: ContractKind;
  lengthMonths: number;
  perAppearanceCents: number;
  weeklyDownsideCents: number;
  exclusive: boolean;
} {
  const preferred = AI_KIND_PREF[company.sizeTier].filter((k) =>
    era.allowedContractKinds.includes(k),
  );
  const kinds: readonly ContractKind[] = preferred.length > 0 ? preferred : ["handshake"];
  const weeklyCapCents = Math.max(0, Math.floor(company.cashCents / 26));

  let cheapest: { kind: ContractKind; perApp: Cents; down: Cents; weekly: Cents } | null = null;
  for (const kind of kinds) {
    const ask = askingPrice(worker, era, kind);
    const perApp = round100(scaleCents(ask.perAppearanceCents, 0.95));
    const down =
      ask.weeklyDownsideCents === 0 ? 0 : round100(scaleCents(ask.weeklyDownsideCents, 0.95));
    const weekly = weeklyValueCents(perApp, down);
    if (weekly <= weeklyCapCents) {
      return {
        kind,
        lengthMonths: AI_KIND_LENGTH[kind],
        perAppearanceCents: perApp,
        weeklyDownsideCents: down,
        exclusive: kind === "exclusive",
      };
    }
    if (cheapest === null || weekly < cheapest.weekly) {
      cheapest = { kind, perApp, down, weekly };
    }
  }
  // Nothing fits the budget: scale the cheapest candidate down to the cap.
  // Terms floor at $1 — a broke company still tenders a minimum-scale offer.
  const f = cheapest!;
  const factor = f.weekly > 0 ? weeklyCapCents / f.weekly : 0;
  return {
    kind: f.kind,
    lengthMonths: AI_KIND_LENGTH[f.kind],
    perAppearanceCents: floor100(f.perApp * factor),
    weeklyDownsideCents: f.down === 0 ? 0 : floor100(f.down * factor),
    exclusive: f.kind === "exclusive",
  };
}
