import {
  M,
  MR,
  RK,
  TK,
  hash01,
  relationColor,
  rgb,
  type MorphLabel,
  type MorphLayoutResult,
  type MorphRegion,
  type MorphRoute,
  type MorphVirtualNode,
} from "@kayfabe/morph-renderer";
import { dayToDate, pairKey, type PersonDossier } from "@kayfabe/graph-contract";
import type { MorphData, NeighborRel } from "../morphAdapter";
import { LOOM, PRIORITY, Z, emptyBounds, growBounds, type MorphControlsState } from "./layoutTypes";
import { routeOrtho, routeOrthoV, sampleOrganicBow } from "./routing";
import { packBackground } from "./backgroundRack";

/**
 * RELATIONSHIP LOOM — the primary organized reading.
 *
 * The selected person becomes a central processor; documented opponents dock
 * into the left rail, same-side partners into the right, battle-royal-only
 * contacts into the lower rail; promotions with documented appearances run
 * along the upper context bus (dashed — context, never a match), documented
 * championships along the gold module bus. One canonical node per wrestler:
 * mixed histories stay in their strongest category and carry both counts.
 */

interface Chip {
  rel: NeighborRel;
  category: "opponent" | "partner" | "br";
  mixed: boolean;
  x: number;
  y: number;
  rank: number;
}

const yearOf = (day: number): number => dayToDate(day).getUTCFullYear();

