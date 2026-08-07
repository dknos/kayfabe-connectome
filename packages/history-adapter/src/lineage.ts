import type { CompanyLineage, LineageFile, LineageMember } from "./corpusTypes";

/**
 * Loaded company-lineage@1 overlay: fragmented corpus promotion ids stitched
 * into one company keyed by the promotion id active last (e.g. pr:4140 for
 * the WWWF/WWF/WWE line). Promotions in no lineage are their own company.
 */
export interface LineageIndex {
  version: number;
  lineages: CompanyLineage[];
  /** corpus promotion id -> canonical company id. */
  promotionToCompany: Map<string, string>;
  byCanonical: Map<string, CompanyLineage>;
}

export function loadLineages(data: unknown): LineageIndex {
  const file = data as LineageFile;
  if (!file || typeof file.version !== "number" || !Array.isArray(file.lineages)) {
    throw new Error("company-lineages: malformed file");
  }
  const promotionToCompany = new Map<string, string>();
  const byCanonical = new Map<string, CompanyLineage>();
  for (const lineage of file.lineages) {
    if (byCanonical.has(lineage.canonical)) {
      throw new Error(`company-lineages: duplicate canonical ${lineage.canonical}`);
    }
    if (!lineage.members.some((m) => m.promotionId === lineage.canonical)) {
      throw new Error(
        `company-lineages: canonical ${lineage.canonical} not among its members`,
      );
    }
    for (const member of lineage.members) {
      if (promotionToCompany.has(member.promotionId)) {
        throw new Error(`company-lineages: duplicate membership ${member.promotionId}`);
      }
      promotionToCompany.set(member.promotionId, lineage.canonical);
    }
    byCanonical.set(lineage.canonical, lineage);
  }
  return { version: file.version, lineages: file.lineages, promotionToCompany, byCanonical };
}

/** Canonical company id for any corpus promotion id (identity when unstitched). */
export function companyIdFor(lin: LineageIndex, promotionId: string): string {
  return lin.promotionToCompany.get(promotionId) ?? promotionId;
}

/**
 * The lineage member whose [from, to) interval covers the ISO date — the
 * era-correct identity ("WWF" for a 1997 save on the WWE line). Falls back
 * to the latest member starting on/before the date, then the first member.
 */
export function eraMember(
  lineage: CompanyLineage,
  isoDate: string,
): LineageMember {
  let covering: LineageMember | undefined;
  let latestStarted: LineageMember | undefined;
  for (const member of lineage.members) {
    if (member.from <= isoDate && (member.to === null || isoDate < member.to)) {
      covering = member;
    }
    if (member.from <= isoDate) {
      if (!latestStarted || member.from > latestStarted.from) latestStarted = member;
    }
  }
  return covering ?? latestStarted ?? lineage.members[0]!;
}
