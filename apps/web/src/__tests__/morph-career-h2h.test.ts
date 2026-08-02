// SYNTHETIC topology fixtures — never production evidence.
import { describe, expect, it } from "vitest";
import {
  MR,
  TRACE_SAMPLES,
  type MorphLayoutResult,
  type MorphRoute,
} from "@kayfabe/morph-renderer";
import {
  isoToDay,
  pairKey,
  type AtlasPersonRoutes,
  type EvidenceEntry,
  type Manifest,
  type NodesColumnar,
  type PersonDossier,
} from "@kayfabe/graph-contract";
import type { CoreData } from "../data/loader";
import type { ChronologyData } from "../data/chronology/loader";
import { EF, GraphModel, STRIDE } from "../graph/model";
import { buildMorphData } from "../morph/morphAdapter";
import { buildCareer } from "../morph/layouts/careerCircuit";
import { buildHeadToHead } from "../morph/layouts/headToHead";
import { DEFAULT_MORPH_CONTROLS } from "../morph/layouts/layoutTypes";

const ids = [
  "p:a",
  "p:b",
  "p:shared-opp",
  "p:shared-partner",
  "p:exclusive-a",
  "p:exclusive-b",
  "p:shared-mixed",
  "pr:red",
  "pr:blue",
  "t:red",
  "t:blue",
  "p:ambient",
];
const names = [
  "Anchor A",
  "Anchor B",
  "Shared Opponent",
  "Shared Partner",
  "A Exclusive",
  "B Exclusive",
  "Shared Mixed",
  "Red Promotion",
  "Blue Promotion",
  "Red Championship",
  "Blue Championship",
  "Ambient",
];

const manifest = {
  schema_version: "2.0.0",
  built_at: "",
  source_fingerprint: "career-h2h-test",
  layout_version: "test",
  projection_version: "test",
  algorithms: {},
  counts: {},
  date_range: ["1960-01-01", "2005-01-01"],
  edges_bin: { count: 9, stride_u32: STRIDE, fields: [] },
  promo_bits: { red: 0, blue: 1 },
  form_bits: {},
  checksums: {},
  validation: { passed: true, checks: {} },
} as unknown as Manifest;

const nodes: NodesColumnar = {
  count: ids.length,
  id: ids,
  type: [0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 0],
  name: names,
  community: new Array(ids.length).fill(0),
  pos: ids.flatMap((_id, i) => [((i % 4) - 1.5) * 0.2, ((i % 5) - 2) * 0.2, ((i % 3) - 1) * 0.2]),
  firstDay: new Array(ids.length).fill(isoToDay("1960-01-01")),
  lastDay: new Array(ids.length).fill(isoToDay("2005-01-01")),
  matches: [300, 260, 90, 80, 70, 60, 50, 1_000, 900, 30, 20, 1],
  degree: [5, 5, 2, 2, 1, 1, 2, 0, 0, 0, 0, 0],
  reigns: [0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 2, 0],
  promoMask: new Array(ids.length).fill(3),
  resolution: new Array(ids.length).fill(0),
};

function edge(
  a: number,
  b: number,
  same: number,
  opposed: number,
  br: number,
  first: string,
  last = first,
): number[] {
  const row = new Array(STRIDE).fill(0);
  row[EF.a] = a;
  row[EF.b] = b;
  row[EF.same] = same;
  row[EF.opposed] = opposed;
  row[EF.br] = br;
  row[EF.firstDay] = isoToDay(first);
  row[EF.lastDay] = isoToDay(last);
  row[EF.promoMask] = 3;
  row[EF.formMask] = 1;
  return row;
}

const edges = Uint32Array.from([
  ...edge(0, 1, 0, 8, 0, "1970-01-01", "1995-01-01"),
  ...edge(0, 2, 0, 7, 0, "1972-01-01"),
  ...edge(1, 2, 0, 5, 0, "1974-01-01"),
  ...edge(0, 3, 8, 0, 0, "1982-01-01"),
  ...edge(1, 3, 6, 0, 0, "1984-01-01"),
  ...edge(0, 4, 0, 9, 0, "1976-01-01"),
  ...edge(1, 5, 10, 0, 0, "1992-01-01"),
  ...edge(0, 6, 4, 5, 0, "1986-01-01"),
  ...edge(1, 6, 6, 3, 0, "1988-01-01"),
]);
const model = new GraphModel(nodes, edges, manifest);
const core: CoreData = {
  manifest,
  nodes,
  edges,
  communities: { count: 1, label: ["Test"], size: [8], center: [0, 0, 0], topMembers: [[]] },
  density: { years: {} },
  search: [],
  promotions: {
    "pr:red": { n: "Red Promotion", m: 1_000, src: "test", bit: 0 },
    "pr:blue": { n: "Blue Promotion", m: 900, src: "test", bit: 1 },
  },
};
const data = buildMorphData(model, core);

