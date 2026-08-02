/** Wire types for data/materialized — see MATERIALIZED-FORMAT.md (v2.0.0). */

export type NodeType = 0 | 1 | 2; // person | promotion | title
export type Resolution = 0 | 1 | 2; // confirmed | probable | unresolved
export type MatchForm =
  | "singles"
  | "tag_team"
  | "multi_way"
  | "battle_royal"
  | "team_implied"
  | "unknown";
export type Rel = "same" | "opposed" | "br";

export interface Manifest {
  schema_version: string;
  built_at: string;
  source_fingerprint: string;
  sources?: Record<string, string>;
  epoch?: string;
  layout_version: string;
  projection_version: string;
  algorithms: Record<string, string>;
  counts: Record<string, number>;
  date_range: [string, string];
  edges_bin: { count: number; stride_u32: number; fields: string[] };
  promo_bits: Record<string, number>;
  /** promotions absent from promo_bits share this bit (v2 corpora) */
  promo_other_bit?: number;
  form_bits: Record<MatchForm, number>;
  checksums: Record<string, string>;
  validation: { passed: boolean; checks: Record<string, unknown> };
}

/** graph/promotions.json — every promotion (graph node or not) */
export interface PromotionInfo {
  n: string;
  m: number;
  src: string;
  bit?: number;
}
export type PromotionsFile = Record<string, PromotionInfo>;

export interface NodesColumnar {
  count: number;
  id: string[];
  type: NodeType[];
  name: string[];
  community: number[];
  pos: number[]; // flat xyz
  firstDay: number[];
  lastDay: number[];
  matches: number[];
  degree: number[];
  reigns: number[];
  promoMask: number[];
  resolution: Resolution[];
}

export interface CommunitiesFile {
  count: number;
  label: string[];
  size: number[];
  center: number[]; // flat xyz
  topMembers: string[][];
}

export interface SearchEntity {
  id: string;
  t: "person" | "promotion" | "title" | "event";
  n: string;
  first?: string;
  last?: string;
  m: number;
  pm?: string[];
}

export interface EvidenceEntry {
  m: string;
  c: string;
  d: string;
  pr: string;
  rel: Rel;
  form: MatchForm;
  res: string;
  fin: string | null;
  t: string | null;
  tc: 0 | 1;
  /** Meltzer star rating (csv enrichment), when reported */
  mr?: number;
}
export type EvidenceBucket = Record<string, EvidenceEntry[]>;

export interface TimelineEvent {
  m: string;
  c: string;
  d: string;
  pr: string;
  en: string;
  loc: string;
  form: MatchForm;
  stip: string;
  res: string;
  fin: string | null;
  w: string[];
  l: string[];
  /** explicit unit partition of w/l (csv comma grammar), present only when a
   * side has >= 2 units — enables record-accurate encounters@2 re-derivation */
  wu?: string[][];
  lu?: string[][];
  unk: boolean;
  t: string | null;
  tc: 0 | 1;
  dur: number | null;
  /** Meltzer star rating, PPV flag, approximate-date flag (csv enrichment) */
  mr?: number;
  ppv?: 1;
  apx?: 1;
}

export interface PersonDossier {
  n: string;
  first: string;
  last: string;
  m: number;
  promos: Record<string, number>;
  years: Record<string, number>;
  top: { partners: [string, number][]; opponents: [string, number][] };
  teams: string[];
  titles: { t: string; reigns: { s: string; e: string | null; m: string }[] }[];
  src: Record<string, unknown>;
}
export type PeopleBucket = Record<string, PersonDossier>;

export interface ChampionshipRecord {
  n: string;
  pr: string;
  artifact: boolean;
  reigns: { holders: string[]; s: string; e: string | null; m: string; endM?: string }[];
  titleMatches: number;
  changes: number;
}
export type ChampionshipsFile = Record<string, ChampionshipRecord>;

export interface DensityFile {
  years: Record<string, { matches: number; titleChanges: number }>;
}

/* ------------------------------------------------------------- CHRONOLOGY
 *
 * data/materialized/atlas/ — the legacy on-wire path for the chronology projection.
 * See docs/CHRONOLOGY-PROJECTION.md. Written by `pnpm chronology:materialize`, which is
 * a SEPARATE entry point from `pnpm data:materialize`; the chronology tree is not
 * in the connectome materializer's managed set and is never wiped by it.
 *
 * Nothing here is a new claim about the corpus. Every field is either a count
 * of documented records or a span between documented records, and the two
 * places where the source is genuinely ambiguous — which promotion a
 * championship belongs to, and whether a title has any derivable lineage —
 * carry their ambiguity as data rather than resolving it.
 */

/** How a championship came to be listed under a promotion. */
export type TitleAssociation =
  /** The csv source row names the promotion outright. */
  | "registry"
  /**
   * Assigned by PLURALITY of documented title matches, ties broken by
   * promotion id.
   *
   * `assocShare` is that plurality's share, and it is the whole story: a high
   * share is a belt defended at home, a low one is a belt defended widely, and
   * a share of exactly 0.5 is a TIE — the records did not choose a promotion,
   * the id ordering did. Two belts in the current corpus sit at 0.5. Consumers
   * must not present a tie as a majority.
   */
  | "dominant"
  /** No promotion is supported by the records. Never guessed into one. */
  | "unresolved";

