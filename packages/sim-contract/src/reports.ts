import type { InjuryLite, IsoDate, PersonId, SegmentId, ShowId } from "./core-aliases";

/**
 * Crowd state: the audience is a stateful actor that every segment mutates.
 * All axes 0–100 except where noted. See docs/simulator/SIMULATION_RULES.md.
 */
export interface CrowdState {
  energy: number;
  attention: number;
  investment: number;
  fatigue: number;
  /** Hostility toward the show itself (bad finishes, confusion), not heel heat. */
  hostility: number;
  satisfaction: number;
  anticipation: number;
}

/** One labeled contribution inside an auditable score breakdown. */
export interface ScoreComponent {
  label: string;
  /** Signed contribution in score points. */
  value: number;
  note: string;
}

export interface ParticipantEffect {
  personId: PersonId;
  /** 0–100 how well this person performed their actual role in the segment. */
  contribution: number;
  role: string;
  momentumDelta: number;
  affinityDelta: number;
  awarenessDelta: number;
  fatigueDelta: number;
  moraleDelta: number;
  credibilityDelta: number;
  injury: InjuryLite | null;
}

export interface SegmentReport {
  segmentId: SegmentId;
  kind: "match" | "angle";
  /** Human-readable line, e.g. "Bret Hart def. Vader (pin) — WWF Championship". */
  headline: string;
  /** 0–100 how well the segment was performed. */
  execution: number;
  /** 0–100 how the crowd received it (the "grade" that matters). */
  reception: number;
  executionComponents: ScoreComponent[];
  receptionComponents: ScoreComponent[];
  participantEffects: ParticipantEffect[];
  crowdAfter: CrowdState;
  /** Plain-language findings: what worked, what failed, whose fault. */
  notes: string[];
}

export interface RevenueLine {
  label: string;
  amountCents: number;
}

export interface ShowReport {
  showId: ShowId;
  date: IsoDate;
  attendance: number;
  capacity: number;
  crowdStart: CrowdState;
  segments: SegmentReport[];
  /** 0–100 whole-show reception, weighted by the company's product DNA. */
  overall: number;
  overallComponents: ScoreComponent[];
  revenue: RevenueLine[];
  expenses: RevenueLine[];
  profitCents: number;
  notes: string[];
}

/** Pre-show forecast — always ranges, never false precision. */
export interface ShowForecast {
  attendanceRange: [number, number];
  gateCentsRange: [number, number];
  qualityRange: [number, number];
  warnings: string[];
}
