import type {
  Alignment,
  AttributeBlock,
  AttributeKey,
  CompanyId,
  CompanySizeTier,
  ContractId,
  ContractKind,
  DetailTier,
  InboxId,
  IsoDate,
  Market,
  MarketId,
  NewsId,
  PersonId,
  ProductDna,
  ProgramId,
  PushLevel,
  SeededAttribute,
  SegmentId,
  ShowId,
  SimOptions,
  StorylineId,
  TitleId,
  TxId,
  Venue,
  VenueId,
  WorkerStyle,
} from "./core";
import type { ShowReport } from "./reports";

/** Signed regional standing: how known and how loved, kept separate. */
export interface Standing {
  /** 0–100 recognition nationally. */
  awarenessNational: number;
  /** −100..100 emotional connection nationally. */
  affinityNational: number;
  /** Sparse per-market deltas applied on top of national values. */
  marketDelta: Record<MarketId, { awareness: number; affinity: number }>;
}

export interface Injury {
  kind: string;
  severity: "minor" | "moderate" | "severe";
  occurredOn: IsoDate;
  outUntil: IsoDate;
  note: string;
}

export interface WorkerCondition {
  /** 0–100 accumulated fatigue; recovers daily. */
  fatigue: number;
  /** Cumulative in-ring minutes since universe start (wear proxy). */
  wearMinutes: number;
  injury: Injury | null;
  /** Days since last match (ring rust proxy). */
  daysSinceMatch: number;
}

export interface WorkerState {
  personId: PersonId;
  /** Display name of the currently active persona. */
  name: string;
  /** All known persona names (from history + post-start changes). */
  personaNames: string[];
  /**
   * Hidden true ability. When scoutingFog is on, UI must show `scouted`
   * instead. Seeded from historical evidence at snapshot time.
   */
  attributes: AttributeBlock;
  /** What staff believes: estimate + confidence per attribute. */
  scouted: Record<AttributeKey, SeededAttribute>;
  styles: WorkerStyle[];
  alignment: Alignment;
  push: PushLevel;
  morale: number; // 0–100
  momentum: number; // −100..100 short-term trajectory
  credibility: number; // 0–100 believability in presented role
  prestige: number; // 0–100 long-term earned status
  standing: Standing;
  condition: WorkerCondition;
  /** First year seen in the historical record, if any. */
  debutYear: number | null;
  experienceYears: number;
  /** Pre-start career facts for profile display (from snapshot). */
  historyNote: string;
  active: boolean;
}

export interface TvDeal {
  programName: string;
  /** 0 = Monday … 6 = Sunday (matches sim-core dayOfWeek). */
  dayOfWeek: number;
  weeklyRightsCents: number;
  /** 0–100 national reach of the platform. */
  reach: number;
}

export interface AiProfile {
  /** 0–100 appetite for gambles (title changes, pushes, spending). */
  riskTolerance: number;
  starBias: "size" | "workrate" | "charisma" | "proven";
  /** −100 (veterans) .. 100 (youth). */
  youthBias: number;
  /** 0–100; low = spends freely, high = disciplined. */
  spendingDiscipline: number;
  /** 0–100 tendency to stick with planned programs under pressure. */
  planLoyalty: number;
}

export interface Program {
  id: ProgramId;
  companyId: CompanyId;
  titleId: TitleId | null;
  participants: PersonId[];
  intendedWinner: PersonId;
  targetDate: IsoDate;
  phase: "building" | "peak" | "blowoff" | "done";
  /** Reason code for the dev-mode AI ledger. */
  reason: string;
  storylineId: StorylineId | null;
}

export interface CompanyState {
  id: CompanyId;
  name: string;
  shortName: string;
  active: boolean;
  cashCents: number;
  homeMarketId: MarketId;
  productDna: ProductDna;
  prestige: number;
  momentum: number;
  standing: Standing;
  sizeTier: CompanySizeTier;
  detailTier: DetailTier;
  tvDeal: TvDeal | null;
  /** Week-of-month for the monthly marquee event; null = none. */
  ppvWeek: number | null;
  aiControlled: boolean;
  aiProfile: AiProfile;
  programs: Program[];
  /** Objectives inform AI booking; strings are reason-code vocabulary. */
  objectives: string[];
  titleIds: TitleId[];
  /** Company name history within the save (renames append here). */
  nameHistory: { name: string; from: IsoDate }[];
}

export interface PushPromise {
  kind: "title_shot" | "main_event" | "push";
  byDate: IsoDate;
  note: string;
  fulfilled: boolean;
}

export interface ContractState {
  id: ContractId;
  personId: PersonId;
  companyId: CompanyId;
  kind: ContractKind;
  exclusive: boolean;
  startDate: IsoDate;
  endDate: IsoDate | null; // null = open-ended handshake
  perAppearanceCents: number;
  /** Weekly guarantee paid regardless of use (0 for appearance deals). */
  weeklyDownsideCents: number;
  promises: PushPromise[];
  status: "active" | "expired" | "terminated";
  signedDate: IsoDate;
}

export interface TitleReign {
  holderIds: PersonId[];
  fromDate: IsoDate;
  toDate: IsoDate | null;
  wonAtShowId: ShowId | null;
  /** For pre-start reigns imported from history. */
  historical: boolean;
}

export interface TitleState {
  id: TitleId;
  name: string;
  companyId: CompanyId;
  tier: "world" | "secondary" | "tag" | "other";
  holderIds: PersonId[]; // empty = vacant
  prestige: number;
  defensesSinceChange: number;
  lineage: TitleReign[];
  active: boolean;
}

export type BeatPurpose =
  | "promo"
  | "interview"
  | "attack"
  | "save"
  | "betrayal"
  | "challenge"
  | "reveal"
  | "contract_signing"
  | "celebration"
  | "video_package";

