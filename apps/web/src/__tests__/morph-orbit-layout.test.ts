// SYNTHETIC fixtures only — production claims are never invented in tests.
import { describe, expect, it } from "vitest";
import { MR, TK, TRACE_SAMPLES, type MorphLayoutResult } from "@kayfabe/morph-renderer";
import { isoToDay, pairKey, type PersonDossier } from "@kayfabe/graph-contract";
import type { MorphData, NeighborRel } from "../morph/morphAdapter";
import { DEFAULT_MORPH_CONTROLS } from "../morph/layouts/layoutTypes";
import {
  ORBIT_BUDGETS,
  buildOrbitMap,
  classifyDirectRelationship,
  relationshipStrength,
  relaxCircularAngles,
  weightedCircularMean,
  type OrbitLayoutResult,
} from "../morph/layouts/orbitMap";

interface FixtureNode {
  id: string;
  name: string;
  type?: number;
}

interface FixtureEdge {
  a: string;
  b: string;
  same?: number;
  opposed?: number;
  br?: number;
  title?: number;
  firstDay?: number;
  lastDay?: number;
}

const first = isoToDay("1984-01-02");
const latest = isoToDay("1998-11-03");

function makeData(nodes: FixtureNode[], edges: FixtureEdge[]): MorphData {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const adjacency = new Map<number, NeighborRel[]>();
  const add = (from: string, to: string, edge: FixtureEdge) => {
    const fromIndex = index.get(from)!;
    const toIndex = index.get(to)!;
    const target = nodes[toIndex]!;
    const list = adjacency.get(fromIndex) ?? [];
    list.push({
      index: toIndex,
      id: target.id,
      name: target.name,
      same: edge.same ?? 0,
      opposed: edge.opposed ?? 0,
      br: edge.br ?? 0,
      title: edge.title ?? 0,
      firstDay: edge.firstDay ?? first,
      lastDay: edge.lastDay ?? latest,
      promoMask: 0,
    });
    adjacency.set(fromIndex, list);
  };
  for (const edge of edges) {
    add(edge.a, edge.b, edge);
    add(edge.b, edge.a, edge);
  }
  const organic = new Float32Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) {
    organic[i * 3] = (i % 5) * 17 - 34;
    organic[i * 3 + 1] = (i % 3) * 13 - 13;
    organic[i * 3 + 2] = (i % 7) * 11 - 33;
  }
  const names = nodes.map((node) => node.name);
  const ids = nodes.map((node) => node.id);
  const types = Uint8Array.from(nodes.map((node) => node.type ?? 0));
  const communities = new Int32Array(nodes.length);
  return {
    count: nodes.length,
    organic,
    organicBounds: { minX: -34, maxX: 34, minY: -13, maxY: 13, minZ: -33, maxZ: 33 },
    graph: {
      count: nodes.length,
      organic,
      color: new Float32Array(nodes.length * 3),
      type: types,
      organicScale: new Float32Array(nodes.length).fill(1),
      organicOpacity: new Float32Array(nodes.length).fill(0.1),
    },
    model: {
      nodes: { id: ids, name: names, type: types, community: communities },
    } as unknown as MorphData["model"],
    core: {
      communities: { size: [nodes.length] },
    } as unknown as MorphData["core"],
    idOf: (i) => ids[i] ?? null,
    indexOf: (id) => index.get(id),
    nameOf: (id) => names[index.get(id) ?? -1] ?? (id === "pr:virtual" ? "Virtual Promotion" : id === "t:virtual" ? "Virtual Title" : null),
    relationsOf: (i) => [...(adjacency.get(i) ?? [])],
    topEdges: () => [],
  };
}

