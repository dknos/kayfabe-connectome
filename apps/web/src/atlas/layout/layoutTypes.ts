import type { AtlasAxis, AtlasLabelSpec, AtlasQuad, RGB } from "@kayfabe/atlas-renderer";
import { QK } from "@kayfabe/atlas-renderer";
import { dayToDate } from "@kayfabe/graph-contract";

/**
 * Shared geometry for every ATLAS layout.
 *
 * One world-space vocabulary across all four states is what makes the morph
 * mean anything: WWE's rail is at the same X for the same years whether you
 * are looking at 571 promotions or at WWE alone, so watching it travel tells
 * you where WWE sits in history rather than just that something moved.
 */

/** Width of the full corpus range in world units. ~12.8 units per year over
 *  1947-2026, which is enough that a single card is still a real rectangle. */
export const TIME_W = 1000;

/** Lane pitch bounds. Height encodes documented volume, so a promotion with
 *  88,000 matches gets room for its title system and a three-card indie does
 *  not claim the same real estate — while still being represented. */
export const LANE_MIN = 6;
export const LANE_MAX = 20;

/** Vertical gap between grouping bands (decades, tiers). */
export const GROUP_GAP = 16;

/** Z layering. The rails material draws in buffer order, so these exist to
 *  make the ordering READABLE, and to give the tilted camera something to
 *  separate — a platform genuinely sits below the rail on it. */
/**
 * Z layering.
 *
 * Two jobs. It makes the draw ORDER readable, and under the tilted camera it
 * is the only thing that produces parallax — a pitched orthographic camera
 * shifts a point's screen Y by z·sin(θ), so with everything within a unit of
 * z=0 a 24° tilt was a vertical squash and nothing else. The scale here is
 * chosen against the lane pitch (6–20): a platform 8 units below its rail
 * separates visibly when tilted and costs nothing when flat.
 */
export const Z = {
  backdrop: -12,
  platform: -8,
  hist: -5,
  rail: 0,
  title: 5,
  reign: 8,
  dot: 10,
  ruler: 14,
  playhead: 18,
} as const;

/** Lane internals as fractions of the lane pitch. */
export const LANE = {
  platformHalf: 0.46,
  titleTop: 0.42,
  titleBottom: 0.06,
  railY: 0,
  histTop: -0.1,
  histBottom: -0.4,
} as const;

export type GroupMode = "decade" | "alpha" | "tier" | "firstYear";
export type SortMode = "volume" | "first" | "last" | "alpha" | "span";

export interface AtlasControls {
  group: GroupMode;
  sort: SortMode;
  /** Minimum documented matches for a promotion to get its own lane. Below it
   *  the promotion is still COUNTED and still reachable by search — it is
   *  folded into a stated residual band, never dropped. */
  minActivity: number;
  /** Minimum documented encounters for a relationship to be drawn. */
  relThreshold: number;
  showTitles: boolean;
  showWrestlers: boolean;
  showBundles: boolean;
  labels: "sparse" | "normal" | "dense";
  tilted: boolean;
}

export const DEFAULT_CONTROLS: AtlasControls = {
  group: "decade",
  sort: "volume",
  minActivity: 0,
  relThreshold: 6,
  showTitles: true,
  showWrestlers: true,
  showBundles: true,
  labels: "normal",
  tilted: false,
};

/** Label priority ladder. Documented here rather than scattered, because
 *  "which name survives a collision" is a product decision. */
export const PRIORITY = {
  selected: 1000,
  hovered: 900,
  breadcrumb: 850,
  playback: 800,
  pinned: 700,
  header: 600,
  /** Everything else ranks inside [0, 500) by documented volume. */
  activityBase: 0,
  activitySpan: 500,
} as const;

/**
 * Build the time axis.
 *
 * Ticks are chosen from the SPAN, not from the zoom, because the axis belongs
 * to the layout and the layout is what a screenshot and a URL restore. Zoom
 * changes which ticks survive collision, not which ticks exist.
 */
export function makeAxis(dayMin: number, dayMax: number, x0 = -TIME_W / 2, x1 = TIME_W / 2): AtlasAxis {
  const span = Math.max(1, dayMax - dayMin);
  const w = x1 - x0;
  const x = (day: number): number => x0 + ((day - dayMin) / span) * w;
  const dayAt = (px: number): number => dayMin + ((px - x0) / w) * span;

  const y0 = dayToDate(dayMin).getUTCFullYear();
  const y1 = dayToDate(dayMax).getUTCFullYear();
  const years = y1 - y0;
  // One tick per year is unreadable across 79 years and essential across 5.
  const step = years > 60 ? 5 : years > 24 ? 2 : 1;
  const ticks: AtlasAxis["ticks"] = [];
  const first = Math.ceil(y0 / step) * step;
  for (let yy = first; yy <= y1; yy += step) {
    const day = isoDay(yy);
    if (day < dayMin || day > dayMax) continue;
    ticks.push({ day, label: String(yy), major: yy % 10 === 0 });
  }
  return { dayMin, dayMax, x0, x1, x, dayAt, ticks };
}

/** Local day encoding, avoiding a Date parse per tick. */
function isoDay(year: number): number {
  return Math.round((Date.UTC(year, 0, 1) - Date.UTC(1900, 0, 1)) / 86400000);
}

/**
 * The axis for a FOCUSED state: the subject's own documented span, padded.
 *
 * The overview shares one corpus-wide axis because comparing 571 lanes is the
 * whole point of it. A single belt, promotion or career is a different
 * question, and holding it to the corpus axis spends 70% of the board on years
 * the subject did not exist — which is how a 61-reign lineage renders as a
 * 40-pixel smear. Zooming the axis to the subject keeps "X is the date" true
 * and makes the reigns legible.
 */
