import { dayToDate, isoToDay } from "@kayfabe/graph-contract";
import { RATING_TIERS, type RatingAggregateVisual, type RatingCoverageCell, type RatingLabel, type RatingLaneVisual } from "@kayfabe/ratings-renderer";
import { COVERAGE_KIND, GLOBAL_SUBJECT, PERIOD, RF, coverageTotals } from "../ratingsAdapter";
import type { RatingsData } from "../ratingsLoader";
import { dayToWorldX, exactMedian, mean, ratingToHeight, sameDaySublaneOffset, stableOpaqueCompare } from "./ratingMath";
import {
  RATING_WORLD,
  type RatingLayoutBuildInput,
  type RatingLayoutBuildResult,
  type RatingStats,
} from "./layoutTypes";

interface PromotionMetric {
  index: number;
  id: string;
  name: string;
  rated: number;
  total: number;
  coverage: number;
  median: number;
  mean: number;
  maximum: number;
  fourPlus: number;
  fivePlus: number;
}

interface LaneAssignment {
  laneId: string;
  laneName: string;
  z: number;
  selected: boolean;
  promotionIndex?: number;
}

const REQUIRED_PRIORITY = 1_000_000;

export function buildRatingLayout(input: RatingLayoutBuildInput): RatingLayoutBuildResult {
  const { data, controls, scope } = input;
  const projectionRange = data.manifest.date_ranges.rated ?? data.manifest.date_ranges.canonical;
  const ratedMin = isoToDay(projectionRange[0]);
  const ratedMax = isoToDay(projectionRange[1]);
  const dayMin = Math.max(ratedMin, Math.min(input.dayMin, ratedMax));
  const dayMax = Math.max(dayMin, Math.min(input.dayMax, ratedMax));
  const globalRatingMin = data.manifest.rating_value_range?.[0] ?? 0;
  const globalRatingMax = data.manifest.rating_value_range?.[1] ?? 5;
  // The default lane order is deliberately anchored to the complete rated
  // corpus. Every explicit analytical order uses the active time window.
  const stableMetrics = promotionMetrics(data, ratedMin, ratedMax);
  const viewMetrics = promotionMetrics(data, dayMin, dayMax);
  const scopeExact = exactForScope(data, scope);
  const filtered = scopeExact.filter((index) => exactPasses(input, index, dayMin, dayMax, viewMetrics));
  const filteredSet = new Set(filtered);
  const assignments = assignLanes(input, filtered, stableMetrics, viewMetrics);
  const laneMap = new Map(assignments.map((lane) => [lane.laneId, lane]));
  const positions = new Float32Array(data.exact.count * 3);
  const heights = new Float32Array(data.exact.count);
  const scales = new Float32Array(data.exact.count);
  const opacity = new Float32Array(data.exact.count);
  const rating = new Float32Array(data.exact.count);
  const required = new Uint8Array(data.exact.count);
  const selectedIndex = input.selectedMatchId ? data.exactIndexById.get(input.selectedMatchId) : undefined;
  const hoveredIndex = input.hoveredMatchId ? data.exactIndexById.get(input.hoveredMatchId) : undefined;
  const currentIndex = input.currentMatchId ? data.exactIndexById.get(input.currentMatchId) : undefined;
  const pinned = new Set(input.pinnedMatchIds.map((id) => data.exactIndexById.get(id)).filter((i): i is number => i !== undefined));
  for (const i of [selectedIndex, hoveredIndex, currentIndex]) if (i !== undefined) required[i] = 1;
  for (const i of pinned) required[i] = 1;

  // Stable cap priority: durable semantics, higher ratings, date, opaque id.
  const orderedVisible = [...filtered].sort((a, b) =>
    (required[b]! - required[a]!) ||
    (data.exact.rating[b]! - data.exact.rating[a]!) ||
    (data.exact.day[a]! - data.exact.day[b]!) ||
    stableOpaqueCompare(data.exactMatchIds[a]!, data.exactMatchIds[b]!),
  );
  const cap = controls.showExact ? RATING_TIERS[input.tier].exactCap : 0;
  const kept = new Set(orderedVisible.slice(0, cap));
  // Required matches survive ordinary caps even when a pathological fixture
  // has more durable items than the configured budget.
  for (let i = 0; i < required.length; i++) if (required[i]) kept.add(i);

  const sameDayOrdinal = new Map<string, number>();
  for (let i = 0; i < data.exact.count; i++) {
    const day = data.exact.day[i]!;
    const promo = data.exact.promotion[i]!;
    const id = data.exactMatchIds[i]!;
    rating[i] = data.exact.rating[i]!;
    heights[i] = ratingToHeight(data.exact.rating[i]!);
    scales[i] = scope.mode === "promotion" || scope.mode === "career" || scope.mode === "title" ? 3.1 : 2.25;
    const laneKey = laneKeyForMatch(input, i, assignments, stableMetrics);
    const lane = laneMap.get(laneKey);
    const fallbackZ = (assignments.length + 2) * RATING_WORLD.laneGap;
    const key = `${day}:${laneKey}`;
    const relevantToScope = filteredSet.has(i) || required[i] === 1;
    const ordinal = relevantToScope ? (sameDayOrdinal.get(key) ?? 0) : 0;
    if (relevantToScope) sameDayOrdinal.set(key, ordinal + 1);
    positions[i * 3] = dayToWorldX(day, dayMin, dayMax);
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = (lane?.z ?? fallbackZ) + sameDaySublaneOffset(id, data.exact.placement[i]! >= 0 ? data.exact.placement[i]! : null, ordinal);
    if (kept.has(i) && lane) {
      const contextual = scope.mode !== "promotions" && !lane.selected;
      opacity[i] = contextual ? 0.24 + controls.context * 0.34 : 0.9;
    }
    // Promotion identity remains in the lane; opaque promotion index is only
    // used to choose the deterministic target above.
    void promo;
  }

  const lanes: RatingLaneVisual[] = assignments.map((lane) => {
    const promoMetric = lane.promotionIndex === undefined ? null : viewMetrics[lane.promotionIndex] ?? null;
    const laneIndices = filtered.filter((index) => laneKeyForMatch(input, index, assignments, stableMetrics) === lane.laneId);
    return {
      id: lane.laneId,
      name: lane.laneName,
      z: lane.z,
      ratedCount: promoMetric?.rated ?? laneIndices.length,
      totalCount: promoMetric?.total ?? 0,
      visibleRatedCount: laneIndices.length,
      coverageBasis: promoMetric ? "promotion-denominator" : "derived-context-no-denominator",
      selected: lane.selected,
    };
  });
  const coverage = buildCoverageCells(data, lanes, assignments, dayMin, dayMax);
  const aggregates = controls.showAggregates
    ? buildAggregates(input, filtered, assignments, stableMetrics, dayMin, dayMax)
    : [];
  const labels = buildLabels(input, filtered, kept, lanes, dayMin, dayMax, globalRatingMin, globalRatingMax, positions, heights);
  const stats = buildStats(input, filtered, kept, dayMin, dayMax, lanes);
  const notes: string[] = [];
  if (orderedVisible.length > kept.size) notes.push(`${orderedVisible.length - kept.size} exact rated matches are summarized at the ${input.tier} quality tier.`);
  if (stableMetrics.filter((metric) => metric.rated > 0).length > lanes.length) notes.push(`${stableMetrics.filter((metric) => metric.rated > 0).length - lanes.length} promotion lanes are omitted from this view and remain available through search.`);
  const outsideFilterRequired = [...kept].filter((index) => !filteredSet.has(index)).length;
  if (outsideFilterRequired) notes.push(`${outsideFilterRequired} locked, current, or pinned match remains visible outside the active filters so its identity is not lost.`);
  if (stats.coverageBoundaryApproximate) notes.push("Coverage denominator uses complete calendar months at partial-month filter boundaries.");
  if (scope.mode === "compare") notes.push("Comparison coverage is reported as A+B subject exposures; shared exact matches appear once in the ridge but belong to each side's denominator. Side ledgers disclose both denominators.");
  if (controls.filters.form !== "all" || controls.filters.ppvOnly || controls.filters.titleMatchOnly || controls.filters.titleChangeOnly) {
    notes.push("Form and event flags filter rated peaks; the coverage rail remains the documented all-match denominator for the same time and lane.");
  }
  const minZ = lanes.length ? Math.min(...lanes.map((lane) => lane.z)) - 18 : -18;
  const maxZ = lanes.length ? Math.max(...lanes.map((lane) => lane.z)) + 18 : 18;
  const layout = {
    generation: input.generation,
    mode: scope.mode,
    scopeId: scope.id,
    matchIds: data.exactMatchIds,
    positions,
    heights,
    scales,
    opacity,
    rating,
    required,
    aggregates,
    coverage,
    lanes,
    labels,
    bounds: {
      minX: RATING_WORLD.xMin,
      maxX: RATING_WORLD.xMax,
      minY: ratingToHeight(Math.min(0, globalRatingMin)) - 14,
      maxY: ratingToHeight(Math.max(5, globalRatingMax)) + 18,
      minZ,
      maxZ,
    },
    dayRange: [dayMin, dayMax] as const,
    ratingRange: [globalRatingMin, globalRatingMax] as const,
    ratingScale: RATING_WORLD.ratingScale,
    visibleExactMatches: kept.size,
    visibleAggregateBins: aggregates.length,
    omittedPromotions: Math.max(0, stableMetrics.filter((metric) => metric.rated > 0).length - lanes.length),
    wantedLabels: labels.length,
    notes,
  };
  return {
    layout,
    stats,
    visibleExactIndices: [...kept].sort((a, b) => a - b),
    scopeExactIndices: filtered,
    scopeLabel: scopeName(data, scope),
  };
}

