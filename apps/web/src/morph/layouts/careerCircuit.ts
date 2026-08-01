import {
  M,
  MR,
  RK,
  TK,
  activity01,
  rgb,
  type MorphLabel,
  type MorphLayoutResult,
  type MorphRegion,
  type MorphRoute,
  type MorphVirtualNode,
} from "@kayfabe/morph-renderer";
import { dayToDate, isoToDay, type AtlasPersonRoutes, type PersonDossier } from "@kayfabe/graph-contract";
import type { AtlasData } from "../../atlas/atlasLoader";
import type { MorphData } from "../morphAdapter";
import { PRIORITY, Z, emptyBounds, growBounds, type MorphControlsState } from "./layoutTypes";
import { packBackground } from "./backgroundRack";
import { resample } from "./routing";

/**
 * CAREER CIRCUIT — one wrestler read chronologically. X is time; Y lanes are
 * promotions ordered by first documented appearance. Lane segments are
 * documented appearance spans — never employment intervals. The career route
 * is a luminous trace crossing lanes; championships dock as gold modules on
 * their associated lane (unresolved associations go to an explicit lane);
 * major opponents and partners are ember/cyan junctions dated by their first
 * documented shared match.
 */

const fmtDay = (day: number): string => (day < 0 ? "—" : dayToDate(day).toISOString().slice(0, 10));

const AXIS_W = 980;
const LANE_H = 44;

