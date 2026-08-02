// SYNTHETIC topology fixtures — never production evidence.
import { describe, expect, it } from "vitest";
import {
  MR,
  TK,
  TRACE_SAMPLES,
  type MorphLayoutResult,
  type MorphTier,
} from "@kayfabe/morph-renderer";
import { isoToDay, type PersonDossier } from "@kayfabe/graph-contract";
import type { MorphData, NeighborRel } from "../morph/morphAdapter";
import {
  ORBIT_BUDGETS,
  buildOrbitMap,
  classifyDirectRelationship,
  relationshipStrength,
  relaxCircularAngles,
  weightedCircularMean,
} from "../morph/layouts/orbitMap";
import { DEFAULT_MORPH_CONTROLS } from "../morph/layouts/layoutTypes";

interface EdgeDef {
  a: string;
  b: string;
  same?: number;
  opposed?: number;
  br?: number;
  title?: number;
  firstDay?: number;
  lastDay?: number;
}

function makeData(
  people: string[],
  edges: EdgeDef[],
  context: { promotions?: string[]; titles?: string[] } = {},
): MorphData {
  const ids = [...people, ...(context.promotions ?? []), ...(context.titles ?? [])];
  const index = new Map(ids.map((id, i) => [id, i]));
  const types = ids.map((id) => id.startsWith("pr:") ? 1 : id.startsWith("t:") ? 2 : 0);
  const names = ids.map(nameOf);
  const adjacency = new Map<number, NeighborRel[]>();
  for (const edge of edges) {
    const a = index.get(edge.a);
    const b = index.get(edge.b);
    if (a === undefined || b === undefined) throw new Error(`bad synthetic edge ${edge.a} / ${edge.b}`);
    const add = (from: number, to: number, id: string) => {
      const list = adjacency.get(from) ?? [];
      list.push({
        index: to,
        id,
        name: names[to]!,
        same: edge.same ?? 0,
        opposed: edge.opposed ?? 0,
        br: edge.br ?? 0,
        title: edge.title ?? 0,
        firstDay: edge.firstDay ?? isoToDay("1980-01-01"),
        lastDay: edge.lastDay ?? edge.firstDay ?? isoToDay("1990-01-01"),
        promoMask: 1,
      });
      adjacency.set(from, list);
    };
    add(a, b, edge.b);
    add(b, a, edge.a);
  }
  const organic = new Float32Array(ids.length * 3);
  for (let i = 0; i < ids.length; i++) {
    organic[i * 3] = (i % 11 - 5) * 17;
    organic[i * 3 + 1] = (i % 7 - 3) * 13;
    organic[i * 3 + 2] = (i % 5 - 2) * 19;
  }
  const model = {
    nodes: {
      count: ids.length,
      id: ids,
      name: names,
      type: types,
      community: new Array(ids.length).fill(0),
    },
  };
  return {
    count: ids.length,
    organic,
    organicBounds: { minX: -100, maxX: 100, minY: -100, maxY: 100, minZ: -100, maxZ: 100 },
    graph: {
      count: ids.length,
      organic,
      color: new Float32Array(ids.length * 3),
      type: Uint8Array.from(types),
      organicScale: new Float32Array(ids.length).fill(1),
      organicOpacity: new Float32Array(ids.length).fill(0.1),
    },
    model,
    core: { communities: { size: [ids.length] }, promotions: {}, search: [] },
    idOf: (slot: number) => ids[slot] ?? null,
    indexOf: (id: string) => index.get(id),
    nameOf: (id: string) => {
      const slot = index.get(id);
      return slot === undefined ? (id.startsWith("pr:") || id.startsWith("t:") ? nameOf(id) : null) : names[slot]!;
    },
    relationsOf: (slot: number) => [...(adjacency.get(slot) ?? [])],
    topEdges: () => [],
  } as unknown as MorphData;
}

const basePeople = [
  "p:hero", "p:opp", "p:same", "p:mixed", "p:br", "p:bridge-one", "p:bridge-two", "p:isolated",
];
const baseEdges: EdgeDef[] = [
  { a: "p:hero", b: "p:opp", opposed: 12, title: 4, firstDay: isoToDay("1970-01-01") },
  { a: "p:hero", b: "p:same", same: 9, firstDay: isoToDay("1975-01-01") },
  { a: "p:hero", b: "p:mixed", same: 1, opposed: 8, firstDay: isoToDay("1980-01-01") },
  { a: "p:hero", b: "p:br", br: 7, firstDay: -1, lastDay: -1 },
  { a: "p:opp", b: "p:bridge-one", opposed: 6 },
  { a: "p:same", b: "p:bridge-one", same: 5 },
  { a: "p:mixed", b: "p:bridge-one", opposed: 3 },
  { a: "p:opp", b: "p:bridge-two", same: 2 },
  // Non-person adjacency must never enter the person bridge ring.
  { a: "p:opp", b: "pr:alpha", same: 100 },
];
const data = makeData(basePeople, baseEdges, { promotions: ["pr:alpha"], titles: ["t:alpha"] });
const dossier: PersonDossier = {
  n: "Hero", first: "1970-01-01", last: "2000-01-01", m: 100,
  promos: { "pr:alpha": 80, "pr:virtual": 20 }, years: {},
  top: { opponents: [], partners: [] }, teams: [],
  titles: [
    { t: "t:alpha", reigns: [{ s: "1980-01-01", e: "1981-01-01", m: "m:1" }] },
    { t: "t:virtual", reigns: [] },
    { t: "t:virtual", reigns: [] },
  ],
  src: {},
};

