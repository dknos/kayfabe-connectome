/** Wire types for data/materialized — see MATERIALIZED-FORMAT.md (v1.0.0). */

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
  layout_version: string;
  projection_version: string;
  algorithms: Record<string, string>;
  counts: Record<string, number>;
  date_range: [string, string];
  edges_bin: { count: number; stride_u32: number; fields: string[] };
  promo_bits: Record<string, number>;
  form_bits: Record<MatchForm, number>;
  checksums: Record<string, string>;
  validation: { passed: boolean; checks: Record<string, unknown> };
}

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
  unk: boolean;
  t: string | null;
  tc: 0 | 1;
  dur: number | null;
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

export const EPOCH = Date.UTC(1950, 0, 1);
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