const baseNodes: FixtureNode[] = [
  { id: "p:center", name: "Center" },
  { id: "p:opp", name: "Opponent" },
  { id: "p:same", name: "Partner" },
  { id: "p:mixed", name: "Mixed" },
  { id: "p:royal", name: "Royal" },
  { id: "p:bridge-x", name: "Bridge X" },
  { id: "p:bridge-y", name: "Bridge Y" },
  { id: "p:title-only", name: "Title Only" },
  { id: "p:ambient", name: "Ambient" },
  { id: "pr:graph", name: "Graph Promotion", type: 1 },
  { id: "t:graph", name: "Graph Title", type: 2 },
];

const baseEdges: FixtureEdge[] = [
  { a: "p:center", b: "p:opp", opposed: 6, title: 1 },
  { a: "p:center", b: "p:same", same: 5 },
  { a: "p:center", b: "p:mixed", same: 3, opposed: 2 },
  { a: "p:center", b: "p:royal", br: 4 },
  { a: "p:center", b: "p:title-only", title: 20 },
  { a: "p:opp", b: "p:bridge-x", same: 4 },
  { a: "p:same", b: "p:bridge-x", opposed: 9 },
  { a: "p:opp", b: "p:bridge-y", same: 2 },
];

const dossier: PersonDossier = {
  n: "Center",
  first: "1980-01-01",
  last: "2000-01-01",
  m: 50,
  promos: { "pr:graph": 20, "pr:virtual": 3 },
  years: {},
  top: { partners: [], opponents: [] },
  teams: [],
  titles: [
    { t: "t:graph", reigns: [{ s: "1990-01-01", e: "1991-01-01", m: "m:1" }] },
    { t: "t:virtual", reigns: [] },
  ],
  src: {},
};

function build(
  data = makeData(baseNodes, baseEdges),
  opts: Partial<{ tier: "high" | "medium" | "low"; traceCap: number; requiredIds: readonly string[]; context: boolean }> = {},
  detail: PersonDossier | null = dossier,
): OrbitLayoutResult {
  return buildOrbitMap(
    data,
    "p:center",
    detail,
    (id) => data.nameOf(id),
    { ...DEFAULT_MORPH_CONTROLS, context: opts.context ?? true },
    { tier: opts.tier ?? "high", traceCap: opts.traceCap ?? 500, requiredIds: opts.requiredIds },
  );
}

function assertFinite(layout: MorphLayoutResult): void {
  for (const values of [layout.nodeTargets, layout.nodeOpacity, layout.nodeScale, layout.nodeDelay]) {
    for (const value of values) expect(Number.isFinite(value)).toBe(true);
  }
  for (const route of layout.routes) {
    expect(route.points).toHaveLength(TRACE_SAMPLES * 3);
    for (const value of route.points) expect(Number.isFinite(value)).toBe(true);
  }
  expect(Number.isFinite(layout.bounds.minX)).toBe(true);
  expect(Number.isFinite(layout.bounds.maxX)).toBe(true);
  expect(layout.bounds.maxX).toBeGreaterThan(layout.bounds.minX);
  expect(layout.bounds.maxY).toBeGreaterThan(layout.bounds.minY);
}

function expectSameBytes(a: ArrayBufferView, b: ArrayBufferView): void {
  expect([...new Uint8Array(a.buffer, a.byteOffset, a.byteLength)]).toEqual([...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]);
}