export interface AtlasManifest {
  schema_version: string;
  projection_version: string;
  epoch: string;
  algorithms: Record<string, string>;
  counts: Record<string, number>;
  date_range: [string, string];
  day_range: [number, number];
  buckets: number;
  /** Files this projection deliberately does not duplicate, and where the
   *  lens reads them from instead. */
  reuses: Record<string, string>;
  checksums: Record<string, string>;
  validation: { passed: boolean; checks: Record<string, unknown> };
}

/**
 * atlas/promotions.json — every promotion in the corpus, columnar.
 *
 * ALL of them, not just the ones that earned a graph node: "every promotion
 * must remain represented" is the whole point of the overview, and 406 of the
 * 571 have no node.
 */
export interface AtlasPromotionsFile {
  count: number;
  id: string[];
  name: string[];
  /** -1 when the promotion has no dated record at all. */
  firstDay: number[];
  lastDay: number[];
  cards: number[];
  matches: number[];
  /** distinct people documented on a card for this promotion */
  people: number[];
  /** number of championships associated with this promotion */
  titles: number[];
  src: string[];
  /** manifest.promo_bits value, or -1 when the promotion shares the other-bit */
  bit: number[];
  /** Yearly documented-match counts, run-length by year: counts[i][k] is the
   *  count for year yearFrom[i] + k. Empty when the promotion has no records. */
  yearFrom: number[];
  yearCounts: number[][];
}

/** atlas/titles.json — every championship in the corpus, columnar. */
export interface AtlasTitlesFile {
  count: number;
  id: string[];
  name: string[];
  /** Promotion id, or "" when `assoc` is "unresolved". */
  pr: string[];
  assoc: TitleAssociation[];
  /** Share of documented title matches held by `pr`, 0..1. 1 for "registry". */
  assocShare: number[];
  firstDay: number[];
  lastDay: number[];
  titleMatches: number[];
  /** Derived reign count. 0 does NOT mean "no reigns happened" — see
   *  `lineage` below. */
  reigns: number[];
  changes: number[];
  /** distinct documented holders */
  holders: number[];
  /** 1 when the belt NAME is a concatenation artifact in the source. */
  artifact: number[];
  src: string[];
  /**
   * Whether a lineage can be derived AT ALL for this title.
   *   "derived"    — the source records title changes; reigns are real.
   *   "no-changes" — the source carries no title-change flag (the csv corpus),
   *                  so reigns are not derived rather than guessed. The title
   *                  still has documented title MATCHES.
   */
  lineage: ("derived" | "no-changes")[];
}

/** One person's documented span inside one promotion. */
export interface AtlasRoute {
  pr: string;
  firstDay: number;
  lastDay: number;
  /** documented matches for this person in this promotion */
  matches: number;
  /** distinct documented cards */
  cards: number;
}

/** atlas/people/{bb}.json — keyed by person id. */
export interface AtlasPersonRoutes {
  n: string;
  firstDay: number;
  lastDay: number;
  matches: number;
  /** Ordered by (firstDay, pr) — the lane order a career route reads in. */
  routes: AtlasRoute[];
}
export type AtlasPeopleBucket = Record<string, AtlasPersonRoutes>;

/** A person's documented participation in one promotion, for its focus board. */
export interface AtlasMember {
  p: string;
  n: string;
  firstDay: number;
  lastDay: number;
  matches: number;
  cards: number;
  /** 1 when this person holds a documented reign in one of the promotion's
   *  titles. Absent rather than 0 to keep the shard small. */
  champ?: 1;
}

/** A championship as it appears on its promotion's focus board. */
export interface AtlasPromotionTitle {
  t: string;
  n: string;
  firstDay: number;
  lastDay: number;
  titleMatches: number;
  reigns: number;
  changes: number;
  holders: number;
  artifact: number;
  assoc: TitleAssociation;
  assocShare: number;
  lineage: "derived" | "no-changes";
  /** Documented title matches per year, run-length from `yearFrom`. */
  yearFrom: number;
  yearCounts: number[];
}

/** atlas/promotions/{bb}.json — keyed by promotion id. */
export interface AtlasPromotionDetail {
  id: string;
  n: string;
  firstDay: number;
  lastDay: number;
  cards: number;
  matches: number;
  people: number;
  src: string;
  yearFrom: number;
  yearCards: number[];
  yearMatches: number[];
  titles: AtlasPromotionTitle[];
  /** Ordered by (-matches, p) so the label budget follows corpus weight. */
  members: AtlasMember[];
  /** Set when `members` was truncated, with the number left out. Never
   *  silently — a capped roster that reads as complete is a false claim. */
  membersTruncated?: number;
}
export type AtlasPromotionsBucket = Record<string, AtlasPromotionDetail>;

// Epoch v2: 1900 (was 1950) — the csv corpus reaches back to 1947.
export const EPOCH = Date.UTC(1900, 0, 1);
export const dayToDate = (day: number): Date => new Date(EPOCH + day * 86400000);
export const isoToDay = (iso: string): number =>
  Math.round((Date.parse(iso + "T00:00:00Z") - EPOCH) / 86400000);

export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
export const bucketOf = (key: string): string =>
  (fnv1a32(key) % 256).toString(16).padStart(2, "0");