export function buildLoom(
  data: MorphData,
  selectedId: string,
  dossier: PersonDossier | null,
  titleNameOf: (id: string) => string | null,
  controls: MorphControlsState,
  traceCap: number,
): MorphLayoutResult {
  const n = data.count;
  const model = data.model;
  const selIdx = data.indexOf(selectedId);
  if (selIdx === undefined) throw new Error(`loom: ${selectedId} has no corpus node`);

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
  const exclude = new Set<number>([selIdx]);

  // ---------- categorize ----------
  const rels = data.relationsOf(selIdx);
  const opponents: NeighborRel[] = [];
  const partners: NeighborRel[] = [];
  const brOnly: NeighborRel[] = [];
  for (const r of rels) {
    if (r.same === 0 && r.opposed === 0 && r.br > 0) brOnly.push(r);
    else if (r.opposed >= r.same) opponents.push(r);
    else partners.push(r);
  }
  const isMixed = (r: NeighborRel): boolean =>
    Math.min(r.same, r.opposed) >= 3 && Math.min(r.same, r.opposed) / Math.max(r.same, r.opposed, 1) >= 0.25;

  const cmp = (a: NeighborRel, b: NeighborRel): number => {
    switch (controls.sort) {
      case "first":
        return a.firstDay - b.firstDay || (a.id < b.id ? -1 : 1);
      case "latest":
        return b.lastDay - a.lastDay || (a.id < b.id ? -1 : 1);
      case "median":
        return (a.firstDay + a.lastDay) / 2 - (b.firstDay + b.lastDay) / 2 || (a.id < b.id ? -1 : 1);
      case "alpha":
        return a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1;
      default:
        return b.same + b.opposed + b.br - (a.same + a.opposed + a.br) || (a.id < b.id ? -1 : 1);
    }
  };
  opponents.sort(cmp);
  partners.sort(cmp);
  brOnly.sort((a, b) => b.br - a.br || (a.id < b.id ? -1 : 1));

  // ---------- rails ----------
  const chips: Chip[] = [];
  const pitch = LOOM.chipH + LOOM.chipGap;
  const perCol = 17;

  const placeRail = (list: NeighborRel[], side: -1 | 1, category: "opponent" | "partner") => {
    const full = list.slice(0, LOOM.maxChips);
    const rest = list.slice(LOOM.maxChips);
    if (controls.timeAxis && full.length > 0) {
      const days = full.map((r) => r.firstDay);
      const d0 = Math.min(...days);
      const d1 = Math.max(...days, d0 + 1);
      full.forEach((r, i) => {
        const y = -210 + 420 * (1 - (r.firstDay - d0) / (d1 - d0));
        chips.push({ rel: r, category, mixed: isMixed(r), x: side * LOOM.railX, y, rank: i });
      });
    } else {
      full.forEach((r, i) => {
        const col = Math.floor(i / perCol);
        const row = i % perCol;
        const colH = Math.min(perCol, full.length - col * perCol) * pitch;
        chips.push({
          rel: r,
          category,
          mixed: isMixed(r),
          x: side * (LOOM.railX + col * LOOM.colGap),
          y: colH / 2 - row * pitch - pitch / 2,
          rank: i,
        });
      });
    }
    // the remainder stays represented: a compact port grid under the rail
    const gridCols = 16;
    rest.forEach((r, k) => {
      const i3 = r.index * 3;
      nodeTargets[i3] = side * (LOOM.railX - 40) + side * (k % gridCols) * 6.5;
      nodeTargets[i3 + 1] = -280 - Math.floor(k / gridCols) * 6.5;
      nodeTargets[i3 + 2] = Z.node;
      nodeOpacity[r.index] = 0.22;
      nodeScale[r.index] = 1.6;
      nodeRole[r.index] = category === "opponent" ? MR.OPPONENT : MR.PARTNER;
      nodeDelay[r.index] = 0.45 + hash01(r.index) * 0.4;
      exclude.add(r.index);
      growBounds(board, nodeTargets[i3]!, nodeTargets[i3 + 1]!, 8);
    });
    if (rest.length > 0) {
      notes.push(`${rest.length} further documented ${category === "opponent" ? "opponents" : "partners"} in the compact grid`);
    }
  };
  placeRail(opponents, -1, "opponent");
  placeRail(partners, 1, "partner");

  brOnly.slice(0, LOOM.maxBr).forEach((r, i) => {
    const cols = Math.min(LOOM.maxBr, brOnly.length);
    const w = cols * 34;
    chips.push({
      rel: r,
      category: "br",
      mixed: false,
      x: -w / 2 + i * 34 + 17,
      y: LOOM.brY - (i % 2) * 18,
      rank: i,
    });
  });
  const brRest = brOnly.slice(LOOM.maxBr);
  brRest.forEach((r, k) => {
    const i3 = r.index * 3;
    nodeTargets[i3] = -300 + (k % 100) * 6;
    nodeTargets[i3 + 1] = LOOM.brY - 44 - Math.floor(k / 100) * 6;
    nodeTargets[i3 + 2] = Z.node;
    nodeOpacity[r.index] = 0.18;
    nodeScale[r.index] = 1.4;
    nodeRole[r.index] = MR.BATTLE_ROYAL;
    nodeDelay[r.index] = 0.5 + hash01(r.index) * 0.35;
    exclude.add(r.index);
    growBounds(board, nodeTargets[i3]!, nodeTargets[i3 + 1]!, 8);
  });
  if (brRest.length > 0) notes.push(`${brRest.length} further battle-royal contacts in the compact grid`);

  // ---------- chip nodes, labels, traces ----------
  const org = data.organic;
  const promoBitName = buildPromoBitNames(data);
  let traceBudget = traceCap;
  const totalChips = chips.length;

  chips.forEach((chip, order) => {
    const r = chip.rel;
    const i3 = r.index * 3;
    nodeTargets[i3] = chip.x;
    nodeTargets[i3 + 1] = chip.y;
    nodeTargets[i3 + 2] = Z.chip;
    nodeOpacity[r.index] = 0.85;
    nodeScale[r.index] = chip.category === "br" ? 2.6 : 3.2;
    nodeRole[r.index] =
      chip.category === "br" ? MR.BATTLE_ROYAL : chip.mixed ? MR.MIXED : chip.category === "opponent" ? MR.OPPONENT : MR.PARTNER;
    nodeDelay[r.index] = 0.08 + 0.45 * (order / Math.max(1, totalChips - 1));
    exclude.add(r.index);
    growBounds(board, chip.x, chip.y, LOOM.chipW / 2 + 8);

    const total = r.same + r.opposed + r.br;
    const catLabel =
      chip.category === "br" ? `battle royal ×${r.br}` : chip.category === "opponent" ? `opposed ×${r.opposed}` : `same-side ×${r.same}`;
    const y0 = yearOf(r.firstDay);
    const y1 = yearOf(r.lastDay);
    const promoCtx = promoBitName(r.promoMask);
    labels.push({
      key: `n:${r.id}`,
      x: chip.x + (chip.x < 0 ? -LOOM.chipW / 2 : chip.category === "br" ? 0 : LOOM.chipW / 2) * 0.14,
      y: chip.y,
      z: Z.chip,
      text: r.name,
      sub: catLabel + (chip.mixed ? " · mixed" : ""),
      detail:
        `opp ${r.opposed} · tag ${r.same} · br ${r.br}` +
        (r.title > 0 ? ` · title ${r.title}` : "") +
        ` · ${y0 === y1 ? y0 : `${y0}–${y1}`}` +
        (promoCtx ? ` · ${promoCtx}` : ""),
      badge: chip.mixed ? "±" : undefined,
      priority: PRIORITY.neighborBase + PRIORITY.neighborSpan * (1 - order / Math.max(1, totalChips)),
      tone: chip.category === "opponent" ? "ember" : chip.category === "br" ? "muted" : "cyan",
      pick: r.id,
    });

    if (traceBudget > 0) {
      traceBudget--;
      const portY = -LOOM.centerH / 2 + 5 + (order % 8) * ((LOOM.centerH - 10) / 7);
      const side = chip.x < 0 ? -1 : 1;
      const laneX = side * (LOOM.railX - 74 - (order % 9) * 7);
      const brPortX = Math.max(-LOOM.centerW / 2 + 8, Math.min(LOOM.centerW / 2 - 8, chip.x * 0.12));
      const target =
        chip.category === "br"
          ? routeOrthoV(brPortX, -LOOM.centerH / 2, chip.x, chip.y + LOOM.chipH / 2, LOOM.brY / 2 - (order % 7) * 6, Z.trace)
          : routeOrtho(side * (LOOM.centerW / 2), portY, chip.x - side * (LOOM.chipW / 2 - 16), chip.y, laneX, Z.trace);
      routes.push({
        key: pairKey(selectedId, r.id),
        points: target,
        fromPoints: sampleOrganicBow(
          org[selIdx * 3]!, org[selIdx * 3 + 1]!, org[selIdx * 3 + 2]!,
          org[r.index * 3]!, org[r.index * 3 + 1]!, org[r.index * 3 + 2]!,
          r.index * 13 + 1,
        ),
        color: relationColor(r.same, r.opposed, r.br, r.title),
        width: 2.2 + 2.6 * Math.min(1, total / 40),
        alpha: 0.72,
        kind: TK.RELATION,
        a: selIdx,
        b: r.index,
      });
    }
  });
  if (traceBudget <= 0 && totalChips > traceCap) {
    notes.push(`strongest ${traceCap} of ${totalChips} relationship traces routed`);
  }

  // ---------- upper context bus: promotions ----------
  const promoEntries = Object.entries(dossier?.promos ?? {}).sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  const promoShown = promoEntries.slice(0, 16);
  if (promoEntries.length > promoShown.length) {
    notes.push(`${promoEntries.length - promoShown.length} further promotions with documented appearances not on the bus`);
  }
  const busSpan = Math.max(360, promoShown.length * 96);
  promoShown.forEach(([prId, count], i) => {
    const x = promoShown.length === 1 ? 0 : -busSpan / 2 + (i * busSpan) / (promoShown.length - 1);
    const idx = data.indexOf(prId);
    const name = data.nameOf(prId) ?? prId;
    if (idx !== undefined) {
      nodeTargets[idx * 3] = x;
      nodeTargets[idx * 3 + 1] = LOOM.busY;
      nodeTargets[idx * 3 + 2] = Z.chip;
      nodeOpacity[idx] = 0.8;
      nodeScale[idx] = 5.4;
      nodeRole[idx] = MR.PROMO_CONTEXT;
      nodeDelay[idx] = 0.5;
      exclude.add(idx);
    } else {
      virtuals.push({
        id: prId,
        x,
        y: LOOM.busY,
        z: Z.chip,
        scale: 5.4,
        opacity: 0.75,
        color: rgb(M.promotion),
        role: MR.PROMO_CONTEXT,
      });
    }
    growBounds(board, x, LOOM.busY, 30);
    labels.push({
      key: `n:${prId}`,
      x,
      y: LOOM.busY + 12,
      z: Z.chip,
      text: name,
      sub: `documented appearances ×${count}`,
      priority: PRIORITY.context + count / 1e6,
      tone: "promotion",
      pick: prId,
    });
    // exit ports fan across the top edge — stacked identical segments would
    // sum additively into a white column through the processor
    const portX = Math.max(-LOOM.centerW / 2 + 8, Math.min(LOOM.centerW / 2 - 8, x * 0.18));
    routes.push({
      key: `ctx:${selectedId}:${prId}`,
      points: routeOrthoV(portX, LOOM.centerH / 2, x, LOOM.busY - 8, LOOM.busY - 52 - (i % 5) * 7, Z.trace),
      color: rgb(M.promotion),
      width: 2,
      alpha: 0.4,
      kind: TK.CONTEXT_PROMO,
      a: selIdx,
      b: idx ?? -1,
    });
  });
  if (promoShown.length > 0) {
    regions.push({
      key: "loom:bus",
      x: 0,
      y: LOOM.busY,
      z: Z.rail,
      w: busSpan + 140,
      h: 3,
      color: rgb(M.ruleBright),
      alpha: 0.5,
      kind: RK.RAIL,
    });
    labels.push({
      key: "loom:bus:h",
      x: -busSpan / 2 - 70,
      y: LOOM.busY + 16,
      z: Z.rail,
      text: "PROMOTIONS — documented appearances, not employment",
      priority: PRIORITY.header,
      tone: "muted",
      anchor: "left",
    });
  }

  // ---------- gold module bus: championships ----------
  const titleList = (dossier?.titles ?? [])
    .map((t) => ({ id: t.t, reigns: t.reigns.length }))
    .sort((a, b) => b.reigns - a.reigns || (a.id < b.id ? -1 : 1))
    .slice(0, 12);
  const goldSpan = Math.max(300, titleList.length * 110);
  titleList.forEach((t, i) => {
    const x = titleList.length === 1 ? 0 : -goldSpan / 2 + (i * goldSpan) / (titleList.length - 1);
    const idx = data.indexOf(t.id);
    const name = titleNameOf(t.id) ?? data.nameOf(t.id) ?? t.id;
    if (idx !== undefined) {
      nodeTargets[idx * 3] = x;
      nodeTargets[idx * 3 + 1] = LOOM.goldY;
      nodeTargets[idx * 3 + 2] = Z.chip;
      nodeOpacity[idx] = 0.85;
      nodeScale[idx] = 4;
      nodeRole[idx] = MR.TITLE_CONTEXT;
      nodeDelay[idx] = 0.52;
      exclude.add(idx);
    } else {
      virtuals.push({
        id: t.id,
        x,
        y: LOOM.goldY,
        z: Z.chip,
        scale: 4,
        opacity: 0.8,
        color: rgb(M.gold),
        role: MR.TITLE_CONTEXT,
      });
    }
    growBounds(board, x, LOOM.goldY, 24);
    regions.push({
      key: `loom:gold:${t.id}`,
      x,
      y: LOOM.goldY,
      z: Z.rail,
      w: 96,
      h: 13,
      color: rgb(M.goldDeep),
      alpha: 0.34,
      kind: RK.GOLD,
      param: 0.6,
      pick: t.id,
    });
    labels.push({
      key: `n:${t.id}`,
      x,
      y: LOOM.goldY - 12,
      z: Z.chip,
      text: name,
      sub: `documented reigns ×${t.reigns}`,
      priority: PRIORITY.context + 20 + t.reigns / 1e4,
      tone: "gold",
      pick: t.id,
    });
    const goldPortX = Math.max(-LOOM.centerW / 2 + 8, Math.min(LOOM.centerW / 2 - 8, x * 0.22));
    routes.push({
      key: `ctx:${selectedId}:${t.id}`,
      points: routeOrthoV(goldPortX, LOOM.centerH / 2, x, LOOM.goldY - 9, LOOM.goldY - 40 - (i % 4) * 6, Z.trace),
      color: rgb(M.gold),
      width: 2.2,
      alpha: 0.45,
      kind: TK.CONTEXT_TITLE,
      a: selIdx,
      b: idx ?? -1,
    });
  });

  // ---------- centre processor ----------
  nodeTargets[selIdx * 3] = 0;
  nodeTargets[selIdx * 3 + 1] = 0;
  nodeTargets[selIdx * 3 + 2] = Z.chip + 1;
  nodeOpacity[selIdx] = 1;
  nodeScale[selIdx] = 8;
  nodeRole[selIdx] = MR.SELECTED;
  nodeDelay[selIdx] = 0;
  regions.push({
    key: "loom:center",
    x: 0,
    y: 0,
    z: Z.backplate + 1,
    w: LOOM.centerW,
    h: LOOM.centerH,
    color: rgb(M.plateLit),
    alpha: 0.85,
    kind: RK.HEADER,
    pick: selectedId,
  });
  const selName = model.nodes.name[selIdx]!;
  const first = dossier ? dossier.first : null;
  const last = dossier ? dossier.last : null;
  labels.push({
    key: `n:${selectedId}`,
    x: 0,
    y: -8,
    z: Z.chip + 1,
    text: selName,
    sub: `wrestler · ${first ? `${first.slice(0, 4)}–${last!.slice(0, 4)}` : "documented record"}`,
    detail: dossier
      ? `${dossier.m.toLocaleString()} documented matches · ${rels.length} connections · ${dossier.titles.length} documented titles`
      : `${rels.length} documented connections`,
    priority: PRIORITY.selected,
    tone: "person",
    force: true,
    pick: selectedId,
  });

  // rail furniture
  const railPlate = (side: -1 | 1, count: number, heading: string, tone: MorphLabel["tone"]) => {
    if (count === 0) return;
    const cols = Math.ceil(Math.min(count, LOOM.maxChips) / perCol);
    const w = cols * LOOM.colGap + 40;
    const x = side * (LOOM.railX + ((cols - 1) * LOOM.colGap) / 2);
    regions.push({
      key: `loom:rail:${side}`,
      x,
      y: 0,
      z: Z.backplate,
      w,
      h: Math.min(perCol, Math.min(count, LOOM.maxChips)) * pitch + 34,
      color: rgb(M.plate),
      alpha: 0.65,
      kind: RK.PLATE,
    });
    labels.push({
      key: `loom:rail:${side}:h`,
      x,
      y: (Math.min(perCol, Math.min(count, LOOM.maxChips)) * pitch) / 2 + 26,
      z: Z.rail,
      text: heading,
      priority: PRIORITY.header,
      tone,
    });
  };
  railPlate(-1, opponents.length, `OPPONENTS · ${opponents.length}`, "ember");
  railPlate(1, partners.length, `PARTNERS · ${partners.length}`, "cyan");
  if (brOnly.length > 0) {
    labels.push({
      key: "loom:br:h",
      x: 0,
      y: LOOM.brY + 22,
      z: Z.rail,
      text: `BATTLE-ROYAL CONTACTS · ${brOnly.length}`,
      priority: PRIORITY.header - 1,
      tone: "muted",
    });
  }

  growBounds(board, 0, 0, LOOM.centerW);
  growBounds(board, 0, LOOM.busY, 40);
  if (brOnly.length > 0) growBounds(board, 0, LOOM.brY, 40);

  const fitBounds = { ...board };
  const bounds = { ...board };
  const rack = packBackground(data, exclude, board, nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, bounds);
  regions.push(...rack.regions);
  labels.push(...rack.labels);

  return {
    mode: "loom",
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
    anchorId: selectedId,
    representedCount: n,
    expandedCount: totalChips + promoShown.length + titleList.length + 1,
    notes,
  };
}

/** map an edge's promotion mask to a short "mostly X" context, if named */
function buildPromoBitNames(data: MorphData): (mask: number) => string | null {
  const bits = data.core.manifest.promo_bits;
  const byBit = new Map<number, string>();
  for (const [bare, bit] of Object.entries(bits)) {
    const name = data.core.promotions[`pr:${bare}`]?.n;
    if (name) byBit.set(bit, name.length > 14 ? name.slice(0, 13) + "…" : name);
  }
  return (mask: number) => {
    for (const [bit, name] of byBit) {
      if (mask & (1 << bit)) return name;
    }
    return null;
  };
}