describe("Orbit evidence helpers", () => {
  it("requires ordinary evidence and uses one bounded strength formula", () => {
    expect(relationshipStrength({ same: 0, opposed: 0, br: 0 })).toBe(0);
    expect(relationshipStrength({ same: 4, opposed: 2, br: 1 })).toBe(6.35);
    expect(relationshipStrength({ same: 0, opposed: 0, br: Number.NaN })).toBe(0);
  });

  it("classifies every both-sides edge as mixed and reserves battle-only honestly", () => {
    expect(classifyDirectRelationship({ same: 1, opposed: 50, br: 0 })).toBe("mixed");
    expect(classifyDirectRelationship({ same: 0, opposed: 7, br: 4 })).toBe("opposed");
    expect(classifyDirectRelationship({ same: 6, opposed: 0, br: 1 })).toBe("same-side");
    expect(classifyDirectRelationship({ same: 0, opposed: 0, br: 2 })).toBe("battle-royal-only");
    expect(classifyDirectRelationship({ same: 0, opposed: 0, br: 0 })).toBeNull();
  });

  it("handles a weighted mean across the -pi/pi seam", () => {
    const angle = weightedCircularMean([
      { angle: Math.PI - 0.05, weight: 2 },
      { angle: -Math.PI + 0.05, weight: 2 },
    ]);
    expect(Math.abs(Math.abs(angle) - Math.PI)).toBeLessThan(1e-6);
  });

  it("relaxes collisions with fixed deterministic finite output", () => {
    const desired = [3.13, -3.13, 3.12, 0.2];
    const values = desired.map((angle, i) => ({ id: `p:${i}`, angle }));
    const a = relaxCircularAngles(values, 0.12, 14);
    const b = relaxCircularAngles(values, 0.12, 14);
    expect(a).toEqual(b);
    expect(a.every((item) => Number.isFinite(item.angle))).toBe(true);
    expect(a.map((item) => item.angle)).not.toEqual(desired);
  });
});

