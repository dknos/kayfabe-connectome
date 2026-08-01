/**
 * The seam between the geographic SCHEDULER (which decides what happened) and
 * the globe RENDERER (which decides how it looks).
 *
 * A `GeoPulseIntent` is a semantic record of a documented card, not a drawing
 * command. The renderer may aggregate several intents into one visual beacon
 * when they land on the same place in the same instant, but the analytical
 * counters upstream have already counted every one of them. Visual aggregation
 * must never subtract from an analytical total.
 */

/** One documented card, ready to light a place. */
export interface GeoPulseIntent {
  /** Index into the projected card table — the canonical identity. */
  cardIndex: number;
  cardId: string;
  day: number;
  promotionIdx: number;
  eventNameIdx: number;
  /** Index into the place table, or -1 when the source location is unresolved. */
  placeIdx: number;
  matchCount: number;
  personCount: number;
  titleMatchCount: number;
  titleChangeCount: number;
  unresolvedParticipant: boolean;
  /** Cards sharing a date form one batch; same-day cards never chain into a route. */
  batchId: number;
}

/** A canonical place, columnar in the wire format and rowed here. */
export interface GeoPlace {
  index: number;
  id: string;
  displayName: string;
  city: string | null;
  admin1: string | null;
  country: string | null;
  countryCode: string | null;
  latitude: number;
  longitude: number;
  precision: GeoPrecision;
  resolution: GeoResolution;
  confidence: number;
  source: string;
  cards: number;
  matches: number;
  titleMatches: number;
  titleChanges: number;
  firstDay: number;
  lastDay: number;
}

export type GeoResolution = "confirmed" | "probable" | "ambiguous" | "unresolved" | "rejected";
export type GeoPrecision = "venue" | "city" | "municipality" | "county" | "region" | "country";

/** What the renderer is asked to ignite this tick. */
export interface BeaconSpec {
  placeIdx: number;
  latitude: number;
  longitude: number;
  /** 0..1, derived from the active metric — never random. */
  energy: number;
  /** A documented title change on one of the constituent cards. */
  gold: boolean;
  /** How many cards this one beacon stands for (>1 means aggregated). */
  cardCount: number;
  label?: string;
}

export interface ArcSpec {
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  /** 0..1 — fades with age so old record connections retire. */
  strength: number;
}

export type AfterglowMode = "none" | "short" | "long" | "accumulate" | "window";
export type CameraMode = "world" | "follow" | "tour" | "region" | "free" | "smart";
export type QualityTier = "high" | "medium" | "low";

export interface GeoRendererStats {
  /** Primitive-level counts — what the GPU is actually carrying. */
  beaconsActive: number;
  ringsActive: number;
  columnsActive: number;
  arcsActive: number;
  labelsActive: number;
  heatPoints: number;
  /** Lifecycle counters — a leak shows up here as created > destroyed + 1. */
  viewersCreated: number;
  viewersDestroyed: number;
  webglContexts: number;
  /** Renderer-side accounting. `intentsDropped` must stay 0: the renderer may
   * GROUP intents (aggregating their energy into one beacon) but never discard
   * one, because the inspector reads the constituent card list back out. */
  intentsReceived: number;
  intentsGrouped: number;
  intentsDropped: number;
  frameMs: number;
  tier: QualityTier;
}
