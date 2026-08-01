import {
  M,
  MR,
  RK,
  TK,
  rgb,
  type MorphLabel,
  type MorphLayoutResult,
  type MorphRegion,
  type MorphRoute,
  type MorphVirtualNode,
} from "@kayfabe/morph-renderer";
import { dayToDate, isoToDay, type ChampionshipRecord } from "@kayfabe/graph-contract";
import type { AtlasData } from "../../atlas/atlasLoader";
import type { MorphData } from "../morphAdapter";
import { PRIORITY, Z, emptyBounds, growBounds } from "./layoutTypes";
import { packBackground } from "./backgroundRack";
import { routeOrthoV } from "./routing";

/**
 * CHAMPIONSHIP LINEAGE — one belt as a central chronological gold rail.
 * Documented reigns become segments; unknown endings stay open ("open in
 * corpus"); holes between records stay literal, inspectable "unrecorded"
 * gaps — never called vacancies. Source-artifact names are preserved with a
 * persistent warning. csv-sourced belts have no title-change field: reigns
 * are absent because the source cannot record them, and the board says so.
 */

const fmtDay = (day: number): string => (day < 0 ? "—" : dayToDate(day).toISOString().slice(0, 10));

const RAIL_Y = 0;

export function buildLineage(
  data: MorphData,
  titleId: string,
  record: ChampionshipRecord | null,
  atlas: AtlasData | null,
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
  const board = emptyBounds();
  const exclude = new Set<number>();

  const ti = atlas?.titleIndex.get(titleId);
  const name = (ti !== undefined ? atlas!.titles.name[ti] : null) ?? data.nameOf(titleId) ?? titleId;
  const artifact = ti !== undefined ? atlas!.titles.artifact[ti] === 1 : (record?.artifact ?? false);
  const lineageKind = ti !== undefined ? atlas!.titles.lineage[ti]! : "derived";
  const prId = record?.pr && record.pr !== "" ? record.pr : ti !== undefined ? atlas!.titles.pr[ti]! : "";
  const assoc = ti !== undefined ? atlas!.titles.assoc[ti]! : "unresolved";
  const titleMatches = ti !== undefined ? atlas!.titles.titleMatches[ti]! : (record?.titleMatches ?? 0);

  const reigns = (record?.reigns ?? []).slice().sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  // a 75-reign lineage needs room — the rail widens with the record
  const RAIL_W = Math.min(2100, Math.max(960, reigns.length * 26));
  const days = reigns.flatMap((r) => [isoToDay(r.s), r.e ? isoToDay(r.e) : -1]).filter((d) => d >= 0);
  const tFirst = ti !== undefined ? atlas!.titles.firstDay[ti]! : -1;
  const tLast = ti !== undefined ? atlas!.titles.lastDay[ti]! : -1;
  if (tFirst >= 0) days.push(tFirst);
  if (tLast >= 0) days.push(tLast);
  const dayMin = days.length ? Math.min(...days) : data.model.fullDayRange[0];
  const dayMax = days.length ? Math.max(dayMin + 365, Math.max(...days)) : data.model.fullDayRange[1];
  const x0 = -RAIL_W / 2;
  const x1 = RAIL_W / 2;
  const xOf = (day: number) => x0 + ((day - dayMin) / Math.max(1, dayMax - dayMin)) * (x1 - x0);

  // ---------- header ----------
  const headerY = 170;
  regions.push({
    key: "cl:header", x: 0, y: headerY, z: Z.backplate + 1, w: RAIL_W, h: 42,
    color: rgb(M.plateLit), alpha: 0.8, kind: RK.HEADER, pick: titleId,
  });
  const titleIdx = data.indexOf(titleId);
  if (titleIdx !== undefined) {
    nodeTargets[titleIdx * 3] = -RAIL_W / 2 + 24;
    nodeTargets[titleIdx * 3 + 1] = headerY;
    nodeTargets[titleIdx * 3 + 2] = Z.chip;
    nodeOpacity[titleIdx] = 1;
    nodeScale[titleIdx] = 6.4;
    nodeRole[titleIdx] = MR.SELECTED;
    nodeDelay[titleIdx] = 0;
    exclude.add(titleIdx);
  } else {
    virtuals.push({
      id: titleId, x: -RAIL_W / 2 + 24, y: headerY, z: Z.chip, scale: 6.4, opacity: 1,
      color: rgb(M.gold), role: MR.SELECTED,
    });
  }
  labels.push({
    key: `n:${titleId}`, x: 0, y: headerY + 30, z: Z.chip,
    text: name,
    sub:
      `${reigns.length > 0 ? `${reigns.length} documented reigns` : "no documented reigns"} · ` +
      `${titleMatches} documented title matches · ${fmtDay(tFirst)} → ${fmtDay(tLast)}`,
    detail: artifact ? "source artifact — name preserved as recorded, not repaired" : undefined,
    badge: artifact ? "!" : undefined,
    priority: PRIORITY.selected, tone: artifact ? "warn" : "gold", force: true, pick: titleId,
  });
  growBounds(board, 0, headerY, RAIL_W / 2 + 24);

  // promotion context — contextual, dashed, never a match edge
  if (prId) {
    const prName = data.nameOf(prId) ?? prId;
    const prIdx = data.indexOf(prId);
    const px = RAIL_W / 2 - 60;
    const py = headerY + 56;
    if (prIdx !== undefined) {
      nodeTargets[prIdx * 3] = px;
      nodeTargets[prIdx * 3 + 1] = py;
      nodeTargets[prIdx * 3 + 2] = Z.chip;
      nodeOpacity[prIdx] = 0.75;
      nodeScale[prIdx] = 5;
      nodeRole[prIdx] = MR.PROMO_CONTEXT;
      nodeDelay[prIdx] = 0.4;
      exclude.add(prIdx);
    } else {
      virtuals.push({
        id: prId, x: px, y: py, z: Z.chip, scale: 5, opacity: 0.7,
        color: rgb(M.promotion), role: MR.PROMO_CONTEXT,
      });
    }
    labels.push({
      key: `n:${prId}`, x: px, y: py + 12, z: Z.chip,
      text: prName,
      sub: assoc === "dominant" ? "associated by documented title activity" : assoc === "registry" ? "registry association" : "association unresolved",
      priority: PRIORITY.context, tone: "promotion", pick: prId,
    });
    routes.push({
      key: `ctx:${titleId}:${prId}`,
      points: routeOrthoV(-RAIL_W / 2 + 24, headerY + 8, px, py - 8, headerY + 34, Z.trace),
      color: rgb(M.promotion), width: 1.3, alpha: 0.32, kind: TK.CONTEXT_PROMO,
      a: titleIdx ?? -1, b: prIdx ?? -1,
    });
    growBounds(board, px, py, 40);
  }

  // ---------- the gold rail ----------
  regions.push({
    key: "cl:rail", x: 0, y: RAIL_Y, z: Z.rail - 1, w: RAIL_W + 20, h: 4,
    color: rgb(M.goldDeep), alpha: 0.5, kind: RK.RAIL,
  });
  // decade ticks
  for (let year = Math.ceil(dayToDate(dayMin).getUTCFullYear() / 10) * 10; year <= dayToDate(dayMax).getUTCFullYear(); year += 10) {
    const x = xOf(isoToDay(`${year}-01-01`));
    regions.push({
      key: `cl:tick:${year}`, x, y: RAIL_Y - 18, z: Z.rail, w: 1.4, h: 12,
      color: rgb(M.rule), alpha: 0.8, kind: RK.TICK,
    });
    labels.push({
      key: `cl:tick:${year}:l`, x, y: RAIL_Y - 30, z: Z.rail,
      text: String(year), priority: PRIORITY.header - 50, tone: "muted",
    });
  }

  // ---------- reign segments, holder chips, gaps ----------
  let prevEnd: number | null = null;
  let holderRow = 0;
  reigns.forEach((reign, i) => {
    const s = isoToDay(reign.s);
    const e = reign.e ? isoToDay(reign.e) : null;
    const sx = xOf(s);
    const ex = e !== null ? Math.max(xOf(e), sx + 4) : x1;
    const open = e === null;

    // unrecorded gap before this reign — a literal hole, not a vacancy
    if (prevEnd !== null && s - prevEnd > 45) {
      const gx0 = xOf(prevEnd);
      regions.push({
        key: `cl:gap:${prevEnd}`, x: (gx0 + sx) / 2, y: RAIL_Y, z: Z.rail, w: sx - gx0, h: 14,
        color: rgb(M.dim), alpha: 0.5, kind: RK.HATCH,
      });
      if (s - prevEnd > 365) {
        labels.push({
          key: `cl:gap:${prevEnd}:l`, x: (gx0 + sx) / 2, y: RAIL_Y - 14, z: Z.rail,
          text: "unrecorded gap",
          sub: `${fmtDay(prevEnd)} → ${fmtDay(s)} — no reign record in corpus`,
          priority: PRIORITY.neighborBase - 10, tone: "warn",
        });
      }
    }
    prevEnd = e;

    regions.push({
      key: `cl:reign:${reign.s}`, x: (sx + ex) / 2, y: RAIL_Y, z: Z.rail, w: ex - sx, h: 16,
      color: rgb(M.goldDeep), alpha: 0.6, kind: open ? RK.OPEN : RK.GOLD, param: 0.5,
      pick: reign.holders[0],
    });

    reign.holders.forEach((holderId, h) => {
      const idx = data.indexOf(holderId);
      const hy = RAIL_Y + 30 + (holderRow % 4) * 30 + h * 22;
      const holderName = data.nameOf(holderId) ?? holderId;
      if (idx !== undefined) {
        nodeTargets[idx * 3] = (sx + ex) / 2;
        nodeTargets[idx * 3 + 1] = hy;
        nodeTargets[idx * 3 + 2] = Z.chip;
        nodeOpacity[idx] = 0.9;
        nodeScale[idx] = 3.6;
        nodeRole[idx] = MR.HOLDER;
        nodeDelay[idx] = 0.15 + 0.4 * (i / Math.max(1, reigns.length));
        exclude.add(idx);
      }
      const dur = e !== null ? e - s : null;
      labels.push({
        key: `cl:holder:${reign.s}:${holderId}`,
        x: (sx + ex) / 2, y: hy + 9, z: Z.chip,
        text: holderName,
        sub: open ? `${fmtDay(s)} → open in corpus` : `${fmtDay(s)} → ${fmtDay(e!)}${dur !== null ? ` · ${dur}d documented` : ""}`,
        detail: `supporting record ${reign.m}`,
        priority: PRIORITY.neighborBase + PRIORITY.neighborSpan * (1 - i / Math.max(1, reigns.length)),
        tone: "person", pick: holderId,
      });
      growBounds(board, (sx + ex) / 2, hy, 30);
    });
    holderRow++;
    growBounds(board, sx, RAIL_Y, 30);
    growBounds(board, ex, RAIL_Y, 30);
  });

  if (reigns.length === 0) {
    const why =
      lineageKind === "no-changes"
        ? "the source for this belt has no title-change field — reigns are not derived and not guessed"
        : "the source recorded no reigns for this belt";
    labels.push({
      key: "cl:noreigns", x: 0, y: RAIL_Y + 40, z: Z.rail,
      text: "no documented reign records",
      sub: why,
      priority: PRIORITY.header, tone: "warn", force: true,
    });
    notes.push(why);
  }

  const fitBounds = { ...board };
  const bounds = { ...board };
  const rack = packBackground(data, exclude, board, nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, bounds);
  regions.push(...rack.regions);
  labels.push(...rack.labels);

  return {
    mode: "lineage",
    nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay,
    virtuals, routes, labels, regions,
    bounds, fitBounds,
    anchorId: titleId,
    representedCount: n,
    expandedCount: reigns.length + 1,
    notes,
    timeAxis: { dayMin, dayMax, x0, x1, y0: RAIL_Y - 40, y1: RAIL_Y + 120 },
  };
}
