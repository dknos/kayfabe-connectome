import {
  M,
  MR,
  RK,
  TK,
  TRACE_SAMPLES,
  hash01,
  rgb,
  type MorphLabel,
  type MorphLayoutResult,
  type MorphRegion,
  type MorphRoute,
  type MorphVirtualNode,
} from "@kayfabe/morph-renderer";
import { dayToDate, type AtlasPromotionDetail } from "@kayfabe/graph-contract";
import type { MorphData } from "../morphAdapter";
import { PRIORITY, emptyBounds, growBounds, type MorphControlsState } from "./layoutTypes";
import { packBackground } from "./backgroundRack";
import { sampleSpatialCurve } from "./routing";

/**
 * 3D PROMOTION NETWORK
 *
 * The promotion is the nucleus. Participants form deterministic volumetric
 * era shelves: depth is first documented appearance, height/radius encode
 * documented activity, and championship context occupies a separate gold
 * upper/front spine. Nothing here implies a roster, employment, or contract.
 */

const yearOf = (day: number): number => dayToDate(day).getUTCFullYear();
const fmtDay = (day: number): string => day < 0 ? "—" : dayToDate(day).toISOString().slice(0, 10);
const golden = Math.PI * (3 - Math.sqrt(5));

export function buildMotherboard(
  data: MorphData,
  promoId: string,
  detail: AtlasPromotionDetail | null,
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
  const active = emptyBounds();
  const exclude = new Set<number>();
  let minZ = Infinity;
  let maxZ = -Infinity;
  const grow3 = (x: number, y: number, z: number, pad = 0) => {
    growBounds(active, x, y, pad);
    minZ = Math.min(minZ, z - pad);
    maxZ = Math.max(maxZ, z + pad);
  };

  const d = detail;
  const name = data.nameOf(promoId) ?? d?.n ?? promoId;
  const promoIdx = data.indexOf(promoId);
  if (promoIdx !== undefined) {
    writeNode(promoIdx, 0, 0, 0, 10, 1, MR.SELECTED, 0, nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay);
    exclude.add(promoIdx);
  } else {
    virtuals.push({ id: promoId, x: 0, y: 0, z: 0, scale: 10, opacity: 1, color: rgb(M.promotion), role: MR.SELECTED });
  }
  grow3(0, 0, 0, 34);
  labels.push({
    key: `n:${promoId}`,
    x: 0, y: 18, z: 0,
    text: name,
    sub: d
      ? `promotion · ${fmtDay(d.firstDay)} → ${fmtDay(d.lastDay)}`
      : shardFailed ? "promotion detail unavailable · registry data only" : "loading promotion detail…",
    detail: d
      ? `${d.cards.toLocaleString()} documented cards · ${d.matches.toLocaleString()} documented matches · ${d.people.toLocaleString()} documented participants · source ${d.src}`
      : undefined,
    priority: PRIORITY.selected,
    tone: "promotion",
    force: true,
    pick: promoId,
  });

  const members = d?.members ?? [];
  const memberDays = members.filter((m) => m.firstDay >= 0).map((m) => m.firstDay);
  const dayMin = memberDays.length ? Math.min(...memberDays) : d?.firstDay ?? 0;
  const dayMax = memberDays.length ? Math.max(...memberDays, dayMin + 1) : d?.lastDay ?? dayMin + 1;
  const maxMatches = Math.max(1, ...members.map((m) => m.matches));
  const eraGroups = new Map<string, typeof members>();
  for (const member of members) {
    const key = member.firstDay < 0 ? "undated" : `${Math.floor(yearOf(member.firstDay) / 10) * 10}s`;
    let group = eraGroups.get(key);
    if (!group) eraGroups.set(key, (group = []));
    group.push(member);
  }
  const eraNames = [...eraGroups.keys()].sort((a, b) => a === "undated" ? 1 : b === "undated" ? -1 : a.localeCompare(b));
  const eraSpacing = Math.min(250, Math.max(180, 1_520 / Math.max(1, eraNames.length - 1)));

  for (let eraIndex = 0; eraIndex < eraNames.length; eraIndex++) {
    const era = eraNames[eraIndex]!;
    const list = eraGroups.get(era)!;
    list.sort((a, b) => b.matches - a.matches || (a.p < b.p ? -1 : 1));
    const eraDay = list.find((m) => m.firstDay >= 0)?.firstDay ?? dayMin;
    const eraZ = -390 + ((eraDay - dayMin) / Math.max(1, dayMax - dayMin)) * 780;
    const eraX = (eraIndex - (eraNames.length - 1) * 0.5) * eraSpacing;
    routes.push({
      key: `ctx:axis:promotion-era:${era}`,
      points: straight3(eraX - 104, -210, eraZ, eraX + 104, -210, eraZ),
      color: rgb(M.ruleBright), width: 0.7, alpha: 0.12, kind: TK.BUS, a: -1, b: -1,
    });
    labels.push({
      key: `mb:bank:${era}:h`,
      x: eraX - 108, y: 224, z: eraZ,
      text: `${era.toUpperCase()} · ${list.length} documented`,
      sub: "first documented appearance band",
      priority: PRIORITY.header - eraIndex,
      tone: "neutral",
      anchor: "left",
      force: true,
    });
    grow3(eraX - 124, -220, eraZ, 10);
    grow3(eraX + 124, 248, eraZ, 10);

    for (let k = 0; k < list.length; k++) {
      const member = list[k]!;
      const idx = data.indexOf(member.p);
      if (idx === undefined) continue;
      const strength = Math.log1p(member.matches) / Math.log1p(maxMatches);
      const tier = Math.floor(k / 180);
      const local = k % 180;
      const angle = local * golden + eraIndex * 0.41 + tier * 0.23;
      const radius = Math.min(112, 18 + Math.sqrt(local) * 7.2);
      // Each decade owns a compact volumetric shelf. The shelves separate in
      // both screen X and chronological Z; inside one shelf Y remains the
      // dominant activity reading instead of dissolving into a glowing ball.
      const x = eraX + Math.cos(angle) * radius + ((tier % 3) - 1) * 18;
      const y = -154 + strength * 334 + Math.sin(angle) * 22 + Math.floor(tier / 3) * 9;
      const z = eraZ + (hash01(idx * 37 + eraIndex) - 0.5) * 48 + (tier - 1) * 24;
      writeNode(
        idx, x, y, z,
        (member.champ ? 2.35 : 1.05) + strength * 1.35,
        member.champ ? 0.64 : 0.035 + strength * 0.13,
        MR.MEMBER,
        0.2 + hash01(idx) * 0.55,
        nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay,
      );
      exclude.add(idx);
      grow3(x, y, z, 8);
      // Keep metadata for every pickable participant. The pooled label layer
      // shows only its spatially legible cap, but a hovered node is promoted
      // in place so its identity and evidence are always available.
      labels.push({
        key: `n:${member.p}`,
        x, y: y + 8, z,
        text: member.n,
        sub: `wrestler · ${member.cards.toLocaleString()} documented cards · ${member.matches.toLocaleString()} documented matches`,
        detail: `${fmtDay(member.firstDay)} → ${fmtDay(member.lastDay)} in ${name}${member.champ ? " · documented title holder" : ""}`,
        priority: PRIORITY.neighborBase + member.matches / Math.max(1, maxMatches),
        tone: member.champ ? "gold" : "neutral",
        pick: member.p,
      });
    }
  }

  if (d?.membersTruncated) {
    notes.push(`${d.membersTruncated.toLocaleString()} further documented participants beyond the chronology projection cap; semantic illumination still follows the canonical membership resolver`);
  }
  if (!d) {
    notes.push(shardFailed
      ? "promotion detail failed to load — participant shelves and championship context are unavailable; retry remains possible"
      : "promotion detail is loading — the nucleus and corpus context remain available");
  }

  // Championship spine: upper/front, chronologically placed in Z.
  const titles = (d?.titles ?? []).slice().sort(
    (a, b) => (a.firstDay < 0 ? 1 : b.firstDay < 0 ? -1 : a.firstDay - b.firstDay) || (a.t < b.t ? -1 : 1),
  );
  const titleShown = titles.slice(0, 28);
  if (titles.length > titleShown.length) notes.push(`${titles.length - titleShown.length} additional championships remain in the inspector`);
  for (let i = 0; i < titleShown.length; i++) {
    const title = titleShown[i]!;
    const z = title.firstDay < 0
      ? 420 + Math.floor(i / 7) * 46
      : -350 + ((title.firstDay - dayMin) / Math.max(1, dayMax - dayMin)) * 700 + 145;
    const x = -420 + (i % 7) * 140;
    const y = 285 + Math.floor(i / 7) * 52;
    const idx = data.indexOf(title.t);
    if (idx !== undefined) {
      writeNode(idx, x, y, z, 4.4, 0.9, MR.TITLE_CONTEXT, 0.46, nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay);
      exclude.add(idx);
    } else {
      virtuals.push({ id: title.t, x, y, z, scale: 4.4, opacity: 0.88, color: rgb(M.gold), role: MR.TITLE_CONTEXT });
    }
    grow3(x, y, z, 24);
    regions.push({ key: `mb:gold:${title.t}`, x, y, z: z - 4, w: 78, h: 8, color: rgb(M.goldDeep), alpha: 0.32, kind: RK.GOLD, pick: title.t });
    const reignText = title.lineage === "no-changes"
      ? "no title-change field in source · reigns not derived"
      : `${title.reigns} documented reigns · ${title.holders} documented holders`;
    labels.push({
      key: `n:${title.t}`,
      x, y: y + 10, z,
      text: title.n.length > 34 ? `${title.n.slice(0, 33)}…` : title.n,
      sub: reignText,
      detail: `${title.titleMatches.toLocaleString()} documented title matches · ${fmtDay(title.firstDay)} → ${fmtDay(title.lastDay)}${title.artifact ? " · source artifact" : ""}`,
      badge: title.artifact ? "!" : undefined,
      priority: PRIORITY.context + 40 - i,
      tone: title.artifact ? "warn" : "gold",
      pick: title.t,
    });
    routes.push({
      key: `ctx:${promoId}:${title.t}`,
      points: sampleSpatialCurve(0, 0, 0, x, y, z, 36 + (i % 6) * 5, i * 101 + (promoIdx ?? 0)),
      color: rgb(M.gold), width: 1.45, alpha: 0.34, kind: TK.CONTEXT_TITLE,
      a: promoIdx ?? -1, b: idx ?? -1,
    });
  }
  if (titleShown.length > 0) labels.push({
    key: "mb:title-spine:h",
    x: -450, y: 352, z: 170,
    text: "CHAMPIONSHIP SPINE",
    sub: "gold context · documented titles associated with this promotion",
    priority: PRIORITY.header,
    tone: "gold",
    anchor: "left",
  });

  if (!Number.isFinite(active.minX)) grow3(0, 0, 0, 1);
  const fitBounds = { ...active, minZ, maxZ };
  const bounds = { ...active };
  const rack = packBackground(
    data, exclude, active,
    nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay,
    bounds, controls.context !== false,
  );
  regions.push(...rack.regions);
  labels.push(...rack.labels);
  const allBounds = { ...bounds, minZ: Math.min(minZ, -900), maxZ: Math.max(maxZ, 900) };
  return {
    mode: "motherboard",
    nodeTargets, nodeOpacity, nodeScale, nodeRole, nodeDelay,
    virtuals, routes, labels, regions,
    bounds: allBounds,
    fitBounds,
    anchorId: promoId,
    representedCount: n,
    expandedCount: members.length + titleShown.length + 1,
    notes,
  };
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
