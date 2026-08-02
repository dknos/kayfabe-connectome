import {
  M,
  MR,
  RK,
  TK,
  relationColor,
  rgb,
  type MorphLabel,
  type MorphLayoutResult,
  type MorphRegion,
  type MorphRoute,
  type MorphRole,
} from "@kayfabe/morph-renderer";
import { pairKey, type EvidenceEntry } from "@kayfabe/graph-contract";
import type { MorphData, NeighborRel } from "../morphAdapter";
import { PRIORITY, emptyBounds, growBounds, type MorphControlsState } from "./layoutTypes";
import { packBackground } from "./backgroundRack";
import { resample3D, sampleSpatialCurve } from "./routing";

/**
 * 3D HEAD-TO-HEAD
 *
 * A and B are stable opposing anchors. Their direct documented matches become
 * chronological rungs; this evidence is kept distinct from graph connections.
 * Shared relationships occupy the central bridge and exclusive relationships
 * occupy outer banks. Nothing here labels a graph-theory path as head-to-head
 * evidence.
 */

const ANCHOR_X = 350;
const RUNG_TOP = 250;
const RUNG_BOTTOM = -250;
const RUNG_CAP = 28;
const SHARED_CAP = 72;
const EXCLUSIVE_CAP = 48;
const SHARED_ROUTE_CAP = 20;
const EXCLUSIVE_ROUTE_CAP = 14;

type Reading = "opponent" | "partner" | "mixed" | "battle";

interface SharedConnection {
  id: string;
  a: NeighborRel;
  b: NeighborRel;
  strength: number;
  reading: Reading;
}

