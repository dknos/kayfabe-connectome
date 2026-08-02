import type { RGB } from "./palette";

/**
 * Morph Lab renderer contract.
 *
 * A layout is a PURE function (corpus, selection, controls) → MorphLayoutResult.
 * The layout owns every world coordinate; the renderer owns none and invents
 * none. The renderer's job is one thing only: carry every node and every
 * active trace CONTINUOUSLY from where it is to where the layout says it
 * belongs. Identity is the corpus node index (stable for the app's lifetime)
 * plus string keys for traces, virtual chips, labels and regions.
 *
 * Node travel is GPU-interpolated: from/to buffer attributes and a single
 * uMorph uniform — there is no per-node CPU work during a transition, and a
 * retarget mid-flight is ONE bounded typed-array capture, never a snap.
 */

export type MorphMode =
  | "organic"
  | "loom"
  | "motherboard"
  | "career"
  | "lineage"
  | "h2h"
  | "orbit"
  | "rack";

/** Node roles, written into aRole and read back by emphasis and tests. */
export const MR = {
  BACKGROUND: 0,
  SELECTED: 1,
  OPPONENT: 2,
  PARTNER: 3,
  BATTLE_ROYAL: 4,
  MIXED: 5,
  PROMO_CONTEXT: 6,
  TITLE_CONTEXT: 7,
  HOLDER: 8,
  JUNCTION: 9,
  MEMBER: 10,
  /** Two-hop person reached through one or more displayed direct neighbours. */
  BRIDGE: 11,
} as const;
export type MorphRole = (typeof MR)[keyof typeof MR];

/** Layout-independent semantic priority written to aSemantic. Roles answer
 * where a node sits; these values answer why it is lit. Never derive one from
 * the other. */
export const ME = {
  AMBIENT: 0,
  ANCHOR: 1,
  PINNED: 2,
  MEMBER: 3,
  PATH: 4,
  HOVERED: 5,
  SELECTED: 6,
} as const;
export type MorphSemanticLevel = (typeof ME)[keyof typeof ME];

/** Trace kinds — canonical relationships and contextual links must never
 *  share a treatment (context is dashed / bus-shaped, never a match fiber). */
export const TK = {
  RELATION: 0, // canonical person-person, colour = relation blend
  CONTEXT_PROMO: 1, // dashed bus — documented appearances
  CONTEXT_TITLE: 2, // gold module link — documented holder/reign context
  BUS: 3, // aggregate bundle where individual traces exceed the cap
  ROUTE: 4, // career circuit route (luminous, wide)
  BRIDGE: 5, // two-hop supporting route; never selected-to-bridge direct evidence
} as const;
export type TraceKind = (typeof TK)[keyof typeof TK];

/** Fixed samples per trace — organic curve and routed trace are both sampled
 *  to exactly this many points so corresponding vertices interpolate. */
export const TRACE_SAMPLES = 24;

export interface MorphRoute {
  /** stable identity: relation traces use the edge pair key, context traces
   *  use `ctx:<from>:<to>` — a persisting key morphs, a new key fades in */
  key: string;
  /** flat xyz, length TRACE_SAMPLES*3 — the ORGANIZED (target) polyline */
  points: Float32Array;
  /** organic-state polyline for the same pair; when absent the renderer
   *  derives one from the endpoint nodes' from-positions */
  fromPoints?: Float32Array;
  color: RGB;
  width: number; // px
  alpha: number;
  kind: TraceKind;
  /** endpoints as corpus slot ids, for pulse resolution (-1 = none) */
  a: number;
  b: number;
  /** Optional canonical/virtual ids preserve endpoint identity when a route
   * touches a keyed virtual slot and therefore has no corpus slot index. */
  aId?: string;
  bId?: string;
}

