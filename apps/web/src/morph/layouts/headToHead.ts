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
} from "@kayfabe/morph-renderer";
import type { EvidenceEntry } from "@kayfabe/graph-contract";
import type { MorphData } from "../morphAdapter";
import { PRIORITY, Z, emptyBounds, growBounds } from "./layoutTypes";
import { packBackground } from "./backgroundRack";
import { resample } from "./routing";

/**
 * HEAD-TO-HEAD (β scaffold) — two wrestlers as facing anchors, their
 * documented shared matches as chronological rungs between them. Every rung
 * is a real record from the evidence shard: date, promotion, form, result,
 * title involvement, star rating where reported. Newest at the bottom.
 */

const RAIL_X = 420;
const TOP_Y = 230;
const RUNG_CAP = 56;

export function buildHeadToHead(
  data: MorphData,
  aId: string,
  bId: string,
  evidence: EvidenceEntry[],
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
  const board = emptyBounds();
  const exclude = new Set<number>();

  const aIdx = data.indexOf(aId);
  const bIdx = data.indexOf(bId);
  if (aIdx === undefined || bIdx === undefined) {
    throw new Error("head-to-head: both anchors need corpus nodes");
  }
  exclude.add(aIdx);
  exclude.add(bIdx);

  const sorted = [...evidence].sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : x.m < y.m ? -1 : 1));
  const shown = sorted.slice(0, RUNG_CAP);
  if (sorted.length > shown.length) {
    notes.push(`earliest ${RUNG_CAP} of ${sorted.length} documented shared matches shown — filters arrive with the full mode`);
  }
  notes.push("head-to-head is a β scaffold: rung filters and playback land after the core modes");

  const rungGap = 16;
  const bottomY = TOP_Y - Math.max(1, shown.length) * rungGap;

  // anchors
  const anchor = (idx: number, id: string, x: number) => {
    nodeTargets[idx * 3] = x;
    nodeTargets[idx * 3 + 1] = TOP_Y + 40;
    nodeTargets[idx * 3 + 2] = Z.chip + 1;
    nodeOpacity[idx] = 1;
    nodeScale[idx] = 7;
    nodeRole[idx] = MR.SELECTED;
    nodeDelay[idx] = 0;
    labels.push({
      key: `n:${id}`,
      x,
      y: TOP_Y + 58,
      z: Z.chip + 1,
      text: data.nameOf(id) ?? id,
      sub: `${sorted.length} documented shared matches`,
      priority: PRIORITY.selected,
      tone: "person",
      force: true,
      pick: id,
    });
    regions.push({
      key: `h2h:rail:${id}`,
      x,
      y: (TOP_Y + bottomY) / 2 + 20,
      z: Z.rail,
      w: 4,
      h: TOP_Y - bottomY + 60,
      color: rgb(M.ruleBright),
      alpha: 0.6,
      kind: RK.RAIL,
      pick: id,
    });
    growBounds(board, x, TOP_Y + 60, 60);
    growBounds(board, x, bottomY, 40);
  };
  anchor(aIdx, aId, -RAIL_X);
  anchor(bIdx, bId, RAIL_X);

  shown.forEach((ev, i) => {
    const y = TOP_Y - (i + 1) * rungGap;
    const color =
      ev.rel === "same" ? rgb(M.same) : ev.rel === "br" ? rgb(M.br) : rgb(M.opposed);
    const gold = ev.t !== null;
    const pts: number[] = [-RAIL_X + 8, y, -RAIL_X * 0.5, y, RAIL_X * 0.5, y, RAIL_X - 8, y];
    routes.push({
      key: `h2h:${ev.m}`,
      points: resample(pts, Z.trace),
      color: gold ? rgb(M.gold) : color,
      width: gold ? 2.8 : 2.2,
      alpha: gold ? 0.6 : 0.42,
      kind: TK.RELATION,
      a: aIdx,
      b: bIdx,
    });
    if (i % 2 === 0 || gold) {
      const prName = data.nameOf(ev.pr) ?? ev.pr;
      labels.push({
        key: `h2h:${ev.m}:l`,
        x: 0,
        y: y + 5,
        z: Z.trace,
        text: `${ev.d} · ${prName}`,
        sub:
          `${ev.form.replace("_", " ")} · ${ev.res}` +
          (gold ? ` · title match${ev.tc ? " — TITLE CHANGE" : ""}` : "") +
          (ev.mr !== undefined ? ` · ${ev.mr}★` : ""),
        priority: PRIORITY.neighborBase + (gold ? 220 : 0) + (shown.length - i),
        tone: gold ? "gold" : ev.rel === "same" ? "cyan" : "ember",
      });
    }
    growBounds(board, 0, y, 20);
  });

  if (shown.length === 0) {
    labels.push({
      key: "h2h:none",
      x: 0,
      y: TOP_Y - 60,
      z: Z.trace,
      text: "no documented shared matches in the corpus",
      priority: PRIORITY.header,
      tone: "warn",
      force: true,
    });
  }

  const fitBounds = { ...board };
  const bounds = { ...board };
  const rack = packBackground(data, exclude, board, nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, bounds);
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
    bounds,
    fitBounds,
    anchorId: aId,
    representedCount: n,
    expandedCount: shown.length + 2,
    notes,
  };
}
