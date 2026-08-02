import {
  M,
  MR,
  RK,
  TK,
  activity01,
  relationColor,
  rgb,
  type MorphLabel,
  type MorphLayoutResult,
  type MorphRegion,
  type MorphRoute,
  type MorphRole,
  type MorphVirtualNode,
} from "@kayfabe/morph-renderer";
import {
  dayToDate,
  isoToDay,
  pairKey,
  type AtlasPersonRoutes,
  type PersonDossier,
} from "@kayfabe/graph-contract";
import type { ChronologyData } from "../../data/chronology/loader";
import type { MorphData, NeighborRel } from "../morphAdapter";
import { PRIORITY, emptyBounds, growBounds, type MorphControlsState } from "./layoutTypes";
import { packBackground } from "./backgroundRack";
import { resample3D, sampleSpatialCurve } from "./routing";

/**
 * 3D CAREER SPINE
 *
 * X is documented time. Promotion lanes are separated in Y and genuine Z,
 * with the career fiber moving between their first documented appearances.
 * Titles dock to the associated promotion/era when the corpus supports that
 * association. Relationship junctions attach to the spine at their first
 * documented shared match; their nearby lane is spatial organization only,
 * never a claim that the match happened in that promotion.
 */

const AXIS_W = 1120;
const LANE_GAP = 82;
const TITLE_DEPTH = 132;
const RELATION_DEPTH = 178;
const TITLE_CAP = 24;
const RELATION_CAP = 28;

const fmtDay = (day: number): string =>
  day < 0 ? "date unavailable" : dayToDate(day).toISOString().slice(0, 10);
const relationStrength = (rel: NeighborRel): number => rel.same + rel.opposed + rel.br;