function exactForScope(data: RatingsData, scope: RatingLayoutBuildInput["scope"]): number[] {
  if (scope.mode === "promotion" && scope.id) {
    const i = data.promotionIndexById.get(scope.id);
    return i === undefined ? [] : [...(data.exactByPromotion.get(i) ?? [])];
  }
  if (scope.mode === "career" && scope.id) {
    const i = data.participantIndexById.get(scope.id);
    return i === undefined ? [] : [...(data.exactByParticipant.get(i) ?? [])];
  }
  if (scope.mode === "title" && scope.id) {
    const i = data.titleIndexById.get(scope.id);
    return i === undefined ? [] : [...(data.exactByTitle.get(i) ?? [])];
  }
  if (scope.mode === "compare") {
    const a = exactForEntity(data, scope.compareA ?? null);
    const b = exactForEntity(data, scope.compareB ?? null);
    return [...new Set([...a, ...b])].sort((x, y) => x - y);
  }
  return Array.from({ length: data.exact.count }, (_, i) => i);
}

function exactForEntity(data: RatingsData, id: string | null): readonly number[] {
  if (!id) return [];
  if (id.startsWith("pr:")) {
    const index = data.promotionIndexById.get(id);
    return index === undefined ? [] : data.exactByPromotion.get(index) ?? [];
  }
  const index = data.participantIndexById.get(id);
  return index === undefined ? [] : data.exactByParticipant.get(index) ?? [];
}

