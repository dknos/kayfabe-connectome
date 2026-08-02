import { dayToDate } from "@kayfabe/graph-contract";
import type { RatingsData } from "./ratingsLoader";

export const RF = {
  PPV: 1 << 0,
  APPROXIMATE: 1 << 1,
  TITLE_MATCH: 1 << 2,
  TITLE_CHANGE: 1 << 3,
  PLACEMENT: 1 << 4,
} as const;

export const COVERAGE_KIND = { global: 0, promotion: 1, person: 2, title: 3 } as const;
export const PERIOD = { year: 0, quarter: 1, month: 2 } as const;
export const GLOBAL_SUBJECT = 0xffffffff;

export interface RatingExactRecord {
  index: number;
  id: string;
  day: number;
  date: string;
  rating: number;
  promotionIndex: number;
  promotionId: string;
  promotionName: string;
  eventId: string;
  eventName: string;
  participantIndexes: number[];
  participantIds: string[];
  participantNames: string[];
  form: string;
  flags: number;
  titleIndex: number;
  titleId: string | null;
  titleName: string | null;
  titleIndexes: number[];
  titleIds: string[];
  titleNames: string[];
  placement: number | null;
}

export function exactRecord(data: RatingsData, index: number): RatingExactRecord | null {
  const e = data.exact;
  if (index < 0 || index >= e.count) return null;
  const promotionIndex = e.promotion[index]!;
  const titleIndex = e.title[index]!;
  const eventIndex = e.eventIndex[index]!;
  const participantIndexes: number[] = [];
  const start = e.participantOffset[index]!;
  const end = start + e.participantCount[index]!;
  for (let p = start; p < end; p++) participantIndexes.push(data.participants[p]!);
  const titleIndexes: number[] = [];
  const titleStart = e.titleOffset[index]!;
  const titleEnd = titleStart + e.titleCount[index]!;
  for (let t = titleStart; t < titleEnd; t++) titleIndexes.push(data.titles[t]!);
  return {
    index,
    id: data.exactMatchIds[index]!,
    day: e.day[index]!,
    date: isoDay(e.day[index]!),
    rating: e.rating[index]!,
    promotionIndex,
    promotionId: data.dictionaries.promotions.id[promotionIndex]!,
    promotionName: data.dictionaries.promotions.name[promotionIndex]!,
    eventId: data.dictionaries.events.id[eventIndex]!,
    eventName: data.dictionaries.events.name[eventIndex]!,
    participantIndexes,
    participantIds: participantIndexes.map((p) => data.dictionaries.participants.id[p]!),
    participantNames: participantIndexes.map((p) => data.dictionaries.participants.name[p]!),
    form: data.dictionaries.forms[e.form[index]!] ?? "unknown",
    flags: e.flags[index]!,
    titleIndex,
    titleId: titleIndex >= 0 ? data.dictionaries.titles.id[titleIndex]! : null,
    titleName: titleIndex >= 0 ? data.dictionaries.titles.name[titleIndex]! : null,
    titleIndexes,
    titleIds: titleIndexes.map((t) => data.dictionaries.titles.id[t]!),
    titleNames: titleIndexes.map((t) => data.dictionaries.titles.name[t]!),
    placement: e.placement[index]! >= 0 ? e.placement[index]! : null,
  };
}

export function isoDay(day: number): string {
  return dayToDate(day).toISOString().slice(0, 10);
}

export function ratingStars(value: number): string {
  if (value < 0) return `−${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}★`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}★`;
}

export function coveragePercent(rated: number, total: number): number {
  return total > 0 ? rated / total : 0;
}

export function formatCoverage(rated: number, total: number): string {
  return `${rated.toLocaleString()} of ${total.toLocaleString()} documented matches (${(coveragePercent(rated, total) * 100).toFixed(1)}%)`;
}

export function monthKey(day: number): number {
  const d = dayToDate(day);
  return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
}

export function coverageTotals(
  data: RatingsData,
  kind: number,
  subject: number,
  dayMin: number,
  dayMax: number,
): { total: number; rated: number; titleChanges: number; approximate: number; boundaryApproximate: boolean } {
  const [start, end] = data.coverageRows(kind, subject, PERIOD.month);
  const minKey = monthKey(dayMin);
  const maxKey = monthKey(dayMax);
  let total = 0;
  let rated = 0;
  let titleChanges = 0;
  let approximate = 0;
  for (let i = start; i < end; i++) {
    const key = data.coverage.periodKey[i]!;
    if (key < minKey || key > maxKey) continue;
    total += data.coverage.total[i]!;
    rated += data.coverage.rated[i]!;
    titleChanges += data.coverage.titleChanges[i]!;
    approximate += data.coverage.approximate[i]!;
  }
  const d0 = dayToDate(dayMin);
  const d1 = dayToDate(dayMax);
  const boundaryApproximate = d0.getUTCDate() !== 1 || new Date(Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth() + 1, 0)).getUTCDate() !== d1.getUTCDate();
  return { total, rated, titleChanges, approximate, boundaryApproximate };
}