const personRoutes: AtlasPersonRoutes = {
  n: "Anchor A",
  firstDay: isoToDay("1965-01-01"),
  lastDay: isoToDay("2000-01-01"),
  matches: 300,
  routes: [
    { pr: "pr:red", firstDay: isoToDay("1965-01-01"), lastDay: isoToDay("1980-01-01"), matches: 180, cards: 30 },
    { pr: "pr:blue", firstDay: isoToDay("1981-01-01"), lastDay: isoToDay("2000-01-01"), matches: 120, cards: 20 },
  ],
};
const dossier: PersonDossier = {
  n: "Anchor A",
  first: "1965-01-01",
  last: "2000-01-01",
  m: 300,
  promos: { "pr:red": 180, "pr:blue": 120 },
  years: {},
  top: {
    opponents: [["p:shared-opp", 7], ["p:exclusive-a", 9], ["p:shared-mixed", 5]],
    partners: [["p:shared-partner", 8], ["p:shared-mixed", 4]],
  },
  teams: [],
  titles: [
    { t: "t:red", reigns: [{ s: "1975-01-01", e: "1977-01-01", m: "m:red" }] },
    { t: "t:blue", reigns: [{ s: "1990-01-01", e: "1992-01-01", m: "m:blue" }] },
  ],
  src: {},
};
const chronology = {
  titles: {
    id: ["t:red", "t:blue"],
    name: ["Red Championship", "Blue Championship"],
    pr: ["pr:red", "pr:blue"],
    assoc: ["registry", "dominant"],
  },
  titleIndex: new Map([["t:red", 0], ["t:blue", 1]]),
} as unknown as ChronologyData;

const evidence: EvidenceEntry[] = [
  {
    m: "m:late", c: "c:3", d: "1995-06-01", pr: "pr:blue", rel: "same",
    form: "tag_team", res: "draw", fin: null, t: null, tc: 0,
  },
  {
    m: "m:early", c: "c:1", d: "1970-01-01", pr: "pr:red", rel: "opposed",
    form: "singles", res: "def. (pin)", fin: "pin", t: null, tc: 0,
  },
  {
    m: "m:title", c: "c:2", d: "1985-01-01", pr: "pr:red", rel: "opposed",
    form: "singles", res: "def. (submission)", fin: "submission", t: "t:red", tc: 1,
  },
];

const index = (id: string): number => {
  const result = data.indexOf(id);
  if (result === undefined) throw new Error(`missing fixture node ${id}`);
  return result;
};
const xyz = (layout: MorphLayoutResult, id: string): [number, number, number] => {
  const i = index(id) * 3;
  return [layout.nodeTargets[i]!, layout.nodeTargets[i + 1]!, layout.nodeTargets[i + 2]!];
};
const point = (route: MorphRoute, sample: number): [number, number, number] => {
  const i = sample * 3;
  return [route.points[i]!, route.points[i + 1]!, route.points[i + 2]!];
};
const expectPoint = (actual: readonly number[], expected: readonly number[]) => {
  expect(actual[0]).toBeCloseTo(expected[0]!, 4);
  expect(actual[1]).toBeCloseTo(expected[1]!, 4);
  expect(actual[2]).toBeCloseTo(expected[2]!, 4);
};
const expectSane = (layout: MorphLayoutResult) => {
  for (const values of [layout.nodeTargets, layout.nodeOpacity, layout.nodeScale, layout.nodeDelay]) {
    for (const value of values) expect(Number.isFinite(value)).toBe(true);
  }
  for (const route of layout.routes) {
    expect(route.points).toHaveLength(TRACE_SAMPLES * 3);
    for (const value of route.points) expect(Number.isFinite(value)).toBe(true);
  }
  for (const value of [
    layout.bounds.minX, layout.bounds.maxX, layout.bounds.minY, layout.bounds.maxY,
    layout.fitBounds?.minZ, layout.fitBounds?.maxZ,
  ]) expect(Number.isFinite(value)).toBe(true);
};
const zSpan = (route: MorphRoute): number => {
  const values: number[] = [];
  for (let i = 2; i < route.points.length; i += 3) values.push(route.points[i]!);
  return Math.max(...values) - Math.min(...values);
};