function exactPasses(input: RatingLayoutBuildInput, index: number, dayMin: number, dayMax: number, metrics: PromotionMetric[]): boolean {
  const { exact, dictionaries } = input.data;
  const f = input.controls.filters;
  const day = exact.day[index]!;
  const value = exact.rating[index]!;
  const flags = exact.flags[index]!;
  if (day < dayMin || day > dayMax || value < f.ratingMin || value > f.ratingMax) return false;
  if (f.promotionId && dictionaries.promotions.id[exact.promotion[index]!] !== f.promotionId) return false;
  if (f.form !== "all" && dictionaries.forms[exact.form[index]!] !== f.form) return false;
  if (f.ppvOnly && !(flags & RF.PPV)) return false;
  if (f.titleMatchOnly && !(flags & RF.TITLE_MATCH)) return false;
  if (f.titleChangeOnly && !(flags & RF.TITLE_CHANGE)) return false;
  if (!f.includeApproximateDates && (flags & RF.APPROXIMATE)) return false;
  if (!f.includeExactDates && !(flags & RF.APPROXIMATE)) return false;
  if ((metrics[exact.promotion[index]!]?.coverage ?? 0) < f.coverageMinimum) return false;
  return true;
}

function promotionMetrics(data: RatingsData, dayMin: number, dayMax: number): PromotionMetric[] {
  return data.dictionaries.promotions.id.map((id, index) => {
    const indices = (data.exactByPromotion.get(index) ?? []).filter((i) => data.exact.day[i]! >= dayMin && data.exact.day[i]! <= dayMax);
    const values = indices.map((i) => data.exact.rating[i]!);
    const totals = coverageTotals(data, COVERAGE_KIND.promotion, index, dayMin, dayMax);
    return {
      index,
      id,
      name: data.dictionaries.promotions.name[index]!,
      rated: values.length,
      total: totals.total,
      coverage: totals.total ? values.length / totals.total : 0,
      median: exactMedian(values) ?? -Infinity,
      mean: mean(values) ?? -Infinity,
      maximum: values.length ? Math.max(...values) : -Infinity,
      fourPlus: values.filter((v) => v >= 4).length,
      fivePlus: values.filter((v) => v >= 5).length,
    };
  });
}

function sortedPromotionMetrics(
  input: RatingLayoutBuildInput,
  stableMetrics: PromotionMetric[],
  viewMetrics: PromotionMetric[],
): PromotionMetric[] {
  const order = input.controls.laneOrder;
  const compare = (a: PromotionMetric, b: PromotionMetric): number => {
    const aa = order === "stable" ? a : viewMetrics[a.index]!;
    const bb = order === "stable" ? b : viewMetrics[b.index]!;
    let delta = 0;
    if (order === "stable" || order === "rated") delta = bb.rated - aa.rated;
    else if (order === "total") delta = bb.total - aa.total;
    else if (order === "coverage") delta = bb.coverage - aa.coverage;
    else if (order === "median") delta = bb.median - aa.median;
    else if (order === "mean") delta = bb.mean - aa.mean;
    else if (order === "fourPlus") delta = bb.fourPlus - aa.fourPlus;
    else if (order === "fivePlus") delta = bb.fivePlus - aa.fivePlus;
    else if (order === "maximum") delta = bb.maximum - aa.maximum;
    if (delta) return delta;
    const name = a.name.localeCompare(b.name);
    return name || stableOpaqueCompare(a.id, b.id);
  };
  return stableMetrics.filter((metric) => metric.rated > 0).sort(compare);
}

