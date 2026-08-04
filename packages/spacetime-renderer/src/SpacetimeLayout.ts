/**
 * Source geometry for the warp field — pure functions, no three.js.
 *
 * Everything is laid out in (day, y, z) space: day becomes world X only
 * through the timeAxisX lens, per-vertex on the GPU for ribbons and per-event
 * on the CPU for beads, so the bubble can travel without a layout rebuild.
 *
 * The visual grammar (docs/SPACETIME_WARP_FIELD.md):
 *   Y band     relationship family — opponents above the subject's worldline,
 *              partners below, mixed alternating nearest the line (they carry
 *              both kinds of evidence), battle-royal co-presence outermost and
 *              faint. Distance from the centre = documented relevance rank.
 *   Z region   dominant shared promotion, one sector per promotion the
 *              subject's history actually touches (documented appearance,
 *              never employment).
 *   Fade       a worldline visibly dissolves across undocumented gaps longer
 *              than GAP_DISSOLVE_DAYS — geometry must not imply activity the
 *              corpus does not record. The subject's own line obeys the same
 *              rule; the Sydal/Bourne merge is what makes his WWE years
 *              continuous, and the persona attribute says who competed.
 */
import {
  GAP_DISSOLVE_DAYS, SC,
  type SpacetimeClass, type SpacetimeRelationship, type SpacetimeScope,
} from "./types";

/** floats per worldline sample: day, y, z, fade, dash, persona, restY, restZ.
 *  (y, z) is the fully-converged position at this sample; (restY, restZ) is
 *  the line's resting lane. The renderer blends between them with the SAME
 *  tanh focus field that drives the time axis, so convergence dips articulate
 *  as the bubble arrives and distant history stays a calm lane — the lens is
 *  focus-and-context for geometry, not just for spacing. */
export const SAMPLE_STRIDE = 8;

export interface WorldlinePath {
  /** -1 for the subject's own line; else index into scope.relationships */
  relIndex: number;
  cls: SpacetimeClass;
  /** SAMPLE_STRIDE floats per sample; fade 0 at dissolved ends */
  samples: Float32Array;
  laneY: number;
  laneZ: number;
}

export interface SpacetimeSector {
  pr: string;
  n: string;
  dayFrom: number;
  dayTo: number;
  z: number;
  count: number;
}

export interface SpacetimeLayoutResult {
  lines: WorldlinePath[];
  sectors: SpacetimeSector[];
  /** decade tick days (Jan 1 of each decade inside the range) */
  decades: number[];
  drawnWorldlines: number;
  /** documented relationships beyond the tier budget — reported, never lost */
  hiddenWorldlines: number;
  /** max |y| and |z| actually used, for camera framing */
  extentY: number;
  extentZ: number;
  dayRange: [number, number];
  layoutMs: number;
  notes: string[];
}

const LANE_BASE_MIXED = 1.5;
const LANE_BASE = 2.6;
/** rank spacing is sqrt-compressed: the strongest relationships get readable
 *  separation near the centre and the long tail packs instead of building a
 *  wall of empty lanes (150 linear steps put the outermost line at |y|=65). */
const LANE_SPREAD = 1.15;
const LANE_Z_STEP = 2.4;
const SECTOR_CAP = 8;
/** worldline pulled this close to the centre at a shared match */
const CONVERGE_Y = 0.34;
/** days on either side of a shared match spent approaching the centre */
const CONVERGE_DAYS = 45;
/** lead-in/out beyond a line's first/last documented day */
const TAIL_DAYS = 120;

export function classOf(r: SpacetimeRelationship): SpacetimeClass {
  if (r.same > 0 && r.opposed > 0) return SC.MIXED;
  if (r.same > 0) return SC.SAME;
  if (r.opposed > 0) return SC.OPPOSED;
  return SC.BR;
}

