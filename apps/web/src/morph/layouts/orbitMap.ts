import {
  M,
  MR,
  RK,
  TK,
  TRACE_SAMPLES,
  relationColor,
  rgb,
  type MorphLabel,
  type MorphLayoutResult,
  type MorphRegion,
  type MorphRole,
  type MorphRoute,
  type MorphTier,
  type MorphVirtualNode,
  type OrbitBridgeDetail,
  type OrbitBridgeSupportDetail,
  type OrbitDetails,
  type OrbitDirectDetail,
  type OrbitSector,
  type OrbitStats,
} from "@kayfabe/morph-renderer";
import { dayToDate, pairKey, type PersonDossier } from "@kayfabe/graph-contract";
import type { MorphData, NeighborRel } from "../morphAdapter";
import { PRIORITY, emptyBounds, growBounds, type MorphControlsState } from "./layoutTypes";
import { packBackground } from "./backgroundRack";
import { sampleOrganicBow, sampleSpatialCurve } from "./routing";

/**
 * Orbit Map's only quantitative edge measure.
 *
 * Ordinary opposed/same-side matches carry full weight. Battle-royal contact
 * is real match evidence but is down-weighted because one match can produce a
 * very large field of incidental pair contacts. Title context is deliberately
 * excluded: it may explain a relationship, but it can never create one.
 */
export function relationshipStrength(relation: Pick<NeighborRel, "same" | "opposed" | "br">): number {
  return finiteCount(relation.same) + finiteCount(relation.opposed) + finiteCount(relation.br) * 0.35;
}

/** A direct relationship's stable angular sector. */
export function classifyDirectRelationship(
  relation: Pick<NeighborRel, "same" | "opposed" | "br">,
): OrbitSector | null {
  const same = finiteCount(relation.same);
  const opposed = finiteCount(relation.opposed);
  const battleRoyal = finiteCount(relation.br);
  if (same > 0 && opposed > 0) return "mixed";
  if (opposed > 0) return "opposed";
  if (same > 0) return "same-side";
  if (battleRoyal > 0) return "battle-royal-only";
  return null;
}

export interface OrbitBudget {
  direct: number;
  bridge: number;
  bridgeRoutes: number;
  context: number;
}

export interface OrbitBuildOptions {
  tier: MorphTier;
  /** Global renderer cap; Orbit's semantic route budgets remain stricter. */
  traceCap: number;
  requiredIds?: readonly string[];
}

export const ORBIT_BUDGETS: Record<MorphTier, OrbitBudget> = {
  // Corpus measurement showed that 260 simultaneous bridge connectors made
  // dense high-tier Orbits read as a woven wall. Keep all 160 ranked bridge
  // people, but route only the strongest 200 supported paths.
  high: { direct: 120, bridge: 160, bridgeRoutes: 200, context: 14 },
  medium: { direct: 80, bridge: 96, bridgeRoutes: 150, context: 10 },
  low: { direct: 48, bridge: 48, bridgeRoutes: 80, context: 7 },
};

const DIRECT_Z = 0;
const BRIDGE_Z = -125;
const CORE_Z = 40;
const DIRECT_RADIUS = 245;
const DIRECT_BAND_GAP = 74;
const BRIDGE_RADIUS = 525;
const BRIDGE_BAND_GAP = 82;
const MIN_DIRECT_ANGLE = 0.105;
const MIN_BRIDGE_ANGLE = 0.085;
const RELAX_ITERATIONS = 12;

interface DirectRecord extends OrbitDirectDetail {
  relation: NeighborRel;
}

interface BridgeSupport extends OrbitBridgeSupportDetail {
  relation: NeighborRel;
}

interface BridgeRecord extends OrbitBridgeDetail {
  supports: BridgeSupport[];
}

interface RouteCandidate {
  bridge: BridgeRecord;
  support: BridgeSupport;
}

export type OrbitLayoutResult = MorphLayoutResult & {
  orbit: OrbitDetails;
  orbitStats: OrbitStats;
  orbitDetails: OrbitDetails;
};

/**
 * Pure, bounded Orbit topology. The builder reads only materialized adjacency;
 * it owns no store state, network work, random simulation, or mutable cache.
 */