const build = (
  targetData = data,
  selected = "p:hero",
  detail: PersonDossier | null = dossier,
  tier: MorphTier = "high",
  context = true,
  requiredIds: readonly string[] = [],
) => buildOrbitMap(
  targetData,
  selected,
  detail,
  (id) => nameOf(id),
  { ...DEFAULT_MORPH_CONTROLS, context },
  { tier, traceCap: 1_400, requiredIds },
);

function nameOf(id: string): string {
  return id.slice(id.indexOf(":") + 1).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function bytes(array: ArrayBufferView): number[] {
  return [...new Uint8Array(array.buffer, array.byteOffset, array.byteLength)];
}

function expectFinite(layout: MorphLayoutResult): void {
  for (const values of [layout.nodeTargets, layout.nodeOpacity, layout.nodeScale, layout.nodeDelay]) {
    for (const value of values) expect(Number.isFinite(value)).toBe(true);
  }
  for (const route of layout.routes) {
    expect(route.points).toHaveLength(TRACE_SAMPLES * 3);
    for (const value of route.points) expect(Number.isFinite(value)).toBe(true);
  }
  for (const value of [
    layout.bounds.minX, layout.bounds.maxX, layout.bounds.minY, layout.bounds.maxY,
    layout.fitBounds?.minX, layout.fitBounds?.maxX, layout.fitBounds?.minY, layout.fitBounds?.maxY,
    layout.fitBounds?.minZ, layout.fitBounds?.maxZ,
  ]) expect(Number.isFinite(value)).toBe(true);
  expect(layout.fitBounds!.maxX - layout.fitBounds!.minX).toBeGreaterThan(0);
  expect(layout.fitBounds!.maxY - layout.fitBounds!.minY).toBeGreaterThan(0);
}

describe("Orbit relationship semantics", () => {
  it("uses one documented-strength formula and never lets title context create a relationship", () => {
    expect(relationshipStrength({ same: 4, opposed: 3, br: 10 })).toBe(10.5);
    expect(relationshipStrength({ same: 0, opposed: 0, br: 0 })).toBe(0);
    expect(relationshipStrength({ same: Number.NaN, opposed: -2, br: 0 })).toBe(0);
    expect(classifyDirectRelationship({ same: 1, opposed: 99, br: 0 })).toBe("mixed");
    expect(classifyDirectRelationship({ same: 0, opposed: 3, br: 8 })).toBe("opposed");
    expect(classifyDirectRelationship({ same: 4, opposed: 0, br: 8 })).toBe("same-side");
    expect(classifyDirectRelationship({ same: 0, opposed: 0, br: 8 })).toBe("battle-royal-only");
    expect(classifyDirectRelationship({ same: 0, opposed: 0, br: 0 })).toBeNull();
  });

  it("handles circular wrap-around and collision relaxation deterministically", () => {
    const mean = weightedCircularMean([
      { angle: Math.PI - 0.08, weight: 2 },
      { angle: -Math.PI + 0.08, weight: 2 },
    ]);
    expect(Math.abs(Math.abs(mean) - Math.PI)).toBeLessThan(0.02);
    const input = [
      { id: "p:c", angle: Math.PI - 0.01 },
      { id: "p:a", angle: -Math.PI + 0.01 },
      { id: "p:b", angle: -Math.PI + 0.012 },
    ];
    expect(relaxCircularAngles(input, 0.1)).toEqual(relaxCircularAngles(input, 0.1));
    for (const item of relaxCircularAngles(input, 0.1)) expect(Number.isFinite(item.angle)).toBe(true);
  });
});

describe("Orbit Map pure layout", () => {
  it("is byte-identical, finite, deep, and centered on one canonical selected slot", () => {
    const a = build();
    const b = build();
    expectFinite(a);
    expect(bytes(a.nodeTargets)).toEqual(bytes(b.nodeTargets));
    expect(bytes(a.nodeOpacity)).toEqual(bytes(b.nodeOpacity));
    expect(bytes(a.nodeRole)).toEqual(bytes(b.nodeRole));
    expect(a.routes.map((route) => [route.key, bytes(route.points)])).toEqual(
      b.routes.map((route) => [route.key, bytes(route.points)]),
    );
    expect(a.orbitStats).toEqual(b.orbitStats);
    expect(a.orbit).toEqual(a.orbitDetails);

    const hero = data.indexOf("p:hero")!;
    expect(a.nodeRole[hero]).toBe(MR.SELECTED);
    expect([...a.nodeRole].filter((role) => role === MR.SELECTED)).toHaveLength(1);
    expect(a.nodeTargets[hero * 3]).toBe(0);
    expect(a.nodeTargets[hero * 3 + 1]).toBe(0);
    expect(a.nodeTargets[hero * 3 + 2]).toBe(40);
    expect(a.fitBounds!.maxZ! - a.fitBounds!.minZ!).toBeGreaterThan(300);
  });

  it("keeps direct and bridge populations disjoint and every bridge supported by displayed real paths", () => {
    const layout = build();
    const directIds = new Set(layout.orbitDetails.direct.map((item) => item.id));
    const bridgeIds = new Set(layout.orbitDetails.bridges.map((item) => item.id));
    expect(directIds).toEqual(new Set(["p:opp", "p:same", "p:mixed", "p:br"]));
    expect(bridgeIds).toEqual(new Set(["p:bridge-one", "p:bridge-two"]));
    expect(directIds.has("p:hero")).toBe(false);
    expect(bridgeIds.has("p:hero")).toBe(false);
    expect(bridgeIds.has("pr:alpha")).toBe(false);
    for (const id of directIds) expect(bridgeIds.has(id)).toBe(false);

    const one = layout.orbitDetails.bridges.find((item) => item.id === "p:bridge-one")!;
    expect(one.routeCount).toBe(3);
    expect(one.displayedRouteCount).toBe(3);
    expect(one.strongestIntermediaryId).toBe("p:opp");
    expect(one.supports.every((support) => directIds.has(support.intermediaryId))).toBe(true);
    expect(one.supports.every((support) => support.displayed)).toBe(true);
    expect(layout.nodeRole[one.index]).toBe(MR.BRIDGE);

    const bridgeRoutes = layout.routes.filter((route) => route.kind === TK.BRIDGE);
    expect(bridgeRoutes).toHaveLength(4);
    const selected = data.indexOf("p:hero")!;
    expect(bridgeRoutes.every((route) => route.a !== selected && route.b !== selected)).toBe(true);
    expect(bridgeRoutes.every((route) => directIds.has(data.idOf(route.a)!))).toBe(true);
    expect(bridgeRoutes.every((route) => bridgeIds.has(data.idOf(route.b)!))).toBe(true);
  });

  it("places graph hops in distinct deterministic bands and classifies mixed/battle evidence honestly", () => {
    const layout = build();
    for (const item of layout.orbitDetails.direct) {
      expect(item.radius).toBeGreaterThanOrEqual(245);
      expect(item.radius).toBeLessThan(525);
    }
    for (const item of layout.orbitDetails.bridges) expect(item.radius).toBeGreaterThanOrEqual(525);
    expect(layout.orbitDetails.direct.find((item) => item.id === "p:mixed")!.sector).toBe("mixed");
    expect(layout.orbitDetails.direct.find((item) => item.id === "p:br")!.sector).toBe("battle-royal-only");
    expect(layout.orbitDetails.direct.find((item) => item.id === "p:br")!.firstDay).toBeNull();
    expect(layout.labels.find((label) => label.pick === "p:br")!.detail).toContain("date unavailable");
  });

  it("uses keyed virtual context slots, honest context copy, and no invented employment/direct claims", () => {
    const layout = build();
    expect(layout.virtuals.map((item) => item.id).sort()).toEqual(["pr:virtual", "t:virtual"]);
    expect(new Set(layout.routes.map((route) => route.key)).size).toBe(layout.routes.length);
    expect(layout.routes.some((route) => route.kind === TK.CONTEXT_PROMO)).toBe(true);
    expect(layout.routes.some((route) => route.kind === TK.CONTEXT_TITLE)).toBe(true);
    const copy = layout.labels.flatMap((label) => [label.sub, label.detail]).filter(Boolean).join(" ").toLowerCase();
    expect(copy).toContain("not employment");
    expect(copy).not.toMatch(/is employed|employment at|employee of/);
    for (const bridge of layout.orbitDetails.bridges) {
      const label = layout.labels.find((item) => item.pick === bridge.id)!;
      expect(label.detail).toContain("no direct relationship is claimed");
    }
  });

  it("keeps active topology placement identical when distant corpus context is toggled", () => {
    const on = build(data, "p:hero", dossier, "high", true);
    const off = build(data, "p:hero", dossier, "high", false);
    const active = ["p:hero", ...on.orbitDetails.direct.map((item) => item.id), ...on.orbitDetails.bridges.map((item) => item.id)];
    for (const id of active) {
      const slot = data.indexOf(id)!;
      expect([...on.nodeTargets.slice(slot * 3, slot * 3 + 3)]).toEqual([...off.nodeTargets.slice(slot * 3, slot * 3 + 3)]);
      expect(on.nodeRole[slot]).toBe(off.nodeRole[slot]);
    }
    expect(on.orbitStats).toEqual(off.orbitStats);
  });

  it("degrades honestly for unavailable dossier, no direct relationships, and no bridge candidates", () => {
    const missing = build(data, "p:hero", null, "high", true, ["p:isolated"]);
    expect(missing.orbitStats.dossierAvailable).toBe(false);
    expect(missing.notes.join(" ")).toContain("Optional person detail is unavailable");
    expect(missing.orbitStats.directDisplayed).toBe(4);
    expect(missing.orbitStats.bridgeDisplayed).toBe(2);
    expect(missing.nodeRole[data.indexOf("p:isolated")!]).toBe(MR.BACKGROUND);
    expect(missing.notes.join(" ")).toContain("ambient context because no supported one-hop or two-hop Orbit placement exists");

    const empty = build(data, "p:isolated", null);
    expect(empty.orbitStats).toMatchObject({ directTotal: 0, directDisplayed: 0, bridgeTotal: 0, bridgeDisplayed: 0 });
    expect(empty.orbitStats.guideCount).toBe(0);
    expect(empty.notes.join(" ")).toContain("No graph-resident direct relationships");

    const directOnly = makeData(["p:center", "p:leaf"], [{ a: "p:center", b: "p:leaf", opposed: 2 }]);
    const noBridge = build(directOnly, "p:center", null);
    expect(noBridge.orbitStats).toMatchObject({ directDisplayed: 1, bridgeTotal: 0, bridgeDisplayed: 0, guideCount: 1 });
    expect(noBridge.notes.join(" ")).toContain("No second-hop bridge candidates");
  });

  it("enforces tier caps, discloses every bounded population, and retains supported required entities", () => {
    const directIds = Array.from({ length: 130 }, (_, i) => `p:d${i.toString().padStart(3, "0")}`);
    const bridgeIds = Array.from({ length: 200 }, (_, i) => `p:b${i.toString().padStart(3, "0")}`);
    const edges: EdgeDef[] = [];
    directIds.forEach((id, i) => edges.push({ a: "p:center", b: id, opposed: 130 - i }));
    bridgeIds.forEach((id, i) => {
      edges.push({ a: "p:d000", b: id, opposed: Math.max(1, 200 - i) });
      edges.push({ a: "p:d001", b: id, same: Math.max(1, 100 - Math.floor(i / 2)) });
    });
    const dense = makeData(["p:center", ...directIds, ...bridgeIds], edges);
    const high = build(dense, "p:center", null, "high", true, ["p:d129", "p:b199"]);
    expect(high.orbitStats.directTotal).toBe(130);
    expect(high.orbitStats.directDisplayed).toBe(ORBIT_BUDGETS.high.direct + 1);
    expect(high.orbitStats.bridgeTotal).toBe(200);
    expect(high.orbitStats.bridgeDisplayed).toBe(ORBIT_BUDGETS.high.bridge + 1);
    expect(high.orbitStats.bridgeRoutesDisplayed).toBe(ORBIT_BUDGETS.high.bridgeRoutes);
    expect(high.orbitStats.bridgeRoutesOmitted).toBeGreaterThan(0);
    expect(high.orbitStats.tierReduced).toBe(true);
    expect(high.orbitDetails.direct.some((item) => item.id === "p:d129")).toBe(true);
    expect(high.orbitDetails.bridges.some((item) => item.id === "p:b199")).toBe(true);
    expect(Math.max(...high.orbitDetails.direct.map((item) => item.radius))).toBeLessThan(
      Math.min(...high.orbitDetails.bridges.map((item) => item.radius)),
    );
    const notes = high.notes.join(" ");
    expect(notes).toContain("direct relationships displayed");
    expect(notes).toContain("bridge candidates displayed");
    expect(notes).toContain("additional routes omitted");

    for (const tier of ["medium", "low"] as const) {
      const layout = build(dense, "p:center", null, tier);
      expect(layout.orbitStats.directDisplayed).toBe(ORBIT_BUDGETS[tier].direct);
      expect(layout.orbitStats.bridgeDisplayed).toBe(ORBIT_BUDGETS[tier].bridge);
      expect(layout.orbitStats.bridgeRoutesDisplayed).toBe(ORBIT_BUDGETS[tier].bridgeRoutes);
    }
  });
});