function assignLanes(
  input: RatingLayoutBuildInput,
  filtered: number[],
  stableMetrics: PromotionMetric[],
  viewMetrics: PromotionMetric[],
): LaneAssignment[] {
  const { data, scope, tier } = input;
  const cap = RATING_TIERS[tier].laneCap;
  if (scope.mode === "career" && scope.id) return careerLanes(input, filtered);
  if (scope.mode === "compare") return compareLanes(input);
  const ordered = sortedPromotionMetrics(input, stableMetrics, viewMetrics);
  const required = new Set(input.requiredPromotionIds);
  if (scope.mode === "promotion" && scope.id) required.add(scope.id);
  if (scope.mode === "title" && scope.id) {
    for (const index of filtered) required.add(data.dictionaries.promotions.id[data.exact.promotion[index]!]!);
  }
  const kept = ordered.slice(0, cap);
  for (const id of required) {
    const metric = stableMetrics[data.promotionIndexById.get(id) ?? -1];
    if (metric?.rated && !kept.includes(metric)) kept.push(metric);
  }
  const focused = scope.mode === "promotion" ? scope.id : null;
  kept.sort((a, b) => {
    if (a.id === focused) return -1;
    if (b.id === focused) return 1;
    return ordered.indexOf(a) - ordered.indexOf(b);
  });
  return kept.map((metric, order) => ({
    laneId: metric.id,
    laneName: metric.name,
    z: order === 0 && focused ? 0 : (focused ? order * RATING_WORLD.selectedLaneGap : order * RATING_WORLD.laneGap),
    selected: metric.id === focused,
    promotionIndex: metric.index,
  }));
}

function careerLanes(input: RatingLayoutBuildInput, filtered: number[]): LaneAssignment[] {
  const { data, scope, tier } = input;
  const selected = data.participantIndexById.get(scope.id!);
  const counts = new Map<number, number>();
  for (const index of filtered) {
    if (data.dictionaries.forms[data.exact.form[index]!] !== "singles") continue;
    const people = participantsOf(data, index).filter((p) => p !== selected);
    if (people.length === 1) counts.set(people[0]!, (counts.get(people[0]!) ?? 0) + 1);
  }
  const namedCap = tier === "high" ? 12 : tier === "medium" ? 8 : 5;
  const named = [...counts].sort((a, b) => b[1] - a[1] || stableOpaqueCompare(data.dictionaries.participants.id[a[0]]!, data.dictionaries.participants.id[b[0]]!)).slice(0, namedCap);
  const lanes: LaneAssignment[] = named.map(([person], i) => ({
    laneId: `opponent:${data.dictionaries.participants.id[person]!}`,
    laneName: data.dictionaries.participants.name[person]!,
    z: i * RATING_WORLD.laneGap,
    selected: true,
  }));
  if (counts.size > named.length) lanes.push({ laneId: "opponent:other", laneName: `Other opponents (${counts.size - named.length})`, z: lanes.length * RATING_WORLD.laneGap, selected: true });
  lanes.push({ laneId: "context:team-multi", laneName: "Team & multi-person matches", z: lanes.length * RATING_WORLD.laneGap, selected: true });
  return lanes;
}

function compareLanes(input: RatingLayoutBuildInput): LaneAssignment[] {
  const { data, scope } = input;
  const name = (id: string | null | undefined): string => {
    if (!id) return "Unset";
    const p = data.participantIndexById.get(id);
    if (p !== undefined) return data.dictionaries.participants.name[p]!;
    const pr = data.promotionIndexById.get(id);
    return pr === undefined ? id : data.dictionaries.promotions.name[pr]!;
  };
  if (scope.compareA?.startsWith("pr:") && scope.compareB?.startsWith("pr:")) {
    return [
      { laneId: "compare:a", laneName: `A · ${name(scope.compareA)}`, z: -RATING_WORLD.laneGap * 0.5, selected: true },
      { laneId: "compare:b", laneName: `B · ${name(scope.compareB)}`, z: RATING_WORLD.laneGap * 0.5, selected: true },
    ];
  }
  return [
    { laneId: "compare:a", laneName: `A · ${name(scope.compareA)}`, z: -RATING_WORLD.laneGap, selected: true },
    { laneId: "compare:shared", laneName: "Shared documented matches", z: 0, selected: true },
    { laneId: "compare:b", laneName: `B · ${name(scope.compareB)}`, z: RATING_WORLD.laneGap, selected: true },
  ];
}