export function buildHeadToHead(
  data: MorphData,
  aId: string,
  bId: string,
  evidence: EvidenceEntry[],
  controls?: MorphControlsState,
): MorphLayoutResult {
  const n = data.count;
  const nodeTargets = new Float32Array(n * 3);
  const nodeOpacity = new Float32Array(n);
  const nodeScale = new Float32Array(n);
  const nodeRole = new Uint8Array(n);
  const nodeDelay = new Float32Array(n);
  const routes: MorphRoute[] = [];
  const labels: MorphLabel[] = [];
  const regions: MorphRegion[] = [];
  const notes: string[] = [];
  const active = emptyBounds();
  const exclude = new Set<number>();
  let minZ = Infinity;
  let maxZ = -Infinity;
  const grow3 = (x: number, y: number, z: number, pad = 0) => {
    growBounds(active, x, y, pad);
    minZ = Math.min(minZ, z - pad);
    maxZ = Math.max(maxZ, z + pad);
  };

  const aIndex = data.indexOf(aId);
  const bIndex = data.indexOf(bId);
  if (aIndex === undefined || bIndex === undefined) {
    throw new Error("head-to-head: both anchors need corpus nodes");
  }
  if (aIndex === bIndex) throw new Error("head-to-head: anchors must be different wrestlers");
  exclude.add(aIndex);
  exclude.add(bIndex);

  const aRelations = new Map(
    data.relationsOf(aIndex).filter((relation) => relation.id !== bId).map((relation) => [relation.id, relation]),
  );
  const bRelations = new Map(
    data.relationsOf(bIndex).filter((relation) => relation.id !== aId).map((relation) => [relation.id, relation]),
  );
  const shared: SharedConnection[] = [];
  const exclusiveA: NeighborRel[] = [];
  const exclusiveB: NeighborRel[] = [];
  for (const relation of aRelations.values()) {
    const other = bRelations.get(relation.id);
    if (other) {
      shared.push({
        id: relation.id,
        a: relation,
        b: other,
        strength: strengthOf(relation) + strengthOf(other),
        reading: sharedReading(relation, other),
      });
    } else {
      exclusiveA.push(relation);
    }
  }
  for (const relation of bRelations.values()) {
    if (!aRelations.has(relation.id)) exclusiveB.push(relation);
  }
  shared.sort((a, b) => b.strength - a.strength || compareId(a.id, b.id));
  exclusiveA.sort(compareRelation);
  exclusiveB.sort(compareRelation);
  const shownShared = shared.slice(0, SHARED_CAP);
  const shownA = exclusiveA.slice(0, EXCLUSIVE_CAP);
  const shownB = exclusiveB.slice(0, EXCLUSIVE_CAP);
  const omitted = [
    shared.length > shownShared.length ? `${shared.length - shownShared.length} shared` : "",
    exclusiveA.length > shownA.length ? `${exclusiveA.length - shownA.length} ${data.nameOf(aId) ?? aId}-exclusive` : "",
    exclusiveB.length > shownB.length ? `${exclusiveB.length - shownB.length} ${data.nameOf(bId) ?? bId}-exclusive` : "",
  ].filter(Boolean);
  if (omitted.length) notes.push(`${omitted.join(" · ")} additional connections remain in the inspector`);

  const sortedEvidence = [...evidence].sort((a, b) =>
    compareId(a.d, b.d) || compareId(a.m, b.m),
  );
  const shownEvidence = evenlySample(sortedEvidence, RUNG_CAP);
  if (sortedEvidence.length > shownEvidence.length) {
    notes.push(`${shownEvidence.length} of ${sortedEvidence.length} documented direct matches shown, sampled deterministically across the full date span`);
  }

  const anchor = (index: number, id: string, side: -1 | 1) => {
    const x = side * ANCHOR_X;
    setNode(index, x, 0, 0, 8.8, 1, MR.SELECTED, 0,
      nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, exclude);
    labels.push({
      key: `n:${id}`,
      x,
      y: RUNG_TOP + 82,
      z: 0,
      text: data.nameOf(id) ?? id,
      sub: `${sortedEvidence.length.toLocaleString()} documented direct match${sortedEvidence.length === 1 ? "" : "es"}`,
      detail: `${shownShared.length.toLocaleString()} shared connections in the visible bridge`,
      priority: PRIORITY.selected,
      tone: "person",
      force: true,
      pick: id,
    });
    regions.push({
      key: `h2h:rail:${id}`,
      x,
      y: 0,
      z: 0,
      w: 4,
      h: RUNG_TOP - RUNG_BOTTOM + 46,
      color: rgb(M.ruleBright),
      alpha: 0.5,
      kind: RK.RAIL,
      pick: id,
    });
    grow3(x, 0, 0, 52);
    grow3(x, RUNG_TOP + 82, 0, 28);
    grow3(x, RUNG_BOTTOM, 0, 24);
  };
  anchor(aIndex, aId, -1);
  anchor(bIndex, bId, 1);

  // Direct evidence remains its own keyed rung. Depth encodes documented
  // match context (title/same-side/opposed/battle), not random decoration.
  shownEvidence.forEach((event, order) => {
    const t = shownEvidence.length <= 1 ? 0.5 : order / (shownEvidence.length - 1);
    const y = RUNG_TOP + (RUNG_BOTTOM - RUNG_TOP) * t;
    const z = event.t !== null
      ? 176
      : event.rel === "same"
        ? 94
        : event.rel === "br"
          ? -164
          : -72;
    routes.push({
      key: `h2h:match:${event.m}`,
      points: resample3D([
        -ANCHOR_X, y, 0,
        -ANCHOR_X * 0.56, y, z,
        ANCHOR_X * 0.56, y, z,
        ANCHOR_X, y, 0,
      ]),
      color: event.t !== null
        ? rgb(M.gold)
        : event.rel === "same"
          ? rgb(M.same)
          : event.rel === "br"
            ? rgb(M.br)
            : rgb(M.opposed),
      width: event.t !== null ? 2.15 : 1.3,
      alpha: event.t !== null ? 0.43 : 0.22,
      kind: TK.RELATION,
      a: aIndex,
      b: bIndex,
    });
    if (order % 3 === 0 || event.t !== null || shownEvidence.length <= 10) {
      labels.push({
        key: `h2h:match:${event.m}:label`,
        x: 0,
        y: y + 7,
        z,
        text: `${event.d} · ${data.nameOf(event.pr) ?? event.pr}`,
        sub:
          `${event.form.replaceAll("_", " ")} · ${event.res}` +
          (event.t !== null ? ` · title match${event.tc ? " · TITLE CHANGE" : ""}` : "") +
          (event.mr !== undefined ? ` · ${event.mr}★` : ""),
        priority: PRIORITY.neighborBase + (event.t !== null ? 240 : 0) + shownEvidence.length - order,
        tone: event.t !== null ? "gold" : event.rel === "same" ? "cyan" : event.rel === "br" ? "muted" : "ember",
      });
    }
    grow3(0, y, z, 18);
  });
  if (!shownEvidence.length) {
    labels.push({
      key: "h2h:no-direct-evidence",
      x: 0,
      y: 0,
      z: 0,
      text: "no documented direct matches in the loaded evidence shard",
      sub: "shared graph connections remain visible but are not direct-match evidence",
      priority: PRIORITY.header,
      tone: "warn",
      force: true,
    });
  }

  // Shared connections: one canonical central node with an actual rendered
  // trace to each anchor. Opponent and partner readings occupy distinct depth.
  const sharedColumns = Math.min(9, Math.max(1, Math.ceil(Math.sqrt(shownShared.length))));
  const maxSharedStrength = Math.max(1, ...shownShared.map((entry) => entry.strength));
  shownShared.forEach((entry, order) => {
    const column = order % sharedColumns;
    const row = Math.floor(order / sharedColumns);
    const x = (column - (sharedColumns - 1) / 2) * 62;
    const y = RUNG_TOP + 112 + row * 44;
    const z = readingDepth(entry.reading) + (row % 3) * 13;
    const index = entry.a.index;
    const scale = 3 + 2.2 * Math.sqrt(entry.strength / maxSharedStrength);
    setNode(index, x, y, z, scale, 0.86, roleFor(entry.reading), 0.22 + order / Math.max(1, shownShared.length) * 0.34,
      nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, exclude);
    labels.push({
      key: `n:${entry.id}`,
      x,
      y: y + 12,
      z,
      text: entry.a.name,
      sub: sharedSummary(entry, data.nameOf(aId) ?? aId, data.nameOf(bId) ?? bId),
      detail: `relationship to both anchors · first documented years ${yearOf(entry.a.firstDay)} / ${yearOf(entry.b.firstDay)}`,
      priority: PRIORITY.neighborBase + PRIORITY.neighborSpan - order,
      tone: entry.reading === "partner" ? "cyan" : entry.reading === "opponent" ? "ember" : "neutral",
      badge: entry.reading === "mixed" ? "±" : undefined,
      pick: entry.id,
    });
    if (order < SHARED_ROUTE_CAP) {
      addConnectionRoute(routes, data, aId, aIndex, entry.a, -ANCHOR_X, x, y, z, order * 2);
      addConnectionRoute(routes, data, bId, bIndex, entry.b, ANCHOR_X, x, y, z, order * 2 + 1);
    }
    grow3(x, y, z, 24);
  });
  if (shownShared.length) {
    labels.push({
      key: "h2h:shared:header",
      x: 0,
      y: RUNG_TOP + 78,
      z: 0,
      text: `SHARED CONNECTION BRIDGE · ${shared.length}`,
      sub: "documented relationships to both anchors",
      priority: PRIORITY.header,
      tone: "neutral",
    });
  }

  // Exclusive banks are outside their respective anchor. "Exclusive" means
  // connected to only one of A/B in this comparison, not career exclusivity.
  placeExclusiveBank(
    shownA,
    -1,
    aId,
    aIndex,
    data,
    routes,
    labels,
    nodeTargets,
    nodeOpacity,
    nodeScale,
    nodeRole,
    nodeDelay,
    exclude,
    grow3,
  );
  placeExclusiveBank(
    shownB,
    1,
    bId,
    bIndex,
    data,
    routes,
    labels,
    nodeTargets,
    nodeOpacity,
    nodeScale,
    nodeRole,
    nodeDelay,
    exclude,
    grow3,
  );
  if (
    shownShared.length > SHARED_ROUTE_CAP ||
    shownA.length > EXCLUSIVE_ROUTE_CAP ||
    shownB.length > EXCLUSIVE_ROUTE_CAP
  ) {
    notes.push(
      `routed strongest: ${Math.min(SHARED_ROUTE_CAP, shownShared.length)}/${shownShared.length} shared to both anchors · ` +
      `${Math.min(EXCLUSIVE_ROUTE_CAP, shownA.length)}/${shownA.length} ${data.nameOf(aId) ?? aId}-exclusive · ` +
      `${Math.min(EXCLUSIVE_ROUTE_CAP, shownB.length)}/${shownB.length} ${data.nameOf(bId) ?? bId}-exclusive; every represented node remains pickable`,
    );
  }
  if (shownA.length) labels.push({
    key: "h2h:exclusive:a:header",
    x: -ANCHOR_X - 148,
    y: RUNG_BOTTOM - 58,
    z: 0,
    text: `${data.nameOf(aId) ?? aId} OUTER BANK · ${exclusiveA.length}`,
    sub: "connections exclusive within this A/B comparison",
    priority: PRIORITY.header - 1,
    tone: "ember",
  });
  if (shownB.length) labels.push({
    key: "h2h:exclusive:b:header",
    x: ANCHOR_X + 148,
    y: RUNG_BOTTOM - 58,
    z: 0,
    text: `${data.nameOf(bId) ?? bId} OUTER BANK · ${exclusiveB.length}`,
    sub: "connections exclusive within this A/B comparison",
    priority: PRIORITY.header - 1,
    tone: "cyan",
  });

  if (!Number.isFinite(active.minX)) grow3(0, 0, 0, 1);
  const fitBounds = { ...active, minZ, maxZ };
  const bounds = { ...active };
  const rack = packBackground(
    data,
    exclude,
    active,
    nodeTargets,
    nodeOpacity,
    nodeScale,
    nodeRole,
    nodeDelay,
    bounds,
    controls?.context !== false,
  );
  regions.push(...rack.regions);
  labels.push(...rack.labels);

  return {
    mode: "h2h",
    nodeTargets,
    nodeOpacity,
    nodeScale,
    nodeRole,
    nodeDelay,
    virtuals: [],
    routes,
    labels,
    regions,
    bounds: { ...bounds, minZ: Math.min(minZ, -900), maxZ: Math.max(maxZ, 900) },
    fitBounds,
    anchorId: aId,
    representedCount: n,
    expandedCount: 2 + shownShared.length + shownA.length + shownB.length + shownEvidence.length,
    notes,
  };
}