export function buildCareer(
  data: MorphData,
  personId: string,
  personRoutes: AtlasPersonRoutes | null,
  dossier: PersonDossier | null,
  chronology: ChronologyData | null,
  controls: MorphControlsState,
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
  const virtuals: MorphVirtualNode[] = [];
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

  const selected = data.indexOf(personId);
  if (selected === undefined) throw new Error(`career spine: ${personId} has no corpus node`);
  exclude.add(selected);

  const stints = (personRoutes?.routes ?? [])
    .filter((route) => Number.isFinite(route.firstDay) && Number.isFinite(route.lastDay) && route.firstDay >= 0)
    .map((route) => ({ ...route, lastDay: Math.max(route.firstDay, route.lastDay) }));
  const dossierFirst = dossier?.first ? isoToDay(dossier.first) : NaN;
  const dossierLast = dossier?.last ? isoToDay(dossier.last) : NaN;
  const firstCandidates = [personRoutes?.firstDay, dossierFirst, ...stints.map((route) => route.firstDay)]
    .filter((day): day is number => day !== undefined && Number.isFinite(day) && day >= 0);
  const lastCandidates = [personRoutes?.lastDay, dossierLast, ...stints.map((route) => route.lastDay)]
    .filter((day): day is number => day !== undefined && Number.isFinite(day) && day >= 0);
  const dayMin = firstCandidates.length ? Math.min(...firstCandidates) : data.model.fullDayRange[0];
  const dayMax = Math.max(dayMin + 365, ...(lastCandidates.length ? lastCandidates : [data.model.fullDayRange[1]]));
  const x0 = -AXIS_W / 2;
  const x1 = AXIS_W / 2;
  const clampDay = (day: number) => Math.max(dayMin, Math.min(dayMax, day));
  const xOf = (day: number) => x0 + ((clampDay(day) - dayMin) / Math.max(1, dayMax - dayMin)) * AXIS_W;

  // Stable lane order is first documented appearance, then promotion id.
  const lanePromos: string[] = [];
  const laneOf = new Map<string, number>();
  for (const stint of [...stints].sort((a, b) => a.firstDay - b.firstDay || compareId(a.pr, b.pr))) {
    if (!laneOf.has(stint.pr)) {
      laneOf.set(stint.pr, lanePromos.length);
      lanePromos.push(stint.pr);
    }
  }
  const laneY = (lane: number) => ((lanePromos.length - 1) / 2 - lane) * LANE_GAP;
  const depthSpan = lanePromos.length <= 1
    ? 0
    : Math.min(560, Math.max(180, (lanePromos.length - 1) * 96));
  const laneZ = (lane: number) => lanePromos.length <= 1
    ? 0
    : -depthSpan / 2 + (lane / (lanePromos.length - 1)) * depthSpan;
  const maxStintMatches = Math.max(1, ...stints.map((stint) => stint.matches));

  lanePromos.forEach((promotionId, lane) => {
    const y = laneY(lane);
    const z = laneZ(lane);
    const name = data.nameOf(promotionId) ?? promotionId;
    regions.push({
      key: `career:lane:${promotionId}`,
      x: 0,
      y,
      z: z - 12,
      w: AXIS_W + 24,
      h: 34,
      color: rgb(M.plate),
      alpha: 0.18,
      kind: RK.PLATE,
    });
    routes.push({
      key: `career:axis:${promotionId}`,
      points: resample3D([x0, y, z, x1, y, z]),
      color: rgb(M.promotion),
      width: 0.75,
      alpha: 0.16,
      kind: TK.BUS,
      a: -1,
      b: -1,
    });
    labels.push({
      key: `career:lane:${promotionId}:label`,
      x: x0 - 48,
      y,
      z,
      text: name,
      sub: "promotion lane · documented appearances",
      priority: PRIORITY.header - lane,
      tone: "promotion",
      anchor: "left",
      pick: promotionId,
    });
    placeEntity(
      data,
      promotionId,
      x0 - 58,
      y,
      z,
      5.2,
      0.82,
      MR.PROMO_CONTEXT,
      rgb(M.promotion),
      nodeTargets,
      nodeOpacity,
      nodeScale,
      nodeRole,
      nodeDelay,
      virtuals,
      exclude,
    );
    growBounds(active, 0, y, AXIS_W / 2 + 74);
    minZ = Math.min(minZ, z - 24);
    maxZ = Math.max(maxZ, z + 24);
  });

  // Documented appearance spans remain literal intervals on their own lane.
  const sortedStints = [...stints].sort((a, b) => a.firstDay - b.firstDay || compareId(a.pr, b.pr));
  for (const stint of sortedStints) {
    const lane = laneOf.get(stint.pr)!;
    const y = laneY(lane);
    const z = laneZ(lane) + 3;
    const sx0 = xOf(stint.firstDay);
    const sx1 = Math.max(sx0 + 3, xOf(stint.lastDay));
    regions.push({
      key: `career:span:${stint.pr}:${stint.firstDay}`,
      x: (sx0 + sx1) / 2,
      y,
      z,
      w: sx1 - sx0,
      h: 8 + activity01(stint.matches, maxStintMatches) * 12,
      color: rgb(M.same),
      alpha: 0.3,
      kind: RK.RAIL,
      pick: stint.pr,
    });
    labels.push({
      key: `career:span:${stint.pr}:${stint.firstDay}:label`,
      x: (sx0 + sx1) / 2,
      y: y + 17,
      z,
      text: data.nameOf(stint.pr) ?? stint.pr,
      sub: `${stint.matches.toLocaleString()} documented appearances · ${fmtDay(stint.firstDay)} → ${fmtDay(stint.lastDay)}`,
      priority: PRIORITY.neighborBase + stint.matches / 1e6,
      tone: "neutral",
      pick: stint.pr,
    });
  }

  // The spine visits first documented promotion appearances in chronological
  // order, then lands at the latest documented stint endpoint. This stays
  // monotonic in X even when promotion spans overlap.
  const spine: number[] = [];
  for (const stint of sortedStints) {
    const lane = laneOf.get(stint.pr)!;
    spine.push(xOf(stint.firstDay), laneY(lane), laneZ(lane) + 10);
  }
  if (sortedStints.length) {
    const latest = [...sortedStints].sort((a, b) => b.lastDay - a.lastDay || compareId(a.pr, b.pr))[0]!;
    const lane = laneOf.get(latest.pr)!;
    if (spine.length === 3 || xOf(latest.lastDay) > spine[spine.length - 3]!) {
      spine.push(xOf(latest.lastDay), laneY(lane), laneZ(lane) + 10);
    }
  }
  if (spine.length >= 6) {
    routes.push({
      key: `route:${personId}`,
      points: resample3D(spine),
      color: rgb(M.goldHot),
      width: 3.2,
      alpha: 0.76,
      kind: TK.ROUTE,
      a: selected,
      b: -1,
    });
  } else {
    notes.push("no dated promotion spans are available for a career route");
  }

  const selectedX = spine[0] ?? x0;
  const selectedY = spine[1] ?? 0;
  const selectedZ = spine[2] ?? 0;
  setCorpusNode(selected, selectedX, selectedY, selectedZ, 8.5, 1, MR.SELECTED, 0,
    nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, exclude);
  grow3(selectedX, selectedY, selectedZ, 30);
  labels.push({
    key: `n:${personId}`,
    x: selectedX,
    y: selectedY + 24,
    z: selectedZ,
    text: data.nameOf(personId) ?? personId,
    sub: dossier
      ? `${dossier.m.toLocaleString()} documented matches · ${dossier.first.slice(0, 4)}–${dossier.last.slice(0, 4)}`
      : "documented career spine",
    priority: PRIORITY.selected,
    tone: "person",
    force: true,
    pick: personId,
  });

  // Championships are one canonical node each. The first documented reign is
  // their attachment era; association is never guessed when chronology lacks it.
  const titleEntries = (dossier?.titles ?? [])
    .map((title) => ({
      ...title,
      firstDay: title.reigns.length
        ? Math.min(...title.reigns.map((reign) => isoToDay(reign.s)))
        : -1,
    }))
    .sort((a, b) => {
      const ad = a.firstDay < 0 ? Infinity : a.firstDay;
      const bd = b.firstDay < 0 ? Infinity : b.firstDay;
      return ad - bd || compareId(a.t, b.t);
    });
  const shownTitles = titleEntries.slice(0, TITLE_CAP);
  if (titleEntries.length > shownTitles.length) {
    notes.push(`${titleEntries.length - shownTitles.length} additional documented championships remain in the inspector`);
  }
  const unresolvedY = lanePromos.length ? Math.min(...lanePromos.map((_id, lane) => laneY(lane))) - 96 : -96;
  for (let order = 0; order < shownTitles.length; order++) {
    const title = shownTitles[order]!;
    const titleIndex = chronology?.titleIndex.get(title.t);
    const promotionId = titleIndex !== undefined ? chronology!.titles.pr[titleIndex]! : "";
    const association = titleIndex !== undefined ? chronology!.titles.assoc[titleIndex]! : "unresolved";
    const lane = promotionId && association !== "unresolved" ? laneOf.get(promotionId) : undefined;
    const attached = lane !== undefined;
    const baseY = attached ? laneY(lane) : unresolvedY;
    const baseZ = attached ? laneZ(lane) : 260;
    const day = title.firstDay >= 0 ? title.firstDay : dayMin + ((order + 1) / (shownTitles.length + 1)) * (dayMax - dayMin);
    const x = xOf(day);
    const y = baseY + (attached ? 31 : -(order % 3) * 22);
    const z = baseZ + TITLE_DEPTH + (order % 4) * 18;
    const titleName = titleIndex !== undefined
      ? chronology!.titles.name[titleIndex]!
      : data.nameOf(title.t) ?? title.t;
    regions.push({
      key: `career:title:${title.t}`,
      x,
      y,
      z: z - 5,
      w: 64,
      h: 10,
      color: rgb(M.goldDeep),
      alpha: 0.48,
      kind: RK.GOLD,
      param: 0.5,
      pick: title.t,
    });
    labels.push({
      key: `n:${title.t}`,
      x,
      y: y + 12,
      z,
      text: titleName,
      sub: `${title.reigns.length} documented reign${title.reigns.length === 1 ? "" : "s"} · ${title.firstDay >= 0 ? fmtDay(title.firstDay) : "reign date unavailable"}`,
      detail: attached
        ? `attached to ${data.nameOf(promotionId) ?? promotionId} by ${association} association`
        : "promotion association unresolved in corpus — lane not guessed",
      priority: PRIORITY.context + 30 - order,
      tone: "gold",
      pick: title.t,
    });
    placeEntity(
      data,
      title.t,
      x,
      y,
      z,
      4.2,
      0.9,
      MR.TITLE_CONTEXT,
      rgb(M.gold),
      nodeTargets,
      nodeOpacity,
      nodeScale,
      nodeRole,
      nodeDelay,
      virtuals,
      exclude,
    );
    routes.push({
      key: `ctx:${personId}:${title.t}`,
      points: sampleSpatialCurve(x, baseY, baseZ + 10, x, y, z, 16 + (order % 5) * 4, order * 103 + selected),
      color: rgb(M.gold),
      width: 1.8,
      alpha: 0.4,
      kind: TK.CONTEXT_TITLE,
      a: selected,
      b: data.indexOf(title.t) ?? -1,
    });
    grow3(x, y, z, 34);
  }
  if (shownTitles.some((title) => {
    const i = chronology?.titleIndex.get(title.t);
    return i === undefined || !chronology!.titles.pr[i] || chronology!.titles.assoc[i] === "unresolved" || !laneOf.has(chronology!.titles.pr[i]!);
  })) {
    labels.push({
      key: "career:title:unresolved",
      x: x0 - 48,
      y: unresolvedY,
      z: 260,
      text: "UNRESOLVED TITLE ASSOCIATION",
      sub: "promotion lane not guessed",
      priority: PRIORITY.header - 20,
      tone: "warn",
      anchor: "left",
    });
  }

  // Major relationships occupy front/back temporal junctions. A node listed
  // as both opponent and partner is placed once and explicitly marked mixed.
  const relationById = new Map(data.relationsOf(selected).map((relation) => [relation.id, relation]));
  const requested = new Map<string, { opponent: boolean; partner: boolean; rank: number }>();
  const addRequested = (id: string, kind: "opponent" | "partner", rank: number) => {
    const previous = requested.get(id) ?? { opponent: false, partner: false, rank };
    previous[kind] = true;
    previous.rank = Math.min(previous.rank, rank);
    requested.set(id, previous);
  };
  (dossier?.top.opponents ?? []).forEach(([id], rank) => addRequested(id, "opponent", rank));
  (dossier?.top.partners ?? []).forEach(([id], rank) => addRequested(id, "partner", rank));
  if (requested.size === 0) {
    const ranked = [...relationById.values()].sort((a, b) => relationStrength(b) - relationStrength(a) || compareId(a.id, b.id));
    for (const relation of ranked.slice(0, RELATION_CAP)) {
      addRequested(relation.id, relation.same > relation.opposed ? "partner" : "opponent", requested.size);
    }
  }
  const major = [...requested]
    .map(([id, reading]) => ({ relation: relationById.get(id), reading }))
    .filter((entry): entry is { relation: NeighborRel; reading: { opponent: boolean; partner: boolean; rank: number } } => entry.relation !== undefined)
    .sort((a, b) => a.relation.firstDay - b.relation.firstDay || compareId(a.relation.id, b.relation.id));
  const shownMajor = major.slice(0, RELATION_CAP);
  if (major.length > shownMajor.length) notes.push(`${major.length - shownMajor.length} additional major relationships remain in the inspector`);
  if (shownMajor.length) {
    notes.push("relationship junctions use first documented shared-match time; their nearest lane is spatial context, not an event-level promotion claim");
  }
  const maxRelation = Math.max(1, ...shownMajor.map(({ relation }) => relationStrength(relation)));
  shownMajor.forEach(({ relation, reading }, order) => {
    const lane = nearestLane(stints, laneOf, relation.firstDay);
    const baseY = lane === null ? 0 : laneY(lane);
    const baseZ = lane === null ? 0 : laneZ(lane);
    const mixed = reading.opponent && reading.partner;
    const partner = !reading.opponent && reading.partner;
    const x = xOf(relation.firstDay);
    const y = baseY + (mixed ? 52 : partner ? 38 : -38) + (order % 3 - 1) * 7;
    const z = baseZ + (mixed ? RELATION_DEPTH * 1.25 : partner ? RELATION_DEPTH : -RELATION_DEPTH) + (order % 4) * 9;
    const strength = relationStrength(relation);
    const role = mixed ? MR.MIXED : partner ? MR.PARTNER : MR.OPPONENT;
    setCorpusNode(
      relation.index,
      x,
      y,
      z,
      2.8 + 2.2 * Math.sqrt(strength / maxRelation),
      0.62 + 0.3 * Math.sqrt(strength / maxRelation),
      role,
      0.48 + order / Math.max(1, shownMajor.length) * 0.28,
      nodeTargets,
      nodeOpacity,
      nodeScale,
      nodeRole,
      nodeDelay,
      exclude,
    );
    labels.push({
      key: `n:${relation.id}`,
      x,
      y: y + 11,
      z,
      text: relation.name,
      sub: mixed
        ? `mixed · opposed ×${relation.opposed} · same-side ×${relation.same}`
        : partner
          ? `major partner · documented same-side ×${relation.same}`
          : `major opponent · documented opposed ×${relation.opposed}`,
      detail: `first documented shared match ${fmtDay(relation.firstDay)}`,
      priority: PRIORITY.neighborBase + PRIORITY.neighborSpan - order,
      tone: mixed ? "neutral" : partner ? "cyan" : "ember",
      badge: mixed ? "±" : undefined,
      pick: relation.id,
    });
    routes.push({
      key: pairKey(personId, relation.id),
      points: sampleSpatialCurve(
        x,
        baseY,
        baseZ + 10,
        x,
        y,
        z,
        18 + (order % 7) * 4,
        selected * 131 + relation.index,
      ),
      color: relationColor(relation.same, relation.opposed, relation.br, relation.title),
      width: 1.1 + 1.5 * Math.sqrt(strength / maxRelation),
      alpha: 0.28 + 0.3 * Math.sqrt(strength / maxRelation),
      kind: TK.RELATION,
      a: selected,
      b: relation.index,
    });
    grow3(x, y, z, 22);
  });

  // Sparse decade ticks establish X as time without a dashboard grid.
  const firstYear = dayToDate(dayMin).getUTCFullYear();
  const lastYear = dayToDate(dayMax).getUTCFullYear();
  const tickY = lanePromos.length ? Math.max(...lanePromos.map((_id, lane) => laneY(lane))) + 72 : 72;
  for (let year = Math.ceil(firstYear / 10) * 10; year <= lastYear; year += 10) {
    const x = xOf(isoToDay(`${year}-01-01`));
    regions.push({
      key: `career:tick:${year}`,
      x,
      y: tickY,
      z: 0,
      w: 1.2,
      h: 14,
      color: rgb(M.rule),
      alpha: 0.72,
      kind: RK.TICK,
    });
    labels.push({
      key: `career:tick:${year}:label`,
      x,
      y: tickY + 14,
      z: 0,
      text: String(year),
      priority: PRIORITY.header - 60,
      tone: "muted",
    });
    grow3(x, tickY, 0, 16);
  }

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
    controls.context !== false,
  );
  regions.push(...rack.regions);
  labels.push(...rack.labels);

  return {
    mode: "career",
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
    anchorId: personId,
    representedCount: n,
    expandedCount: 1 + lanePromos.length + shownTitles.length + shownMajor.length,
    notes,
    timeAxis: {
      dayMin,
      dayMax,
      x0,
      x1,
      y0: Math.min(active.minY, -120),
      y1: Math.max(active.maxY, 120),
    },
  };
}