export type BeatRole =
  | "speaker"
  | "target"
  | "attacker"
  | "victim"
  | "interviewer"
  | "bystander";

export interface AngleBeat {
  purpose: BeatPurpose;
  location: "ring" | "backstage" | "stage";
  durationMin: number;
  participants: { personId: PersonId; role: BeatRole }[];
  summary: string;
}

export type FinishKind =
  | "pin"
  | "submission"
  | "dq"
  | "countout"
  | "ko"
  | "no_contest"
  | "time_limit_draw";

export interface MatchSide {
  members: PersonId[];
  label?: string;
}

export interface MatchPlan {
  sides: MatchSide[]; // 2+ sides, each 1+ members
  titleId: TitleId | null;
  /** Index into sides; null with draw/no-contest finishes. */
  winnerSide: number | null;
  finish: FinishKind;
  stipulation: string | null;
  /** 0–100 planned physical intensity (drives quality + injury risk). */
  intensity: number;
  /** 0–100 planned risk level (high spots). */
  risk: number;
  mainEvent: boolean;
}

export interface Segment {
  id: SegmentId;
  kind: "match" | "angle";
  durationMin: number;
  match: MatchPlan | null;
  angle: { beats: AngleBeat[] } | null;
  storylineId: StorylineId | null;
}

export type ShowType = "tv" | "ppv" | "house";

export interface ShowPlan {
  id: ShowId;
  companyId: CompanyId;
  name: string;
  date: IsoDate;
  venueId: VenueId;
  marketId: MarketId;
  showType: ShowType;
  ticketPriceCents: number;
  segments: Segment[];
  /** Workers advertised in advance (draws attendance, breaks trust if absent). */
  advertised: PersonId[];
  status: "scheduled" | "completed" | "cancelled";
  report: ShowReport | null;
}

export interface StorylineBeatRecord {
  date: IsoDate;
  showId: ShowId | null;
  segmentId: SegmentId | null;
  summary: string;
}

export interface Storyline {
  id: StorylineId;
  companyId: CompanyId;
  name: string;
  premise: string;
  participants: { personId: PersonId; role: "protagonist" | "antagonist" | "supporting" }[];
  titleId: TitleId | null;
  heat: number; // 0–100 audience investment in the story
  phase: "building" | "peak" | "blowoff" | "concluded" | "abandoned";
  startDate: IsoDate;
  targetDate: IsoDate | null;
  beats: StorylineBeatRecord[];
  milestones: { description: string; targetDate: IsoDate | null; done: boolean }[];
}

export type RevenueCategory =
  | "tickets"
  | "broadcast_rights"
  | "ppv"
  | "merchandise"
  | "sponsorship"
  | "other_income";

export type ExpenseCategory =
  | "talent_payroll"
  | "appearance_fees"
  | "staff_payroll"
  | "venue_rental"
  | "production"
  | "travel"
  | "marketing"
  | "medical"
  | "office_overhead"
  | "other_expense";

export interface Transaction {
  id: TxId;
  date: IsoDate;
  companyId: CompanyId;
  direction: "in" | "out";
  amountCents: number; // always positive; direction carries sign
  category: RevenueCategory | ExpenseCategory;
  memo: string;
  showId: ShowId | null;
  personId: PersonId | null;
}

export type NewsKind =
  | "show_results"
  | "signing"
  | "release"
  | "injury"
  | "title_change"
  | "business"
  | "rumor"
  | "anniversary";

export interface NewsItem {
  id: NewsId;
  date: IsoDate;
  kind: NewsKind;
  headline: string;
  body: string;
  companyId: CompanyId | null;
  personIds: PersonId[];
  /** Rumors are always labeled; body must hedge. */
  rumor: boolean;
}

export interface InboxItem {
  id: InboxId;
  date: IsoDate;
  kind: "contract_expiry" | "offer_received" | "injury" | "show_due" | "info";
  title: string;
  body: string;
  relatedPersonId: PersonId | null;
  relatedShowId: ShowId | null;
  resolved: boolean;
}

/** Append-only domain event (the save's replayable audit trail). */
export interface DomainEvent {
  seq: number;
  date: IsoDate;
  type: string;
  /** Small reference payload; heavyweight data lives in state collections. */
  refs: Record<string, string | number | boolean | null>;
}

export interface AiDecisionRecord {
  seq: number;
  date: IsoDate;
  companyId: CompanyId;
  action: string;
  reason: string;
  /** Candidate → utility, for the dev-mode reasoning ledger. */
  considered: { option: string; utility: number }[];
}

export interface SimMeta {
  saveId: string;
  engineVersion: string;
  schemaVersion: number;
  worldSeed: string;
  startDate: IsoDate;
  bundleHash: string;
  snapshotHash: string;
  options: SimOptions;
}

export interface SimState {
  meta: SimMeta;
  currentDate: IsoDate;
  markets: Record<MarketId, Market>;
  venues: Record<VenueId, Venue>;
  workers: Record<PersonId, WorkerState>;
  companies: Record<CompanyId, CompanyState>;
  contracts: Record<ContractId, ContractState>;
  titles: Record<TitleId, TitleState>;
  storylines: Record<StorylineId, Storyline>;
  shows: Record<ShowId, ShowPlan>;
  ledger: Transaction[];
  news: NewsItem[];
  inbox: InboxItem[];
  eventLog: DomainEvent[];
  aiLedger: AiDecisionRecord[];
  /** Serialized RNG stream states (RngHubState from sim-core). */
  rng: Record<string, [number, number, number, number]>;
  /** Deterministic ID counters per entity prefix. */
  counters: Record<string, number>;
}