function placeExclusiveBank(
  relations: readonly NeighborRel[],
  side: -1 | 1,
  anchorId: string,
  anchorIndex: number,
  data: MorphData,
  routes: MorphRoute[],
  labels: MorphLabel[],
  targets: Float32Array,
  opacity: Float32Array,
  scale: Float32Array,
  role: Uint8Array,
  delay: Float32Array,
  exclude: Set<number>,
  grow3: (x: number, y: number, z: number, pad?: number) => void,
): void {
  const columns = 4;
  const maxStrength = Math.max(1, ...relations.map(strengthOf));
  relations.forEach((relation, order) => {
    const column = order % columns;
    const row = Math.floor(order / columns);
    const x = side * (ANCHOR_X + 132 + column * 58);
    const y = RUNG_BOTTOM + row * 39;
    const reading = readingOf(relation);
    const z = readingDepth(reading) + (column - 1.5) * 18;
    const strength = strengthOf(relation);
    setNode(
      relation.index,
      x,
      y,
      z,
      2.7 + 1.8 * Math.sqrt(strength / maxStrength),
      0.66 + 0.22 * Math.sqrt(strength / maxStrength),
      roleFor(reading),
      0.46 + order / Math.max(1, relations.length) * 0.3,
      targets,
      opacity,
      scale,
      role,
      delay,
      exclude,
    );
    // Metadata exists for every pickable node; the pooled label cap keeps the
    // resting view quiet and promotes the hovered identity in place.
    labels.push({
      key: `n:${relation.id}`,
      x,
      y: y + 10,
      z,
      text: relation.name,
      sub: `${data.nameOf(anchorId) ?? anchorId} only in this comparison · ${readingText(reading, relation)}`,
      detail: `first documented ${yearOf(relation.firstDay)} · latest ${yearOf(relation.lastDay)}`,
      priority: PRIORITY.neighborBase + 120 - order,
      tone: reading === "partner" ? "cyan" : reading === "opponent" ? "ember" : "neutral",
      pick: relation.id,
    });
    if (order < EXCLUSIVE_ROUTE_CAP) {
      addConnectionRoute(routes, data, anchorId, anchorIndex, relation, side * ANCHOR_X, x, y, z, order + (side > 0 ? 701 : 401));
    }
    grow3(x, y, z, 21);
  });
}