function nearestLane(
  stints: readonly { pr: string; firstDay: number; lastDay: number }[],
  laneOf: ReadonlyMap<string, number>,
  day: number,
): number | null {
  if (!stints.length) return null;
  const ordered = [...stints].sort((a, b) => {
    const aDistance = day < a.firstDay ? a.firstDay - day : day > a.lastDay ? day - a.lastDay : 0;
    const bDistance = day < b.firstDay ? b.firstDay - day : day > b.lastDay ? day - b.lastDay : 0;
    return aDistance - bDistance || a.firstDay - b.firstDay || compareId(a.pr, b.pr);
  });
  return laneOf.get(ordered[0]!.pr) ?? null;
}

function setCorpusNode(
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

function placeEntity(
  data: MorphData,
  id: string,
  x: number,
  y: number,
  z: number,
  scaleValue: number,
  opacityValue: number,
  roleValue: MorphRole,
  color: [number, number, number],
  targets: Float32Array,
  opacity: Float32Array,
  scale: Float32Array,
  role: Uint8Array,
  delay: Float32Array,
  virtuals: MorphVirtualNode[],
  exclude: Set<number>,
): void {
  const index = data.indexOf(id);
  if (index === undefined) {
    virtuals.push({ id, x, y, z, scale: scaleValue, opacity: opacityValue, color, role: roleValue });
    return;
  }
  setCorpusNode(index, x, y, z, scaleValue, opacityValue, roleValue, 0.42,
    targets, opacity, scale, role, delay, exclude);
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
