/**
 * Corpus row shapes not exported by @kayfabe/graph-contract, plus the shapes
 * of the adapter's own versioned overlay data files.
 */

/**
 * One row of `evidence/person/{bb}.json` (person-matches@1). Producer:
 * services/materializer/kayfabe_materializer/person_matches_project.py.
 * Every row is one participant's side of one canonical match; optional
 * fields omitted = not recorded. Note `p` is the PARTNER list (side mates),
 * not a card placement — person-matches@1 carries no placement and no `mr`.
 */
export interface PersonMatchRow {
  m: string;
  /** ISO date, matching the timeline record. */
  d: string;
  pr: string;
  f: string;
  /** 1 won / 0 lost / 2 drawn — derived from `res`, not side order. */
  r: 0 | 1 | 2;
  o: string[];
  p?: string[];
  en?: string;
  fin?: string;
  stip?: string;
  t?: string;
  tc?: 1;
  /** Not emitted by person-matches@1; read defensively for future versions. */
  mr?: number;
}

export type PersonEvidenceBucket = Record<string, PersonMatchRow[]>;

/** persona-crosswalk@1 — src/data/persona-crosswalk.json (DATA_CONTRACT §2.1). */
export interface CrosswalkMember {
  id: string;
  persona: string;
}

export interface CrosswalkGroup {
  canonical: string;
  displayName: string;
  members: CrosswalkMember[];
  note: string;
}

export interface CrosswalkFile {
  version: number;
  groups: CrosswalkGroup[];
}

/** company-lineage@1 — src/data/company-lineages.json (DATA_CONTRACT §2.2). */
export interface LineageMember {
  promotionId: string;
  /** Era-correct display name while this member is the active identity. */
  name: string;
  from: string;
  to: string | null;
}

export interface CompanyLineage {
  /** The corpus promotion id active LAST in the lineage. */
  canonical: string;
  members: LineageMember[];
  childOf?: string;
  note?: string;
}

export interface LineageFile {
  version: number;
  lineages: CompanyLineage[];
}

/** Static curated company metadata — src/data/company-meta.json. */
export interface CompanyMeta {
  shortName?: string;
  /** Present only for North American companies; gates playability. */
  homeMarketId?: string;
  sizeTier?: "national" | "regional" | "indie";
  /** Partial DNA seed; unspecified axes fall back to derived defaults. */
  productDna?: Record<string, number>;
}

export interface CompanyMetaFile {
  version: number;
  companies: Record<string, CompanyMeta>;
}