function addConnectionRoute(
  routes: MorphRoute[],
  data: MorphData,
  anchorId: string,
  anchorIndex: number,
  relation: NeighborRel,
  anchorX: number,
  x: number,
  y: number,
  z: number,
  seed: number,
): void {
  routes.push({
    key: pairKey(anchorId, relation.id),
    points: sampleSpatialCurve(anchorX, 0, 0, x, y, z, 20 + (seed % 9) * 4, anchorIndex * 97 + relation.index),
    color: relationColor(relation.same, relation.opposed, relation.br, relation.title),
    width: 0.9 + Math.min(1.1, Math.log1p(strengthOf(relation)) * 0.22),
    alpha: 0.12 + Math.min(0.16, Math.log1p(strengthOf(relation)) * 0.03),
    kind: TK.RELATION,
    a: anchorIndex,
    b: data.indexOf(relation.id) ?? -1,
  });
}

function evenlySample<T>(items: readonly T[], cap: number): T[] {
  if (items.length <= cap) return [...items];
  if (cap <= 1) return items.length ? [items[0]!] : [];
  const out: T[] = [];
  let previous = -1;
  for (let i = 0; i < cap; i++) {
    const index = Math.round((i / (cap - 1)) * (items.length - 1));
    if (index !== previous) out.push(items[index]!);
    previous = index;
  }
  return out;
}

