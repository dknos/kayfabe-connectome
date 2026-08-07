import { isoToDay } from "@kayfabe/graph-contract";
import type { CompanySizeTier, EvidenceSummary } from "@kayfabe/sim-contract";
import type { PersonMatchRow } from "./corpusTypes";

/**
 * Merge person-matches@1 rows recorded under every persona of one canonical
 * person, keep only rows dated on/before startDay (the anti-look-ahead
 * boundary), sort by (d, m) and dedupe by match id — a match reached through
 * two member ids must count once.
 */
export function mergeEvidenceRows(
  rowsPerMember: PersonMatchRow[][],
  startDay: number,
): PersonMatchRow[] {
  const merged: PersonMatchRow[] = [];
  for (const rows of rowsPerMember) {
    for (const row of rows) {
      if (isoToDay(row.d) <= startDay) merged.push(row);
    }
  }
  merged.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.m < b.m ? -1 : a.m > b.m ? 1 : 0));
  const seen = new Set<string>();
  return merged.filter((row) => {
    if (seen.has(row.m)) return false;
    seen.add(row.m);
    return true;
  });
}

/** Resolve a promotion id to the size tier used for promoLevelMix. */
export type PromoLevelResolver = (promotionId: string) => CompanySizeTier;

export function buildEvidenceSummary(opts: {
  personId: string;
  rows: PersonMatchRow[];
  startDay: number;
  promoLevel: PromoLevelResolver;
  /** Maps row promotion ids to lineage-canonical company ids for topPromotions. */
  companyIdFor: (promotionId: string) => string;
}): EvidenceSummary {
  const { personId, rows, startDay, promoLevel, companyIdFor } = opts;
  const matches = rows.length;

  let firstYear: number | null = null;
  let lastYear: number | null = null;
  let wins = 0;
  let losses = 0;
  let titleMatches = 0;
  let recent = 0;
  const opponents = new Set<string>();
  const levelCounts = { national: 0, regional: 0, indie: 0 };
  const formCounts = { singles: 0, tag: 0, multi: 0 };
  const byPromotion = new Map<string, number>();
  let mrCount = 0;
  let mrSum = 0;
  let mrBest = -Infinity;

  for (const row of rows) {
    const year = Number(row.d.slice(0, 4));
    if (firstYear === null || year < firstYear) firstYear = year;
    if (lastYear === null || year > lastYear) lastYear = year;
    if (row.r === 1) wins += 1;
    else if (row.r === 0) losses += 1;
    if (row.t !== undefined) titleMatches += 1;
    if (isoToDay(row.d) > startDay - 730) recent += 1;
    for (const opp of row.o) opponents.add(opp);
    levelCounts[promoLevel(row.pr)] += 1;
    if (row.f === "singles") formCounts.singles += 1;
    else if (row.f === "tag_team" || row.f === "team_implied") formCounts.tag += 1;
    else if (row.f === "multi_way" || row.f === "battle_royal") formCounts.multi += 1;
    // form "unknown" counts toward no bucket: missing is not a form.
    const companyId = companyIdFor(row.pr);
    byPromotion.set(companyId, (byPromotion.get(companyId) ?? 0) + 1);
    if (typeof row.mr === "number") {
      mrCount += 1;
      mrSum += row.mr;
      if (row.mr > mrBest) mrBest = row.mr;
    }
  }

  const decided = wins + losses;
  const topPromotions = [...byPromotion.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 5)
    .map(([promotionId, m]) => ({ promotionId, matches: m }));

  return {
    personId,
    matches,
    firstYear,
    lastYear,
    careerYears: firstYear !== null && lastYear !== null ? lastYear - firstYear + 1 : 0,
    distinctOpponents: opponents.size,
    winShare: decided > 0 ? wins / decided : null,
    // person-matches@1 records no card placement, so main-event share is
    // unknown for every worker — null, never zero (noted in data health).
    mainEventShare: null,
    titleMatchShare: matches > 0 ? titleMatches / matches : 0,
    promoLevelMix: {
      national: matches > 0 ? levelCounts.national / matches : 0,
      regional: matches > 0 ? levelCounts.regional / matches : 0,
      indie: matches > 0 ? levelCounts.indie / matches : 0,
    },
    formMix: {
      singles: matches > 0 ? formCounts.singles / matches : 0,
      tag: matches > 0 ? formCounts.tag / matches : 0,
      multi: matches > 0 ? formCounts.multi / matches : 0,
    },
    meltzer: mrCount > 0 ? { count: mrCount, mean: mrSum / mrCount, best: mrBest } : null,
    recentDensity: recent / 2,
    topPromotions,
  };
}