describe("deterministic Orbit layout", () => {
  it("is byte-identical and stable call-to-call", () => {
    const a = build();
    const b = build();
    for (const key of ["nodeTargets", "nodeOpacity", "nodeScale", "nodeRole", "nodeDelay"] as const) expectSameBytes(a[key], b[key]);
    expect(a.routes.map((route) => route.key)).toEqual(b.routes.map((route) => route.key));
    a.routes.forEach((route, i) => expectSameBytes(route.points, b.routes[i]!.points));
    expect(a.labels).toEqual(b.labels);
    expect(a.orbit).toEqual(b.orbit);
    expect(a.orbitDetails).toEqual(b.orbitDetails);
  });

  it("emits only finite, nonzero geometry", () => assertFinite(build()));

  it("places one selected core, disjoint direct bands and supported bridge bands", () => {
    const layout = build();
    expect(layout.nodeRole[0]).toBe(MR.SELECTED);
    expect([...layout.nodeRole].filter((role) => role === MR.SELECTED)).toHaveLength(1);
    expect(layout.labels.filter((label) => label.key === "n:p:center")).toHaveLength(1);
    expect(layout.orbitDetails!.direct.map((item) => item.id).sort()).toEqual(["p:mixed", "p:opp", "p:royal", "p:same"]);
    expect(layout.orbitDetails!.bridges.map((item) => item.id).sort()).toEqual(["p:bridge-x", "p:bridge-y"]);
    expect(layout.nodeRole[5]).toBe(MR.BRIDGE);
    const directIds = new Set(layout.orbitDetails!.direct.map((item) => item.id));
    expect(layout.orbitDetails!.bridges.some((item) => directIds.has(item.id))).toBe(false);
    for (const item of layout.orbitDetails!.direct) expect(item.radius).toBeLessThan(505);
    for (const item of layout.orbitDetails!.bridges) expect(item.radius).toBeGreaterThanOrEqual(505);
  });

  it("accumulates multiple real intermediary paths into one bridge person", () => {
    const layout = build();
    const bridge = layout.orbitDetails!.bridges.find((item) => item.id === "p:bridge-x")!;
    expect(bridge.routeCount).toBe(2);
    expect(bridge.displayedRouteCount).toBe(2);
    expect(bridge.strongestIntermediaryId).toBe("p:same");
    expect(bridge.supports.map((support) => support.intermediaryId).sort()).toEqual(["p:opp", "p:same"]);
    expect(layout.labels.find((label) => label.key === "n:p:bridge-x")!.detail).toMatch(/no direct relationship is claimed/);
  });

  it("never draws selected-to-bridge direct evidence", () => {
    const layout = build();
    const bridgeIndices = new Set(layout.orbitDetails!.bridges.map((item) => item.index));
    expect(layout.routes.some((route) => route.kind === TK.RELATION && route.a === 0 && bridgeIndices.has(route.b))).toBe(false);
    expect(layout.routes.filter((route) => route.kind === TK.BRIDGE).map((route) => route.key).sort()).toEqual([
      pairKey("p:opp", "p:bridge-x"),
      pairKey("p:opp", "p:bridge-y"),
      pairKey("p:same", "p:bridge-x"),
    ].sort());
  });

  it("keeps title-only context from becoming a direct or bridge relationship", () => {
    const layout = build();
    expect(layout.orbitDetails!.direct.some((item) => item.id === "p:title-only")).toBe(false);
    expect(layout.orbitDetails!.bridges.some((item) => item.id === "p:title-only")).toBe(false);
  });

  it("preserves all component counts, missing dates and exact mixed/battle roles", () => {
    const edges = baseEdges.map((edge) => edge.b === "p:mixed" ? { ...edge, firstDay: 0, lastDay: 0 } : edge);
    const layout = build(makeData(baseNodes, edges));
    const mixed = layout.orbitDetails!.direct.find((item) => item.id === "p:mixed")!;
    expect(mixed).toMatchObject({ same: 3, opposed: 2, battleRoyal: 0, firstDay: null, lastDay: null, sector: "mixed" });
    expect(layout.nodeRole[mixed.index]).toBe(MR.MIXED);
    const royal = layout.orbitDetails!.direct.find((item) => item.id === "p:royal")!;
    expect(royal.sector).toBe("battle-royal-only");
    expect(layout.nodeRole[royal.index]).toBe(MR.BATTLE_ROYAL);
    expect(layout.labels.find((label) => label.key === "n:p:mixed")!.detail).toMatch(/date unavailable/);
  });

  it("keeps active placement byte-identical when corpus context is hidden", () => {
    const on = build(undefined, { context: true });
    const off = build(undefined, { context: false });
    const active = [0, ...on.orbitDetails!.direct.map((item) => item.index), ...on.orbitDetails!.bridges.map((item) => item.index)];
    for (const i of active) {
      expect([...on.nodeTargets.slice(i * 3, i * 3 + 3)]).toEqual([...off.nodeTargets.slice(i * 3, i * 3 + 3)]);
      expect(on.nodeRole[i]).toBe(off.nodeRole[i]);
    }
    expect(off.nodeOpacity[8]).toBeLessThan(on.nodeOpacity[8]!);
  });

  it("represents graph-resident and virtual promotion/title context honestly", () => {
    const layout = build();
    expect(layout.virtuals.map((item) => item.id).sort()).toEqual(["pr:virtual", "t:virtual"]);
    expect(layout.nodeRole[9]).toBe(MR.PROMO_CONTEXT);
    expect(layout.nodeRole[10]).toBe(MR.TITLE_CONTEXT);
    const text = layout.labels.flatMap((label) => [label.text, label.sub, label.detail]).filter(Boolean).join(" | ").toLowerCase();
    expect(text).toContain("documented appearance");
    expect(text).toContain("not employment");
    expect(text.replaceAll("not employment", "")).not.toContain("employment");
  });

  it("reports missing optional detail and both honest sparse states", () => {
    const noBridgeEdges = baseEdges.filter((edge) => !edge.a.includes("p:opp") || edge.b === "p:center").filter((edge) => edge.a !== "p:same" || edge.b === "p:center");
    const noBridge = build(makeData(baseNodes, noBridgeEdges), {}, null);
    expect(noBridge.orbitStats).toMatchObject({ dossierAvailable: false, bridgeTotal: 0, bridgeDisplayed: 0 });
    expect(noBridge.notes.join(" ")).toMatch(/optional person detail is unavailable/i);
    expect(noBridge.notes.join(" ")).toMatch(/no second-hop bridge candidates/i);

    const noDirect = build(makeData(baseNodes, []), {}, null);
    expect(noDirect.orbitStats).toMatchObject({ directTotal: 0, directDisplayed: 0, bridgeTotal: 0 });
    expect(noDirect.notes.join(" ")).toMatch(/no graph-resident direct relationships/i);
    expect(noDirect.routes.some((route) => route.kind === TK.RELATION || route.kind === TK.BRIDGE)).toBe(false);
  });
});