export function buildLayout(
  scope: SpacetimeScope,
  worldlineBudget: number,
  notesIn: string[] = [],
): SpacetimeLayoutResult {
  const t0 = performance.now();
  const notes = [...notesIn];
  const events = scope.events;
  const dayRange: [number, number] = scope.dayRange;

  // ---- one pass over events: shared days + promo votes per node index
  const sharedDays = new Map<number, number[]>();
  const promoVotes = new Map<number, Map<number, number>>();
  for (const e of events) {
    for (const arr of [e.same, e.opposed]) {
      for (let i = 0; i < arr.length; i++) {
        const idx = arr[i]!;
        let days = sharedDays.get(idx);
        if (!days) sharedDays.set(idx, days = []);
        days.push(e.day);
        let votes = promoVotes.get(idx);
        if (!votes) promoVotes.set(idx, votes = new Map());
        votes.set(e.promoIdx, (votes.get(e.promoIdx) ?? 0) + 1);
      }
    }
  }

  // ---- promotion sectors: the subject's strongest promotions, capped, with
  // the overflow folded into a shared "elsewhere" depth rather than dropped.
  const sectors: SpacetimeSector[] = [];
  const sectorZ = new Map<string, number>();
  for (let i = 0; i < Math.min(SECTOR_CAP, scope.promos.length); i++) {
    const p = scope.promos[i]!;
    const z = -(i + 1) * LANE_Z_STEP;
    sectorZ.set(p.pr, z);
    sectors.push({ pr: p.pr, n: p.n, dayFrom: p.firstDay, dayTo: p.lastDay, z, count: p.count });
  }
  const elsewhereZ = -(sectors.length + 1) * LANE_Z_STEP;
  if (scope.promos.length > SECTOR_CAP) {
    notes.push(`${scope.promos.length - SECTOR_CAP} further promotions share the outermost sector`);
  }
  const promoZByIdx = new Map<number, number>();
  // promoIdx (dictionary index) -> z, via the subject's promos list order.
  // scope.promos entries carry pr ids; the adapter maps promoIdx -> pr id.
  // Layout receives that mapping through scope.events' promoIdx + a parallel
  // list the adapter provides on promos (see promoIdxOf below).

  // ---- rank relationships within their band; strongest sit nearest
  const ranked = scope.relationships.map((r, i) => ({ r, i, cls: classOf(r) }));
  const drawn = ranked.slice(0, worldlineBudget);
  const hidden = ranked.length - drawn.length;
  if (hidden > 0) notes.push(`${hidden} documented relationships beyond the drawn budget`);

  const bandRank: Record<number, number> = { [SC.OPPOSED]: 0, [SC.SAME]: 0, [SC.MIXED]: 0, [SC.BR]: 0 };
  let extentY = 0, extentZ = 0;
  const lines: WorldlinePath[] = [];

  // The subject's own worldline first: every documented event, gap rule applied.
  lines.push(buildPath(-1, SC.CENTER, events.map((e) => e.day), 0, 0,
    events.map((e) => e.persona)));

  for (const { r, i, cls } of drawn) {
    const rank = bandRank[cls]!++;
    let laneY: number;
    if (cls === SC.MIXED) {
      // Mixed carries both kinds of evidence: nearest the line, alternating.
      laneY = (rank % 2 === 0 ? 1 : -1)
        * (LANE_BASE_MIXED + Math.sqrt(Math.floor(rank / 2)) * LANE_SPREAD * 0.8);
    } else if (cls === SC.SAME) {
      laneY = -(LANE_BASE + Math.sqrt(rank) * LANE_SPREAD);
    } else if (cls === SC.OPPOSED) {
      laneY = LANE_BASE + Math.sqrt(rank) * LANE_SPREAD;
    } else {
      laneY = LANE_BASE + Math.sqrt(bandRank[SC.OPPOSED]! + rank + 4) * LANE_SPREAD + 1.2;
    }
    // Dominant shared promotion decides depth; unheard-of promos share a lane.
    const votes = promoVotes.get(r.nodeIdx);
    let laneZ = elsewhereZ;
    if (votes) {
      let best = -1, bestN = 0;
      for (const [pIdx, n] of votes) {
        if (n > bestN || (n === bestN && (best === -1 || pIdx < best))) { best = pIdx; bestN = n; }
      }
      laneZ = promoZByIdx.get(best) ?? sectorZFromIdx(best, scope, sectorZ, elsewhereZ, promoZByIdx);
    }
    const days = sharedDays.get(r.nodeIdx) ?? [];
    lines.push(buildPath(i, cls, days, laneY, laneZ));
    extentY = Math.max(extentY, Math.abs(laneY));
    extentZ = Math.max(extentZ, Math.abs(laneZ));
  }

  // ---- decade ticks
  const decades: number[] = [];
  const startYear = Math.ceil((1900 + dayRange[0] / 365.25) / 10) * 10;
  const endYear = 1900 + dayRange[1] / 365.25;
  for (let y = startYear; y <= endYear; y += 10) {
    decades.push(Math.round((Date.UTC(y, 0, 1) - Date.UTC(1900, 0, 1)) / 86400000));
  }

  return {
    lines, sectors, decades,
    drawnWorldlines: drawn.length,
    hiddenWorldlines: hidden,
    extentY: Math.max(extentY, LANE_BASE),
    extentZ: Math.max(extentZ, LANE_Z_STEP),
    dayRange,
    layoutMs: performance.now() - t0,
    notes,
  };
}