describe("3D Career Spine", () => {
  const build = (context = true) => buildCareer(
    data,
    "p:a",
    personRoutes,
    dossier,
    chronology,
    { ...DEFAULT_MORPH_CONTROLS, context },
  );

  it("is deterministic, finite, and gives organized structure substantial depth", () => {
    const a = build();
    const b = build();
    expectSane(a);
    expect([...a.nodeTargets]).toEqual([...b.nodeTargets]);
    expect(a.routes.map((route) => route.key)).toEqual(b.routes.map((route) => route.key));
    expect(a.fitBounds!.maxZ! - a.fitBounds!.minZ!).toBeGreaterThan(300);
    expect(Math.abs(xyz(a, "pr:red")[2] - xyz(a, "pr:blue")[2])).toBeGreaterThanOrEqual(180);
  });

  it("keeps X as time and carries the career fiber through promotion depths", () => {
    const layout = build();
    const spine = layout.routes.find((route) => route.key === "route:p:a")!;
    expect(spine).toBeTruthy();
    expect(zSpan(spine)).toBeGreaterThan(150);
    const xs: number[] = [];
    for (let i = 0; i < spine.points.length; i += 3) xs.push(spine.points[i]!);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]! - 1e-4);
    expect(layout.timeAxis).toMatchObject({
      dayMin: isoToDay("1965-01-01"),
      dayMax: isoToDay("2000-01-01"),
    });
  });

  it("attaches championships to their documented promotion and reign era", () => {
    const layout = build();
    const redPromotion = xyz(layout, "pr:red");
    const bluePromotion = xyz(layout, "pr:blue");
    const redTitle = xyz(layout, "t:red");
    const blueTitle = xyz(layout, "t:blue");
    expect(redTitle[0]).toBeLessThan(blueTitle[0]);
    expect(redTitle[2] - redPromotion[2]).toBeGreaterThan(120);
    expect(blueTitle[2] - bluePromotion[2]).toBeGreaterThan(120);
    for (const titleId of ["t:red", "t:blue"]) {
      const route = layout.routes.find((candidate) => candidate.key === `ctx:p:a:${titleId}`)!;
      expectPoint(point(route, TRACE_SAMPLES - 1), xyz(layout, titleId));
    }
  });

  it("places each major relationship once and routes pulses on visible geometry", () => {
    const layout = build();
    const mixedLabels = layout.labels.filter((label) => label.key === "n:p:shared-mixed");
    expect(mixedLabels).toHaveLength(1);
    expect(layout.nodeRole[index("p:shared-mixed")]).toBe(MR.MIXED);
    for (const id of ["p:shared-opp", "p:shared-partner", "p:exclusive-a", "p:shared-mixed"]) {
      const route = layout.routes.find((candidate) => candidate.key === pairKey("p:a", id))!;
      expect(route).toBeTruthy();
      expectPoint(point(route, TRACE_SAMPLES - 1), xyz(layout, id));
      expect(zSpan(route)).toBeGreaterThan(50);
    }
    expect(new Set(layout.routes.map((route) => route.key)).size).toBe(layout.routes.length);
  });

  it("keeps corpus identity while making hidden context non-pickable", () => {
    const shown = build(true);
    const hidden = build(false);
    expect(shown.nodeOpacity[index("p:ambient")]).toBeGreaterThan(0.001);
    expect(hidden.nodeOpacity[index("p:ambient")]).toBeCloseTo(0.001, 6);
    expect(hidden.nodeTargets).toHaveLength(data.count * 3);
    expect(hidden.nodeRole[index("p:a")]).toBe(MR.SELECTED);
    expect(hidden.nodeOpacity[index("p:a")]).toBe(1);
    expect(hidden.nodeRole[index("pr:red")]).toBe(MR.PROMO_CONTEXT);
    expect(hidden.nodeOpacity[index("pr:red")]).toBeGreaterThan(0.8);
    expect(hidden.nodeRole[index("t:red")]).toBe(MR.TITLE_CONTEXT);
    expect(hidden.nodeOpacity[index("t:red")]).toBeGreaterThan(0.8);
    expect(hidden.nodeRole[index("p:shared-opp")]).not.toBe(MR.BACKGROUND);
    expect(hidden.nodeOpacity[index("p:shared-opp")]).toBeGreaterThan(0.5);
  });
});

