import type {
  Alignment,
  CompanyId,
  ContractId,
  ContractKind,
  InboxId,
  IsoDate,
  PersonId,
  PushLevel,
  ShowId,
  StorylineId,
  TitleId,
  VenueId,
} from "./core";
import type { DomainEvent, Segment, ShowType, SimState } from "./state";
import type { ShowReport } from "./reports";

export type Command =
  | { type: "ADVANCE_DAY" }
  | {
      type: "SCHEDULE_SHOW";
      companyId: CompanyId;
      name: string;
      date: IsoDate;
      venueId: VenueId;
      showType: ShowType;
      ticketPriceCents: number;
    }
  | { type: "CANCEL_SHOW"; showId: ShowId }
  | {
      type: "UPDATE_SHOW_CARD";
      showId: ShowId;
      segments: Segment[];
      advertised: PersonId[];
    }
  | { type: "RUN_SHOW"; showId: ShowId }
  | {
      type: "OFFER_CONTRACT";
      companyId: CompanyId;
      personId: PersonId;
      kind: ContractKind;
      lengthMonths: number;
      perAppearanceCents: number;
      weeklyDownsideCents: number;
      exclusive: boolean;
    }
  | { type: "RELEASE_WORKER"; contractId: ContractId }
  | {
      type: "CREATE_STORYLINE";
      companyId: CompanyId;
      name: string;
      premise: string;
      participants: { personId: PersonId; role: "protagonist" | "antagonist" | "supporting" }[];
      titleId: TitleId | null;
      targetDate: IsoDate | null;
      milestones: { description: string; targetDate: IsoDate | null }[];
    }
  | { type: "CONCLUDE_STORYLINE"; storylineId: StorylineId; outcome: "concluded" | "abandoned" }
  | { type: "SET_PUSH"; personId: PersonId; push: PushLevel }
  | { type: "SET_ALIGNMENT"; personId: PersonId; alignment: Alignment }
  | {
      type: "SET_TITLE_HOLDER";
      titleId: TitleId;
      holderIds: PersonId[];
      reason: string;
    }
  | { type: "RESOLVE_INBOX"; inboxId: InboxId };

export interface OfferOutcome {
  accepted: boolean;
  /** Plain-language reasons the worker gives — never raw utility numbers. */
  reasons: string[];
  counter: {
    perAppearanceCents: number;
    weeklyDownsideCents: number;
    lengthMonths: number;
  } | null;
}

export interface EngineResult {
  state: SimState;
  events: DomainEvent[];
  /** Present when the command completed a show. */
  report: ShowReport | null;
  /** Present for OFFER_CONTRACT. */
  offerOutcome: OfferOutcome | null;
  /** Validation problems that made the command a no-op (state unchanged). */
  errors: string[];
}