export interface MorphLabel {
  key: string;
  x: number;
  y: number;
  z: number;
  text: string;
  priority: number;
  tone: "neutral" | "gold" | "promotion" | "person" | "muted" | "warn" | "ember" | "cyan";
  /** secondary line — relation category, counts; shown from medium zoom */
  sub?: string;
  /** third line — close-zoom detail (counts, spans); shown when zoomed close */
  detail?: string;
  badge?: string;
  force?: boolean;
  anchor?: "left" | "center";
  pick?: string;
  /** Optional explicit accessible copy. Defaults are derived from id/tone/text. */
  accessibleName?: string;
  /** Current topology role, for example "two-hop bridge". */
  roleDescription?: string;
}

/** Region quad kinds (backplanes, rails, shelves, gold modules, gaps). */
export const RK = {
  PLATE: 0,
  RAIL: 1, // rounded capsule rail / bus
  GOLD: 2, // gold module, sheen band
  TICK: 3, // hard rectangle: activity bars, playhead
  GRID: 4, // hairline
  HATCH: 5, // unrecorded gap — hatched, never called vacant
  OPEN: 6, // open-ended reign: right edge dissolves
  HEADER: 7, // region heading backplate, vertical gradient
} as const;
export type RegionKind = (typeof RK)[keyof typeof RK];

export interface MorphRegion {
  key: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  color: RGB;
  alpha: number;
  kind: RegionKind;
  param?: number;
  pick?: string;
}

export interface LayoutBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ?: number;
  maxZ?: number;
}

/** A chip for an entity with NO corpus node (406/571 promotions, 3,648/4,389
 *  titles). Virtual chips fade in place; they have no organic home to travel
 *  from. Slot assignment is keyed on `id` so a persisting chip morphs. */
export interface MorphVirtualNode {
  id: string;
  x: number;
  y: number;
  z: number;
  scale: number;
  opacity: number;
  color: RGB;
  role: MorphRole;
}

export type OrbitSector = "opposed" | "same-side" | "mixed" | "battle-royal-only";

export interface OrbitDirectDetail {
  id: string;
  index: number;
  name: string;
  sector: OrbitSector;
  strength: number;
  same: number;
  opposed: number;
  battleRoyal: number;
  titleRelated: number;
  firstDay: number | null;
  lastDay: number | null;
  angle: number;
  radius: number;
  band: number;
}

export interface OrbitBridgeSupportDetail {
  intermediaryId: string;
  intermediaryIndex: number;
  intermediaryName: string;
  strength: number;
  pathScore: number;
  displayed: boolean;
}

export interface OrbitBridgeDetail {
  id: string;
  index: number;
  name: string;
  score: number;
  routeCount: number;
  displayedRouteCount: number;
  strongestIntermediaryId: string;
  strongestIntermediaryName: string;
  angle: number;
  radius: number;
  band: number;
  supports: OrbitBridgeSupportDetail[];
}

export interface OrbitStats {
  directTotal: number;
  directDisplayed: number;
  bridgeTotal: number;
  bridgeDisplayed: number;
  bridgeRoutesDisplayed: number;
  bridgeRoutesOmitted: number;
  guideCount: number;
  tierReduced: boolean;
  dossierAvailable: boolean;
}

export interface OrbitDetails {
  selectedId: string;
  direct: OrbitDirectDetail[];
  bridges: OrbitBridgeDetail[];
}

export interface MorphLayoutResult {
  mode: MorphMode;
  /** flat xyz per corpus node — length = 3*count, every node gets a target */
  nodeTargets: Float32Array;
  nodeOpacity: Float32Array;
  nodeScale: Float32Array;
  nodeRole: Uint8Array;
  /** transition stagger per node, 0..1 fraction of the delay budget */
  nodeDelay: Float32Array;
  virtuals: MorphVirtualNode[];
  routes: MorphRoute[];
  labels: MorphLabel[];
  regions: MorphRegion[];
  bounds: LayoutBounds;
  /** opening frame when it should differ from the whole board */
  fitBounds?: LayoutBounds;
  /** entity id the camera anchors on (stays near its screen position) */
  anchorId: string | null;
  representedCount: number;
  expandedCount: number;
  /** honest degradation — trace caps, label caps, truncations. Never empty
   *  when something was bounded. */
  notes: string[];
  /** Orbit-only semantic report used by inspector, hover copy and QA. */
  orbitStats?: OrbitStats;
  orbitDetails?: OrbitDetails;
  /** Rich semantic alias retained for QA/inspection callers. */
  orbit?: OrbitDetails;
  /** linear day→x mapping when the mode has a time axis (playhead rides it) */
  timeAxis?: { dayMin: number; dayMax: number; x0: number; x1: number; y0: number; y1: number };
}