export function buildCareer(
  data: MorphData,
  personId: string,
  personRoutes: AtlasPersonRoutes | null,
  dossier: PersonDossier | null,
  atlas: AtlasData | null,
  controls: MorphControlsState,
): MorphLayoutResult {
  void controls;
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

  const selIdx = data.indexOf(personId);
  if (selIdx === undefined) throw new Error(`career: ${personId} has no corpus node`);
  exclude.add(selIdx);
  const selName = data.model.nodes.name[selIdx]!;

  const stints = (personRoutes?.routes ?? []).filter((r) => r.firstDay >= 0);
  const dayMin = stints.length ? Math.min(...stints.map((r) => r.firstDay)) : data.model.fullDayRange[0];
  const dayMax = Math.max(dayMin + 365, ...stints.map((r) => r.lastDay));
  const x0 = -AXIS_W / 2;
  const x1 = AXIS_W / 2;
  const xOf = (day: number) => x0 + ((day - dayMin) / Math.max(1, dayMax - dayMin)) * (x1 - x0);

  // ---------- lanes, ordered by first documented appearance ----------
  const lanePromos: string[] = [];
  const laneOf = new Map<string, number>();
  for (const s of [...stints].sort((a, b) => a.firstDay - b.firstDay || (a.pr < b.pr ? -1 : 1))) {
    if (!laneOf.has(s.pr)) {
      laneOf.set(s.pr, lanePromos.length);
      lanePromos.push(s.pr);
    }
  }
  const laneY = (lane: number) => 160 - lane * LANE_H;
  const maxMatches = Math.max(1, ...stints.map((s) => s.matches));

  lanePromos.forEach((pr, lane) => {
    const y = laneY(lane);
    const prName = data.nameOf(pr) ?? pr;
    regions.push({
      key: `cc:lane:${pr}`, x: 0, y, z: Z.backplate, w: AXIS_W + 60, h: LANE_H - 6,
      color: rgb(M.plate), alpha: 0.55, kind: RK.PLATE,
    });
    labels.push({
      key: `cc:lane:${pr}:h`, x: x0 - 24, y, z: Z.rail,
      text: prName, priority: PRIORITY.header - lane, tone: "promotion",
      anchor: "left", pick: pr,
    });
    const prIdx = data.indexOf(pr);
    if (prIdx !== undefined) {
      nodeTargets[prIdx * 3] = x0 - 34;
      nodeTargets[prIdx * 3 + 1] = y;
      nodeTargets[prIdx * 3 + 2] = Z.chip;
      nodeOpacity[prIdx] = 0.7;
      nodeScale[prIdx] = 4.6;
      nodeRole[prIdx] = MR.PROMO_CONTEXT;
      nodeDelay[prIdx] = 0.3;
      exclude.add(prIdx);
    } else {
      virtuals.push({
        id: pr, x: x0 - 34, y, z: Z.chip, scale: 4.6, opacity: 0.65,
        color: rgb(M.promotion), role: MR.PROMO_CONTEXT,
      });
    }
    growBounds(board, 0, y, AXIS_W / 2 + 80);
  });

  // ---------- stint spans + career route ----------
  const routePts: number[] = [];
  const stintsByStart = [...stints].sort((a, b) => a.firstDay - b.firstDay || (a.pr < b.pr ? -1 : 1));
  stintsByStart.forEach((s, i) => {
    const lane = laneOf.get(s.pr)!;
    const y = laneY(lane);
    const sx0 = xOf(s.firstDay);
    const sx1 = Math.max(xOf(s.lastDay), sx0 + 3);
    regions.push({
      key: `cc:stint:${s.pr}:${s.firstDay}`,
      x: (sx0 + sx1) / 2, y, z: Z.rail,
      w: sx1 - sx0, h: 10 + 10 * activity01(s.matches, maxMatches),
      color: rgb(M.same), alpha: 0.3, kind: RK.RAIL, pick: s.pr,
    });
    labels.push({
      key: `cc:stint:${s.pr}:${s.firstDay}:l`,
      x: (sx0 + sx1) / 2, y: y + 14, z: Z.rail,
      text: `${data.nameOf(s.pr) ?? s.pr}`,
      sub: `documented appearances ×${s.matches} · ${fmtDay(s.firstDay)} → ${fmtDay(s.lastDay)}`,
      priority: PRIORITY.neighborBase + s.matches / 1e6, tone: "neutral", pick: s.pr,
    });
    if (i === 0) routePts.push(sx0, y);
    else routePts.push(sx0, y);
    routePts.push(sx1, y);
  });
  if (routePts.length >= 4) {
    routes.push({
      key: `route:${personId}`,
      points: resample(routePts, Z.trace + 1),
      color: rgb(M.goldHot),
      width: 3.4,
      alpha: 0.8,
      kind: TK.ROUTE,
      a: selIdx,
      b: -1,
    });
  } else {
    notes.push("no dated promotion stints in the corpus for a career route");
  }

  // ---------- the wrestler chip rides the route start ----------
  const startX = stintsByStart.length ? xOf(stintsByStart[0]!.firstDay) : 0;
  const startY = stintsByStart.length ? laneY(laneOf.get(stintsByStart[0]!.pr)!) : 0;
  nodeTargets[selIdx * 3] = startX;
  nodeTargets[selIdx * 3 + 1] = startY + 18;
  nodeTargets[selIdx * 3 + 2] = Z.chip + 1;
  nodeOpacity[selIdx] = 1;
  nodeScale[selIdx] = 7;
  nodeRole[selIdx] = MR.SELECTED;
  nodeDelay[selIdx] = 0;
  labels.push({
    key: `n:${personId}`, x: startX, y: startY + 32, z: Z.chip + 1,
    text: selName,
    sub: dossier ? `${dossier.m.toLocaleString()} documented matches · ${dossier.first.slice(0, 4)}–${dossier.last.slice(0, 4)}` : "career circuit",
    priority: PRIORITY.selected, tone: "person", force: true, pick: personId,
  });

  // ---------- championships on their associated lanes ----------
  const unresolvedLaneY = laneY(lanePromos.length) - 10;
  let unresolvedUsed = false;
  (dossier?.titles ?? []).slice(0, 14).forEach((t, i) => {
    const ti = atlas?.titleIndex.get(t.t);
    const pr = ti !== undefined ? atlas!.titles.pr[ti]! : "";
    const assoc = ti !== undefined ? atlas!.titles.assoc[ti]! : "unresolved";
    const tName = ti !== undefined ? atlas!.titles.name[ti]! : t.t;
    const firstReign = t.reigns[0];
    const day = firstReign ? isoToDay(firstReign.s) : -1;
    const lane = pr && assoc !== "unresolved" ? laneOf.get(pr) : undefined;
    const y = lane !== undefined ? laneY(lane) - 16 : unresolvedLaneY;
    if (lane === undefined) unresolvedUsed = true;
    const x = day >= 0 ? xOf(day) : x0 + 40 + i * 60;
    regions.push({
      key: `cc:gold:${t.t}`, x, y, z: Z.rail + 1, w: 54, h: 10,
      color: rgb(M.goldDeep), alpha: 0.5, kind: RK.GOLD, param: 0.5, pick: t.t,
    });
    labels.push({
      key: `n:${t.t}`, x, y: y - 10, z: Z.rail + 1,
      text: tName.length > 26 ? tName.slice(0, 25) + "…" : tName,
      sub: `documented reigns ×${t.reigns.length}${lane === undefined ? " · lane: unresolved association" : ""}`,
      priority: PRIORITY.context + 10 - i, tone: "gold", pick: t.t,
    });
    const idx = data.indexOf(t.t);
    if (idx !== undefined) {
      nodeTargets[idx * 3] = x;
      nodeTargets[idx * 3 + 1] = y;
      nodeTargets[idx * 3 + 2] = Z.chip;
      nodeOpacity[idx] = 0.85;
      nodeScale[idx] = 3.4;
      nodeRole[idx] = MR.TITLE_CONTEXT;
      nodeDelay[idx] = 0.45;
      exclude.add(idx);
    } else {
      virtuals.push({
        id: t.t, x, y, z: Z.chip, scale: 3.4, opacity: 0.8,
        color: rgb(M.gold), role: MR.TITLE_CONTEXT,
      });
    }
  });
  if (unresolvedUsed) {
    labels.push({
      key: "cc:unresolved:h", x: x0 - 24, y: unresolvedLaneY, z: Z.rail,
      text: "UNRESOLVED TITLE ASSOCIATIONS",
      sub: "association not guessed",
      priority: PRIORITY.header - 40, tone: "warn", anchor: "left",
    });
  }

  // ---------- relationship junctions, dated by first documented match ----------
  const rels = data.relationsOf(selIdx);
  const relOf = new Map(rels.map((r) => [r.id, r]));
  const junction = (id: string, kind: "opponent" | "partner", i: number) => {
    const r = relOf.get(id);
    if (!r) return;
    const idx = r.index;
    const x = xOf(Math.max(dayMin, Math.min(dayMax, r.firstDay)));
    const y = laneY(lanePromos.length + (unresolvedUsed ? 1 : 0)) - 24 - (kind === "partner" ? 26 : 0) - (i % 3) * 8;
    nodeTargets[idx * 3] = x;
    nodeTargets[idx * 3 + 1] = y;
    nodeTargets[idx * 3 + 2] = Z.node;
    nodeOpacity[idx] = 0.7;
    nodeScale[idx] = 2.8;
    nodeRole[idx] = MR.JUNCTION;
    nodeDelay[idx] = 0.5;
    exclude.add(idx);
    if (i < 8) {
      labels.push({
        key: `n:${id}`, x, y: y - 8, z: Z.node,
        text: r.name,
        sub: kind === "opponent" ? `opposed ×${r.opposed} · first ${fmtDay(r.firstDay)}` : `same-side ×${r.same} · first ${fmtDay(r.firstDay)}`,
        priority: PRIORITY.neighborBase + 60 - i, tone: kind === "opponent" ? "ember" : "cyan", pick: id,
      });
    }
    growBounds(board, x, y, 12);
  };
  (dossier?.top.opponents ?? []).slice(0, 12).forEach(([id], i) => junction(id, "opponent", i));
  (dossier?.top.partners ?? []).slice(0, 12).forEach(([id], i) => junction(id, "partner", i));

  // decade ticks
  for (let year = Math.ceil(dayToDate(dayMin).getUTCFullYear() / 10) * 10; year <= dayToDate(dayMax).getUTCFullYear(); year += 10) {
    const x = xOf(isoToDay(`${year}-01-01`));
    regions.push({
      key: `cc:tick:${year}`, x, y: 190, z: Z.rail, w: 1.4, h: 10,
      color: rgb(M.rule), alpha: 0.8, kind: RK.TICK,
    });
    labels.push({
      key: `cc:tick:${year}:l`, x, y: 200, z: Z.rail,
      text: String(year), priority: PRIORITY.header - 50, tone: "muted",
    });
  }
  growBounds(board, 0, 200, AXIS_W / 2 + 60);

  const fitBounds = { ...board };
  const bounds = { ...board };
  const rack = packBackground(data, exclude, board, nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, bounds);
  regions.push(...rack.regions);
  labels.push(...rack.labels);

  return {
    mode: "career",
    nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay,
    virtuals, routes, labels, regions,
    bounds, fitBounds,
    anchorId: personId,
    representedCount: n,
    expandedCount: stints.length + lanePromos.length + 1,
    notes,
    timeAxis: {
      dayMin, dayMax, x0, x1,
      y0: laneY(lanePromos.length + 2), y1: 200,
    },
  };
}
