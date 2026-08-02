import type { RatingLayout, RatingMode, RatingTier } from "@kayfabe/ratings-renderer";
import type { RatingsData } from "../ratingsLoader";

export const RATING_WORLD = {
  xMin: -560,
  xMax: 560,
  ratingScale: 42,
  laneGap: 42,
  selectedLaneGap: 58,
  yearGapBreak: 1,
} as const;

export type RatingLaneOrder =
  | "stable"
  | "rated"
  | "total"
  | "coverage"
  | "median"
  | "mean"
  | "fourPlus"
  | "fivePlus"
  | "maximum"
  | "alphabetical";

export type RatingFormFilter = "all" | "singles" | "tag_team" | "multi_way" | "battle_royal" | "team_implied" | "unknown";

export interface RatingFilters {
  ratingMin: number;
  ratingMax: number;
  promotionId: string | null;
  form: RatingFormFilter;
  ppvOnly: boolean;
  titleMatchOnly: boolean;
  titleChangeOnly: boolean;
  includeExactDates: boolean;
  includeApproximateDates: boolean;
  coverageMinimum: number;
}

export interface RatingControlsState {
  threshold: number;
  laneOrder: RatingLaneOrder;
  showTrend: boolean;
  showExact: boolean;
  showAggregates: boolean;
  context: number;
  filters: RatingFilters;
}

export interface RatingScope {
  mode: RatingMode;
  id: string | null;
  compareA?: string | null;
  compareB?: string | null;
}

export interface RatingStats {
  ratedMatches: number;
  coverageRatedMatches: number;
  totalDocumentedMatches: number;
  coverage: number;
  coverageBoundaryApproximate: boolean;
  /** Compare denominators count each side's documented exposure separately. */
  coverageAccounting: "unique-matches" | "subject-exposures";
  promotions: number;
  wrestlers: number;
  median: number | null;
  mean: number | null;
  maximum: number | null;
  minimum: number | null;
  fourPlus: number;
  fivePlus: number;
  approximateDates: number;
  displayedMatches: number;
  omittedMatches: number;
  displayedLanes: number;
  omittedLanes: number;
  dateSpan: readonly [number, number] | null;
}

export interface RatingLayoutBuildInput {
  data: RatingsData;
  scope: RatingScope;
  controls: RatingControlsState;
  dayMin: number;
  dayMax: number;
  tier: RatingTier;
  selectedMatchId: string | null;
  hoveredMatchId: string | null;
  currentMatchId: string | null;
  pinnedMatchIds: readonly string[];
  requiredPromotionIds: readonly string[];
  generation: number;
}

export interface RatingLayoutBuildResult {
  layout: RatingLayout;
  stats: RatingStats;
  visibleExactIndices: number[];
  scopeExactIndices: number[];
  scopeLabel: string;
}

export const DEFAULT_RATING_CONTROLS: RatingControlsState = {
  threshold: 5,
  laneOrder: "stable",
  showTrend: true,
  showExact: true,
  showAggregates: true,
  context: 0.42,
  filters: {
    ratingMin: -1,
    ratingMax: 7,
    promotionId: null,
    form: "all",
    ppvOnly: false,
    titleMatchOnly: false,
    titleChangeOnly: false,
    includeExactDates: true,
    includeApproximateDates: true,
    coverageMinimum: 0,
  },
};
