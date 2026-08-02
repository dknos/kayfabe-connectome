// SYNTHETIC ratings fixtures — never production data.
import { describe, expect, it } from "vitest";
import { isoToDay } from "@kayfabe/graph-contract";
import { MIN_RATING_TREND_SAMPLES, ratingTrendEligible } from "@kayfabe/ratings-renderer";
import { buildRatingLayout, dayToWorldX, exactMedian, RATING_WORLD, ratingToHeight, sameDaySublaneOffset, trendSegments } from "../ratings/layouts";
import { DEFAULT_RATING_CONTROLS, type RatingLayoutBuildInput } from "../ratings/layouts/layoutTypes";
import type { RatingsData } from "../ratings/ratingsLoader";

type Row = {
  id: string;
  date: string;
  rating: number;
  promotion: "pr:a" | "pr:b";
  participants: string[];
  placement?: number;
};

type LodRow = {
  promotion: "pr:a" | "pr:b";
  year: number;
  start: string;
  end: string;
  total: number;
  rated: number;
  min: number;
  max: number;
  sum: number;
  median: number;
  fourPlus: number;
  fivePlus: number;
};

const PEOPLE = ["p:a", "p:b", "p:c"];
const PROMOTIONS = ["pr:a", "pr:b"];

const fixtureRows: Row[] = [
  { id: "m:negative", date: "2000-01-01", rating: -1, promotion: "pr:a", participants: ["p:a", "p:b"], placement: 0 },
  { id: "m:zero", date: "2000-01-01", rating: 0, promotion: "pr:a", participants: ["p:a", "p:c"], placement: 1 },
  { id: "m:five", date: "2000-02-01", rating: 5, promotion: "pr:a", participants: ["p:b", "p:c"], placement: 2 },
  { id: "m:over-five", date: "2001-01-01", rating: 6.25, promotion: "pr:b", participants: ["p:b", "p:c"], placement: 0 },
  { id: "m:shared", date: "2001-02-01", rating: 4.5, promotion: "pr:b", participants: ["p:a", "p:b"], placement: 1 },
];

/** Builds a deliberately small, complete typed-array projection. The absent
 * sixth documented match has coverage only: it must never become an exact
 * zero-valued row. */