function laneKeyForMatch(input: RatingLayoutBuildInput, index: number, lanes: LaneAssignment[], metrics: PromotionMetric[]): string {
  const { data, scope } = input;
  if (scope.mode === "career" && scope.id) {
    const selected = data.participantIndexById.get(scope.id);
    const form = data.dictionaries.forms[data.exact.form[index]!];
    const other = participantsOf(data, index).filter((p) => p !== selected);
    if (form === "singles" && other.length === 1) {
      const key = `opponent:${data.dictionaries.participants.id[other[0]!]!}`;
      return lanes.some((lane) => lane.laneId === key) ? key : "opponent:other";
    }
    return "context:team-multi";
  }
  if (scope.mode === "compare") {
    const a = scope.compareA;
    const b = scope.compareB;
    const ids = new Set(participantsOf(data, index).map((p) => data.dictionaries.participants.id[p]!));
    const promotion = data.dictionaries.promotions.id[data.exact.promotion[index]!]!;
    const has = (id: string | null | undefined) => !!id && (id.startsWith("pr:") ? promotion === id : ids.has(id));
    const ha = has(a);
    const hb = has(b);
    return ha && hb ? "compare:shared" : ha ? "compare:a" : "compare:b";
  }
  const promo = data.exact.promotion[index]!;
  return metrics[promo]?.id ?? data.dictionaries.promotions.id[promo]!;
}

function participantsOf(data: RatingsData, index: number): number[] {
  const out: number[] = [];
  const start = data.exact.participantOffset[index]!;
  const end = start + data.exact.participantCount[index]!;
  for (let p = start; p < end; p++) out.push(data.participants[p]!);
  return [...new Set(out)];
}

function buildCoverageCells(data: RatingsData, lanes: RatingLaneVisual[], assignments: LaneAssignment[], dayMin: number, dayMax: number): RatingCoverageCell[] {
  const cells: RatingCoverageCell[] = [];
  const minYear = dayToDate(dayMin).getUTCFullYear();
  const maxYear = dayToDate(dayMax).getUTCFullYear();
  const yearWidth = (RATING_WORLD.xMax - RATING_WORLD.xMin) / Math.max(1, maxYear - minYear + 1);
  for (const lane of lanes) {
    const assignment = assignments.find((item) => item.laneId === lane.id);
    if (assignment?.promotionIndex === undefined) continue;
    const [start, end] = data.coverageRows(COVERAGE_KIND.promotion, assignment.promotionIndex, PERIOD.year);
    let maxTotal = 1;
    for (let i = start; i < end; i++) {
      const year = data.coverage.periodKey[i]!;
      if (year >= minYear && year <= maxYear) maxTotal = Math.max(maxTotal, data.coverage.total[i]!);
    }
    for (let i = start; i < end; i++) {
      const year = data.coverage.periodKey[i]!;
      if (year < minYear || year > maxYear) continue;
      const yearStart = isoToDay(`${year}-01-01`);
      const yearEnd = isoToDay(`${year}-12-31`);
      const x0 = dayToWorldX(Math.max(dayMin, yearStart), dayMin, dayMax);
      const x1 = dayToWorldX(Math.min(dayMax, yearEnd), dayMin, dayMax);
      cells.push({
        key: `coverage:${lane.id}:${year}`,
        promotionId: lane.id,
        x: (x0 + x1) * 0.5,
        z: lane.z,
        width: Math.max(0.6, Math.min(yearWidth, x1 - x0)),
        totalCount: data.coverage.total[i]!,
        ratedCount: data.coverage.rated[i]!,
        maxTotalInLane: maxTotal,
        opacity: 1,
      });
    }
  }
  return cells;
}

function buildAggregates(input: RatingLayoutBuildInput, filtered: number[], assignments: LaneAssignment[], metrics: PromotionMetric[], dayMin: number, dayMax: number): RatingAggregateVisual[] {
  const exactBins = buildExactAggregates(input, filtered, assignments, metrics, dayMin, dayMax);
  if (!canUseMaterializedLod(input)) return exactBins;
  const materialized = buildMaterializedAggregates(input.data, assignments, dayMin, dayMax);
  if (!materialized.length) return exactBins;
  // Partial boundary years remain derived from the exact in-window records.
  // Complete years use the validated direct-sample aggregate so the far LOD
  // consumes, rather than merely duplicates, the projection contract.
  const materializedKeys = new Set(materialized.map((bin) => bin.key));
  return [...materialized, ...exactBins.filter((bin) => !materializedKeys.has(bin.key))]
    .sort((a, b) => a.z - b.z || a.startDay - b.startDay || stableOpaqueCompare(a.key, b.key));
}

function canUseMaterializedLod(input: RatingLayoutBuildInput): boolean {
  const f = input.controls.filters;
  if (input.scope.mode !== "promotions" && input.scope.mode !== "promotion") return false;
  if (f.promotionId || f.form !== "all" || f.ppvOnly || f.titleMatchOnly || f.titleChangeOnly ||
      !f.includeExactDates || !f.includeApproximateDates || f.coverageMinimum > 0) return false;
  const range = input.data.manifest.rating_value_range;
  return range !== null && f.ratingMin <= range[0] && f.ratingMax >= range[1];
}

