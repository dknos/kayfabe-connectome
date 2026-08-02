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
  type MorphRoute,
  type MorphRole,
  type TraceKind,
  type MorphVirtualNode,
} from "@kayfabe/morph-renderer";
import { dayToDate, pairKey, type PersonDossier } from "@kayfabe/graph-contract";
import type { MorphData, NeighborRel } from "../morphAdapter";
import { LOOM, PRIORITY, emptyBounds, growBounds, type MorphControlsState } from "./layoutTypes";
import { sampleOrganicBow, sampleSpatialCurve } from "./routing";
import { packBackground } from "./backgroundRack";

/**
 * 3D RELATIONSHIP ARRAY
 *
 * X separates relationship banks, Y communicates documented strength, and Z
 * communicates first documented encounter. Mixed relationships come toward
 * the reader, battle-royal-only contacts sit below, promotions occupy the
 * upper/back volume and championships the gold upper/front rail. Every slot
 * is deterministic and every rendered relation terminates at its node.
 */

type Category = "opponent" | "partner" | "br";

interface PlacedRel {
  rel: NeighborRel;
  category: Category;
  mixed: boolean;
  rank: number;
  x: number;
  y: number;
  z: number;
}

const relStrength = (r: NeighborRel): number => r.opposed + r.same + r.br;
const yearOf = (day: number): number => dayToDate(day).getUTCFullYear();
const mixedRel = (r: NeighborRel): boolean =>
  Math.min(r.same, r.opposed) >= 3 && Math.min(r.same, r.opposed) / Math.max(1, r.same, r.opposed) >= 0.25;