function makeRatings(rows: readonly Row[], lodRows: readonly LodRow[] = []): RatingsData {
  const matchIds = rows.map((row) => row.id);
  const participantValues: number[] = [];
  const participantOffset: number[] = [];
  const participantCount: number[] = [];
  for (const row of rows) {
    participantOffset.push(participantValues.length);
    participantCount.push(row.participants.length);
    participantValues.push(...row.participants.map((id) => PEOPLE.indexOf(id)));
  }
  const promotion = rows.map((row) => PROMOTIONS.indexOf(row.promotion));
  const exactByPromotion = new Map<number, number[]>();
  const exactByParticipant = new Map<number, number[]>();
  rows.forEach((row, index) => {
    const promo = promotion[index]!;
    exactByPromotion.set(promo, [...(exactByPromotion.get(promo) ?? []), index]);
    for (const person of row.participants) {
      const i = PEOPLE.indexOf(person);
      exactByParticipant.set(i, [...(exactByParticipant.get(i) ?? []), index]);
    }
  });

  type Coverage = { kind: number; subject: number; resolution: number; periodKey: number; total: number; rated: number };
  const coverage = new Map<string, Coverage>();
  const addCoverage = (kind: number, subject: number, resolution: number, periodKey: number, total: number, rated: number) => {
    const key = `${kind}:${subject}:${resolution}:${periodKey}`;
    const prior = coverage.get(key) ?? { kind, subject, resolution, periodKey, total: 0, rated: 0 };
    prior.total += total;
    prior.rated += rated;
    coverage.set(key, prior);
  };
  for (const row of rows) {
    const year = Number(row.date.slice(0, 4));
    const month = Number(row.date.slice(0, 7).replace("-", ""));
    const promotionIndex = PROMOTIONS.indexOf(row.promotion);
    for (const [resolution, key] of [[0, year], [2, month]] as const) {
      addCoverage(0, 0xffffffff, resolution, key, 1, 1);
      addCoverage(1, promotionIndex, resolution, key, 1, 1);
      for (const person of row.participants) addCoverage(2, PEOPLE.indexOf(person), resolution, key, 1, 1);
    }
  }
  // One known documented-but-unrated match in March 2000. It is denominator
  // evidence only, not an invented exact rating.
  addCoverage(0, 0xffffffff, 0, 2000, 1, 0);
  addCoverage(0, 0xffffffff, 2, 200003, 1, 0);
  const coverageRows = [...coverage.values()].sort((a, b) =>
    a.kind - b.kind || a.subject - b.subject || a.resolution - b.resolution || a.periodKey - b.periodKey,
  );
  const coverageRange = (kind: number, subject: number, resolution: number): readonly [number, number] => {
    const first = coverageRows.findIndex((row) => row.kind === kind && row.subject === subject && row.resolution === resolution);
    if (first < 0) return [0, 0];
    let end = first;
    while (end < coverageRows.length && coverageRows[end]!.kind === kind && coverageRows[end]!.subject === subject && coverageRows[end]!.resolution === resolution) end++;
    return [first, end];
  };

  const materialized = [...lodRows].sort((a, b) => PROMOTIONS.indexOf(a.promotion) - PROMOTIONS.indexOf(b.promotion) || a.year - b.year);
  const ratings = rows.map((row) => row.rating);
  const ratingRange: [number, number] | null = ratings.length
    ? [Math.min(...ratings), Math.max(...ratings)]
    : null;
  const lodRange = (promotionIndex: number, resolution: number): readonly [number, number] => {
    if (resolution !== 0) return [0, 0];
    const first = materialized.findIndex((row) => PROMOTIONS.indexOf(row.promotion) === promotionIndex);
    if (first < 0) return [0, 0];
    let end = first;
    while (end < materialized.length && PROMOTIONS.indexOf(materialized[end]!.promotion) === promotionIndex) end++;
    return [first, end];
  };

  return {
    manifest: {
      schema_version: "2.0.0",
      projection_version: "meltzer-ratings@2",
      built_at: "2001-12-31T00:00:00Z",
      built_at_policy: "synthetic deterministic fixture",
      source_fingerprint: "synthetic",
      source_schema_version: "2.0.0",
      source_projection_version: "synthetic",
      source_manifest_sha256: "synthetic",
      source_manifest_sha256_policy: "synthetic fixture",
      date_ranges: { canonical: ["2000-01-01", "2001-12-31"], rated: ["2000-01-01", "2001-12-31"] },
      rating_value_range: ratingRange,
      overall_coverage: { rated_matches: rows.length, total_documented_matches: rows.length + 1, fraction: rows.length / (rows.length + 1) },
      promotions_with_ratings: new Set(rows.map((row) => row.promotion)).size,
      aggregate_bin_sizes: {
        year: { resolution_code: 0, calendar_months: 12 },
        quarter: { resolution_code: 1, calendar_months: 3 },
        month: { resolution_code: 2, calendar_months: 1 },
      },
      counts: {
        canonical_matches: rows.length + 1,
        rated_matches: rows.length,
        participant_values: participantValues.length,
        title_values: 0,
        coverage_records: coverageRows.length,
        lod_records: materialized.length,
      },
      dictionary_counts: { matches: rows.length, participants: PEOPLE.length, promotions: PROMOTIONS.length, titles: 0, events: rows.length },
      algorithms: {},
      binary: {
        endianness: "little",
        matches: { file: "matches.bin", record_count: rows.length, stride: 48, offsets: {
          day: 0, rating: 4, promotion: 12, participantOffset: 16, participantCount: 20, flags: 22,
          form: 24, eventIndex: 26, title: 28, placement: 32, matchIdIndex: 36, titleOffset: 40, titleCount: 44, reserved: 46,
        } },
        participants: { file: "participants.bin", record_count: participantValues.length, stride: 4, offsets: { participantIndex: 0 } },
        titles: { file: "titles.bin", record_count: 0, stride: 4, offsets: { titleIndex: 0 } },
        coverage: { file: "coverage.bin", record_count: coverageRows.length, stride: 28, offsets: {
          kind: 0, resolution: 1, subject: 4, periodKey: 8, total: 12, rated: 16, titleChanges: 20, approximate: 24,
        } },
        lod: { file: "lod.bin", record_count: materialized.length, stride: 72, offsets: {
          promotion: 0, resolution: 4, periodStartDay: 8, periodEndDay: 12, periodKey: 16, total: 20,
          rated: 24, min: 28, max: 36, sum: 44, median: 52, fourPlus: 60, fivePlus: 64, approximate: 68,
        } },
      }, checksums: {}, validation: { passed: true, checks: {} },
    },
    dictionaries: {
      schema_version: "2.0.0", ordering: "synthetic", forms: ["singles"],
      matches: { id: matchIds },
      participants: { id: PEOPLE, name: ["A", "B", "C"] },
      promotions: { id: PROMOTIONS, name: ["Alpha", "Beta"] },
      titles: { id: [], name: [] }, events: { id: ["e:test"], name: ["Test event"] },
    },
    histograms: null,
    exact: {
      count: rows.length, day: Int32Array.from(rows.map((row) => isoToDay(row.date))), rating: Float64Array.from(rows.map((row) => row.rating)),
      promotion: Uint32Array.from(promotion), participantOffset: Uint32Array.from(participantOffset), participantCount: Uint16Array.from(participantCount),
      flags: new Uint16Array(rows.length), form: new Uint16Array(rows.length), eventIndex: new Uint16Array(rows.length), title: Int32Array.from(rows.map(() => -1)),
      placement: Int32Array.from(rows.map((row) => row.placement ?? -1)), matchIdIndex: Uint32Array.from(rows.map((_, i) => i)),
      titleOffset: new Uint32Array(rows.length), titleCount: new Uint16Array(rows.length),
    },
    participants: Uint32Array.from(participantValues), titles: new Uint32Array(),
    coverage: {
      count: coverageRows.length, kind: Uint8Array.from(coverageRows.map((row) => row.kind)), resolution: Uint8Array.from(coverageRows.map((row) => row.resolution)),
      subject: Uint32Array.from(coverageRows.map((row) => row.subject)), periodKey: Uint32Array.from(coverageRows.map((row) => row.periodKey)),
      total: Uint32Array.from(coverageRows.map((row) => row.total)), rated: Uint32Array.from(coverageRows.map((row) => row.rated)),
      titleChanges: new Uint32Array(coverageRows.length), approximate: new Uint32Array(coverageRows.length),
    },
    lod: {
      count: materialized.length, promotion: Uint32Array.from(materialized.map((row) => PROMOTIONS.indexOf(row.promotion))), resolution: new Uint8Array(materialized.length),
      startDay: Int32Array.from(materialized.map((row) => isoToDay(row.start))), endDay: Int32Array.from(materialized.map((row) => isoToDay(row.end))), periodKey: Uint32Array.from(materialized.map((row) => row.year)),
      total: Uint32Array.from(materialized.map((row) => row.total)), rated: Uint32Array.from(materialized.map((row) => row.rated)),
      min: Float64Array.from(materialized.map((row) => row.min)), max: Float64Array.from(materialized.map((row) => row.max)), sum: Float64Array.from(materialized.map((row) => row.sum)), median: Float64Array.from(materialized.map((row) => row.median)),
      fourPlus: Uint32Array.from(materialized.map((row) => row.fourPlus)), fivePlus: Uint32Array.from(materialized.map((row) => row.fivePlus)), approximate: new Uint32Array(materialized.length),
    },
    exactMatchIds: matchIds, exactIndexById: new Map(matchIds.map((id, i) => [id, i])),
    promotionIndexById: new Map(PROMOTIONS.map((id, i) => [id, i])), participantIndexById: new Map(PEOPLE.map((id, i) => [id, i])), titleIndexById: new Map(),
    exactByPromotion, exactByParticipant, exactByTitle: new Map(), decodeDurationMs: 0, payloadBytes: 0,
    coverageRows: coverageRange, lodRows: lodRange,
  };
}

