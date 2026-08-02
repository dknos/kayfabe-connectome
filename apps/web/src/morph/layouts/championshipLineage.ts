import {
  M,
  MR,
  RK,
  TK,
  rgb,
  type LayoutBounds,
  type MorphLabel,
  type MorphLayoutResult,
  type MorphRegion,
  type MorphRoute,
  type MorphVirtualNode,
} from "@kayfabe/morph-renderer";
import {
  dayToDate,
  fnv1a32,
  isoToDay,
  type ChampionshipRecord,
} from "@kayfabe/graph-contract";
import type { ChronologyData } from "../../data/chronology/loader";
import type { MorphData } from "../morphAdapter";
import {
  PRIORITY,
  growBounds,
  type MorphControlsState,
} from "./layoutTypes";
import { packBackground } from "./backgroundRack";
import { sampleSpatialCurve } from "./routing";

/**
 * TITLE LINEAGE — a chronological sculpture rather than a flat timeline.
 *
 * X is time everywhere. Each documented holder occurrence receives an
 * interval-coloured Z lane, so co-holders and overlapping records remain
 * separate under orbit. A person still owns exactly one corpus slot: their
 * node is anchored to their earliest documented occurrence and later history
 * remains visible as gold rails, occurrence labels and routed tethers.
 *
 * Missing graph nodes become one stable virtual entity per listed holder.
 * Gaps are explicitly unrecorded, open endings are open in corpus, and a
 * source without title-change fields never has a lineage invented for it.
 */

const RAIL_Y = 0;
const HEADER_Y = 214;
const TITLE_Z = 168;
const PROMOTION_Z = -168;
const LANE_GAP_Z = 112;
const HOLDER_Y = 82;
const HOLDER_ROW_GAP = 28;
const HOLDER_DEPTH_NUDGE = 28;
const DEPTH_PAD = 36;

const fmtDay = (day: number): string =>
  day < 0 || !Number.isFinite(day) ? "—" : dayToDate(day).toISOString().slice(0, 10);

interface NormalizedReign {
  source: ChampionshipRecord["reigns"][number];
  start: number;
  end: number | null;
  holders: string[];
  key: string;
  order: number;
}

interface HolderOccurrence {
  holderId: string;
  reign: NormalizedReign;
  lane: number;
  laneZ: number;
  key: string;
}

interface HolderSummary {
  id: string;
  occurrences: HolderOccurrence[];
  representative: HolderOccurrence;
  x: number;
  y: number;
  z: number;
  slot: number | undefined;
  rank: number;
}