function buildMaterializedAggregates(
  data: RatingsData,
  assignments: LaneAssignment[],
  dayMin: number,
  dayMax: number,
): RatingAggregateVisual[] {
  const bins: RatingAggregateVisual[] = [];
  for (const lane of assignments) {
    if (lane.promotionIndex === undefined) continue;
    const [rowStart, rowEnd] = data.lodRows(lane.promotionIndex, PERIOD.year);
    for (let row = rowStart; row < rowEnd; row++) {
      const start = data.lod.startDay[row]!;
      const end = data.lod.endDay[row]!;
      const rated = data.lod.rated[row]!;
      // Never let a full-year aggregate claim records outside a partial date
      // window; the exact-derived boundary bin handles that case below.
      if (!rated || start < dayMin || end > dayMax) continue;
      const x0 = dayToWorldX(start, dayMin, dayMax);
      const x1 = dayToWorldX(end, dayMin, dayMax);
      const year = data.lod.periodKey[row]!;
      const median = data.lod.median[row]!;
      const maximum = data.lod.max[row]!;
      bins.push({
        key: `bin:${lane.laneId}:${year}`,
        promotionId: lane.laneId,
        startDay: start,
        endDay: end,
        x: (x0 + x1) * 0.5,
        z: lane.z,
        width: Math.max(1.2, (x1 - x0) * 0.84),
        maxHeight: ratingToHeight(maximum),
        medianHeight: ratingToHeight(median),
        ratedCount: rated,
        coverageRatedCount: rated,
        totalCount: data.lod.total[row]!,
        coverageBasis: "promotion-denominator",
        min: data.lod.min[row]!,
        median,
        mean: data.lod.sum[row]! / rated,
        max: maximum,
        fourPlus: data.lod.fourPlus[row]!,
        fivePlus: data.lod.fivePlus[row]!,
        approximateCount: data.lod.approximate[row]!,
        opacity: 1,
      });
    }
  }
  return bins;
}

function buildExactAggregates(input: RatingLayoutBuildInput, filtered: number[], assignments: LaneAssignment[], metrics: PromotionMetric[], dayMin: number, dayMax: number): RatingAggregateVisual[] {
  const groups = new Map<string, number[]>();
  for (const index of filtered) {
    const lane = laneKeyForMatch(input, index, assignments, metrics);
    if (!assignments.some((assignment) => assignment.laneId === lane)) continue;
    const year = dayToDate(input.data.exact.day[index]!).getUTCFullYear();
    const key = `${lane}:${year}`;
    const list = groups.get(key);
    if (list) list.push(index);
    else groups.set(key, [index]);
  }
  const bins: RatingAggregateVisual[] = [];
  for (const [key, indices] of groups) {
    const split = key.lastIndexOf(":");
    const laneId = key.slice(0, split);
    const year = Number(key.slice(split + 1));
    const lane = assignments.find((item) => item.laneId === laneId);
    if (!lane) continue;
    const values = indices.map((index) => input.data.exact.rating[index]!);
    const firstPromotion = input.data.exact.promotion[indices[0]!]!;
    const sourceCoverage = lane.promotionIndex === undefined
      ? null
      : coverageYear(input.data, lane.promotionIndex, year);
    const start = Math.max(dayMin, isoToDay(`${year}-01-01`));
    const end = Math.min(dayMax, isoToDay(`${year}-12-31`));
    const x0 = dayToWorldX(start, dayMin, dayMax);
    const x1 = dayToWorldX(end, dayMin, dayMax);
    const median = exactMedian(values)!;
    bins.push({
      key: `bin:${laneId}:${year}`,
      promotionId: input.data.dictionaries.promotions.id[firstPromotion]!,
      startDay: start,
      endDay: end,
      x: (x0 + x1) * 0.5,
      z: lane.z,
      width: Math.max(1.2, (x1 - x0) * 0.84),
      maxHeight: ratingToHeight(Math.max(...values)),
      medianHeight: ratingToHeight(median),
      ratedCount: values.length,
      coverageRatedCount: sourceCoverage?.rated ?? null,
      totalCount: sourceCoverage?.total ?? 0,
      coverageBasis: sourceCoverage ? "promotion-denominator" : "derived-context-no-denominator",
      min: Math.min(...values),
      median,
      mean: mean(values)!,
      max: Math.max(...values),
      fourPlus: values.filter((v) => v >= 4).length,
      fivePlus: values.filter((v) => v >= 5).length,
      approximateCount: indices.filter((i) => input.data.exact.flags[i]! & RF.APPROXIMATE).length,
      opacity: 1,
    });
  }
  return bins.sort((a, b) => a.z - b.z || a.startDay - b.startDay || stableOpaqueCompare(a.key, b.key));
}

function coverageYear(data: RatingsData, promotion: number, year: number): { total: number; rated: number } {
  const [start, end] = data.coverageRows(COVERAGE_KIND.promotion, promotion, PERIOD.year);
  for (let i = start; i < end; i++) if (data.coverage.periodKey[i] === year) return { total: data.coverage.total[i]!, rated: data.coverage.rated[i]! };
  return { total: 0, rated: 0 };
}

