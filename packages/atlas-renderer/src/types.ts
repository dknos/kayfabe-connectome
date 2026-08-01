/**
 * The wire between a semantic layout and the ATLAS renderer.
 *
 * A layout is a PURE function of (data, controls, viewport) -> AtlasScene. It
 * owns every world coordinate; the renderer owns none of them and invents
 * none. That split is what makes the layouts unit-testable without a GPU, and
 * what makes "the same entity keeps its slot across a state change" possible:
 * two scenes are comparable because both are plain data keyed by stable ids.
 */

/** Which semantic state a scene is a rendering of. */
export type AtlasState = "overview" | "promotion" | "title" | "career";

/**
 * Quad treatments. The renderer has ONE instanced quad mesh; `kind` selects a
 * fragment treatment rather than a new draw call, because at overview scale
 * this corpus emits ~36,000 quads (571 promotion platforms, 4,389 title rails,
 * and a per-year activity bar for every promotion-year that has records).
 */
export const QK = {
  /** Promotion lane base — soft slab with a lit top edge; reads as extruded
   *  under the tilted camera without needing real geometry. */
  PLATFORM: 0,
  /** The promotion's documented span. Rounded caps. */
  RAIL: 1,
  /** A championship's documented span. Gold, rounded, slight sheen. */
  TITLE: 2,
  /** A closed reign: bright left edge (the documented change), rounded right. */
  REIGN: 3,
  /** A reign open at the corpus edge: the right edge fades out rather than
   *  ending, because the record stops — the reign does not. */
  REIGN_OPEN: 4,
  /** Hard rectangle: activity bars, year ticks, playhead. */
  TICK: 5,
  /** Era / decade divider. Alpha falls off at both ends. */
  DIVIDER: 6,
  /** An unrecorded gap in a lineage. Hatched, never called "vacant". */
  GAP: 7,
  /** Flat filled block with no rounding — zone backing, selection halo. */
  PLATE: 8,
} as const;
export type QuadKind = (typeof QK)[keyof typeof QK];

/** Dot shapes, mirroring the connectome's node vocabulary. */
export const DK = {
  PERSON: 0,
  PROMOTION: 1,
  TITLE: 2,
  /** A documented title holder, sitting on a lineage rail. */
  HOLDER: 3,
  /** A documented event on the timeline. */
  EVENT: 4,
} as const;
export type DotShape = (typeof DK)[keyof typeof DK];

export type RGB = [number, number, number];

/** One axis-aligned quad in world space. */
export interface AtlasQuad {
  /**
   * Stable identity across states. Two scenes that both contain `rail:pr:4140`
   * interpolate that quad from one to the other instead of destroying and
   * recreating it — which is the whole difference between a morph and a cut.
   */
  key: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  color: RGB;
  alpha: number;
  kind: QuadKind;
  /** Entity id this quad selects, if it is selectable at all. */
  pick?: string;
  /** Free per-kind scalar: sheen strength, hatch density, gradient bias. */
  param?: number;
}

export interface AtlasDot {
  key: string;
  x: number;
  y: number;
  z: number;
  /** World-space diameter. The shader converts to pixels and clamps, so a
   *  zoomed-in dot cannot become a supernova. */
  size: number;
  color: RGB;
  alpha: number;
  shape: DotShape;
  pick?: string;
}

/** A polyline in world space — career routes, lineage connectors, bundles. */
export interface AtlasPath {
  key: string;
  /** Flat x,y,z triples. */
  points: number[];
  color: RGB;
  alpha: number;
  width: number;
  pick?: string;
}

export type LabelTone =
  | "neutral"
  | "gold"
  | "promotion"
  | "person"
  | "muted"
  | "warn";

export interface AtlasLabelSpec {
  key: string;
  x: number;
  y: number;
  z: number;
  text: string;
  /** Higher wins a collision. The priority ladder lives in labelLayout.ts. */
  priority: number;
  tone: LabelTone;
  /** Drawn even when it collides — used for the selection and the breadcrumb
   *  context, which the reader explicitly asked to see. */
  force?: boolean;
  /** Second line, smaller: counts, spans, caveats. */
  sub?: string;
  /** Small pill after the text: title counts, source-artifact warnings. */
  badge?: string;
  /** "left" anchors the text to the world point (rails read left-to-right);
   *  "center" centres it (dots). */
  anchor?: "left" | "center";
  /**
   * Pin the label's X to the viewport edge, keeping only its world Y.
   *
   * A lane's NAME has to stay on screen while the lane's rail is panned off
   * it — which is most lanes, most of the time, at 571 of them. Anchoring the
   * name to a world X put every promotion label off the left edge the moment
   * the reader panned into the 1990s.
   */
  pin?: "left";
  pick?: string;
}

/** A horizontal band the reader can name: a promotion lane, a title lane, an
 * era band. Drives the minimap and the screen-reader description. */
export interface AtlasLane {
  key: string;
  label: string;
  /** World Y of the lane's spine. */
  y: number;
  /** World half-height of the lane's claim on the Y axis. */
  half: number;
  /** Group heading this lane sits under ("1980s", "WWE"), or "". */
  group: string;
  tone: LabelTone;
  /** World X extent of the lane's documented span, when it has one. The
   *  minimap draws these rather than full-width bars, so 571 lanes read as the
   *  shape of history instead of a solid block. */
  x0?: number;
  x1?: number;
  /** 0..1 documented activity, for the minimap's alpha. */
  weight?: number;
  pick?: string;
}

/** The time axis a scene was laid out against. */
export interface AtlasAxis {
  dayMin: number;
  dayMax: number;
  x0: number;
  x1: number;
  /** day -> world x */
  x(day: number): number;
  /** world x -> day */
  dayAt(x: number): number;
  ticks: { day: number; label: string; major: boolean }[];
}

/**
 * Everything the UI must be able to state out loud.
 *
 * Degradation is surfaced, never silent: a reader who sees 42 labels over
 * 571 promotions has to be told that is a label cap and not a promotion count.
 */
export interface AtlasSceneStats {
  represented: number;
  representedNoun: string;
  /** Filled by the label layer after collision suppression. */
  labelled: number;
  /** Non-empty when the layout deliberately bounded something. */
  notes: string[];
}

export interface AtlasScene {
  state: AtlasState;
  /** Reader-facing trail: ["All promotions", "WWE", "WWE Championship"]. */
  breadcrumbs: { id: string | null; label: string }[];
  quads: AtlasQuad[];
  dots: AtlasDot[];
  paths: AtlasPath[];
  labels: AtlasLabelSpec[];
  lanes: AtlasLane[];
  axis: AtlasAxis;
  /** Full extent of everything laid out — what the minimap and R frame. */
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /**
   * The region worth framing when this state OPENS, when that is not the whole
   * board. A promotion with 2,170 documented participants is thousands of
   * world units tall; fitting all of it renders the championships it exists to
   * show as a two-pixel smear at the top. The reader zooms out to the rest.
   */
  fitBounds?: { minX: number; maxX: number; minY: number; maxY: number };
  /** Entity id -> world point. Camera focus, pulse endpoints and the "flash
   *  this lane" affordance all resolve through this and nothing else. */
  anchors: Map<string, [number, number, number]>;
  stats: AtlasSceneStats;
}

export interface AtlasPickResult {
  id: string;
  kind: "quad" | "dot" | "path";
}
