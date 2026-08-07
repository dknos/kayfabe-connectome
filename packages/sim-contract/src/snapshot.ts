import type {
  Alignment,
  AttributeKey,
  CompanyId,
  CompanySizeTier,
  DetailTier,
  IsoDate,
  Market,
  MarketId,
  PersonId,
  ProductDna,
  SeededAttribute,
  TitleId,
  Venue,
  WorkerStyle,
} from "./core";

/**
 * Per-worker evidence features extracted from the corpus, strictly ≤ startDay.
 * Produced by @kayfabe/history-adapter, consumed by the ratings seeder, and
 * retained in the snapshot so profile screens can show *why* a number is what
 * it is. `null` always means "not recorded", never zero.
 */
export interface EvidenceSummary {
  personId: PersonId;
  matches: number;
  firstYear: number | null;
  lastYear: number | null;
  careerYears: number;
  distinctOpponents: number;
  /** Share of decided matches this person's side won — positioning, not skill. */
  winShare: number | null;
  /** Share of matches with a recorded top-of-card placement. */
  mainEventShare: number | null;
  titleMatchShare: number;
  /** Fraction of matches by promotion level. */
  promoLevelMix: { national: number; regional: number; indie: number };
  formMix: { singles: number; tag: number; multi: number };
  meltzer: { count: number; mean: number; best: number } | null;
  /** Matches per year over the last two pre-start years. */
  recentDensity: number;
  topPromotions: { promotionId: string; matches: number }[];
}

export interface SnapshotPersona {
  /** Corpus person ID this persona was recorded under. */
  corpusId: string;
  name: string;
}

export interface SnapshotWorker {
  /** Canonical sim person ID (= canonical corpus ID from the crosswalk group). */
  personId: PersonId;
  displayName: string;
  personas: SnapshotPersona[];
  seeded: Record<AttributeKey, SeededAttribute>;
  awarenessNational: number;
  affinityNational: number;
  credibility: number;
  prestige: number;
  styles: WorkerStyle[];
  alignment: Alignment;
  debutYear: number | null;
  experienceYears: number;
  evidence: EvidenceSummary;
  /** e.g. "1,204 recorded matches 1988–1996, primarily WCW; 2 recorded title reigns." */
  historyNote: string;
}

export interface SnapshotCompany {
  companyId: CompanyId;
  /** Era-correct display name at the start date (lineage-resolved). */
  name: string;
  shortName: string;
  /** All corpus promotion IDs stitched into this company. */
  lineageIds: string[];
  sizeTier: CompanySizeTier;
  detailTier: DetailTier;
  homeMarketId: MarketId;
  rosterPersonIds: PersonId[];
  titleIds: TitleId[];
  awarenessNational: number;
  affinityNational: number;
  prestige: number;
  productDna: ProductDna;
  playable: boolean;
  /** Founding capital override (player-founded startups); tier default otherwise. */
  startCashCents?: number;
}

export interface SnapshotReign {
  holderIds: PersonId[];
  holderNames: string[];
  fromDay: number;
  toDay: number | null;
}

export interface SnapshotTitle {
  titleId: TitleId;
  name: string;
  companyId: CompanyId;
  tier: "world" | "secondary" | "tag" | "other";
  holderIds: PersonId[];
  holderNames: string[];
  /** Most recent pre-start reigns (tail), for profile/almanac display. */
  preStartReigns: SnapshotReign[];
  prestige: number;
  /** False for csv titles whose lineage is underivable — surfaced in data health. */
  lineageComplete: boolean;
}

export interface DataHealthReport {
  /** Suspected same-human splits or shared-name merges we did NOT auto-resolve. */
  aliasSuspects: { reason: string; ids: string[]; names: string[] }[];
  titlesWithoutLineage: number;
  workersLowConfidence: number;
  quarantinedRecords: number;
  notes: string[];
}

export interface SnapshotMeta {
  schemaVersion: number;
  builderVersion: string;
  bundleHash: string;
  crosswalkVersion: number;
  startDate: IsoDate;
  /** Epoch-1900 day int matching corpus encoding. */
  startDay: number;
  rosterInference: {
    method: string;
    windowDays: number;
    minAppearances: number;
    maxDaysSinceLast: number;
  };
  seederMethod: string;
  snapshotHash: string;
}

export interface UniverseSnapshot {
  meta: SnapshotMeta;
  markets: Market[];
  venues: Venue[];
  companies: SnapshotCompany[];
  workers: SnapshotWorker[];
  titles: SnapshotTitle[];
  dataHealth: DataHealthReport;
}