export interface MorphPickResult {
  id: string;
  kind: "node" | "virtual" | "region";
}

export type MorphPickSource = "canvas" | "touch" | "keyboard" | "programmatic";

/** Mutable read-only-at-the-boundary probe populated by MorphRenderer.pick. */
export interface MorphPickDiagnostic {
  id: string | null;
  source: MorphPickSource;
  /** Node slots plus interactive regions evaluated by this pick. */
  candidateCount: number;
  durationMs: number;
  normalizedDistance: number;
  depth: number;
  semanticPriority: number;
  layoutRole: number;
}

export type MorphTier = "high" | "medium" | "low";

export interface MorphQuality {
  pixelRatioCap: number;
  bloom: boolean;
  traceCap: number;
  labelCap: number;
}

export const MORPH_TIERS: Record<MorphTier, MorphQuality> = {
  high: { pixelRatioCap: 2, bloom: true, traceCap: 1400, labelCap: 150 },
  medium: { pixelRatioCap: 1.5, bloom: true, traceCap: 900, labelCap: 84 },
  low: { pixelRatioCap: 1, bloom: false, traceCap: 450, labelCap: 34 },
};

export interface MorphEmphasis {
  /** corpus slot index, -1 = none */
  selected: number;
  hovered: number;
  /** selected/hovered VIRTUAL chip ids (no corpus slot) */
  selectedId: string | null;
  hoveredId: string | null;
  pinned: readonly number[];
  virtualPinned?: readonly string[];
  pathNodes: readonly number[];
  /** Transient semantic relatives of the hovered entity (for example title
   * holders inside a promotion). They sit at path priority, above the active
   * population but below the hovered node itself. */
  hoverMembers?: readonly number[];
  /** Resolved semantic populations, independent of outgoing layout roles. */
  members: readonly number[];
  anchors: readonly number[];
  /** IDs which do not have a corpus slot may still have a live virtual slot in
   * the active organized structure. */
  virtualMembers: readonly string[];
  virtualAnchors: readonly string[];
  memberGroup: string;
  basis: string;
  caveat: string | null;
  coverageWarnings: readonly string[];
  /** dim background-role nodes. The app clears this while a rebuild is in
   *  flight — roles still belong to the OUTGOING layout, and dimming the
   *  incoming neighbourhood against them reads as flicker. */
  dimBackground: boolean;
}

/** Static per-corpus node data the renderer bakes once. */
export interface MorphGraphInput {
  count: number;
  /** flat xyz ORGANIC positions, already scaled to world units. The renderer
   *  copies this — the caller's array is never retained or mutated. */
  organic: Float32Array;
  color: Float32Array; // 3 per node
  type: Uint8Array; // 0 person, 1 promotion, 2 title
  organicScale: Float32Array; // per-node base size
  organicOpacity: Float32Array;
}

/** Transition timing (spec: total 800–1000 ms, staged by per-node delay). */
export const MORPH_MS = 920;
export const MORPH_REDUCED_MS = 190;
/** each element animates over this fraction of the timeline; delays occupy
 *  the rest, so everything lands together at raw progress 1 */
export const MORPH_WINDOW = 0.62;
export const MORPH_DELAY_MAX = 1 - MORPH_WINDOW;

/** quintic in-out — MUST match the GLSL copy in MorphNodes/MorphTraces and
 *  the camera flight so board and camera arrive together */
export const easeQuintic = (t: number): number =>
  t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;

/** per-element progress under the shared raw clock */
export const elementProgress = (raw: number, delay: number): number => {
  const t = (raw - delay * MORPH_DELAY_MAX) / MORPH_WINDOW;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
};