function buildLabels(
  input: RatingLayoutBuildInput,
  filtered: number[],
  kept: Set<number>,
  lanes: RatingLaneVisual[],
  dayMin: number,
  dayMax: number,
  ratingMin: number,
  ratingMax: number,
  positions: Float32Array,
  heights: Float32Array,
): RatingLabel[] {
  const labels: RatingLabel[] = [];
  for (let laneOrder = 0; laneOrder < lanes.length; laneOrder++) {
    const lane = lanes[laneOrder]!;
    const nearEdgeAnchor = laneOrder === 0;
    const coverageSub = lane.coverageBasis === "promotion-denominator"
      ? `${lane.ratedCount.toLocaleString()}/${lane.totalCount.toLocaleString()} source coverage${lane.visibleRatedCount !== lane.ratedCount ? ` · ${lane.visibleRatedCount.toLocaleString()} visible` : ""}`
      : `${lane.visibleRatedCount.toLocaleString()} rated · derived context`;
    const forceLane = nearEdgeAnchor
      || (input.scope.mode === "promotion" && lane.selected)
      || (input.scope.mode === "title" && lane.visibleRatedCount > 0)
      || (input.scope.mode === "career" && laneOrder < 5)
      || input.scope.mode === "compare";
    const semanticPriority = input.scope.mode !== "promotions" && lane.visibleRatedCount > 0 ? 7_000 + Math.min(900, lane.visibleRatedCount) : 0;
    labels.push({
      key: `lane:${lane.id}`,
      text: lane.name,
      sub: coverageSub,
      x: RATING_WORLD.xMin - 14,
      y: 2,
      z: lane.z,
      priority: Math.max(semanticPriority, lane.selected ? 8_500 : nearEdgeAnchor ? 5_200 : 3_000 + Math.min(900, lane.ratedCount)),
      force: forceLane,
      tone: "lane",
      pick: lane.id.startsWith("pr:") ? `promotion:${lane.id}` : undefined,
      accessibleName: lane.coverageBasis === "promotion-denominator"
        ? `${lane.name} lane. ${lane.visibleRatedCount} visible rated matches. Promotion coverage is ${lane.ratedCount} source-rated matches of ${lane.totalCount} documented matches.`
        : `${lane.name} derived context lane. ${lane.visibleRatedCount} visible rated matches. Its documented denominator is not attributed to this derived lane; use the scope inspector denominator.`,
    });
  }
  const lo = Math.floor(Math.min(0, ratingMin));
  const hi = Math.ceil(Math.max(5, ratingMax));
  for (let value = lo; value <= hi; value++) labels.push({
    key: `rating-tick:${value}`,
    text: `${value}`,
    sub: value === 5 ? "5★ datum" : undefined,
    x: RATING_WORLD.xMin,
    y: ratingToHeight(value),
    z: lanes[0]?.z ?? 0,
    priority: value === 5 ? 4_800 : 1_700,
    force: value === 5,
    tone: value < 0 ? "negative" : value === 5 ? "datum" : "tick",
    accessibleName: `Reported rating ${value}`,
  });
  const yForDates = ratingToHeight(Math.min(0, ratingMin)) - 8;
  const firstYear = dayToDate(dayMin).getUTCFullYear();
  const lastYear = dayToDate(dayMax).getUTCFullYear();
  for (let year = Math.ceil(firstYear / 5) * 5; year <= lastYear; year += 5) labels.push({
    key: `date-tick:${year}`,
    text: String(year),
    x: dayToWorldX(isoToDay(`${year}-01-01`), dayMin, dayMax),
    y: yForDates,
    z: lanes[0]?.z ?? 0,
    priority: year % 10 === 0 ? 2_100 : 1_250,
    tone: "tick",
  });
  for (const index of filtered) {
    if (!kept.has(index)) continue;
    const id = input.data.exactMatchIds[index]!;
    const required = id === input.selectedMatchId || id === input.hoveredMatchId || id === input.currentMatchId || input.pinnedMatchIds.includes(id);
    if (!required && input.data.exact.rating[index]! < 5) continue;
    const names = participantsOf(input.data, index).map((p) => input.data.dictionaries.participants.name[p]!);
    const short = names.length <= 2 ? names.join(" vs ") : `${names.slice(0, 2).join(" · ")} +${names.length - 2}`;
    labels.push({
      key: `match:${id}`,
      text: `${input.data.exact.rating[index]!.toLocaleString(undefined, { maximumFractionDigits: 2 })}★ · ${short}`,
      sub: `${dayToDate(input.data.exact.day[index]!).getUTCFullYear()} · ${input.data.dictionaries.promotions.name[input.data.exact.promotion[index]!]}`,
      x: positions[index * 3]!,
      y: heights[index]!,
      z: positions[index * 3 + 2]!,
      priority: required ? REQUIRED_PRIORITY : 3_600 + input.data.exact.rating[index]! * 100,
      force: required,
      tone: input.data.exact.rating[index]! < 0 ? "negative" : "match",
      pick: id,
      accessibleName: `${short}, reported Meltzer rating ${input.data.exact.rating[index]!}, ${dayToDate(input.data.exact.day[index]!).toISOString().slice(0, 10)}`,
    });
  }
  return labels;
}