export function buildOrbitMap(
  data: MorphData,
  selectedId: string,
  dossier: PersonDossier | null,
  titleNameOf: (id: string) => string | null,
  controls: MorphControlsState,
  optionsOrTier: OrbitBuildOptions | MorphTier,
  legacyRequiredIds: readonly string[] = [],
): OrbitLayoutResult {
  const selectedIndex = data.indexOf(selectedId);
  if (selectedIndex === undefined) throw new Error(`orbit map: ${selectedId} has no corpus node`);
  if (data.model.nodes.type[selectedIndex] !== 0) throw new Error(`orbit map: ${selectedId} is not a person node`);

  const count = data.count;
  // The object form is the public contract; accepting the earlier tier/ids
  // pair keeps in-flight integration and older callers source-compatible.
  const options: OrbitBuildOptions = typeof optionsOrTier === "string"
    ? { tier: optionsOrTier, traceCap: Number.MAX_SAFE_INTEGER, requiredIds: legacyRequiredIds }
    : optionsOrTier;
  const tier = options.tier;
  const budget = ORBIT_BUDGETS[tier];
  const nodeTargets = new Float32Array(count * 3);
  const nodeOpacity = new Float32Array(count);
  const nodeScale = new Float32Array(count);
  const nodeRole = new Uint8Array(count);
  const nodeDelay = new Float32Array(count);
  const routes: MorphRoute[] = [];
  const labels: MorphLabel[] = [];
  const regions: MorphRegion[] = [];
  const virtuals: MorphVirtualNode[] = [];
  const notes: string[] = [];
  const exclude = new Set<number>([selectedIndex]);
  const active = emptyBounds();
  let minZ = Infinity;
  let maxZ = -Infinity;
  const grow3 = (x: number, y: number, z: number, pad = 0) => {
    growBounds(active, x, y, pad);
    minZ = Math.min(minZ, z - pad);
    maxZ = Math.max(maxZ, z + pad);
  };

  const required = new Set(options.requiredIds ?? []);
  const allDirect = data.relationsOf(selectedIndex)
    .filter((relation) =>
      relation.index !== selectedIndex &&
      data.model.nodes.type[relation.index] === 0 &&
      classifyDirectRelationship(relation) !== null &&
      relationshipStrength(relation) > 0,
    )
    .sort(compareDirectRelation);
  const shownRelations = withRequiredBeyondCap(allDirect, budget.direct, required);
  addRequiredBridgeIntermediaries(data, selectedId, selectedIndex, allDirect, shownRelations, required);
  shownRelations.sort(compareDirectRelation);
  if (allDirect.length > shownRelations.length) {
    notes.push(`${shownRelations.length} of ${allDirect.length} documented direct relationships displayed at ${tier} quality`);
  }
  if (shownRelations.length > budget.direct) {
    notes.push(`${shownRelations.length - budget.direct} semantically required direct relationships displayed beyond the ${tier} quality budget`);
  }

  const direct = placeDirect(shownRelations);
  const directIds = new Set(allDirect.map((record) => record.id));
  const bridgeMap = new Map<string, BridgeRecord>();
  for (const intermediary of direct) {
    for (const candidateEdge of data.relationsOf(intermediary.index)) {
      if (
        candidateEdge.index === selectedIndex ||
        candidateEdge.index === intermediary.index ||
        data.model.nodes.type[candidateEdge.index] !== 0 ||
        directIds.has(candidateEdge.id) ||
        classifyDirectRelationship(candidateEdge) === null
      ) continue;
      const candidateStrength = relationshipStrength(candidateEdge);
      if (!(candidateStrength > 0)) continue;
      const pathScore = Math.sqrt(intermediary.strength * candidateStrength);
      if (!Number.isFinite(pathScore) || pathScore <= 0) continue;
      let bridge = bridgeMap.get(candidateEdge.id);
      if (!bridge) {
        bridge = {
          id: candidateEdge.id,
          index: candidateEdge.index,
          name: candidateEdge.name,
          score: 0,
          routeCount: 0,
          displayedRouteCount: 0,
          strongestIntermediaryId: intermediary.id,
          strongestIntermediaryName: intermediary.name,
          angle: 0,
          radius: BRIDGE_RADIUS,
          band: 0,
          supports: [],
        };
        bridgeMap.set(candidateEdge.id, bridge);
      }
      bridge.score += pathScore;
      bridge.supports.push({
        intermediaryId: intermediary.id,
        intermediaryIndex: intermediary.index,
        intermediaryName: intermediary.name,
        strength: candidateStrength,
        pathScore,
        displayed: false,
        relation: candidateEdge,
      });
    }
  }

  const allBridges = [...bridgeMap.values()];
  for (const bridge of allBridges) {
    bridge.supports.sort(compareSupport);
    bridge.routeCount = bridge.supports.length;
    const strongest = bridge.supports[0]!;
    bridge.strongestIntermediaryId = strongest.intermediaryId;
    bridge.strongestIntermediaryName = strongest.intermediaryName;
    bridge.angle = weightedCircularMean(
      bridge.supports.map((support) => ({
        angle: direct.find((item) => item.id === support.intermediaryId)!.angle,
        weight: support.pathScore,
      })),
    );
  }
  allBridges.sort(compareBridge);
  // A displayed bridge must retain at least one visible intermediary route.
  // Under an unusually small external trace cap, reduce the bridge population
  // before placement instead of leaving unsupported nodes on the outer ring.
  const availableBridgeRouteBudget = Math.max(
    0,
    Math.min(budget.bridgeRoutes, Math.floor(options.traceCap) - shownRelations.length - budget.context * 2 - 2),
  );
  const shownBridges = withRequiredBeyondCap(
    allBridges,
    Math.min(budget.bridge, availableBridgeRouteBudget),
    required,
  );
  placeBridges(shownBridges);
  if (allBridges.length > shownBridges.length) {
    notes.push(`${shownBridges.length} of ${allBridges.length} two-hop bridge candidates displayed at ${tier} quality`);
  } else if (shownBridges.length > budget.bridge) {
    notes.push(`${shownBridges.length - budget.bridge} supported, semantically required bridge people displayed beyond the ${tier} quality budget`);
  }
  const activePersonIds = new Set([selectedId, ...direct.map((item) => item.id), ...shownBridges.map((item) => item.id)]);
  const unsupportedRequiredPeople = [...required].filter((id) => {
    const index = data.indexOf(id);
    return index !== undefined && data.model.nodes.type[index] === 0 && !activePersonIds.has(id);
  });
  if (unsupportedRequiredPeople.length > 0) {
    notes.push(`${unsupportedRequiredPeople.length} pinned or path person${unsupportedRequiredPeople.length === 1 ? " remains" : "s remain"} ambient context because no supported one-hop or two-hop Orbit placement exists`);
  }

  const directMax = Math.max(1, ...direct.map((item) => item.strength));
  for (const [order, item] of direct.entries()) {
    const normalized = Math.log1p(item.strength) / Math.log1p(directMax);
    const { x, y } = polar(item.radius, item.angle);
    setCorpusNode(item.index, x, y, DIRECT_Z, 3 + normalized * 3.2, 0.55 + normalized * 0.4,
      roleForSector(item.sector), 0.08 + 0.36 * (order / Math.max(1, direct.length - 1)),
      nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, exclude);
    grow3(x, y, DIRECT_Z, 20);
    const relation = item.relation;
    labels.push({
      key: `n:${item.id}`,
      x, y: y + 11, z: DIRECT_Z,
      text: item.name,
      sub: `${sectorLabel(item.sector)} · opposed ×${relation.opposed} · same-side ×${relation.same} · battle royal ×${relation.br}`,
      detail: `${dateSpan(relation.firstDay, relation.lastDay)} · strength ${formatStrength(item.strength)}`,
      priority: PRIORITY.neighborBase + PRIORITY.neighborSpan * (1 - order / Math.max(1, direct.length)),
      tone: toneForSector(item.sector),
      pick: item.id,
    });
    routes.push({
      key: pairKey(selectedId, item.id),
      points: sampleSpatialCurve(0, 0, CORE_Z, x, y, DIRECT_Z, 8 + (order % 7) * 2, selectedIndex * 131 + item.index),
      fromPoints: organicRoute(data, selectedIndex, item.index, item.index * 31 + selectedIndex),
      color: relationColor(relation.same, relation.opposed, relation.br, relation.title),
      width: 0.75 + normalized * 1.55,
      alpha: 0.14 + normalized * 0.28,
      kind: TK.RELATION,
      a: selectedIndex,
      b: item.index,
    });
  }

  const bridgeMax = Math.max(1, ...shownBridges.map((item) => item.score));
  for (const [order, bridge] of shownBridges.entries()) {
    const normalized = Math.log1p(bridge.score) / Math.log1p(bridgeMax);
    const { x, y } = polar(bridge.radius, bridge.angle);
    setCorpusNode(bridge.index, x, y, BRIDGE_Z, 2.5 + normalized * 2.8, 0.44 + normalized * 0.35,
      MR.BRIDGE, 0.42 + 0.3 * (order / Math.max(1, shownBridges.length - 1)),
      nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, exclude);
    grow3(x, y, BRIDGE_Z, 18);
    labels.push({
      key: `n:${bridge.id}`,
      x, y: y + 10, z: BRIDGE_Z,
      text: bridge.name,
      sub: `2 hops · ${bridge.routeCount} supporting connection${bridge.routeCount === 1 ? "" : "s"}`,
      detail: `strongest route through ${bridge.strongestIntermediaryName} · no direct relationship is claimed`,
      priority: PRIORITY.neighborBase + PRIORITY.neighborSpan * 0.8 * (1 - order / Math.max(1, shownBridges.length)),
      tone: "person",
      pick: bridge.id,
    });
  }

  // Every displayed bridge receives its strongest supporting path before the
  // remaining connector budget is filled globally by evidence score.
  const primaryRoutes = shownBridges.map((bridge) => ({ bridge, support: bridge.supports[0]! }));
  const additionalRoutes = shownBridges.flatMap((bridge) => bridge.supports.slice(1).map((support) => ({ bridge, support })));
  additionalRoutes.sort(compareRouteCandidate);
  // Leave room for direct/context/guide traces under an unusually small
  // externally supplied renderer budget. Normal tier caps are much larger.
  // Required semantic bridges may exceed the ordinary tier population, so
  // their mandatory strongest paths follow them beyond the ordinary budget.
  const bridgeRouteBudget = Math.max(availableBridgeRouteBudget, primaryRoutes.length);
  const chosenRoutes = [...primaryRoutes, ...additionalRoutes].slice(0, bridgeRouteBudget);
  const chosenKeys = new Set(chosenRoutes.map(routeCandidateKey));
  for (const bridge of shownBridges) {
    bridge.displayedRouteCount = 0;
    for (const support of bridge.supports) {
      support.displayed = chosenKeys.has(routeCandidateKey({ bridge, support }));
      if (support.displayed) bridge.displayedRouteCount++;
    }
  }
  for (const [order, candidate] of chosenRoutes.entries()) {
    const intermediary = direct.find((item) => item.id === candidate.support.intermediaryId)!;
    const from = polar(intermediary.radius, intermediary.angle);
    const to = polar(candidate.bridge.radius, candidate.bridge.angle);
    const normalized = Math.log1p(candidate.support.pathScore) / Math.log1p(Math.max(1, bridgeMax));
    const relation = candidate.support.relation;
    routes.push({
      key: pairKey(candidate.support.intermediaryId, candidate.bridge.id),
      points: sampleSpatialCurve(from.x, from.y, DIRECT_Z, to.x, to.y, BRIDGE_Z,
        4 + (order % 5) * 1.5, candidate.support.intermediaryIndex * 67 + candidate.bridge.index),
      fromPoints: organicRoute(data, candidate.support.intermediaryIndex, candidate.bridge.index,
        candidate.support.intermediaryIndex * 43 + candidate.bridge.index),
      color: relationColor(relation.same, relation.opposed, relation.br, relation.title),
      width: 0.42 + normalized * 0.62,
      alpha: 0.035 + normalized * 0.085,
      kind: TK.BRIDGE,
      a: candidate.support.intermediaryIndex,
      b: candidate.bridge.index,
    });
  }
  const totalBridgeRoutes = allBridges.reduce((sum, bridge) => sum + bridge.routeCount, 0);
  const omittedBridgeRoutes = Math.max(0, totalBridgeRoutes - chosenRoutes.length);
  if (omittedBridgeRoutes > 0) {
    notes.push(`${chosenRoutes.length} strongest supporting bridge routes displayed; ${omittedBridgeRoutes} additional routes omitted at ${tier} quality`);
  }

  // The selected canonical person is one node, never a duplicate center chip.
  setCorpusNode(selectedIndex, 0, 0, CORE_Z, 9.5, 1, MR.SELECTED, 0,
    nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, exclude);
  grow3(0, 0, CORE_Z, 32);
  labels.push({
    key: `n:${selectedId}`,
    x: 0, y: 15, z: CORE_Z,
    text: data.nameOf(selectedId) ?? selectedId,
    sub: "center · selected person",
    priority: PRIORITY.selected,
    tone: "person",
    force: true,
    pick: selectedId,
  });

  const guideCount = addGuides(routes, direct.length > 0, shownBridges.length > 0);
  if (direct.length > 0) {
    labels.push({
      key: "orbit:direct:heading", x: 0, y: -DIRECT_RADIUS - 48, z: DIRECT_Z,
      text: "INNER ORBIT · DIRECT RELATIONSHIPS", sub: "radius = one graph hop", priority: PRIORITY.header,
      tone: "neutral", anchor: "center",
    });
    addSectorHeadings(labels, direct);
  } else {
    notes.push("No graph-resident direct relationships are available for this person in the current corpus");
  }
  if (shownBridges.length > 0) {
    labels.push({
      key: "orbit:bridge:heading", x: 0, y: BRIDGE_RADIUS + 54, z: BRIDGE_Z,
      text: "OUTER ORBIT · TWO-HOP BRIDGES", sub: "placement does not claim a direct relationship", priority: PRIORITY.header,
      tone: "neutral", anchor: "center",
    });
  } else if (direct.length > 0) {
    notes.push("No second-hop bridge candidates survived the current documented evidence and display rules");
  }

  addContextHalos(
    data, selectedId, selectedIndex, dossier, titleNameOf, budget.context,
    nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay,
    virtuals, routes, labels, regions, notes, exclude, grow3,
  );
  if (!dossier) notes.push("Optional person detail is unavailable; direct and bridge topology uses graph adjacency only");
  notes.push("Direct strength = opposed + same-side + 0.35 × battle-royal contacts; title context never creates a relationship. Bridge score sums the square roots of supported two-edge path strengths");

  if (!Number.isFinite(active.minX)) grow3(0, 0, CORE_Z, 1);
  const fitBounds = { ...active, minZ, maxZ };
  const bounds = { ...active };
  const rack = packBackground(
    data, exclude, active, nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, bounds,
    controls.context !== false,
  );
  regions.push(...rack.regions);
  labels.push(...rack.labels);

  const stats: OrbitStats = {
    directTotal: allDirect.length,
    directDisplayed: direct.length,
    bridgeTotal: allBridges.length,
    bridgeDisplayed: shownBridges.length,
    bridgeRoutesDisplayed: chosenRoutes.length,
    bridgeRoutesOmitted: omittedBridgeRoutes,
    guideCount,
    tierReduced:
      allDirect.length > budget.direct ||
      allBridges.length > budget.bridge ||
      totalBridgeRoutes > chosenRoutes.length,
    dossierAvailable: dossier !== null,
  };
  const details: OrbitDetails = {
    selectedId,
    direct: direct.map(({ relation: _relation, ...item }) => item),
    bridges: shownBridges.map((bridge) => ({
      ...bridge,
      supports: bridge.supports.map(({ relation: _relation, ...support }) => support),
    })),
  };
  const contextCount = routes.filter((route) => route.kind === TK.CONTEXT_PROMO || route.kind === TK.CONTEXT_TITLE).length;
  return {
    mode: "orbit",
    nodeTargets,
    nodeOpacity,
    nodeScale,
    nodeRole,
    nodeDelay,
    virtuals,
    routes,
    labels,
    regions,
    bounds: { ...bounds, minZ: Math.min(minZ, -900), maxZ: Math.max(maxZ, 900) },
    fitBounds,
    anchorId: selectedId,
    representedCount: count,
    expandedCount: 1 + direct.length + shownBridges.length + contextCount,
    notes,
    orbit: details,
    orbitStats: stats,
    orbitDetails: details,
  };
}

