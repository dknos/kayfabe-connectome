import type {
  AiDecisionRecord,
  CompanyId,
  CompanyState,
  ContractId,
  ContractKind,
  ContractState,
  EraProfile,
  IsoDate,
  Market,
  MarketId,
  PersonId,
  Program,
  Segment,
  ShowId,
  ShowPlan,
  ShowType,
  TitleId,
  TitleState,
  Venue,
  VenueId,
  WorkerState,
} from "@kayfabe/sim-contract";
import type { RngStream } from "../rng";

/**
 * ai-booker@1 — everything one AI company sees on one simulated day.
 * The engine builds this per aiControlled company; the rng stream is
 * dedicated (`ai:<companyId>`) so AI draws never perturb other subsystems.
 */
export interface AiTickContext {
  company: CompanyState; // aiControlled true
  date: IsoDate;
  workers: Record<PersonId, WorkerState>; // whole world
  contractsByCompany: Record<CompanyId, ContractState[]>; // active only
  titles: Record<TitleId, TitleState>;
  shows: Record<ShowId, ShowPlan>; // all shows (to see its own scheduled ones)
  venues: Record<VenueId, Venue>;
  markets: Record<MarketId, Market>;
  era: EraProfile;
  rng: RngStream; // stream dedicated to this company
  nextId: (prefix: string) => string; // deterministic id minting
}

/** A show the AI wants on the calendar; the engine fills in the rest. */
export interface NewShow {
  id: ShowId;
  companyId: CompanyId;
  name: string;
  date: IsoDate;
  venueId: VenueId;
  marketId: MarketId;
  showType: ShowType;
  ticketPriceCents: number;
}

export interface AiContractOffer {
  personId: PersonId;
  kind: ContractKind;
  lengthMonths: number;
  perAppearanceCents: number;
  weeklyDownsideCents: number;
  exclusive: boolean;
}

export interface AiActions {
  scheduleShows: NewShow[];
  cardUpdates: { showId: ShowId; segments: Segment[]; advertised: PersonId[] }[];
  /** Full replacement list for company.programs. */
  programUpdates: Program[];
  releaseContractIds: ContractId[];
  offers: AiContractOffer[];
  /** seq is filled by the engine — the AI always sets seq 0. */
  decisions: AiDecisionRecord[];
}