/** Resolve a dictionary promoIdx to a sector depth through the scope's promo
 *  list (which the adapter builds with promoIdx attached). Falls back to the
 *  shared outermost sector — context, never a claim. */
function sectorZFromIdx(
  promoIdx: number, scope: SpacetimeScope, sectorZ: Map<string, number>,
  elsewhereZ: number, cache: Map<number, number>,
): number {
  const promo = (scope.promos as ({ pr: string; promoIdx?: number })[])
    .find((p) => p.promoIdx === promoIdx);
  const z = promo ? (sectorZ.get(promo.pr) ?? elsewhereZ) : elsewhereZ;
  cache.set(promoIdx, z);
  return z;
}

/**
 * One worldline's samples from its documented days.
 *
 * Between events the line rests in its lane; within CONVERGE_DAYS of a shared
 * match it approaches the centre and touches down at the exact date. Gaps
 * longer than GAP_DISSOLVE_DAYS dissolve: fade ramps to 0, the dash channel
 * marks the span, and no sample pretends to be documented activity.
 */
export function buildPath(
  relIndex: number, cls: SpacetimeClass, daysIn: number[],
  laneY: number, laneZ: number, personas?: number[],
): WorldlinePath {
  const order = daysIn.map((_, i) => i).sort((a, b) => daysIn[a]! - daysIn[b]!);
  const days = order.map((i) => daysIn[i]!);
  const personaOf = (k: number): number => (personas ? personas[order[k]!] ?? 0 : 0);
  const pts: number[] = [];
  const push = (day: number, y: number, z: number, fade: number, dash: number, persona: number): void => {
    pts.push(day, y, z, fade, dash, persona, laneY, laneZ);
  };
  if (days.length === 0) {
    return { relIndex, cls, samples: new Float32Array(0), laneY, laneZ };
  }
  const center = relIndex === -1;
  const touchY = center ? 0 : Math.sign(laneY || 1) * CONVERGE_Y;
  const touchZ = center ? 0 : laneZ * 0.12;

  push(days[0]! - TAIL_DAYS, laneY, laneZ, 0, 0, personaOf(0));
  for (let k = 0; k < days.length; k++) {
    const d = days[k]!;
    const persona = personaOf(k);
    const prev = k > 0 ? days[k - 1]! : -Infinity;
    const next = k < days.length - 1 ? days[k + 1]! : Infinity;
    // Approach only across room the neighbours leave free.
    const inGap = Math.min(CONVERGE_DAYS, Math.max(8, (d - prev) / 2));
    const outGap = Math.min(CONVERGE_DAYS, Math.max(8, (next - d) / 2));
    if (Number.isFinite(prev) && d - prev > GAP_DISSOLVE_DAYS) {
      // Dissolve across the undocumented span: down at the last record,
      // back up just before this one. dash=1 marks the unrecorded interval.
      push(prev + TAIL_DAYS, laneY, laneZ, 0, 1, personaOf(k - 1));
      push(d - TAIL_DAYS, laneY, laneZ, 0, 1, persona);
    } else if (Number.isFinite(prev) && d - prev > 2 * CONVERGE_DAYS) {
      push((prev + d) / 2, laneY, laneZ, 1, 0, persona);
    }
    if (!center) push(d - inGap, laneY, laneZ, 1, 0, persona);
    push(d, touchY, touchZ, 1, 0, persona);
    if (!center) push(d + outGap, laneY, laneZ, 1, 0, persona);
  }
  const lastPersona = personaOf(days.length - 1);
  push(days[days.length - 1]! + TAIL_DAYS, laneY, laneZ, 0, 0, lastPersona);
  return { relIndex, cls, samples: new Float32Array(pts), laneY, laneZ };
}