function compareDirectRelation(a: NeighborRel, b: NeighborRel): number {
  return relationshipStrength(b) - relationshipStrength(a) || compareValidDay(a.firstDay, b.firstDay) || compareId(a.id, b.id);
}

function compareValidDay(a: number, b: number): number {
  // Columnar graph projections use zero as the missing-date sentinel. Treating
  // it as epoch day would fabricate a 1900 chronology position.
  const av = Number.isFinite(a) && a > 0;
  const bv = Number.isFinite(b) && b > 0;
  if (av !== bv) return av ? -1 : 1;
  return av ? a - b : 0;
}

function compareBridge(a: BridgeRecord, b: BridgeRecord): number {
  return b.score - a.score || b.routeCount - a.routeCount || compareId(a.id, b.id);
}

function compareSupport(a: BridgeSupport, b: BridgeSupport): number {
  return b.pathScore - a.pathScore || compareId(a.intermediaryId, b.intermediaryId);
}

function compareRouteCandidate(a: RouteCandidate, b: RouteCandidate): number {
  return b.support.pathScore - a.support.pathScore || compareId(a.bridge.id, b.bridge.id) ||
    compareId(a.support.intermediaryId, b.support.intermediaryId);
}

function routeCandidateKey(candidate: RouteCandidate): string {
  return `${candidate.support.intermediaryId}\u0000${candidate.bridge.id}`;
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finiteCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function withRequiredBeyondCap<T extends { id: string }>(
  sorted: readonly T[], cap: number, required: ReadonlySet<string>,
): T[] {
  const out = sorted.slice(0, cap);
  const seen = new Set(out.map((item) => item.id));
  for (const item of sorted) {
    if (required.has(item.id) && !seen.has(item.id)) {
      out.push(item);
      seen.add(item.id);
    }
  }
  return out;
}

/** If a required two-hop person is reachable only through a direct neighbour
 * outside the ordinary tier cap, preserve its strongest real intermediary.
 * This is bounded by the small semantic required-id set and adjacency lists;
 * it never scans arbitrary corpus pairs. */
function addRequiredBridgeIntermediaries(
  data: MorphData,
  selectedId: string,
  selectedIndex: number,
  allDirect: readonly NeighborRel[],
  shownDirect: NeighborRel[],
  required: ReadonlySet<string>,
): void {
  if (required.size === 0 || allDirect.length === shownDirect.length) return;
  const directIds = new Set(allDirect.map((relation) => relation.id));
  const shownIds = new Set(shownDirect.map((relation) => relation.id));
  for (const requiredId of [...required].sort(compareId)) {
    if (requiredId === selectedId || directIds.has(requiredId)) continue;
    const candidateIndex = data.indexOf(requiredId);
    if (candidateIndex === undefined || candidateIndex === selectedIndex || data.model.nodes.type[candidateIndex] !== 0) continue;
    const alreadySupported = shownDirect.some((intermediary) => {
      const edge = data.relationsOf(intermediary.index).find((candidate) => candidate.id === requiredId);
      return !!edge && classifyDirectRelationship(edge) !== null && relationshipStrength(edge) > 0;
    });
    if (alreadySupported) continue;
    let best: { intermediary: NeighborRel; score: number } | null = null;
    for (const intermediary of allDirect) {
      if (shownIds.has(intermediary.id)) continue;
      const candidateEdge = data.relationsOf(intermediary.index).find((edge) => edge.id === requiredId);
      if (!candidateEdge || classifyDirectRelationship(candidateEdge) === null) continue;
      const score = Math.sqrt(relationshipStrength(intermediary) * relationshipStrength(candidateEdge));
      if (!(score > 0) || !Number.isFinite(score)) continue;
      if (!best || score > best.score || (score === best.score && compareId(intermediary.id, best.intermediary.id) < 0)) {
        best = { intermediary, score };
      }
    }
    if (!best) continue;
    shownDirect.push(best.intermediary);
    shownIds.add(best.intermediary.id);
  }
}

function placeDirect(relations: readonly NeighborRel[]): DirectRecord[] {
  const sectors: Record<OrbitSector, NeighborRel[]> = {
    opposed: [],
    "same-side": [],
    mixed: [],
    "battle-royal-only": [],
  };
  for (const relation of relations) sectors[classifyDirectRelationship(relation)!].push(relation);
  const ranges: Record<OrbitSector, readonly [number, number]> = {
    mixed: [deg(38), deg(142)],
    opposed: [deg(146), deg(248)],
    "battle-royal-only": [deg(252), deg(288)],
    "same-side": [deg(292), deg(398)],
  };
  const result: DirectRecord[] = [];
  for (const sector of ["opposed", "same-side", "mixed", "battle-royal-only"] as const) {
    const list = sectors[sector];
    const [start, end] = ranges[sector];
    const span = end - start;
    const naturalCapacity = Math.max(1, Math.floor(span / MIN_DIRECT_ANGLE));
    // Bound inner-hop depth to three rings. Even a pathologically skewed
    // sector therefore stays inside the outer bridge radius; angular spacing
    // tightens deterministically instead of changing graph-hop meaning.
    const bandCount = Math.min(3, Math.max(1, Math.ceil(list.length / naturalCapacity)));
    const capacity = Math.max(1, Math.ceil(list.length / bandCount));
    for (let order = 0; order < list.length; order++) {
      const relation = list[order]!;
      const band = Math.floor(order / capacity);
      const lane = order % capacity;
      const inBand = Math.min(capacity, list.length - band * capacity);
      const angle = inBand === 1 ? start + span * 0.5 : start + span * ((lane + 0.5) / inBand);
      result.push({
        id: relation.id,
        index: relation.index,
        name: relation.name,
        sector,
        strength: relationshipStrength(relation),
        same: finiteCount(relation.same),
        opposed: finiteCount(relation.opposed),
        battleRoyal: finiteCount(relation.br),
        titleRelated: finiteCount(relation.title),
        firstDay: validDay(relation.firstDay),
        lastDay: validDay(relation.lastDay),
        angle: normalizeAngle(angle),
        radius: DIRECT_RADIUS + band * DIRECT_BAND_GAP,
        band,
        relation,
      });
    }
  }
  return result;
}

function placeBridges(bridges: BridgeRecord[]): void {
  const capacity = Math.max(1, Math.floor(Math.PI * 2 / MIN_BRIDGE_ANGLE));
  for (let order = 0; order < bridges.length; order++) {
    const bridge = bridges[order]!;
    bridge.band = Math.floor(order / capacity);
    bridge.radius = BRIDGE_RADIUS + bridge.band * BRIDGE_BAND_GAP;
  }
  const bands = new Map<number, BridgeRecord[]>();
  for (const bridge of bridges) {
    const list = bands.get(bridge.band) ?? [];
    list.push(bridge);
    bands.set(bridge.band, list);
  }
  for (const list of bands.values()) {
    const relaxed = relaxCircularAngles(list.map((item) => ({ id: item.id, angle: item.angle })), MIN_BRIDGE_ANGLE);
    const byId = new Map(relaxed.map((item) => [item.id, item.angle]));
    for (const bridge of list) bridge.angle = byId.get(bridge.id)!;
  }
}

/** Weighted circular mean with correct -pi/pi wrap-around. */
export function weightedCircularMean(values: readonly { angle: number; weight: number }[]): number {
  if (values.length === 0) return 0;
  let x = 0;
  let y = 0;
  let fallback = 0;
  let fallbackSet = false;
  for (const value of values) {
    if (!Number.isFinite(value.angle) || !Number.isFinite(value.weight) || value.weight <= 0) continue;
    const angle = normalizeAngle(value.angle);
    if (!fallbackSet) {
      fallback = angle;
      fallbackSet = true;
    }
    x += Math.cos(angle) * value.weight;
    y += Math.sin(angle) * value.weight;
  }
  if (!fallbackSet) return 0;
  if (Math.hypot(x, y) < 1e-9) return fallback;
  return normalizeAngle(Math.atan2(y, x));
}

/**
 * Fixed-pass collision relaxation around a circle. The stable id tie-break and
 * fixed iteration count make the output byte-identical; no simulation remains
 * alive after the builder returns.
 */
export function relaxCircularAngles(
  values: readonly { id: string; angle: number }[],
  minimumSeparation: number,
  iterations = RELAX_ITERATIONS,
): { id: string; angle: number }[] {
  if (values.length <= 1) return values.map((item) => ({ id: item.id, angle: normalizeAngle(item.angle) }));
  const min = Math.min(Math.max(0, minimumSeparation), (Math.PI * 2) / values.length * 0.98);
  const original = new Map(values.map((item) => [item.id, normalizePositive(item.angle)]));
  const items = values
    .map((item) => ({ id: item.id, angle: normalizePositive(item.angle) }))
    .sort((a, b) => a.angle - b.angle || compareId(a.id, b.id));
  for (let pass = 0; pass < Math.max(0, Math.floor(iterations)); pass++) {
    for (let i = 0; i < items.length; i++) {
      const current = items[i]!;
      const next = items[(i + 1) % items.length]!;
      const nextAngle = i === items.length - 1 ? next.angle + Math.PI * 2 : next.angle;
      const gap = nextAngle - current.angle;
      if (gap >= min) continue;
      const shift = (min - gap) * 0.5;
      current.angle -= shift;
      next.angle += shift;
    }
    // A light deterministic spring preserves the intermediary direction.
    for (const item of items) {
      const target = original.get(item.id)!;
      item.angle += signedAngularDelta(item.angle, target) * 0.08;
    }
    items.sort((a, b) => a.angle - b.angle || compareId(a.id, b.id));
  }
  return items.map((item) => ({ id: item.id, angle: normalizeAngle(item.angle) }));
}

function signedAngularDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

function normalizePositive(angle: number): number {
  const tau = Math.PI * 2;
  const finite = Number.isFinite(angle) ? angle : 0;
  return ((finite % tau) + tau) % tau;
}

function normalizeAngle(angle: number): number {
  const positive = normalizePositive(angle);
  return positive > Math.PI ? positive - Math.PI * 2 : positive;
}

function deg(value: number): number {
  return value * Math.PI / 180;
}

function polar(radius: number, angle: number): { x: number; y: number } {
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function validDay(day: number): number | null {
  return Number.isFinite(day) && day > 0 ? day : null;
}

function dateSpan(first: number, last: number): string {
  const a = validDay(first);
  const b = validDay(last);
  if (a === null && b === null) return "documented date unavailable";
  const af = a !== null ? dayToDate(a).toISOString().slice(0, 10) : "date unavailable";
  const bf = b !== null ? dayToDate(b).toISOString().slice(0, 10) : "date unavailable";
  return `first documented ${af} · latest documented ${bf}`;
}

function formatStrength(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function roleForSector(sector: OrbitSector): MorphRole {
  if (sector === "opposed") return MR.OPPONENT;
  if (sector === "same-side") return MR.PARTNER;
  if (sector === "mixed") return MR.MIXED;
  return MR.BATTLE_ROYAL;
}

function toneForSector(sector: OrbitSector): MorphLabel["tone"] {
  if (sector === "opposed") return "ember";
  if (sector === "same-side") return "cyan";
  if (sector === "battle-royal-only") return "warn";
  return "muted";
}

function sectorLabel(sector: OrbitSector): string {
  if (sector === "same-side") return "same-side";
  if (sector === "battle-royal-only") return "battle-royal-only";
  return sector;
}

function setCorpusNode(
  index: number, x: number, y: number, z: number, scaleValue: number, opacityValue: number,
  roleValue: MorphRole, delayValue: number,
  targets: Float32Array, opacity: Float32Array, scale: Float32Array, role: Uint8Array,
  delay: Float32Array, exclude: Set<number>,
): void {
  const i3 = index * 3;
  targets[i3] = x;
  targets[i3 + 1] = y;
  targets[i3 + 2] = z;
  opacity[index] = opacityValue;
  scale[index] = scaleValue;
  role[index] = roleValue;
  delay[index] = delayValue;
  exclude.add(index);
}

function organicRoute(data: MorphData, a: number, b: number, seed: number): Float32Array {
  const ai = a * 3;
  const bi = b * 3;
  return sampleOrganicBow(
    data.organic[ai]!, data.organic[ai + 1]!, data.organic[ai + 2]!,
    data.organic[bi]!, data.organic[bi + 1]!, data.organic[bi + 2]!,
    seed,
  );
}

function addGuides(routes: MorphRoute[], directVisible: boolean, bridgeVisible: boolean): number {
  let count = 0;
  if (directVisible) {
    routes.push(guideCircle("orbit:guide:direct", DIRECT_RADIUS, DIRECT_Z - 8, rgb(M.ruleBright), 0.15));
    count++;
  }
  if (bridgeVisible) {
    routes.push(guideCircle("orbit:guide:bridge", BRIDGE_RADIUS, BRIDGE_Z - 8, rgb(M.rule), 0.12));
    count++;
  }
  return count;
}

function guideCircle(key: string, radius: number, z: number, color: [number, number, number], alpha: number): MorphRoute {
  const points = new Float32Array(TRACE_SAMPLES * 3);
  for (let i = 0; i < TRACE_SAMPLES; i++) {
    const angle = Math.PI * 2 * i / (TRACE_SAMPLES - 1);
    points[i * 3] = Math.cos(angle) * radius;
    points[i * 3 + 1] = Math.sin(angle) * radius;
    points[i * 3 + 2] = z;
  }
  return { key, points, color, width: 0.7, alpha, kind: TK.BUS, a: -1, b: -1 };
}

function addSectorHeadings(labels: MorphLabel[], direct: readonly DirectRecord[]): void {
  const definitions: readonly [OrbitSector, string, number][] = [
    ["opposed", "OPPOSED", deg(197)],
    ["same-side", "SAME-SIDE", deg(345)],
    ["mixed", "MIXED", deg(90)],
    ["battle-royal-only", "BATTLE ROYAL ONLY", deg(270)],
  ];
  for (const [sector, text, angle] of definitions) {
    const total = direct.filter((item) => item.sector === sector).length;
    if (total === 0) continue;
    // Headings sit just outside the direct band. An interior radius projected
    // them onto the selected core at the tuned Orbit camera angle.
    const p = polar(DIRECT_RADIUS + 28, angle);
    labels.push({
      key: `orbit:sector:${sector}`, x: p.x, y: p.y, z: DIRECT_Z + 8,
      text: `${text} · ${total}`, priority: PRIORITY.header - 4,
      tone: toneForSector(sector), anchor: "center", force: true,
    });
  }
}

function addContextHalos(
  data: MorphData,
  selectedId: string,
  selectedIndex: number,
  dossier: PersonDossier | null,
  titleNameOf: (id: string) => string | null,
  cap: number,
  targets: Float32Array,
  opacity: Float32Array,
  scale: Float32Array,
  role: Uint8Array,
  delay: Float32Array,
  virtuals: MorphVirtualNode[],
  routes: MorphRoute[],
  labels: MorphLabel[],
  regions: MorphRegion[],
  notes: string[],
  exclude: Set<number>,
  grow3: (x: number, y: number, z: number, pad?: number) => void,
): void {
  const promos = Object.entries(dossier?.promos ?? {})
    .sort((a, b) => b[1] - a[1] || compareId(a[0], b[0]));
  const shownPromos = promos.slice(0, cap);
  for (const [[id, appearances], order] of shownPromos.map((item, i) => [item, i] as const)) {
    const angle = shownPromos.length === 1 ? Math.PI / 2 : deg(32) + deg(116) * order / (shownPromos.length - 1);
    const x = Math.cos(angle) * 360;
    const y = 300 + Math.sin(angle) * 115;
    const z = 170;
    placeContext(data, id, x, y, z, 4.4, 0.76, MR.PROMO_CONTEXT, rgb(M.promotion),
      targets, opacity, scale, role, delay, virtuals, exclude);
    grow3(x, y, z, 20);
    labels.push({
      key: `n:${id}`, x, y: y + 10, z, text: data.nameOf(id) ?? id,
      sub: `documented appearance context · ${appearances.toLocaleString()} appearances`,
      detail: "documented appearances, not employment", priority: PRIORITY.context + appearances / 1e6,
      tone: "promotion", pick: id,
    });
    routes.push(contextRoute(selectedId, selectedIndex, id, data.indexOf(id), x, y, z, TK.CONTEXT_PROMO, rgb(M.promotion), order));
  }
  if (promos.length > shownPromos.length) notes.push(`${shownPromos.length} of ${promos.length} documented promotion contexts displayed`);
  if (shownPromos.length > 0) labels.push({
    key: "orbit:promotion:heading", x: -430, y: 438, z: 170,
    text: "PROMOTION HALO", sub: "documented appearance context · not employment",
    priority: PRIORITY.header, tone: "promotion", anchor: "left",
  });

  const titleReigns = new Map<string, number>();
  for (const title of dossier?.titles ?? []) {
    titleReigns.set(title.t, (titleReigns.get(title.t) ?? 0) + title.reigns.length);
  }
  const titles = [...titleReigns]
    .map(([id, reigns]) => ({ id, reigns }))
    .sort((a, b) => b.reigns - a.reigns || compareId(a.id, b.id));
  const shownTitles = titles.slice(0, cap);
  for (const [title, order] of shownTitles.map((item, i) => [item, i] as const)) {
    const angle = shownTitles.length === 1 ? Math.PI / 2 : deg(38) + deg(104) * order / (shownTitles.length - 1);
    const x = Math.cos(angle) * 435;
    const y = 385 + Math.sin(angle) * 125;
    const z = 270;
    placeContext(data, title.id, x, y, z, 4, 0.84, MR.TITLE_CONTEXT, rgb(M.gold),
      targets, opacity, scale, role, delay, virtuals, exclude);
    grow3(x, y, z, 20);
    labels.push({
      key: `n:${title.id}`, x, y: y + 10, z,
      text: titleNameOf(title.id) ?? data.nameOf(title.id) ?? title.id,
      sub: `documented championship context · ${title.reigns} recorded reign${title.reigns === 1 ? "" : "s"}`,
      detail: title.reigns > 0 ? "documented reign context" : "source has no title-change field",
      priority: PRIORITY.context + 20 + title.reigns / 1e4, tone: "gold", pick: title.id,
    });
    regions.push({ key: `orbit:title:${title.id}`, x, y, z: z - 5, w: 58, h: 6, color: rgb(M.goldDeep), alpha: 0.26, kind: RK.GOLD, pick: title.id });
    routes.push(contextRoute(selectedId, selectedIndex, title.id, data.indexOf(title.id), x, y, z, TK.CONTEXT_TITLE, rgb(M.gold), order + 97));
  }
  if (titles.length > shownTitles.length) notes.push(`${shownTitles.length} of ${titles.length} documented championship contexts displayed`);
  if (shownTitles.length > 0) labels.push({
    key: "orbit:title:heading", x: -470, y: 525, z: 270,
    text: "CHAMPIONSHIP HALO", sub: "documented reign context",
    priority: PRIORITY.header, tone: "gold", anchor: "left",
  });
}

function placeContext(
  data: MorphData, id: string, x: number, y: number, z: number, scaleValue: number, opacityValue: number,
  roleValue: MorphRole, color: [number, number, number], targets: Float32Array, opacity: Float32Array,
  scale: Float32Array, role: Uint8Array, delay: Float32Array, virtuals: MorphVirtualNode[], exclude: Set<number>,
): void {
  const index = data.indexOf(id);
  if (index === undefined) {
    virtuals.push({ id, x, y, z, scale: scaleValue, opacity: opacityValue, color, role: roleValue });
    return;
  }
  setCorpusNode(index, x, y, z, scaleValue, opacityValue, roleValue, 0.72,
    targets, opacity, scale, role, delay, exclude);
}

function contextRoute(
  selectedId: string, selectedIndex: number, id: string, index: number | undefined,
  x: number, y: number, z: number, kind: typeof TK.CONTEXT_PROMO | typeof TK.CONTEXT_TITLE,
  color: [number, number, number], seed: number,
): MorphRoute {
  return {
    key: `ctx:${selectedId}:${id}`,
    points: sampleSpatialCurve(0, 0, CORE_Z, x, y, z, 18 + seed % 7, seed * 101 + selectedIndex),
    color,
    width: kind === TK.CONTEXT_TITLE ? 1.8 : 1.35,
    alpha: kind === TK.CONTEXT_TITLE ? 0.38 : 0.27,
    kind,
    a: selectedIndex,
    b: index ?? -1,
    aId: selectedId,
    bId: id,
  };
}