export function buildLineage(
  data: MorphData,
  titleId: string,
  record: ChampionshipRecord | null,
  chronology: ChronologyData | null,
  controls: Pick<MorphControlsState, "context"> = { context: true },
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
  const board = emptyBounds3();
  const exclude = new Set<number>();

  const ti = chronology?.titleIndex.get(titleId);
  const name =
    (ti !== undefined ? chronology!.titles.name[ti] : null) ??
    data.nameOf(titleId) ??
    titleId;
  const artifact =
    ti !== undefined
      ? chronology!.titles.artifact[ti] === 1
      : (record?.artifact ?? false);
  const lineageKind =
    ti !== undefined ? chronology!.titles.lineage[ti]! : "derived";
  const prId =
    record?.pr && record.pr !== ""
      ? record.pr
      : ti !== undefined
        ? chronology!.titles.pr[ti]!
        : "";
  const assoc = ti !== undefined ? chronology!.titles.assoc[ti]! : "unresolved";
  const titleMatches =
    ti !== undefined
      ? chronology!.titles.titleMatches[ti]!
      : (record?.titleMatches ?? 0);

  const normalized = normalizeReigns(
    lineageKind === "no-changes" ? [] : (record?.reigns ?? []),
    notes,
  );
  const chronologySuppressed =
    lineageKind === "no-changes" && (record?.reigns.length ?? 0) > 0;
  if (chronologySuppressed) {
    notes.push(
      "title-change records were ignored because this source has no title-change field; no lineage was invented",
    );
  }

  const tFirst = ti !== undefined ? chronology!.titles.firstDay[ti]! : -1;
  const tLast = ti !== undefined ? chronology!.titles.lastDay[ti]! : -1;
  const documentedDays = normalized.flatMap((r) =>
    r.end === null ? [r.start] : [r.start, r.end],
  );
  if (Number.isFinite(tFirst) && tFirst >= 0) documentedDays.push(tFirst);
  if (Number.isFinite(tLast) && tLast >= 0) documentedDays.push(tLast);
  const fallbackMin = finiteDay(data.model.fullDayRange[0], 0);
  const fallbackMax = finiteDay(data.model.fullDayRange[1], fallbackMin + 365);
  const dayMin = documentedDays.length
    ? Math.min(...documentedDays)
    : Math.min(fallbackMin, fallbackMax);
  const dayMax = documentedDays.length
    ? Math.max(dayMin + 365, ...documentedDays)
    : Math.max(dayMin + 365, fallbackMax);

  // Long lineages receive more X room, but never become an unbounded wall.
  const railWidth = Math.min(2240, Math.max(960, normalized.length * 28));
  const x0 = -railWidth / 2;
  const x1 = railWidth / 2;
  const xOf = (day: number): number =>
    x0 + ((day - dayMin) / Math.max(1, dayMax - dayMin)) * railWidth;

  const titleX = x0 + 28;
  const titleIdx = data.indexOf(titleId);
  regions.push({
    key: "cl:header",
    x: 0,
    y: HEADER_Y,
    z: TITLE_Z - 10,
    w: railWidth,
    h: 42,
    color: rgb(M.plateLit),
    alpha: 0.72,
    kind: RK.HEADER,
    pick: titleId,
  });
  if (titleIdx !== undefined) {
    writeNode(
      titleIdx,
      titleX,
      HEADER_Y,
      TITLE_Z,
      6.4,
      1,
      MR.SELECTED,
      0,
      nodeTargets,
      nodeOpacity,
      nodeScale,
      nodeRole,
      nodeDelay,
    );
    exclude.add(titleIdx);
  } else {
    virtuals.push({
      id: titleId,
      x: titleX,
      y: HEADER_Y,
      z: TITLE_Z,
      scale: 6.4,
      opacity: 1,
      color: rgb(M.gold),
      role: MR.SELECTED,
    });
  }
  labels.push({
    key: `n:${titleId}`,
    x: 0,
    y: HEADER_Y + 30,
    z: TITLE_Z,
    text: name,
    sub:
      `${normalized.length > 0 ? `${normalized.length} documented reign records` : "no documented reigns"} · ` +
      `${titleMatches} documented title matches · ${fmtDay(tFirst)} → ${fmtDay(tLast)}`,
    detail: artifact
      ? "source artifact — name preserved as recorded, not repaired"
      : undefined,
    badge: artifact ? "!" : undefined,
    priority: PRIORITY.selected,
    tone: artifact ? "warn" : "gold",
    force: true,
    pick: titleId,
  });
  grow3(board, 0, HEADER_Y, TITLE_Z, railWidth / 2 + 24, DEPTH_PAD);

  // Promotion is a contextual anchor behind the title, not a match edge.
  if (prId) {
    const prName = data.nameOf(prId) ?? prId;
    const prIdx = data.indexOf(prId);
    const px = x1 - 60;
    const py = HEADER_Y + 62;
    if (prIdx !== undefined) {
      writeNode(
        prIdx,
        px,
        py,
        PROMOTION_Z,
        5,
        0.76,
        MR.PROMO_CONTEXT,
        0.4,
        nodeTargets,
        nodeOpacity,
        nodeScale,
        nodeRole,
        nodeDelay,
      );
      exclude.add(prIdx);
    } else {
      virtuals.push({
        id: prId,
        x: px,
        y: py,
        z: PROMOTION_Z,
        scale: 5,
        opacity: 0.72,
        color: rgb(M.promotion),
        role: MR.PROMO_CONTEXT,
      });
    }
    labels.push({
      key: `n:${prId}`,
      x: px,
      y: py + 14,
      z: PROMOTION_Z,
      text: prName,
      sub:
        assoc === "dominant"
          ? "associated by documented title activity"
          : assoc === "registry"
            ? "registry association"
            : "association unresolved",
      priority: PRIORITY.context,
      tone: "promotion",
      pick: prId,
    });
    routes.push({
      key: `ctx:${titleId}:${prId}`,
      points: sampleSpatialCurve(
        titleX,
        HEADER_Y,
        TITLE_Z,
        px,
        py,
        PROMOTION_Z,
        22,
        fnv1a32(`${titleId}|${prId}`),
      ),
      color: rgb(M.promotion),
      width: 1.3,
      alpha: 0.3,
      kind: TK.CONTEXT_PROMO,
      a: titleIdx ?? -1,
      b: prIdx ?? -1,
    });
    grow3(board, px, py, PROMOTION_Z, 42, DEPTH_PAD);
  }

  // The zero-depth rail makes the global time direction legible while holder
  // strands separate forward/backward from it.
  regions.push({
    key: "cl:rail",
    x: 0,
    y: RAIL_Y,
    z: 0,
    w: railWidth + 20,
    h: 4,
    color: rgb(M.goldDeep),
    alpha: 0.38,
    kind: RK.RAIL,
  });
  grow3(board, x0, RAIL_Y, 0, 30, DEPTH_PAD);
  grow3(board, x1, RAIL_Y, 0, 30, DEPTH_PAD);

  const firstYear = dayToDate(dayMin).getUTCFullYear();
  const lastYear = dayToDate(dayMax).getUTCFullYear();
  for (
    let year = Math.ceil(firstYear / 10) * 10;
    year <= lastYear;
    year += 10
  ) {
    const x = xOf(isoToDay(`${year}-01-01`));
    regions.push({
      key: `cl:tick:${year}`,
      x,
      y: RAIL_Y - 18,
      z: 0,
      w: 1.4,
      h: 12,
      color: rgb(M.rule),
      alpha: 0.8,
      kind: RK.TICK,
    });
    labels.push({
      key: `cl:tick:${year}:l`,
      x,
      y: RAIL_Y - 30,
      z: 0,
      text: String(year),
      priority: PRIORITY.header - 50,
      tone: "muted",
    });
  }

  addUnrecordedGaps(
    titleId,
    normalized,
    dayMin,
    dayMax,
    xOf,
    regions,
    labels,
    board,
  );

  const occurrences = allocateOccurrenceLanes(titleId, normalized, dayMax);
  const summaries = summarizeHolders(occurrences, xOf, data);

  // Write each corpus holder exactly once, at the deterministic earliest
  // documented occurrence. Later reigns never overwrite this canonical slot.
  for (const summary of summaries) {
    const holderName = data.nameOf(summary.id) ?? summary.id;
    if (summary.slot !== undefined) {
      writeNode(
        summary.slot,
        summary.x,
        summary.y,
        summary.z,
        4.2,
        0.96,
        MR.HOLDER,
        0.14 + 0.4 * (summary.rank / Math.max(1, summaries.length - 1)),
        nodeTargets,
        nodeOpacity,
        nodeScale,
        nodeRole,
        nodeDelay,
      );
      exclude.add(summary.slot);
    } else {
      virtuals.push({
        id: summary.id,
        x: summary.x,
        y: summary.y,
        z: summary.z,
        scale: 4.2,
        opacity: 0.94,
        color: rgb(M.text),
        role: MR.HOLDER,
      });
    }

    const first = summary.occurrences[0]!.reign;
    const latest = summary.occurrences.reduce(
      (best, occurrence) =>
        effectiveEnd(occurrence.reign, dayMax) > effectiveEnd(best, dayMax)
          ? occurrence.reign
          : best,
      first,
    );
    const missingReason =
      summary.slot === undefined
        ? "listed in documented title-change records but has no graph-resident node in the current corpus, so there is no corpus node to illuminate; source identifier retained"
        : undefined;
    labels.push({
      key: `n:${summary.id}`,
      x: summary.x,
      y: summary.y + (summary.y >= 0 ? 13 : -13),
      z: summary.z,
      text: holderName,
      sub:
        `${summary.occurrences.length} documented ${summary.occurrences.length === 1 ? "reign" : "reigns"} · ` +
        `${fmtDay(first.start)} → ${latest.end === null ? "open in corpus" : fmtDay(latest.end)}`,
      detail: missingReason ?? "node anchored at earliest documented reign; every recorded reign remains on the gold rails",
      badge: summary.slot === undefined ? "NO GRAPH NODE" : undefined,
      priority: PRIORITY.neighborBase + PRIORITY.neighborSpan * 0.8,
      tone: summary.slot === undefined ? "warn" : "person",
      force: summary.slot === undefined,
      pick: summary.id,
    });
    grow3(board, summary.x, summary.y, summary.z, 36, DEPTH_PAD);
  }

  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  for (const occurrence of occurrences) {
    const summary = summaryById.get(occurrence.holderId)!;
    const reign = occurrence.reign;
    const sx = xOf(reign.start);
    const ex =
      reign.end === null
        ? x1
        : Math.max(xOf(reign.end), sx + 4);
    const mx = (sx + ex) / 2;
    const open = reign.end === null;
    const holderName = data.nameOf(occurrence.holderId) ?? occurrence.holderId;
    const reignCountForHolder = summary.occurrences.length;
    const occurrenceIndex = summary.occurrences.indexOf(occurrence) + 1;
    const isCoHolder = reign.holders.length > 1;

    // A quiet under-rail keeps depth lanes readable without whole-scene bloom.
    regions.push({
      key: `cl:underlay:${occurrence.key}`,
      x: mx,
      y: RAIL_Y,
      z: occurrence.laneZ - 2,
      w: ex - sx,
      h: 18,
      color: rgb(M.goldDeep),
      alpha: 0.16,
      kind: RK.RAIL,
    });
    regions.push({
      key: occurrence.key,
      x: mx,
      y: RAIL_Y,
      z: occurrence.laneZ,
      w: ex - sx,
      h: 9,
      color: rgb(open ? M.goldHot : M.gold),
      alpha: open ? 0.88 : 0.82,
      kind: open ? RK.OPEN : RK.GOLD,
      param: 0.7,
      pick: occurrence.holderId,
    });
    labels.push({
      key: `${occurrence.key}:label`,
      x: mx,
      y: RAIL_Y + (summary.y >= 0 ? 20 : -20),
      z: occurrence.laneZ,
      text: holderName,
      sub:
        `${fmtDay(reign.start)} → ${open ? "open in corpus" : fmtDay(reign.end!)}` +
        (isCoHolder ? " · documented co-holder" : "") +
        (reignCountForHolder > 1
          ? ` · reign ${occurrenceIndex}/${reignCountForHolder}`
          : ""),
      detail:
        `supporting record ${reign.source.m}` +
        (summary.slot === undefined
          ? " · listed holder has no graph-resident node in the current corpus"
          : ""),
      priority:
        PRIORITY.neighborBase +
        PRIORITY.neighborSpan *
          (1 - reign.order / Math.max(1, normalized.length)),
      tone: summary.slot === undefined ? "warn" : "gold",
      pick: occurrence.holderId,
    });
    routes.push({
      key: `ctx:${occurrence.key}`,
      points: sampleSpatialCurve(
        mx,
        RAIL_Y,
        occurrence.laneZ,
        summary.x,
        summary.y,
        summary.z,
        12 + Math.abs(occurrence.lane) * 5,
        fnv1a32(`${titleId}|${occurrence.key}`),
      ),
      color: rgb(M.gold),
      width: 1.25,
      alpha: 0.42,
      kind: TK.CONTEXT_TITLE,
      a: titleIdx ?? -1,
      b: summary.slot ?? -1,
    });
    grow3(board, sx, RAIL_Y, occurrence.laneZ, 28, DEPTH_PAD);
    grow3(board, ex, RAIL_Y, occurrence.laneZ, 28, DEPTH_PAD);
  }

  // Reign records without a listed holder remain visible but make no person
  // claim. They get their own neutral rail and an explicit source limitation.
  for (const reign of normalized.filter((item) => item.holders.length === 0)) {
    const sx = xOf(reign.start);
    const ex = reign.end === null ? x1 : Math.max(xOf(reign.end), sx + 4);
    regions.push({
      key: `cl:reign:${titleId}:${reign.key}`,
      x: (sx + ex) / 2,
      y: RAIL_Y,
      z: 0,
      w: ex - sx,
      h: 9,
      color: rgb(M.goldDeep),
      alpha: 0.58,
      kind: reign.end === null ? RK.OPEN : RK.GOLD,
      pick: titleId,
    });
    labels.push({
      key: `cl:reign:${titleId}:${reign.key}:unlisted`,
      x: (sx + ex) / 2,
      y: RAIL_Y + 20,
      z: 0,
      text: "holder not listed in record",
      sub: `${fmtDay(reign.start)} → ${reign.end === null ? "open in corpus" : fmtDay(reign.end)}`,
      detail: `supporting record ${reign.source.m}; no holder identity was supplied`,
      priority: PRIORITY.neighborBase,
      tone: "warn",
      pick: titleId,
    });
  }

  if (normalized.length === 0) {
    const why =
      lineageKind === "no-changes"
        ? "the source for this belt has no title-change field — reigns are not derived and not guessed"
        : "the source recorded no reigns for this belt";
    labels.push({
      key: "cl:noreigns",
      x: 0,
      y: RAIL_Y + 44,
      z: 0,
      text: "no documented reign records",
      sub: why,
      priority: PRIORITY.header,
      tone: "warn",
      force: true,
    });
    notes.push(why);
    grow3(board, 0, RAIL_Y + 44, 0, 30, DEPTH_PAD);
  }

  const fitBounds: LayoutBounds = {
    minX: board.minX,
    maxX: board.maxX,
    minY: board.minY,
    maxY: board.maxY,
    minZ: board.minZ,
    maxZ: board.maxZ,
  };
  // Curved tethers can fan beyond their endpoints in Z. Include their actual
  // sampled geometry so Fit frames what the renderer really draws.
  expandDepthBounds(
    fitBounds,
    nodeTargets,
    nodeOpacity,
    virtuals,
    routes,
    regions,
    labels,
  );
  const bounds: LayoutBounds = { ...fitBounds };
  const rack = packBackground(
    data,
    exclude,
    board,
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
  expandDepthBounds(
    bounds,
    nodeTargets,
    nodeOpacity,
    virtuals,
    routes,
    regions,
    labels,
  );

  return {
    mode: "lineage",
    nodeTargets,
    nodeOpacity,
    nodeScale,
    nodeRole,
    nodeDelay,
    virtuals,
    routes,
    labels,
    regions,
    bounds,
    fitBounds,
    anchorId: titleId,
    representedCount: n,
    expandedCount: summaries.length + (prId ? 2 : 1),
    notes,
    timeAxis: {
      dayMin,
      dayMax,
      x0,
      x1,
      y0: RAIL_Y - 48,
      y1: HEADER_Y + 90,
    },
  };
}

function normalizeReigns(
  input: ChampionshipRecord["reigns"],
  notes: string[],
): NormalizedReign[] {
  let invalid = 0;
  const parsed = input
    .map((source, sourceOrder) => {
      const start = isoToDay(source.s);
      const end = source.e === null ? null : isoToDay(source.e);
      if (
        !Number.isFinite(start) ||
        (end !== null && (!Number.isFinite(end) || end < start))
      ) {
        invalid++;
        return null;
      }
      return {
        source,
        start,
        end,
        holders: [...new Set(source.holders)].sort(),
        sourceOrder,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort(
      (a, b) =>
        a.start - b.start ||
        effectiveSortEnd(a.end) - effectiveSortEnd(b.end) ||
        a.holders.join("\u0000").localeCompare(b.holders.join("\u0000")) ||
        a.source.m.localeCompare(b.source.m) ||
        a.sourceOrder - b.sourceOrder,
    );

  const startTotals = new Map<string, number>();
  for (const reign of parsed) {
    startTotals.set(reign.source.s, (startTotals.get(reign.source.s) ?? 0) + 1);
  }
  const startSeen = new Map<string, number>();
  const normalized = parsed.map((reign, order): NormalizedReign => {
    const seen = startSeen.get(reign.source.s) ?? 0;
    startSeen.set(reign.source.s, seen + 1);
    const suffix = (startTotals.get(reign.source.s) ?? 0) > 1 ? `:${seen + 1}` : "";
    return {
      source: reign.source,
      start: reign.start,
      end: reign.end,
      holders: reign.holders,
      key: `${reign.source.s}${suffix}`,
      order,
    };
  });
  if (invalid > 0) {
    notes.push(
      `${invalid} reign ${invalid === 1 ? "record was" : "records were"} omitted because documented dates were invalid`,
    );
  }
  return normalized;
}

function allocateOccurrenceLanes(
  titleId: string,
  reigns: NormalizedReign[],
  dayMax: number,
): HolderOccurrence[] {
  const laneEnds: number[] = [];
  const out: HolderOccurrence[] = [];
  for (const reign of reigns) {
    for (let holderOrder = 0; holderOrder < reign.holders.length; holderOrder++) {
      const holderId = reign.holders[holderOrder]!;
      let lane = laneEnds.findIndex((end) => end <= reign.start);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(Number.NEGATIVE_INFINITY);
      }
      laneEnds[lane] = effectiveEnd(reign, dayMax);
      const signedLane = signedLaneOf(lane);
      out.push({
        holderId,
        reign,
        lane: signedLane,
        laneZ: signedLane * LANE_GAP_Z,
        key:
          holderOrder === 0
            ? `cl:reign:${titleId}:${reign.key}`
            : `cl:reign:${titleId}:${reign.key}:co:${holderOrder + 1}:${holderId}`,
      });
    }
  }
  return out;
}

function summarizeHolders(
  occurrences: HolderOccurrence[],
  xOf: (day: number) => number,
  data: MorphData,
): HolderSummary[] {
  const byHolder = new Map<string, HolderOccurrence[]>();
  for (const occurrence of occurrences) {
    let list = byHolder.get(occurrence.holderId);
    if (!list) byHolder.set(occurrence.holderId, (list = []));
    list.push(occurrence);
  }
  const ordered = [...byHolder.entries()].sort(
    ([aId, a], [bId, b]) =>
      a[0]!.reign.start - b[0]!.reign.start || aId.localeCompare(bId),
  );
  return ordered.map(([id, holderOccurrences], rank) => {
    // Occurrences arrive in deterministic chronology order. The earliest is
    // the canonical representative and is the only one allowed to write the
    // corpus node slot.
    const representative = holderOccurrences[0]!;
    const end =
      representative.reign.end === null
        ? representative.reign.start + 365
        : representative.reign.end;
    // Alternating sorted holders guarantees real above/below shelves; the
    // chronological rank and id tie-break make the choice deterministic.
    const side = rank % 2 === 0 ? 1 : -1;
    const y = side * (HOLDER_Y + (Math.floor(rank / 2) % 3) * HOLDER_ROW_GAP);
    return {
      id,
      occurrences: holderOccurrences,
      representative,
      x: (xOf(representative.reign.start) + xOf(end)) / 2,
      y,
      z: representative.laneZ + side * HOLDER_DEPTH_NUDGE,
      slot: data.indexOf(id),
      rank,
    };
  });
}

function addUnrecordedGaps(
  titleId: string,
  reigns: NormalizedReign[],
  dayMin: number,
  dayMax: number,
  xOf: (day: number) => number,
  regions: MorphRegion[],
  labels: MorphLabel[],
  board: Bounds3,
): void {
  if (reigns.length === 0) return;
  let coveredUntil = dayMin;
  for (const reign of reigns) {
    addGap(titleId, coveredUntil, reign.start, xOf, regions, labels, board);
    const end = effectiveEnd(reign, dayMax);
    coveredUntil = Math.max(coveredUntil, end);
  }
  // An open record covers the remaining corpus span because its end is
  // explicitly unknown. A closed final record leaves an honest trailing gap.
  addGap(titleId, coveredUntil, dayMax, xOf, regions, labels, board);
}

function addGap(
  titleId: string,
  from: number,
  to: number,
  xOf: (day: number) => number,
  regions: MorphRegion[],
  labels: MorphLabel[],
  board: Bounds3,
): void {
  if (to - from <= 45) return;
  const gx0 = xOf(from);
  const gx1 = xOf(to);
  const key = `cl:gap:${titleId}:${from}:${to}`;
  regions.push({
    key,
    x: (gx0 + gx1) / 2,
    y: RAIL_Y,
    z: 0,
    w: gx1 - gx0,
    h: 14,
    color: rgb(M.dim),
    alpha: 0.5,
    kind: RK.HATCH,
  });
  if (to - from > 365) {
    labels.push({
      key: `${key}:label`,
      x: (gx0 + gx1) / 2,
      y: RAIL_Y - 18,
      z: 0,
      text: "unrecorded gap",
      sub: `${fmtDay(from)} → ${fmtDay(to)} — no reign record in corpus`,
      priority: PRIORITY.neighborBase - 10,
      tone: "warn",
    });
  }
  grow3(board, (gx0 + gx1) / 2, RAIL_Y, 0, (gx1 - gx0) / 2, DEPTH_PAD);
}

function writeNode(
  slot: number,
  x: number,
  y: number,
  z: number,
  size: number,
  alpha: number,
  roleValue: number,
  delayValue: number,
  targets: Float32Array,
  opacity: Float32Array,
  scale: Float32Array,
  role: Uint8Array,
  delay: Float32Array,
): void {
  const i3 = slot * 3;
  targets[i3] = x;
  targets[i3 + 1] = y;
  targets[i3 + 2] = z;
  opacity[slot] = alpha;
  scale[slot] = size;
  role[slot] = roleValue;
  delay[slot] = delayValue;
}

interface Bounds3 extends LayoutBounds {
  minZ: number;
  maxZ: number;
}

function emptyBounds3(): Bounds3 {
  return {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
}

function grow3(
  bounds: Bounds3,
  x: number,
  y: number,
  z: number,
  padXY = 0,
  padZ = 0,
): void {
  growBounds(bounds, x, y, padXY);
  bounds.minZ = Math.min(bounds.minZ, z - padZ);
  bounds.maxZ = Math.max(bounds.maxZ, z + padZ);
}

function expandDepthBounds(
  bounds: LayoutBounds,
  targets: Float32Array,
  opacity: Float32Array,
  virtuals: MorphVirtualNode[],
  routes: MorphRoute[],
  regions: MorphRegion[],
  labels: MorphLabel[],
): void {
  let minZ = Number.isFinite(bounds.minZ) ? bounds.minZ! : Infinity;
  let maxZ = Number.isFinite(bounds.maxZ) ? bounds.maxZ! : -Infinity;
  for (let i = 0; i < opacity.length; i++) {
    if (opacity[i]! <= 0) continue;
    const z = targets[i * 3 + 2]!;
    if (Number.isFinite(z)) {
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  for (const virtual of virtuals) {
    minZ = Math.min(minZ, virtual.z);
    maxZ = Math.max(maxZ, virtual.z);
  }
  for (const route of routes) {
    for (let i = 2; i < route.points.length; i += 3) {
      minZ = Math.min(minZ, route.points[i]!);
      maxZ = Math.max(maxZ, route.points[i]!);
    }
  }
  for (const region of regions) {
    minZ = Math.min(minZ, region.z);
    maxZ = Math.max(maxZ, region.z);
  }
  for (const label of labels) {
    minZ = Math.min(minZ, label.z);
    maxZ = Math.max(maxZ, label.z);
  }
  bounds.minZ = Number.isFinite(minZ) ? minZ : 0;
  bounds.maxZ = Number.isFinite(maxZ) ? maxZ : 0;
}

function signedLaneOf(lane: number): number {
  if (lane === 0) return 0;
  const distance = Math.ceil(lane / 2);
  return lane % 2 === 1 ? distance : -distance;
}

function effectiveEnd(reign: NormalizedReign, dayMax: number): number {
  return reign.end === null ? dayMax : reign.end;
}

function effectiveSortEnd(end: number | null): number {
  return end === null ? Number.MAX_SAFE_INTEGER : end;
}

function finiteDay(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