function buildStats(input: RatingLayoutBuildInput, filtered: number[], kept: Set<number>, dayMin: number, dayMax: number, lanes: RatingLaneVisual[]): RatingStats {
  const { data, scope } = input;
  let kind: number = COVERAGE_KIND.global;
  let subject = GLOBAL_SUBJECT;
  if (scope.mode === "promotion" && scope.id) {
    kind = COVERAGE_KIND.promotion;
    subject = data.promotionIndexById.get(scope.id) ?? GLOBAL_SUBJECT;
  } else if (scope.mode === "career" && scope.id) {
    kind = COVERAGE_KIND.person;
    subject = data.participantIndexById.get(scope.id) ?? GLOBAL_SUBJECT;
  } else if (scope.mode === "title" && scope.id) {
    kind = COVERAGE_KIND.title;
    subject = data.titleIndexById.get(scope.id) ?? GLOBAL_SUBJECT;
  }
  const den = scope.mode === "compare"
    ? compareCoverage(input, dayMin, dayMax)
    : coverageTotals(data, kind, subject, dayMin, dayMax);
  const values = filtered.map((index) => data.exact.rating[index]!);
  const promotions = new Set(filtered.map((index) => data.exact.promotion[index]!));
  const wrestlers = new Set(filtered.flatMap((index) => participantsOf(data, index)));
  const days = filtered.map((index) => data.exact.day[index]!);
  return {
    ratedMatches: filtered.length,
    coverageRatedMatches: den.rated,
    totalDocumentedMatches: den.total,
    coverage: den.total ? den.rated / den.total : 0,
    coverageBoundaryApproximate: den.boundaryApproximate,
    coverageAccounting: scope.mode === "compare" ? "subject-exposures" : "unique-matches",
    promotions: promotions.size,
    wrestlers: wrestlers.size,
    median: exactMedian(values),
    mean: mean(values),
    maximum: values.length ? Math.max(...values) : null,
    minimum: values.length ? Math.min(...values) : null,
    fourPlus: values.filter((v) => v >= 4).length,
    fivePlus: values.filter((v) => v >= 5).length,
    approximateDates: filtered.filter((index) => data.exact.flags[index]! & RF.APPROXIMATE).length,
    displayedMatches: kept.size,
    omittedMatches: Math.max(0, filtered.length - kept.size),
    displayedLanes: lanes.length,
    omittedLanes: Math.max(0, data.exactByPromotion.size - lanes.length),
    dateSpan: days.length ? [Math.min(...days), Math.max(...days)] : null,
  };
}

function compareCoverage(input: RatingLayoutBuildInput, dayMin: number, dayMax: number) {
  const { data, scope } = input;
  const one = (id: string | null | undefined) => {
    if (!id) return { total: 0, rated: 0, titleChanges: 0, approximate: 0, boundaryApproximate: false };
    if (id.startsWith("pr:")) return coverageTotals(data, COVERAGE_KIND.promotion, data.promotionIndexById.get(id) ?? GLOBAL_SUBJECT, dayMin, dayMax);
    return coverageTotals(data, COVERAGE_KIND.person, data.participantIndexById.get(id) ?? GLOBAL_SUBJECT, dayMin, dayMax);
  };
  const a = one(scope.compareA);
  const b = one(scope.compareB);
  return {
    total: a.total + b.total,
    rated: a.rated + b.rated,
    titleChanges: a.titleChanges + b.titleChanges,
    approximate: a.approximate + b.approximate,
    boundaryApproximate: a.boundaryApproximate || b.boundaryApproximate,
  };
}

function scopeName(data: RatingsData, scope: RatingLayoutBuildInput["scope"]): string {
  if (scope.mode === "compare") {
    const entityName = (id: string | null | undefined): string => {
      if (!id) return "Unset";
      if (id.startsWith("pr:")) {
        const index = data.promotionIndexById.get(id);
        return index === undefined ? id : data.dictionaries.promotions.name[index]!;
      }
      const index = data.participantIndexById.get(id);
      return index === undefined ? id : data.dictionaries.participants.name[index]!;
    };
    return `${entityName(scope.compareA)} versus ${entityName(scope.compareB)}`;
  }
  if (!scope.id) return "All rated promotions";
  if (scope.id.startsWith("pr:")) {
    const index = data.promotionIndexById.get(scope.id);
    return index === undefined ? scope.id : data.dictionaries.promotions.name[index]!;
  }
  if (scope.id.startsWith("t:")) {
    const index = data.titleIndexById.get(scope.id);
    return index === undefined ? scope.id : data.dictionaries.titles.name[index]!;
  }
  const index = data.participantIndexById.get(scope.id);
  return index === undefined ? scope.id : data.dictionaries.participants.name[index]!;
}
