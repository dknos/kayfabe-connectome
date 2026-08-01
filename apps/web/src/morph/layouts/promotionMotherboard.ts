import {
  M,
  MR,
  RK,
  TK,
  activity01,
  hash01,
  rgb,
  type MorphLabel,
  type MorphLayoutResult,
  type MorphRegion,
  type MorphRoute,
  type MorphVirtualNode,
} from "@kayfabe/morph-renderer";
import { dayToDate, type AtlasPromotionDetail } from "@kayfabe/graph-contract";
import type { AtlasData } from "../../atlas/atlasLoader";
import type { MorphData } from "../morphAdapter";
import { PRIORITY, Z, emptyBounds, growBounds, type MorphControlsState } from "./layoutTypes";
import { packBackground } from "./backgroundRack";
import { routeOrthoV } from "./routing";

/**
 * PROMOTION MOTHERBOARD — one promotion expanded into an organized circuit
 * board: header, time bus of documented yearly activity, gold championship
 * modules, and person port banks grouped by first documented decade.
 * Membership is documented appearance on a card — never employment.
 */

const yearOf = (day: number): number => dayToDate(day).getUTCFullYear();
const fmtDay = (day: number): string => (day < 0 ? "—" : dayToDate(day).toISOString().slice(0, 10));

const BOARD_W = 1040;

