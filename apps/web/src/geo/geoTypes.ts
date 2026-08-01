import type { GeoPlace } from "@kayfabe/geo-renderer";

/** Wire shapes for data/materialized/geo. Mirrors docs/GEO-PROJECTION.md. */

export interface GeoManifest {
  schema_version: string;
  projection_version: string;
  resolution_version: string;
  gazetteer_version: string;
  coordinate_reference_system: string;
  epoch: string;
  attribution: string[];
  counts: Record<string, number>;
  date_range: [string, string];
  day_range: [number, number];
  cards_bin: { count: number; stride_u32: number; fields: string[] };
  flags: { unresolvedParticipant: number; csvSource: number };
  coverage: { rowCoverage: number; cardCoverage: number; matchCoverage: number };
  precision_counts: Record<string, number>;
  checksums: Record<string, string>;
}

export interface GeoPlacesFile {
  count: number;
  id: string[];
  displayName: string[];
  city: (string | null)[];
  admin1: (string | null)[];
  country: (string | null)[];
  countryCode: (string | null)[];
  lat: number[];
  lon: number[];
  precision: string[];
  cards: number[];
  matches: number[];
  titleMatches: number[];
  titleChanges: number[];
  firstDay: number[];
  lastDay: number[];
  resolution: string[];
  confidence: number[];
  source: string[];
}

export interface GeoStringsFile {
  cardIds: string[];
  promotionIds: string[];
  promotionNames: string[];
  eventNames: string[];
}

export interface GeoQualityFile {
  byResolution: Record<string, { locations: number; cards: number; matches: number }>;
  precisionCounts: Record<string, number>;
  rowCoverage: number;
  cardCoverage: number;
  matchCoverage: number;
  plottedCards: number;
  unplottedCards: number;
  plottedMatches: number;
  unplottedMatches: number;
  totalCards: number;
  totalMatches: number;
  totalLocations: number;
  places: number;
  targets: { rows: number; cards: number; matches: number };
}

export interface GeoUnresolvedRow {
  locationKey: string;
  rawName: string;
  family: "sql" | "csv";
  resolution: string;
  cards: number;
  matches: number;
  firstDate: string;
  lastDate: string;
  notes: string[];
}

export interface SourceLocationRow {
  placeId: string | null;
  resolution: string;
  confidence: number;
  rung: string;
  reviewed: boolean;
  notes: string[];
  rawName: string;
  family: "sql" | "csv";
  cards: number;
  matches: number;
  venue?: string;
  city?: string;
  sourceLocationId?: number;
}

/** One projected card, decoded from cards.bin. */
export interface GeoCard {
  index: number;
  cardId: string;
  day: number;
  promotionIdx: number;
  placeIdx: number; // -1 when the source location is unresolved
  eventNameIdx: number;
  matchCount: number;
  personCount: number;
  titleMatchCount: number;
  titleChangeCount: number;
  unresolvedParticipant: boolean;
  csvSource: boolean;
}

export type GeoScopeKind =
  | "promotion"
  | "person"
  | "pair"
  | "championship"
  | "event"
  | "place"
  | "corpus";

export interface GeoScope {
  kind: GeoScopeKind;
  /** Canonical id(s) — a pair scope carries two. */
  ids: string[];
  label: string;
}

export type PlaybackUnit = "card" | "match" | "day";
export type ClockKind = "calendar" | "record";
export type HeatMetric = "cards" | "matches" | "people" | "titleMatches" | "titleChanges";

export type { GeoPlace };