function setNode(
  index: number,
  x: number,
  y: number,
  z: number,
  scaleValue: number,
  opacityValue: number,
  roleValue: MorphRole,
  delayValue: number,
  targets: Float32Array,
  opacity: Float32Array,
  scale: Float32Array,
  role: Uint8Array,
  delay: Float32Array,
  exclude: Set<number>,
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

function strengthOf(relation: NeighborRel): number {
  return relation.same + relation.opposed + relation.br;
}

function compareRelation(a: NeighborRel, b: NeighborRel): number {
  return strengthOf(b) - strengthOf(a) || compareId(a.id, b.id);
}

function readingOf(relation: NeighborRel): Reading {
  if (relation.same === 0 && relation.opposed === 0 && relation.br > 0) return "battle";
  const weaker = Math.min(relation.same, relation.opposed);
  const stronger = Math.max(1, relation.same, relation.opposed);
  if (weaker >= 2 && weaker / stronger >= 0.25) return "mixed";
  return relation.same > relation.opposed ? "partner" : "opponent";
}

function sharedReading(a: NeighborRel, b: NeighborRel): Reading {
  const ar = readingOf(a);
  const br = readingOf(b);
  if (ar === br) return ar;
  if (ar === "battle" && br === "battle") return "battle";
  return "mixed";
}

function roleFor(reading: Reading): MorphRole {
  return reading === "partner"
    ? MR.PARTNER
    : reading === "opponent"
      ? MR.OPPONENT
      : reading === "battle"
        ? MR.BATTLE_ROYAL
        : MR.MIXED;
}

function readingDepth(reading: Reading): number {
  return reading === "partner" ? 224 : reading === "opponent" ? -224 : reading === "battle" ? -306 : 0;
}

function readingText(reading: Reading, relation: NeighborRel): string {
  return reading === "partner"
    ? `partner · same-side ×${relation.same}`
    : reading === "opponent"
      ? `opponent · opposed ×${relation.opposed}`
      : reading === "battle"
        ? `battle-royal contact ×${relation.br}`
        : `mixed · opposed ×${relation.opposed} · same-side ×${relation.same}`;
}

function sharedSummary(entry: SharedConnection, aName: string, bName: string): string {
  return `shared ${entry.reading} · ${aName}: ${readingText(readingOf(entry.a), entry.a)} · ${bName}: ${readingText(readingOf(entry.b), entry.b)}`;
}

function yearOf(day: number): number {
  return new Date(Date.UTC(1900, 0, 1) + day * 86_400_000).getUTCFullYear();
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