export function buildMotherboard(
  data: MorphData,
  promoId: string,
  detail: AtlasPromotionDetail | null,
  atlas: AtlasData | null,
  controls: MorphControlsState,
  shardFailed = false,
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

  const name = data.nameOf(promoId) ?? promoId;
  const promoIdx = data.indexOf(promoId);
  const headerY = 300;

  // ---------- promotion header chip ----------
  if (promoIdx !== undefined) {
    nodeTargets[promoIdx * 3] = 0;
    nodeTargets[promoIdx * 3 + 1] = headerY;
    nodeTargets[promoIdx * 3 + 2] = Z.chip;
    nodeOpacity[promoIdx] = 1;
    nodeScale[promoIdx] = 9;
    nodeRole[promoIdx] = MR.SELECTED;
    nodeDelay[promoIdx] = 0;
    exclude.add(promoIdx);
  } else {
    virtuals.push({
      id: promoId, x: 0, y: headerY, z: Z.chip, scale: 9, opacity: 1,
      color: rgb(M.promotion), role: MR.SELECTED,
    });
  }
  regions.push({
    key: "mb:header", x: 0, y: headerY, z: Z.backplate + 1,
    w: BOARD_W, h: 46, color: rgb(M.plateLit), alpha: 0.8, kind: RK.HEADER, pick: promoId,
  });
  const d = detail;
  labels.push({
    key: `n:${promoId}`,
    x: -BOARD_W / 2 + 16, y: headerY + 44, z: Z.chip,
    anchor: "left",
    text: name,
    sub: d
      ? `documented record ${fmtDay(d.firstDay)} → ${fmtDay(d.lastDay)} · source: ${d.src}`
      : shardFailed
        ? "promotion shard unavailable — registry data only"
        : "loading promotion detail…",
    detail: d
      ? `${d.cards.toLocaleString()} documented cards · ${d.matches.toLocaleString()} documented matches · ${d.people.toLocaleString()} documented participants · ${d.titles.length} associated championships`
      : undefined,
    priority: PRIORITY.selected, tone: "promotion", force: true, pick: promoId,
  });
  growBounds(board, 0, headerY, BOARD_W / 2 + 20);

  // ---------- time bus ----------
  if (d && d.yearMatches.length > 0) {
    const y0 = d.yearFrom;
    const years = d.yearMatches.length;
    const busY = headerY - 64;
    const x0 = -BOARD_W / 2 + 30;
    const x1 = BOARD_W / 2 - 30;
    const xOf = (year: number) => x0 + ((year - y0) / Math.max(1, years - 1)) * (x1 - x0);
    const maxM = Math.max(1, ...d.yearMatches);
    regions.push({
      key: "mb:bus", x: 0, y: busY - 14, z: Z.rail, w: x1 - x0 + 30, h: 2.4,
      color: rgb(M.ruleBright), alpha: 0.55, kind: RK.RAIL,
    });
    for (let k = 0; k < years; k++) {
      const m = d.yearMatches[k]!;
      if (m <= 0) continue;
      const h = 4 + 26 * activity01(m, maxM);
      regions.push({
        key: `mb:act:${y0 + k}`, x: xOf(y0 + k), y: busY - 14 + h / 2 + 2, z: Z.rail,
        w: Math.max(2, (x1 - x0) / years - 1.5), h,
        color: rgb(M.same), alpha: 0.3, kind: RK.TICK,
      });
    }
    for (let year = Math.ceil(y0 / 10) * 10; year <= y0 + years; year += 10) {
      labels.push({
        key: `mb:decade:${year}`, x: xOf(year), y: busY - 26, z: Z.rail,
        text: String(year), priority: PRIORITY.header - 30, tone: "muted",
      });
    }
    labels.push({
      key: "mb:bus:h", x: x0 - 8, y: busY + 22, z: Z.rail,
      text: "DOCUMENTED ACTIVITY — matches per year",
      priority: PRIORITY.header - 5, tone: "muted", anchor: "left",
    });
    growBounds(board, 0, busY, BOARD_W / 2);
  }

  // ---------- gold championship modules ----------
  const titles = (d?.titles ?? [])
    .slice()
    .sort((a, b) => (a.firstDay < 0 ? 1 : b.firstDay < 0 ? -1 : a.firstDay - b.firstDay) || (a.n < b.n ? -1 : 1));
  const goldTop = headerY - 130;
  const perRow = 5;
  const modW = 190;
  const modH = 26;
  const shown = titles.slice(0, 20);
  if (titles.length > shown.length) notes.push(`${titles.length - shown.length} further championships not shown as modules`);
  shown.forEach((t, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = -((perRow - 1) * (modW + 14)) / 2 + col * (modW + 14);
    const y = goldTop - row * (modH + 26);
    regions.push({
      key: `mb:gold:${t.t}`, x, y, z: Z.rail, w: modW, h: modH,
      color: rgb(M.goldDeep), alpha: 0.28, kind: RK.GOLD, param: 0.3, pick: t.t,
    });
    const idx = data.indexOf(t.t);
    if (idx !== undefined) {
      nodeTargets[idx * 3] = x - modW / 2 + 14;
      nodeTargets[idx * 3 + 1] = y;
      nodeTargets[idx * 3 + 2] = Z.chip;
      nodeOpacity[idx] = 0.9;
      nodeScale[idx] = 4;
      nodeRole[idx] = MR.TITLE_CONTEXT;
      nodeDelay[idx] = 0.35 + 0.3 * (i / Math.max(1, shown.length));
      exclude.add(idx);
    } else {
      virtuals.push({
        id: t.t, x: x - modW / 2 + 14, y, z: Z.chip, scale: 4, opacity: 0.85,
        color: rgb(M.gold), role: MR.TITLE_CONTEXT,
      });
    }
    const reignNote =
      t.lineage === "no-changes"
        ? "no title-change field in source — reigns not derived"
        : `${t.reigns} documented reigns · ${t.holders} holders`;
    labels.push({
      key: `n:${t.t}`, x: x + 8, y: y - modH / 2 - 8, z: Z.chip,
      text: t.n.length > 30 ? t.n.slice(0, 29) + "…" : t.n,
      sub: reignNote,
      detail: `${fmtDay(t.firstDay)} → ${fmtDay(t.lastDay)}${t.artifact ? " · source artifact" : ""}${t.assoc === "unresolved" ? " · association unresolved" : ""}`,
      badge: t.artifact ? "!" : undefined,
      priority: PRIORITY.context + 40 - i,
      tone: t.artifact ? "warn" : "gold",
      pick: t.t,
    });
    routes.push({
      key: `ctx:${promoId}:${t.t}`,
      points: routeOrthoV(0, headerY - 23, x, y + modH / 2, headerY - 46 - (i % 4) * 5, Z.trace),
      color: rgb(M.gold), width: 1.3, alpha: 0.3, kind: TK.CONTEXT_TITLE,
      a: promoIdx ?? -1, b: idx ?? -1,
    });
    growBounds(board, x, y, modW / 2 + 12);
  });

  // ---------- person port banks ----------
  const members = d?.members ?? [];
  if (d?.membersTruncated) {
    notes.push(`${d.membersTruncated} further documented participants beyond the projection cap`);
  }
  const bankKey = (m: { firstDay: number; matches: number; n: string; champ?: 1 }): string => {
    switch (controls.group) {
      case "activity":
        return m.matches >= 100 ? "100+ matches" : m.matches >= 20 ? "20–99 matches" : "under 20 matches";
      case "alpha": {
        const c = m.n.charAt(0).toUpperCase();
        return c < "A" || c > "Z" ? "#" : c < "H" ? "A–G" : c < "P" ? "H–O" : "P–Z";
      }
      case "champ":
        return m.champ ? "documented title holders" : "documented participants";
      default:
        return m.firstDay < 0 ? "undated" : `${Math.floor(yearOf(m.firstDay) / 10) * 10}s`;
    }
  };
  const banks = new Map<string, typeof members>();
  for (const m of members) {
    const k = bankKey(m);
    let arr = banks.get(k);
    if (!arr) banks.set(k, (arr = []));
    arr.push(m);
  }
  const bankNames = [...banks.keys()].sort();
  const bankTop = goldTop - Math.ceil(shown.length / perRow) * (modH + 26) - 40;
  let bankY = bankTop;
  const cell = 8.5;
  const bankCols = Math.floor((BOARD_W - 60) / cell);
  for (const bn of bankNames) {
    const list = banks.get(bn)!;
    list.sort((a, b) => b.matches - a.matches || (a.p < b.p ? -1 : 1));
    const rows = Math.ceil(list.length / bankCols);
    const h = rows * cell + 26;
    regions.push({
      key: `mb:bank:${bn}`, x: 0, y: bankY - h / 2, z: Z.backplate, w: BOARD_W - 20, h,
      color: rgb(M.plate), alpha: 0.6, kind: RK.PLATE,
    });
    labels.push({
      key: `mb:bank:${bn}:h`, x: -BOARD_W / 2 + 18, y: bankY - 10, z: Z.rail,
      text: `${bn.toUpperCase()} · ${list.length} documented`,
      priority: PRIORITY.header - 2, tone: "neutral", anchor: "left",
    });
    list.forEach((m, k) => {
      const idx = data.indexOf(m.p);
      if (idx === undefined) return;
      const col = k % bankCols;
      const row = Math.floor(k / bankCols);
      nodeTargets[idx * 3] = -BOARD_W / 2 + 30 + (col + 0.5) * cell;
      nodeTargets[idx * 3 + 1] = bankY - 24 - row * cell;
      nodeTargets[idx * 3 + 2] = Z.node;
      nodeOpacity[idx] = m.champ ? 0.75 : 0.42;
      nodeScale[idx] = m.champ ? 3 : 2.2;
      nodeRole[idx] = MR.MEMBER;
      nodeDelay[idx] = 0.3 + hash01(idx) * 0.5;
      exclude.add(idx);
      if (k < 8) {
        labels.push({
          key: `n:${m.p}`,
          x: nodeTargets[idx * 3]!, y: nodeTargets[idx * 3 + 1]! + 6, z: Z.node,
          text: m.n,
          sub: `documented appearances ×${m.matches}`,
          priority: PRIORITY.neighborBase + m.matches / 1e6,
          tone: m.champ ? "gold" : "neutral",
          pick: m.p,
        });
      }
    });
    growBounds(board, 0, bankY - h, BOARD_W / 2 + 10);
    bankY -= h + 18;
  }
  if (!d) {
    notes.push(
      shardFailed
        ? "promotion shard failed to load — port banks and title modules unavailable"
        : "promotion shard still loading — banks appear when it lands",
    );
  }

  const fitBounds = { ...board };
  const bounds = { ...board };
  const rack = packBackground(data, exclude, board, nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, bounds);
  regions.push(...rack.regions);
  labels.push(...rack.labels);
  void atlas;

  return {
    mode: "motherboard",
    nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay,
    virtuals, routes, labels, regions,
    bounds, fitBounds,
    anchorId: promoId,
    representedCount: n,
    expandedCount: shown.length + members.length + 1,
    notes,
  };
}
