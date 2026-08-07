/**
 * Core identifiers, attribute vocabulary, and world primitives for THE BOOK.
 *
 * IDs are plain strings minted deterministically by the engine from
 * per-entity counters ("show-000042"), except PersonId / CompanyId /
 * TitleId for historical entities, which reuse the canonical IDs from the
 * materialized corpus so almanac deep-links and provenance stay intact.
 */

export type PersonId = string;
export type CompanyId = string;
export type TitleId = string;
export type ContractId = string;
export type ShowId = string;
export type SegmentId = string;
export type StorylineId = string;
export type MarketId = string;
export type VenueId = string;
export type NewsId = string;
export type TxId = string;
export type InboxId = string;
export type ProgramId = string;

export type IsoDate = string; // YYYY-MM-DD, validated at boundaries

/**
 * Attribute vocabulary for the vertical slice. A deliberate subset of the
 * full design (see docs/simulator/GAME_DESIGN.md §9); chosen so every
 * value can be honestly seeded from historical evidence or clearly marked
 * low-confidence. All values live on 0–100.
 */
export const ATTRIBUTE_KEYS = [
  // in-ring execution
  "fundamentals",
  "psychology",
  "athleticism",
  "technical",
  "brawling",
  "aerial",
  "stamina",
  "safety",
  // presentation
  "charisma",
  "promo",
  "starPresence",
  "crowdConnection",
  // professional / personality
  "reliability",
  "ambition",
  "ego",
  "loyalty",
] as const;

export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

export type AttributeBlock = Record<AttributeKey, number>;

/** Confidence grade for any derived or scouted number. */
export type ConfidenceGrade = "high" | "medium" | "low" | "speculative";

/**
 * A derived starting attribute: the estimate, how it was produced, and how
 * sure we are. `inputs` names the evidence features that moved it, so the
 * editor and profile screens can explain every number.
 */
export interface SeededAttribute {
  value: number; // 0-100
  confidence: ConfidenceGrade;
  method: string; // e.g. "evidence-seeder@1"
  inputs: string[]; // e.g. ["matches:412", "mainEvents:0.31", "promotionLevel:national"]
  override?: "mod" | "editor";
}

export type WorkerStyle =
  | "technician"
  | "brawler"
  | "highflyer"
  | "powerhouse"
  | "allrounder"
  | "entertainer"
  | "hardcore";

export type Alignment = "face" | "heel" | "neutral";

export type PushLevel =
  | "main_event"
  | "upper"
  | "midcard"
  | "lower"
  | "opener"
  | "unused";

/** Product DNA axes implemented in the slice (0–100 each). */
export const DNA_AXES = [
  "athleticCompetition",
  "characterSpectacle",
  "serializedStory",
  "violence",
  "comedy",
  "starDriven",
  "nationalAmbition",
] as const;

export type DnaAxis = (typeof DNA_AXES)[number];
export type ProductDna = Record<DnaAxis, number>;

export type CompanySizeTier = "national" | "regional" | "indie";

/** Simulation level of detail for AI companies. */
export type DetailTier = "full" | "standard" | "abstract";

export interface Market {
  id: MarketId;
  name: string;
  region: string;
  /** Rough potential audience in the market, persons. Original estimates. */
  population: number;
  /** Baseline appetite for wrestling, 0–100. */
  wrestlingInterest: number;
  /** Economic strength index, 0–100 (ticket price tolerance). */
  economicStrength: number;
}

export interface Venue {
  id: VenueId;
  name: string;
  marketId: MarketId;
  capacity: number;
  /** Venue aura, 0–100; MSG is not a high-school gym. */
  prestige: number;
  rentalCents: number;
  /** Canonical location id in the historical corpus, when derived from it. */
  sourceLocationId?: string;
}

/**
 * Era profile: data-driven parameters that make different start dates feel
 * structurally different without forking the engine. Loaded from JSON,
 * moddable.
 */
export interface EraProfile {
  id: string;
  label: string;
  appliesFrom: IsoDate;
  appliesTo: IsoDate;
  tvAvailable: boolean;
  ppvAvailable: boolean;
  streamingAvailable: boolean;
  /** Weekly broadcast rights fee baseline by company size tier, cents. */
  weeklyTvRightsCents: Record<CompanySizeTier, number>;
  /** Fraction of aware+positive national audience buying a PPV, 0–1 baseline. */
  ppvBuyRateBase: number;
  ppvPriceCents: number;
  ticketPriceTypicalCents: number;
  allowedContractKinds: ContractKind[];
  /** Per-show travel+production baseline by size tier, cents. */
  showOverheadCents: Record<CompanySizeTier, number>;
  /** Weekly office/admin overhead by size tier, cents. */
  weeklyOverheadCents: Record<CompanySizeTier, number>;
  /** How fast news/awareness propagates, 0–100. */
  newsSpeed: number;
}

export type ContractKind = "exclusive" | "written" | "appearance" | "handshake";

export type HistoricalMode =
  | "open_alternate"
  | "guided"
  | "strict_sandbox"
  | "fictional";

export type PlayerRole = "owner" | "booker" | "owner_booker";

export interface SimOptions {
  historicalMode: HistoricalMode;
  playerRole: PlayerRole;
  playerCompanyId: CompanyId;
  startDate: IsoDate;
  worldSeed: string;
  /** When true, hidden true attributes differ from scouted estimates. */
  scoutingFog: boolean;
  /** Abstract-tier companies simulate on a weekly aggregate tick. */
  abstractTierEnabled: boolean;
}