describe("3D Head-to-Head", () => {
  const build = (context = true) => buildHeadToHead(
    data,
    "p:a",
    "p:b",
    evidence,
    { ...DEFAULT_MORPH_CONTROLS, context },
  );

  it("keeps A/B stable and separates shared bridge from exclusive outer banks", () => {
    const layout = build();
    expect(xyz(layout, "p:a")).toEqual([-350, 0, 0]);
    expect(xyz(layout, "p:b")).toEqual([350, 0, 0]);
    expect(Math.abs(xyz(layout, "p:shared-opp")[0])).toBeLessThan(300);
    expect(Math.abs(xyz(layout, "p:shared-partner")[0])).toBeLessThan(300);
    expect(xyz(layout, "p:exclusive-a")[0]).toBeLessThan(-350);
    expect(xyz(layout, "p:exclusive-b")[0]).toBeGreaterThan(350);
    expect(xyz(layout, "p:shared-partner")[2] - xyz(layout, "p:shared-opp")[2]).toBeGreaterThan(400);
  });

  it("uses canonical pair traces that terminate at every shared/exclusive node", () => {
    const layout = build();
    for (const [anchor, related] of [
      ["p:a", "p:shared-opp"], ["p:b", "p:shared-opp"],
      ["p:a", "p:shared-partner"], ["p:b", "p:shared-partner"],
      ["p:a", "p:exclusive-a"], ["p:b", "p:exclusive-b"],
    ] as const) {
      const route = layout.routes.find((candidate) => candidate.key === pairKey(anchor, related))!;
      expectPoint(point(route, 0), xyz(layout, anchor));
      expectPoint(point(route, TRACE_SAMPLES - 1), xyz(layout, related));
    }
    expect(layout.labels.filter((label) => label.key === "n:p:shared-opp")).toHaveLength(1);
    expect(new Set(layout.routes.map((route) => route.key)).size).toBe(layout.routes.length);
  });

  it("orders direct documented matches as spatial chronological rungs", () => {
    const layout = build();
    const rungs = layout.routes.filter((route) => route.key.startsWith("h2h:match:"));
    expect(rungs.map((route) => route.key)).toEqual([
      "h2h:match:m:early",
      "h2h:match:m:title",
      "h2h:match:m:late",
    ]);
    const rungY = rungs.map((route) => point(route, 0)[1]);
    expect(rungY[0]).toBeGreaterThan(rungY[1]!);
    expect(rungY[1]).toBeGreaterThan(rungY[2]!);
    expect(zSpan(rungs[1]!)).toBeGreaterThan(150);
    const text = [...layout.notes, ...layout.labels.flatMap((label) => [label.text, label.sub ?? "", label.detail ?? ""])].join(" ");
    expect(text).not.toMatch(/shortest[- ]path/i);
    expect(text).toMatch(/documented direct match/i);
  });

  it("is deterministic, finite, substantially 3D, and supports hidden context", () => {
    const a = build();
    const b = build();
    const hidden = build(false);
    expectSane(a);
    expect([...a.nodeTargets]).toEqual([...b.nodeTargets]);
    expect(a.routes.map((route) => route.key)).toEqual(b.routes.map((route) => route.key));
    expect(a.fitBounds!.maxZ! - a.fitBounds!.minZ!).toBeGreaterThan(500);
    expect(hidden.nodeOpacity[index("p:ambient")]).toBeCloseTo(0.001, 6);
    expect(hidden.nodeTargets).toHaveLength(data.count * 3);
    for (const anchor of ["p:a", "p:b"]) {
      expect(hidden.nodeRole[index(anchor)]).toBe(MR.SELECTED);
      expect(hidden.nodeOpacity[index(anchor)]).toBe(1);
    }
    expect(hidden.nodeRole[index("p:shared-opp")]).not.toBe(MR.BACKGROUND);
    expect(hidden.nodeOpacity[index("p:shared-opp")]).toBeGreaterThan(0.5);
    expect(hidden.routes.filter((route) => route.key.startsWith("h2h:match:"))).toHaveLength(
      evidence.length,
    );
  });
});
