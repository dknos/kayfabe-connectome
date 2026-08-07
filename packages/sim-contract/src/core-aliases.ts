/**
 * Small shared aliases split out to keep reports.ts free of import cycles.
 */
export type { IsoDate, PersonId, SegmentId, ShowId } from "./core";

export interface InjuryLite {
  kind: string;
  severity: "minor" | "moderate" | "severe";
  outUntil: string;
}
