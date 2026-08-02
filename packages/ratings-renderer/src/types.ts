import type { MorphView } from "@kayfabe/morph-renderer";

export type RatingMode = "promotions" | "promotion" | "career" | "title" | "compare";
export type RatingTier = "low" | "medium" | "high";
export type RatingQualityOverride = "auto" | RatingTier;

export const RATING_TIERS = {
  high: { exactCap: 18_000, laneCap: 48, labelCap: 126, pixelRatioCap: 2, pointSize: 3.5 },
  medium: { exactCap: 10_000, laneCap: 32, labelCap: 78, pixelRatioCap: 1.5, pointSize: 3 },
  low: { exactCap: 3_600, laneCap: 20, labelCap: 44, pixelRatioCap: 1.1, pointSize: 2.5 },
} as const;

/** A one- or two-match bin is inspectable evidence, not a supported trend. */
export const MIN_RATING_TREND_SAMPLES = 3;
export const ratingTrendEligible = (ratedCount: number): boolean =>
  Number.isInteger(ratedCount) && ratedCount >= MIN_RATING_TREND_SAMPLES;

export interface RatingBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface RatingLabel {
  key: string;
  text: string;
  sub?: string;
  x: number;
  y: number;
  z: number;
  priority: number;
  force?: boolean;
  tone: "lane" | "match" | "datum" | "tick" | "muted" | "negative";
  pick?: string;
  accessibleName?: string;
}

export interface RatingAggregateVisual {
  key: string;
  /** Promotion identity for promotion-backed bins; null for global/derived bins. */
  promotionId: string | null;
  startDay: number;
  endDay: number;
  x: number;
  z: number;
  width: number;
  maxHeight: number;
  medianHeight: number;
  /** Rated observations contributing to this aggregate's statistics/shape. */
  ratedCount: number;
  /** Source-rated numerator for a matching documented denominator, when one exists. */
  coverageRatedCount: number | null;
  totalCount: number;
  coverageBasis: "global-denominator" | "promotion-denominator" | "derived-context-no-denominator";
  min: number;
  median: number;
  mean: number;
  max: number;
  fourPlus: number;
  fivePlus: number;
  approximateCount: number;
  opacity: number;
}

export interface RatingCoverageCell {
  key: string;
  promotionId: string | null;
  x: number;
  z: number;
  width: number;
  totalCount: number;
  ratedCount: number;
  maxTotalInLane: number;
  opacity: number;
}

export interface RatingLaneVisual {
  id: string;
  name: string;
  z: number;
  /** Source-rated numerator for global/promotion coverage; otherwise the derived sample. */
  ratedCount: number;
  totalCount: number;
  visibleRatedCount: number;
  coverageBasis: "global-denominator" | "promotion-denominator" | "derived-context-no-denominator";
  selected: boolean;
}

/**
 * Every exact array is indexed by the immutable ratings projection row.
 * Hidden/capped rows retain identity with opacity=0; no layout can duplicate a
 * canonical match or quietly reuse an array slot for another match.
 */
export interface RatingLayout {
  generation: number;
  mode: RatingMode;
  scopeId: string | null;
  matchIds: readonly string[];
  positions: Float32Array;
  heights: Float32Array;
  scales: Float32Array;
  opacity: Float32Array;
  rating: Float32Array;
  required: Uint8Array;
  aggregates: RatingAggregateVisual[];
  coverage: RatingCoverageCell[];
  lanes: RatingLaneVisual[];
  labels: RatingLabel[];
  bounds: RatingBounds;
  dayRange: readonly [number, number];
  ratingRange: readonly [number, number];
  /** World units per one exact reported-rating unit. */
  ratingScale: number;
  visibleExactMatches: number;
  visibleAggregateBins: number;
  omittedPromotions: number;
  wantedLabels: number;
  notes: string[];
}

export type RatingPickKind = "match" | "aggregate" | "promotion";

export interface RatingPickResult {
  id: string;
  kind: RatingPickKind;
  instanceId: number;
  depth: number;
  normalizedDistance: number;
}

export type RatingPickSource = "instance-raycast" | "projected-fallback" | "aggregate-raycast" | "keyboard" | "programmatic";

export interface RatingPickDiagnostic {
  id: string | null;
  kind: RatingPickKind | null;
  source: RatingPickSource;
  candidateCount: number;
  durationMs: number;
  depth: number;
  normalizedDistance: number;
  instanceId: number;
  result: "hit" | "miss" | "suppressed-drag" | "suppressed-morph";
}

export interface RatingCoverageReport {
  totalDocumented: number;
  rated: number;
  coverage: number;
  visibleRailCells: number;
}

export interface RatingRendererInfo {
  drawCalls: number;
  triangles: number;
  points: number;
  geometries: number;
  textures: number;
  context: "ready" | "lost";
}

export interface RatingsQaSeam {
  mode: RatingMode;
  qualityTier: RatingTier;
  frameTimeMs: number;
  frameIntervalMs: number;
  rendererCpuMs: number;
  visibleExactMatches: number;
  visibleAggregateBins: number;
  omittedPromotions: number;
  shownLabels: number;
  wantedLabels: number;
  selectedMatchId: string | null;
  hoveredMatchId: string | null;
  activeThreshold: number;
  coverageStats: RatingCoverageReport;
  ratingRange: readonly [number, number];
  morphing: boolean;
  morphProgress: number;
  currentPositionOfMatch(id: string): [number, number, number] | null;
  lastPickDiagnostic: RatingPickDiagnostic;
  camera: MorphView;
  cameraSnapshot: MorphView;
  rendererInfo: RatingRendererInfo;
  screenshot(): string;
  fit(): void;
  focusSelection(): boolean;
}

export const easeRatingMorph = (t: number): number => {
  const q = Math.max(0, Math.min(1, t));
  return q < 0.5 ? 16 * q ** 5 : 1 - ((-2 * q + 2) ** 5) / 2;
};