describe("Orbit budgets", () => {
  function denseFixture(directCount: number, bridgeCount: number): MorphData {
    const nodes: FixtureNode[] = [{ id: "p:center", name: "Center" }];
    const edges: FixtureEdge[] = [];
    for (let i = 0; i < directCount; i++) {
      nodes.push({ id: `p:d-${String(i).padStart(3, "0")}`, name: `Direct ${i}` });
      edges.push({ a: "p:center", b: nodes.at(-1)!.id, opposed: directCount - i + 1, firstDay: i % 2 ? first : 0 });
    }
    for (let i = 0; i < bridgeCount; i++) {
      nodes.push({ id: `p:b-${String(i).padStart(3, "0")}`, name: `Bridge ${i}` });
      edges.push({ a: `p:d-${String(i % directCount).padStart(3, "0")}`, b: nodes.at(-1)!.id, same: bridgeCount - i + 1 });
    }
    return makeData(nodes, edges);
  }

  it("applies explicit low direct, bridge and connector caps with notes", () => {
    const layout = build(denseFixture(70, 70), { tier: "low", traceCap: 500 }, null);
    expect(layout.orbitStats).toMatchObject({
      directTotal: 70,
      directDisplayed: ORBIT_BUDGETS.low.direct,
      bridgeDisplayed: ORBIT_BUDGETS.low.bridge,
      tierReduced: true,
    });
    expect(layout.orbitStats!.bridgeRoutesDisplayed).toBeLessThanOrEqual(ORBIT_BUDGETS.low.bridgeRoutes);
    expect(layout.notes.join(" ")).toMatch(/48 of 70 documented direct relationships displayed/);
  });

  it("lets a supported required id survive the ordinary semantic cap", () => {
    const data = denseFixture(70, 70);
    const requiredDirect = "p:d-069";
    const requiredBridge = "p:b-069"; // requires preserving omitted intermediary d-069
    const layout = build(data, { tier: "low", traceCap: 500, requiredIds: [requiredDirect, requiredBridge] }, null);
    expect(layout.orbitDetails!.direct.some((item) => item.id === requiredDirect)).toBe(true);
    expect(layout.orbitDetails!.bridges.some((item) => item.id === requiredBridge)).toBe(true);
  });

  it("does not expand the direct ring when a required bridge already has a displayed intermediary", () => {
    const data = denseFixture(70, 70);
    const layout = build(data, { tier: "low", traceCap: 500, requiredIds: ["p:b-000"] }, null);
    expect(layout.orbitStats!.directDisplayed).toBe(ORBIT_BUDGETS.low.direct);
    expect(layout.orbitDetails!.bridges.some((item) => item.id === "p:b-000")).toBe(true);
  });

  it("bounds connector routes while preserving one real route per displayed bridge", () => {
    const layout = build(denseFixture(60, 70), { tier: "low", traceCap: 95 }, null);
    expect(layout.orbitStats!.bridgeRoutesDisplayed).toBeLessThanOrEqual(ORBIT_BUDGETS.low.bridgeRoutes);
    expect(layout.orbitDetails!.bridges.every((bridge) => bridge.displayedRouteCount >= 1)).toBe(true);
    expect(layout.orbitStats!.bridgeRoutesOmitted).toBeGreaterThan(0);
    expect(layout.notes.join(" ")).toMatch(/supporting bridge routes displayed/);
  });
});