export function focusAxis(
  firstDay: number,
  lastDay: number,
  corpusMin: number,
  corpusMax: number,
): AtlasAxis {
  if (firstDay < 0 || lastDay < 0 || lastDay < firstDay) {
    return makeAxis(corpusMin, corpusMax);
  }
  const span = Math.max(365, lastDay - firstDay);
  const pad = Math.max(120, span * 0.05);
  return makeAxis(
    Math.max(corpusMin, firstDay - pad),
    Math.min(corpusMax, lastDay + pad),
  );
}

/** Decade label for a day, or "" when there is no dated record. */
export function decadeOf(day: number): number {
  return Math.floor(dayToDate(day).getUTCFullYear() / 10) * 10;
}

export function yearOf(day: number): number {
  return dayToDate(day).getUTCFullYear();
}

/** First day of a year, in the corpus day encoding. */
export function dayOfYear(year: number): number {
  return Math.round((Date.UTC(year, 0, 1) - Date.UTC(1900, 0, 1)) / 86400000);
}

/**
 * Greedy interval packing into rows.
 *
 * Two championships that never overlapped in time share a row; two that ran
 * concurrently do not. Rows are therefore a real reading of a promotion's
 * title SYSTEM — how many belts it ran at once — and not an arbitrary stack.
 *
 * Deterministic: input order decides ties, and callers sort before calling.
 */
export function packRows(
  items: { firstDay: number; lastDay: number }[],
  gap = 0,
): { rows: number[]; count: number } {
  const rowEnd: number[] = [];
  const rows = new Array<number>(items.length);
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const start = it.firstDay;
    let placed = -1;
    for (let r = 0; r < rowEnd.length; r++) {
      if (rowEnd[r]! + gap <= start) {
        placed = r;
        break;
      }
    }
    if (placed < 0) {
      placed = rowEnd.length;
      rowEnd.push(-Infinity);
    }
    rowEnd[placed] = Math.max(rowEnd[placed]!, it.lastDay);
    rows[i] = placed;
  }
  return { rows, count: rowEnd.length };
}

/** A quad spanning [dayA, dayB] on a lane, with a minimum world width so a
 *  single-day record is still a visible mark rather than nothing. */
export function spanQuad(
  key: string,
  axis: AtlasAxis,
  dayA: number,
  dayB: number,
  y: number,
  h: number,
  color: RGB,
  alpha: number,
  kind: AtlasQuad["kind"],
  z: number,
  pick?: string,
  minW = 0.6,
): AtlasQuad {
  const xa = axis.x(Math.max(axis.dayMin, Math.min(dayA, dayB)));
  const xb = axis.x(Math.min(axis.dayMax, Math.max(dayA, dayB)));
  const w = Math.max(minW, xb - xa);
  return { key, x: xa + w / 2, y, z, w, h, color, alpha, kind, pick };
}

export function label(
  key: string,
  x: number,
  y: number,
  z: number,
  text: string,
  priority: number,
  tone: AtlasLabelSpec["tone"],
  extra: Partial<AtlasLabelSpec> = {},
): AtlasLabelSpec {
  return { key, x, y, z, text, priority, tone, anchor: "left", ...extra };
}

/**
 * A lane's NAME, pinned to the left edge of the viewport.
 *
 * Anchoring it to a world X — the left end of the time axis — meant every
 * promotion label slid off screen the moment the reader panned into the 1990s,
 * which at 571 lanes is an unnavigable board. Only the Y is spatial: the name
 * tracks its lane vertically and stays readable horizontally.
 */
export function laneLabel(
  key: string,
  y: number,
  z: number,
  text: string,
  priority: number,
  tone: AtlasLabelSpec["tone"],
  extra: Partial<AtlasLabelSpec> = {},
): AtlasLabelSpec {
  return { key, x: 0, y, z, text, priority, tone, anchor: "left", pin: "left", ...extra };
}

/** Rank inside the ambient band, from a documented count. */
export function activityPriority(value: number, ceiling: number): number {
  if (value <= 0) return PRIORITY.activityBase;
  const t = Math.log1p(value) / Math.log1p(Math.max(1, ceiling));
  return PRIORITY.activityBase + Math.min(1, t) * PRIORITY.activitySpan;
}

/** Decade / era dividers and the year ruler, shared by every state. */
export function rulerQuads(
  axis: AtlasAxis,
  topY: number,
  bottomY: number,
  color: RGB,
): { quads: AtlasQuad[]; labels: AtlasLabelSpec[] } {
  const quads: AtlasQuad[] = [];
  const labels: AtlasLabelSpec[] = [];
  const h = Math.max(1, topY - bottomY);
  const midY = (topY + bottomY) / 2;
  for (const t of axis.ticks) {
    const x = axis.x(t.day);
    quads.push({
      key: `tick:${t.label}`,
      x,
      y: midY,
      z: Z.backdrop,
      w: t.major ? 0.9 : 0.35,
      h,
      color,
      alpha: t.major ? 0.16 : 0.07,
      kind: QK.DIVIDER,
    });
    labels.push({
      key: `year:${t.label}`,
      x,
      y: topY + 3,
      z: Z.ruler,
      text: t.label,
      priority: t.major ? PRIORITY.header + 20 : PRIORITY.header - 40,
      tone: "muted",
      anchor: "center",
    });
  }
  return { quads, labels };
}