export function buildLoom(
  data: MorphData,
  selectedId: string,
  dossier: PersonDossier | null,
  titleNameOf: (id: string) => string | null,
  controls: MorphControlsState,
  traceCap: number,
): MorphLayoutResult {
  const n = data.count;
  const selIdx = data.indexOf(selectedId);
  if (selIdx === undefined) throw new Error(`relationship array: ${selectedId} has no corpus node`);

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
  const exclude = new Set<number>([selIdx]);
  let minZ = Infinity;
  let maxZ = -Infinity;
  const grow3 = (x: number, y: number, z: number, pad = 0) => {
    growBounds(active, x, y, pad);
    minZ = Math.min(minZ, z - pad);
    maxZ = Math.max(maxZ, z + pad);
  };

  const relations = data.relationsOf(selIdx);
  const opponents: NeighborRel[] = [];
  const partners: NeighborRel[] = [];
  const battle: NeighborRel[] = [];
  for (const r of relations) {
    if (r.same === 0 && r.opposed === 0 && r.br > 0) battle.push(r);
    else if (r.opposed >= r.same) opponents.push(r);
    else partners.push(r);
  }
  const compare = comparator(controls);
  opponents.sort(compare);
  partners.sort(compare);
  battle.sort((a, b) => b.br - a.br || stableId(a, b));

  const days = relations.filter((r) => Number.isFinite(r.firstDay)).map((r) => r.firstDay);
  const dayMin = days.length ? Math.min(...days) : 0;
  const dayMax = days.length ? Math.max(...days, dayMin + 1) : 1;
  const maxStrength = Math.max(1, ...relations.map(relStrength));
  const chronoZ = (r: NeighborRel): number =>
    -LOOM.railDepth + ((r.firstDay - dayMin) / Math.max(1, dayMax - dayMin)) * LOOM.railDepth * 2;
  const strengthY = (r: NeighborRel, rank: number): number => {
    const k = Math.log1p(relStrength(r)) / Math.log1p(maxStrength);
    // Stable rank separates exact ties without changing the strength reading.
    return -LOOM.bankHeight * 0.38 + k * LOOM.bankHeight * 0.86 - rank * 0.01;
  };

  const placed: PlacedRel[] = [];
  const placeBank = (list: NeighborRel[], category: "opponent" | "partner", side: -1 | 1) => {
    list.forEach((r, rank) => {
      const shelf = Math.floor(rank / 44);
      const lane = rank % 44;
      const mixed = mixedRel(r);
      const x = side * (LOOM.railX + shelf * LOOM.shelfGap + (lane % 3) * 8);
      const y = strengthY(r, rank);
      const z = Math.min(LOOM.railDepth + 160, chronoZ(r) + (mixed ? 160 : 0) + (lane % 4) * 5);
      placed.push({ rel: r, category, mixed, rank, x, y, z });
    });
  };
  placeBank(opponents, "opponent", -1);
  placeBank(partners, "partner", 1);
  battle.forEach((r, rank) => {
    const row = Math.floor(rank / 22);
    const col = rank % 22;
    placed.push({
      rel: r,
      category: "br",
      mixed: false,
      rank,
      x: (col - 10.5) * 31 + (row % 2) * 15.5,
      y: LOOM.brY - row * 32,
      z: chronoZ(r),
    });
  });

  const organic = data.organic;
  const totalPlaced = placed.length;
  const relationBudget = Math.max(0, traceCap);
  let traced = 0;
  for (let order = 0; order < placed.length; order++) {
    const p = placed[order]!;
    const r = p.rel;
    const i = r.index;
    const i3 = i * 3;
    const strength = relStrength(r);
    nodeTargets[i3] = p.x;
    nodeTargets[i3 + 1] = p.y;
    nodeTargets[i3 + 2] = p.z;
    nodeOpacity[i] = 0.52 + 0.42 * Math.min(1, Math.log1p(strength) / Math.log1p(maxStrength));
    nodeScale[i] = (p.category === "br" ? 2.4 : 2.8) + 2.2 * Math.sqrt(strength / maxStrength);
    nodeRole[i] = p.category === "br" ? MR.BATTLE_ROYAL : p.mixed ? MR.MIXED : p.category === "opponent" ? MR.OPPONENT : MR.PARTNER;
    nodeDelay[i] = 0.1 + 0.48 * (order / Math.max(1, totalPlaced - 1));
    exclude.add(i);
    grow3(p.x, p.y, p.z, 16);

    const first = yearOf(r.firstDay);
    const last = yearOf(r.lastDay);
    const relationship = p.category === "br"
      ? `battle-royal contact ×${r.br}`
      : p.mixed
        ? `mixed · opposed ×${r.opposed} · same-side ×${r.same}`
        : p.category === "opponent"
          ? `opponent · documented encounters ×${r.opposed}`
          : `partner · documented same-side matches ×${r.same}`;
    labels.push({
      key: `n:${r.id}`,
      x: p.x,
      y: p.y + 10,
      z: p.z,
      text: r.name,
      sub: relationship,
      detail: `${strength} documented shared matches · ${first === last ? first : `${first}–${last}`}`,
      badge: p.mixed ? "±" : undefined,
      priority: PRIORITY.neighborBase + PRIORITY.neighborSpan * (1 - order / Math.max(1, totalPlaced)),
      tone: p.category === "opponent" ? "ember" : p.category === "partner" ? "cyan" : "muted",
      pick: r.id,
    });

    if (traced < relationBudget) {
      const target = sampleSpatialCurve(0, 0, 0, p.x, p.y, p.z, (order % 11) * 3.5, i * 31 + selIdx);
      routes.push({
        key: pairKey(selectedId, r.id),
        points: target,
        fromPoints: sampleOrganicBow(
          organic[selIdx * 3]!, organic[selIdx * 3 + 1]!, organic[selIdx * 3 + 2]!,
          organic[i3]!, organic[i3 + 1]!, organic[i3 + 2]!,
          i * 13 + 1,
        ),
        color: relationColor(r.same, r.opposed, r.br, r.title),
        width: 0.9 + 1.9 * Math.min(1, Math.log1p(strength) / Math.log1p(maxStrength)),
        alpha: 0.2 + 0.36 * Math.min(1, Math.log1p(strength) / Math.log1p(maxStrength)),
        kind: TK.RELATION,
        a: selIdx,
        b: i,
      });
      traced++;
    }
  }
  if (placed.length > traced) notes.push(`strongest ${traced} of ${placed.length} relationship traces routed; every related node remains represented`);

  // Context anchors are true spatial tiers, not another row on a flat board.
  const promoEntries = Object.entries(dossier?.promos ?? {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const promoShown = promoEntries.slice(0, 18);
  promoShown.forEach(([id, count], i) => {
    const layer = Math.floor(i / 9);
    const col = i % 9;
    const x = (col - Math.min(8, promoShown.length - 1) / 2) * 92;
    const y = LOOM.busY + layer * 46;
    const z = -245 - layer * 72;
    placeContextNode(data, id, x, y, z, 5.2, 0.82, MR.PROMO_CONTEXT, rgb(M.promotion), nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, virtuals, exclude);
    grow3(x, y, z, 24);
    labels.push({
      key: `n:${id}`,
      x, y: y + 12, z,
      text: data.nameOf(id) ?? id,
      sub: `promotion · ${count.toLocaleString()} documented appearances`,
      detail: "documented appearances, not employment status",
      priority: PRIORITY.context + count / 1e6,
      tone: "promotion",
      pick: id,
    });
    if (routes.length < traceCap + 36) routes.push(contextRoute(selectedId, selIdx, id, data.indexOf(id), x, y, z, TK.CONTEXT_PROMO, rgb(M.promotion), i));
  });
  if (promoEntries.length > promoShown.length) notes.push(`${promoEntries.length - promoShown.length} additional documented promotions remain in the inspector`);

  const titleEntries = (dossier?.titles ?? [])
    .map((t) => ({ id: t.t, reigns: t.reigns.length }))
    .sort((a, b) => b.reigns - a.reigns || (a.id < b.id ? -1 : 1));
  const titleShown = titleEntries.slice(0, 16);
  titleShown.forEach((t, i) => {
    const layer = Math.floor(i / 8);
    const col = i % 8;
    const x = (col - Math.min(7, titleShown.length - 1) / 2) * 102;
    const y = LOOM.goldY + layer * 48;
    const z = 245 + layer * 68;
    placeContextNode(data, t.id, x, y, z, 4.4, 0.9, MR.TITLE_CONTEXT, rgb(M.gold), nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay, virtuals, exclude);
    grow3(x, y, z, 22);
    regions.push({ key: `array:title:${t.id}`, x, y, z: z - 5, w: 72, h: 8, color: rgb(M.goldDeep), alpha: 0.3, kind: RK.GOLD, pick: t.id });
    labels.push({
      key: `n:${t.id}`,
      x, y: y + 11, z,
      text: titleNameOf(t.id) ?? data.nameOf(t.id) ?? t.id,
      sub: `championship · ${t.reigns} documented reign${t.reigns === 1 ? "" : "s"}`,
      priority: PRIORITY.context + 20 + t.reigns / 1e4,
      tone: "gold",
      pick: t.id,
    });
    if (routes.length < traceCap + 36) routes.push(contextRoute(selectedId, selIdx, t.id, data.indexOf(t.id), x, y, z, TK.CONTEXT_TITLE, rgb(M.gold), i + 101));
  });
  if (titleEntries.length > titleShown.length) notes.push(`${titleEntries.length - titleShown.length} additional documented championships remain in the inspector`);

  // Anchor is deliberately compact and bright; emphasis supplies the halo.
  nodeTargets[selIdx * 3] = 0;
  nodeTargets[selIdx * 3 + 1] = 0;
  nodeTargets[selIdx * 3 + 2] = 0;
  nodeOpacity[selIdx] = 1;
  nodeScale[selIdx] = 9;
  nodeRole[selIdx] = MR.SELECTED;
  nodeDelay[selIdx] = 0;
  grow3(0, 0, 0, 30);
  const selectedName = data.model.nodes.name[selIdx]!;
  labels.push({
    key: `n:${selectedId}`,
    x: 0, y: 14, z: 0,
    text: selectedName,
    sub: `wrestler · ${dossier?.first ? `${dossier.first.slice(0, 4)}–${dossier.last!.slice(0, 4)}` : "documented record"}`,
    detail: dossier
      ? `${dossier.m.toLocaleString()} documented matches · ${relations.length.toLocaleString()} relationships`
      : `${relations.length.toLocaleString()} documented relationships`,
    priority: PRIORITY.selected,
    tone: "person",
    force: true,
    pick: selectedId,
  });

  // A few restrained rails explain axes without enclosing everything in cards.
  for (const side of [-1, 1] as const) {
    if ((side < 0 ? opponents.length : partners.length) === 0) continue;
    regions.push({
      key: `array:bank:${side}`,
      x: side * LOOM.railX,
      y: 0,
      z: -LOOM.railDepth,
      w: 2.2,
      h: LOOM.bankHeight + 80,
      color: rgb(side < 0 ? M.opposed : M.same),
      alpha: 0.22,
      kind: RK.TICK,
    });
    labels.push({
      key: `array:bank:${side}:label`,
      x: side * LOOM.railX,
      y: LOOM.bankHeight * 0.56,
      z: -LOOM.railDepth,
      text: side < 0 ? `OPPONENT BANK · ${opponents.length}` : `PARTNER BANK · ${partners.length}`,
      sub: "height = relationship strength · depth = first documented encounter",
      priority: PRIORITY.header,
      tone: side < 0 ? "ember" : "cyan",
    });
  }
  if (battle.length > 0) labels.push({
    key: "array:battle:label",
    x: 0, y: LOOM.brY + 30, z: -LOOM.railDepth,
    text: `BATTLE-ROYAL-ONLY CONTACTS · ${battle.length}`,
    priority: PRIORITY.header - 1,
    tone: "muted",
  });
  if (promoShown.length > 0) labels.push({
    key: "array:promos:label",
    x: -410, y: LOOM.busY + 42, z: -245,
    text: "PROMOTION CONTEXT",
    sub: "documented appearances · not employment",
    priority: PRIORITY.header,
    tone: "promotion",
    anchor: "left",
  });
  if (titleShown.length > 0) labels.push({
    key: "array:titles:label",
    x: -410, y: LOOM.goldY + 40, z: 245,
    text: "CHAMPIONSHIP CONTEXT",
    priority: PRIORITY.header,
    tone: "gold",
    anchor: "left",
  });

  // Sparse depth rails make chronology and parallax readable without a flat
  // backplane. They are data axes, not decoration.
  for (const side of [-1, 1] as const) {
    const color = rgb(side < 0 ? M.opposed : M.same);
    for (let k = 0; k < 5; k++) {
      const y = -LOOM.bankHeight * 0.34 + (k / 4) * LOOM.bankHeight * 0.78;
      routes.push({
        key: `ctx:axis:relationship:${side}:${k}`,
        points: straight3(side * LOOM.railX, y, -LOOM.railDepth, side * LOOM.railX, y, LOOM.railDepth + 150),
        color,
        width: 0.65,
        alpha: 0.11,
        kind: TK.BUS,
        a: -1,
        b: -1,
      });
    }
  }
  routes.push({
    key: "ctx:axis:promotion",
    points: straight3(-430, LOOM.busY, -245, 430, LOOM.busY, -245),
    color: rgb(M.promotion), width: 0.8, alpha: 0.16, kind: TK.BUS, a: -1, b: -1,
  });
  routes.push({
    key: "ctx:axis:championship",
    points: straight3(-430, LOOM.goldY, 245, 430, LOOM.goldY, 245),
    color: rgb(M.gold), width: 0.9, alpha: 0.18, kind: TK.BUS, a: -1, b: -1,
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
    controls.context !== false,
  );
  regions.push(...rack.regions);
  labels.push(...rack.labels);

  const allBounds = { ...bounds, minZ: Math.min(minZ, -900), maxZ: Math.max(maxZ, 900) };
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
    bounds: allBounds,
    fitBounds,
    anchorId: selectedId,
    representedCount: n,
    expandedCount: placed.length + promoShown.length + titleShown.length + 1,
    notes,
  };
}

function comparator(controls: MorphControlsState): (a: NeighborRel, b: NeighborRel) => number {
  return (a, b) => {
    switch (controls.sort) {
      case "first": return a.firstDay - b.firstDay || stableId(a, b);
      case "latest": return b.lastDay - a.lastDay || stableId(a, b);
      case "median": return (a.firstDay + a.lastDay) - (b.firstDay + b.lastDay) || stableId(a, b);
      case "alpha": return a.name.localeCompare(b.name) || stableId(a, b);
      default: return relStrength(b) - relStrength(a) || stableId(a, b);
    }
  };
}

function stableId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function placeContextNode(
  data: MorphData,
  id: string,
  x: number,
  y: number,
  z: number,
  scaleValue: number,
  alpha: number,
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
    virtuals.push({ id, x, y, z, scale: scaleValue, opacity: alpha, color, role: roleValue });
    return;
  }
  const i3 = index * 3;
  targets[i3] = x;
  targets[i3 + 1] = y;
  targets[i3 + 2] = z;
  opacity[index] = alpha;
  scale[index] = scaleValue;
  role[index] = roleValue;
  delay[index] = 0.5;
  exclude.add(index);
}

function contextRoute(
  selectedId: string,
  selectedSlot: number,
  id: string,
  slot: number | undefined,
  x: number,
  y: number,
  z: number,
  kind: TraceKind,
  color: [number, number, number],
  seed: number,
): MorphRoute {
  return {
    key: `ctx:${selectedId}:${id}`,
    points: sampleSpatialCurve(0, 0, 0, x, y, z, 28 + (seed % 7) * 5, seed * 101 + selectedSlot),
    color,
    width: kind === TK.CONTEXT_TITLE ? 2.1 : 1.7,
    alpha: kind === TK.CONTEXT_TITLE ? 0.46 : 0.34,
    kind,
    a: selectedSlot,
    b: slot ?? -1,
  };
}

function straight3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): Float32Array {
  const out = new Float32Array(TRACE_SAMPLES * 3);
  for (let i = 0; i < TRACE_SAMPLES; i++) {
    const t = i / (TRACE_SAMPLES - 1);
    out[i * 3] = ax + (bx - ax) * t;
    out[i * 3 + 1] = ay + (by - ay) * t;
    out[i * 3 + 2] = az + (bz - az) * t;
  }
  return out;
}
