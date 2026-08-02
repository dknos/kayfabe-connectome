import { fnv1a32 } from "@kayfabe/graph-contract";
import { RATING_WORLD } from "./layoutTypes";

export function ratingToHeight(rating: number): number {
  if (!Number.isFinite(rating)) throw new Error("Reported rating must be finite");
  return rating * RATING_WORLD.ratingScale;
}

export function dayToWorldX(day: number, dayMin: number, dayMax: number): number {
  const t = (day - dayMin) / Math.max(1, dayMax - dayMin);
  return RATING_WORLD.xMin + Math.max(0, Math.min(1, t)) * (RATING_WORLD.xMax - RATING_WORLD.xMin);
}

/** Placement is authoritative when supplied; opaque match id is the fallback. */
export function sameDaySublaneOffset(matchId: string, placement: number | null, ordinal = 0): number {
  if (placement !== null && Number.isInteger(placement) && placement >= 0) {
    const centered = (placement % 9) - 4;
    return centered * 1.7;
  }
  const stable = ((fnv1a32(matchId) % 17) - 8) * 0.72;
  return stable + Math.max(-2, Math.min(2, ordinal)) * 0.24;
}

export function exactMedian(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

export function trendSegments<T extends { year: number }>(bins: readonly T[]): T[][] {
  const ordered = [...bins].sort((a, b) => a.year - b.year);
  const segments: T[][] = [];
  for (const bin of ordered) {
    const current = segments[segments.length - 1];
    if (!current || current[current.length - 1]!.year + 1 !== bin.year) segments.push([bin]);
    else current.push(bin);
  }
  return segments;
}

export function stableOpaqueCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