function build(data: RatingsData, patch: Partial<RatingLayoutBuildInput> = {}) {
  return buildRatingLayout({
    data, scope: { mode: "promotions", id: null }, controls: structuredClone(DEFAULT_RATING_CONTROLS),
    dayMin: isoToDay("2000-01-01"), dayMax: isoToDay("2001-12-31"), tier: "high",
    selectedMatchId: null, hoveredMatchId: null, currentMatchId: null, pinnedMatchIds: [], requiredPromotionIds: [], generation: 1,
    ...patch,
  });
}

describe("ratings layout arithmetic and identity", () => {
  it("keeps the signed rating scale linear and rejects non-finite claims", () => {
    for (const rating of [-1, 0, 5, 6.25]) {
      expect(ratingToHeight(rating)).toBe(rating * RATING_WORLD.ratingScale);
      expect(Number.isFinite(ratingToHeight(rating))).toBe(true);
    }
    expect(ratingToHeight(-1)).toBeLessThan(0);
    expect(ratingToHeight(0)).toBe(0);
    expect(ratingToHeight(6.25)).toBeGreaterThan(ratingToHeight(5));
    expect(() => ratingToHeight(Number.NaN)).toThrow(/finite/i);
    expect(() => ratingToHeight(Number.POSITIVE_INFINITY)).toThrow(/finite/i);
  });

  it("preserves missing-vs-zero evidence, lane order, and same-day placement deterministically", () => {
    const data = makeRatings(fixtureRows);
    const first = build(data);
    const second = build(data);
    const zero = data.exactIndexById.get("m:zero")!;
    const negative = data.exactIndexById.get("m:negative")!;
    const overFive = data.exactIndexById.get("m:over-five")!;

    expect(data.exactMatchIds).toHaveLength(5); // documented-but-unrated #6 is not an exact row
    expect(first.stats).toMatchObject({ ratedMatches: 5, coverageRatedMatches: 5, totalDocumentedMatches: 6 });
    expect(first.layout.heights[zero]).toBe(0);
    expect(first.layout.heights[negative]).toBeLessThan(0);
    expect(first.layout.heights[overFive]).toBeGreaterThan(ratingToHeight(5));
    expect(first.layout.lanes.map((lane) => lane.id)).toEqual(["pr:a", "pr:b"]);
    expect(second.layout.lanes.map((lane) => lane.id)).toEqual(first.layout.lanes.map((lane) => lane.id));
    expect(first.layout.positions[zero * 3 + 2]).not.toBe(first.layout.positions[negative * 3 + 2]);
    expect(sameDaySublaneOffset("m:opaque", null, 2)).toBe(sameDaySublaneOffset("m:opaque", null, 2));
    expect(sameDaySublaneOffset("m:any", 0)).toBe(-6.8);
    expect(sameDaySublaneOffset("m:any", 8)).toBe(6.8);
  });

  it("uses materialized full-year aggregates and exact partial-window aggregates without changing the rating scale", () => {
    const data = makeRatings(fixtureRows, [{
      promotion: "pr:a", year: 2000, start: "2000-01-01", end: "2000-12-31", total: 3, rated: 3,
      min: -1, max: 5, sum: 4, median: 0, fourPlus: 1, fivePlus: 1,
    }]);
    const full = build(data);
    const materialized = full.layout.aggregates.find((bin) => bin.key === "bin:pr:a:2000")!;
    expect(materialized).toMatchObject({ ratedCount: 3, totalCount: 3, min: -1, median: 0, max: 5, fourPlus: 1, fivePlus: 1 });
    expect(materialized.mean).toBeCloseTo(4 / 3);
    expect(materialized.maxHeight).toBe(ratingToHeight(5));
    expect(materialized.medianHeight).toBe(0);

    const partial = build(data, { dayMin: isoToDay("2000-01-15") });
    const exact = partial.layout.aggregates.find((bin) => bin.key === "bin:pr:a:2000")!;
    expect(exact).toMatchObject({ ratedCount: 1, min: 5, median: 5, mean: 5, max: 5 });
    expect(exact.totalCount).toBe(3); // documented denominator still includes the calendar-month boundary
    expect(exact.medianHeight).toBe(ratingToHeight(5));
    expect(exactMedian([5, -1, 0])).toBe(0);
  });

  it("retains selected and pinned identities past the low-tier exact cap", () => {
    const rows: Row[] = Array.from({ length: 3_602 }, (_, i) => ({
      id: `m:${String(i).padStart(4, "0")}`, date: "2000-01-01", rating: i < 3_600 ? 5 : i === 3_600 ? -1 : 0,
      promotion: "pr:a", participants: ["p:a", "p:b"], placement: i,
    }));
    const data = makeRatings(rows);
    const result = build(data, { tier: "low", selectedMatchId: "m:3600", pinnedMatchIds: ["m:3601"] });
    expect(result.layout.visibleExactMatches).toBe(3_600);
    expect(result.visibleExactIndices).toContain(data.exactIndexById.get("m:3600")!);
    expect(result.visibleExactIndices).toContain(data.exactIndexById.get("m:3601")!);
    expect(result.layout.opacity[data.exactIndexById.get("m:3600")!]).toBeGreaterThan(0);
    expect(result.layout.opacity[data.exactIndexById.get("m:3601")!]).toBeGreaterThan(0);
  });

  it("keeps compare peaks on the same absolute height scale and assigns shared evidence its own lane", () => {
    const data = makeRatings(fixtureRows);
    const all = build(data);
    const compare = build(data, { scope: { mode: "compare", id: null, compareA: "p:a", compareB: "p:b" } });
    expect(compare.layout.ratingRange).toEqual(all.layout.ratingRange);
    expect(compare.layout.lanes.map((lane) => lane.id)).toEqual(["compare:a", "compare:shared", "compare:b"]);
    for (let i = 0; i < data.exact.count; i++) expect(compare.layout.heights[i]).toBe(all.layout.heights[i]);
    const shared = data.exactIndexById.get("m:shared")!;
    expect(compare.layout.positions[shared * 3 + 2]).toBeCloseTo(sameDaySublaneOffset("m:shared", 1), 5);
    expect(compare.layout.positions[shared * 3]).toBeCloseTo(dayToWorldX(data.exact.day[shared]!, compare.layout.dayRange[0], compare.layout.dayRange[1]), 5);

    const promotions = build(data, { scope: { mode: "compare", id: null, compareA: "pr:a", compareB: "pr:b" } });
    expect(promotions.layout.lanes.map((lane) => lane.id)).toEqual(["compare:a", "compare:b"]);
    expect(promotions.layout.ratingRange).toEqual(all.layout.ratingRange);
    expect(promotions.layout.lanes[0]!.z).toBe(-promotions.layout.lanes[1]!.z);
  });

  it("does not bridge gaps in year trends", () => {
    expect(trendSegments([{ year: 2003 }, { year: 2000 }, { year: 2001 }]).map((segment) => segment.map((bin) => bin.year)))
      .toEqual([[2000, 2001], [2003]]);
    expect(MIN_RATING_TREND_SAMPLES).toBe(3);
    expect(ratingTrendEligible(1)).toBe(false);
    expect(ratingTrendEligible(2)).toBe(false);
    expect(ratingTrendEligible(3)).toBe(true);
  });
});
