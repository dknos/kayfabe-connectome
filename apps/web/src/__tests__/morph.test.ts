// SYNTHETIC test fixtures — never production data.
import { describe, expect, it } from "vitest";
import {
  MR,
  RK,
  TK,
  TRACE_SAMPLES,
  easeQuintic,
  elementProgress,
  type MorphLayoutResult,
} from "@kayfabe/morph-renderer";
import {
  isoToDay,
  pairKey,
  type AtlasPersonRoutes,
  type AtlasPromotionDetail,
  type AtlasPromotionsFile,
  type AtlasTitlesFile,
  type ChampionshipRecord,
  type Manifest,
  type NodesColumnar,
  type PersonDossier,
} from "@kayfabe/graph-contract";
import { EF, GraphModel, STRIDE } from "../graph/model";
import type { CoreData } from "../data/loader";
import type { ChronologyData } from "../data/chronology/loader";
import { buildMorphData } from "../morph/morphAdapter";
import {
  DEFAULT_MORPH_CONTROLS,
  LOOM,
  ORGANIC_SCALE,
} from "../morph/layouts/layoutTypes";
import { buildOrganic } from "../morph/layouts/organicLayout";
import { buildLoom } from "../morph/layouts/relationshipLoom";
import { buildMotherboard } from "../morph/layouts/promotionMotherboard";
import { buildLineage } from "../morph/layouts/championshipLineage";
import { buildCareer } from "../morph/layouts/careerCircuit";
import { packBackground } from "../morph/layouts/backgroundRack";
import { morphModeFor, useMorph } from "../morph/morphStore";
import { applyPendingMorphUrl, installMorphUrl, markMorphCameraTouched } from "../morph/morphUrl";
import { restoreFromUrl, useStore, writeUrl } from "../state/store";

/**
 * Morph layouts are pure functions (corpus, selection, detail, controls,
 * caps) → MorphLayoutResult, which is what makes them testable without a GPU.
 * What is asserted is the lens's claims: one canonical placement per
 * wrestler, byte-exact return-to-tissue, honest degradation notes, and the
 * wording contract — membership is a documented appearance, gaps are
 * unrecorded, nothing is ever employment, a contract or a vacancy.
 */

/* ------------------------------------------------------------- fixture */

const manifest = {
  schema_version: "1.0.0",
  built_at: "",
  source_fingerprint: "test",
  layout_version: "t",
  projection_version: "t",
  algorithms: {},
  counts: {},
  date_range: ["1960-01-01", "2020-01-01"],
  edges_bin: { count: 7, stride_u32: 10, fields: [] },
  promo_bits: { a: 0 },
  form_bits: { singles: 0, tag_team: 1, multi_way: 2, battle_royal: 3, team_implied: 4, unknown: 5 },
  checksums: {},
  validation: { passed: true, checks: {} },
} as unknown as Manifest;

// positions are quarter-multiples so pos * ORGANIC_SCALE is exact in f32
const pos: number[] = [];
for (let i = 0; i < 10; i++) {
  pos.push(((i % 5) - 2) * 0.25, (((i * 3) % 7) - 3) * 0.25, ((i % 3) - 1) * 0.25);
}

const nodes: NodesColumnar = {
  count: 10,
  id: ["p:hero", "p:mix", "p:opp", "p:tiea", "p:tieb", "p:par", "p:br", "p:loose", "pr:a", "t:1"],
  type: [0, 0, 0, 0, 0, 0, 0, 0, 1, 2],
  name: ["Hero", "Mixy", "Opp One", "Tie A", "Tie B", "Partner", "Royal", "Loose", "Alpha", "Alpha World Title"],
  community: [0, 0, 0, 1, 1, 1, 1, 0, 0, 0],
  pos,
  firstDay: new Array<number>(10).fill(isoToDay("1966-01-01")),
  lastDay: new Array<number>(10).fill(isoToDay("1999-01-01")),
  matches: [500, 100, 120, 40, 40, 200, 70, 30, 4000, 300],
  degree: [6, 1, 2, 1, 1, 2, 1, 0, 0, 0],
  reigns: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  promoMask: new Array<number>(10).fill(1),
  resolution: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

function edge(a: number, b: number, same: number, opposed: number, br: number, title: number): number[] {
  const rec = new Array<number>(STRIDE).fill(0);
  rec[EF.a] = a;
  rec[EF.b] = b;
  rec[EF.same] = same;
  rec[EF.opposed] = opposed;
  rec[EF.br] = br;
  rec[EF.title] = title;
  rec[EF.firstDay] = isoToDay("1980-06-01");
  rec[EF.lastDay] = isoToDay("1995-06-01");
  rec[EF.promoMask] = 1;
  rec[EF.formMask] = 0b111111;
  return rec;
}

const edges = Uint32Array.from([
  ...edge(0, 1, 10, 10, 0, 2), // hero × mix — genuinely both, opposed >= same
  ...edge(0, 2, 1, 5, 0, 1), //   hero × opp — opponent, too lopsided for mixed
  ...edge(0, 3, 0, 4, 0, 0), //   hero × tiea — tied strength with tieb
  ...edge(0, 4, 0, 4, 0, 0), //   hero × tieb
  ...edge(0, 5, 6, 1, 0, 0), //   hero × par — partner
  ...edge(0, 6, 0, 0, 7, 0), //   hero × br — battle-royal only
  ...edge(2, 5, 0, 3, 0, 0), //   ambient edge not touching hero
]);

const model = new GraphModel(nodes, edges, manifest);

const core: CoreData = {
  manifest,
  nodes,
  edges,
  communities: {
    count: 2,
    label: ["Territory Alpha", "Territory Beta"],
    size: [5, 4],
    center: new Array<number>(6).fill(0),
    topMembers: [[], []],
  },
  density: { years: {} },
  search: [],
  promotions: {
    "pr:a": { n: "Alpha", m: 4000, src: "local_sql", bit: 0 },
    "pr:x": { n: "Ghost Promo", m: 12, src: "csv_initial_matches" },
  },
};

const data = buildMorphData(model, core);

const heroDossier: PersonDossier = {
  n: "Hero",
  first: "1966-01-01",
  last: "1999-01-01",
  m: 500,
  promos: { "pr:a": 120, "pr:x": 4 },
  years: {},
  top: { partners: [["p:par", 6]], opponents: [["p:opp", 5]] },
  teams: [],
  titles: [
    { t: "t:1", reigns: [{ s: "1985-01-01", e: "1986-01-01", m: "m:1" }] },
    { t: "t:x", reigns: [] }, // a belt with no corpus node — must become a virtual chip
  ],
  src: {},
};

const titleNameOf = (id: string): string | null =>
  id === "t:1" ? "Alpha World Title" : id === "t:x" ? "Ghost Belt" : null;

function makeChronology(): ChronologyData {
  const promotions: AtlasPromotionsFile = {
    count: 1,
    id: ["pr:a"],
    name: ["Alpha"],
    firstDay: [isoToDay("1965-03-01")],
    lastDay: [isoToDay("1999-01-01")],
    cards: [400],
    matches: [4000],
    people: [3],
    titles: [2],
    src: ["local_sql"],
    bit: [0],
    yearFrom: [1965],
    yearCounts: [[100, 200]],
  };
  const titles: AtlasTitlesFile = {
    count: 2,
    id: ["t:1", "t:nc"],
    name: ["Alpha World Title", "Ghost Belt"],
    pr: ["pr:a", "pr:a"],
    assoc: ["dominant", "registry"],
    assocShare: [0.8, 1],
    firstDay: [isoToDay("1966-01-01"), isoToDay("1990-01-01")],
    lastDay: [isoToDay("1998-01-01"), isoToDay("1995-01-01")],
    titleMatches: [300, 44],
    reigns: [3, 0],
    changes: [3, 0],
    holders: [2, 0],
    artifact: [0, 0],
    src: ["local_sql", "csv_initial_matches"],
    lineage: ["derived", "no-changes"],
  };
  return {
    manifest: {
      schema_version: "1.0.0",
      projection_version: "atlas-projection@1",
      epoch: "1900-01-01",
      algorithms: {},
      counts: {},
      date_range: ["1960-01-01", "2020-01-01"],
      day_range: [isoToDay("1960-01-01"), isoToDay("2020-01-01")],
      buckets: 256,
      reuses: {},
      checksums: {},
      validation: { passed: true, checks: {} },
    },
    promotions,
    titles,
    promoIndex: new Map(promotions.id.map((id, i) => [id, i])),
    titleIndex: new Map(titles.id.map((id, i) => [id, i])),
    titlesByPromo: new Map([["pr:a", [0, 1]]]),
    unresolvedTitles: [],
    maxPromoMatches: 4000,
    maxTitleMatches: 300,
  };
}
const chronology = makeChronology();

const lineageRecord: ChampionshipRecord = {
  n: "Alpha World Title",
  pr: "pr:a",
  artifact: false,
  titleMatches: 300,
  changes: 3,
  // deliberately OUT of date order — the layout must sort by start date
  reigns: [
    { holders: ["p:par"], s: "1975-01-01", e: "1980-01-01", m: "m:3", endM: "m:4" },
    { holders: ["p:opp"], s: "1966-01-01", e: "1970-01-01", m: "m:1", endM: "m:2" },
    { holders: ["p:hero"], s: "1980-06-01", e: null, m: "m:5" },
  ],
};

const heroRoutes: AtlasPersonRoutes = {
  n: "Hero",
  firstDay: isoToDay("1966-01-01"),
  lastDay: isoToDay("1999-01-01"),
  matches: 700,
  routes: [
    { pr: "pr:a", firstDay: isoToDay("1966-01-01"), lastDay: isoToDay("1975-01-01"), matches: 500, cards: 50 },
    { pr: "pr:x", firstDay: isoToDay("1990-01-01"), lastDay: isoToDay("1999-01-01"), matches: 200, cards: 20 },
  ],
};

const alphaDetail: AtlasPromotionDetail = {
  id: "pr:a",
  n: "Alpha",
  firstDay: isoToDay("1965-03-01"),
  lastDay: isoToDay("1999-01-01"),
  cards: 400,
  matches: 4000,
  people: 3,
  src: "local_sql",
  yearFrom: 1965,
  yearCards: [10, 20, 30],
  yearMatches: [100, 200, 300],
  titles: [
    {
      t: "t:1", n: "Alpha World Title",
      firstDay: isoToDay("1966-01-01"), lastDay: isoToDay("1998-01-01"),
      titleMatches: 300, reigns: 3, changes: 3, holders: 2, artifact: 0,
      assoc: "dominant", assocShare: 0.8, lineage: "derived",
      yearFrom: 1966, yearCounts: [5, 6],
    },
    {
      t: "t:nc", n: "Ghost Belt",
      firstDay: isoToDay("1990-01-01"), lastDay: isoToDay("1995-01-01"),
      titleMatches: 44, reigns: 0, changes: 0, holders: 0, artifact: 0,
      assoc: "registry", assocShare: 1, lineage: "no-changes",
      yearFrom: 1990, yearCounts: [2],
    },
  ],
  members: [
    { p: "p:hero", n: "Hero", firstDay: isoToDay("1966-01-01"), lastDay: isoToDay("1975-01-01"), matches: 500, cards: 50, champ: 1 },
    { p: "p:par", n: "Partner", firstDay: isoToDay("1968-01-01"), lastDay: isoToDay("1980-01-01"), matches: 200, cards: 20 },
    { p: "p:loose", n: "Loose", firstDay: isoToDay("1985-01-01"), lastDay: isoToDay("1990-01-01"), matches: 30, cards: 5 },
  ],
};

/* ------------------------------------------------------------- helpers */

const idx = (id: string): number => {
  const i = data.indexOf(id);
  if (i === undefined) throw new Error(`fixture id ${id} has no node`);
  return i;
};

function expectSameFloats(a: Float32Array, b: Float32Array): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) expect.fail(`arrays differ at ${i}: ${a[i]} vs ${b[i]}`);
  }
}

/** Every coordinate a layout emits must be a real number, and every trace
 *  must carry exactly TRACE_SAMPLES points so vertices interpolate. */
function assertLayoutSane(l: MorphLayoutResult): void {
  for (const arr of [l.nodeTargets, l.nodeOpacity, l.nodeScale, l.nodeDelay]) {
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i]!)) expect.fail(`non-finite at ${i} in mode ${l.mode}`);
    }
  }
  for (const r of l.routes) {
    expect(r.points.length).toBe(TRACE_SAMPLES * 3);
    if (r.fromPoints) expect(r.fromPoints.length).toBe(TRACE_SAMPLES * 3);
    for (let i = 0; i < r.points.length; i++) {
      if (!Number.isFinite(r.points[i]!)) expect.fail(`non-finite route point in ${r.key}`);
    }
  }
  for (const lb of l.labels) {
    for (const v of [lb.x, lb.y, lb.z]) expect(Number.isFinite(v)).toBe(true);
  }
  for (const v of [l.bounds.minX, l.bounds.maxX, l.bounds.minY, l.bounds.maxY]) {
    expect(Number.isFinite(v)).toBe(true);
  }
}

/** All human-readable text a layout emits, labels and notes alike. */
function layoutText(l: MorphLayoutResult): string {
  const parts: string[] = [...l.notes];
  for (const lb of l.labels) parts.push(lb.text, lb.sub ?? "", lb.detail ?? "", lb.badge ?? "");
  return parts.join(" | ");
}

/**
 * Same rule as the chronology suite: a forbidden word may still APPEAR, because
 * saying "not employment" out loud is the honest thing to do — but every
 * occurrence must be a denial. Unlike the chronology helper this one does not
 * require the word to occur at all: most boards never mention it.
 */
function expectDeniedOrAbsent(text: string, word: string, deniers: RegExp[]): void {
  const hay = text.toLowerCase();
  const needle = word.toLowerCase();
  let at = hay.indexOf(needle);
  while (at >= 0) {
    const window = text.slice(Math.max(0, at - 70), at + needle.length + 70);
    expect(deniers.some((d) => d.test(window)), `undenied claim: …${window}…`).toBe(true);
    at = hay.indexOf(needle, at + 1);
  }
}

/* ------------------------------------------------------------- adapter */

describe("morph adapter", () => {
  it("scales the organic clone by exactly ORGANIC_SCALE", () => {
    expect(data.organic.length).toBe(pos.length);
    for (let i = 0; i < pos.length; i++) {
      expect(data.organic[i]).toBe(pos[i]! * ORGANIC_SCALE);
    }
  });

  it("owns the clone — mutating it never touches the connectome's positions", () => {
    const before = [...model.nodes.pos];
    const mine = buildMorphData(model, core);
    mine.organic[0] = 99999;
    mine.organic[1] = -99999;
    expect(model.nodes.pos).toEqual(before);
  });

  it("names node-less promotions from the registry", () => {
    expect(data.nameOf("pr:x")).toBe("Ghost Promo");
    expect(data.nameOf("pr:a")).toBe("Alpha");
    expect(data.indexOf("pr:x")).toBeUndefined();
  });
});

/* ------------------------------------------------------------- organic */

describe("organic layout", () => {
  it("targets are byte-identical to the organic clone — return to tissue is exact", () => {
    const l = buildOrganic(data, null, [], 100);
    expectSameFloats(l.nodeTargets, data.organic);
    // and building never mutated the clone itself
    for (let i = 0; i < pos.length; i++) expect(data.organic[i]).toBe(pos[i]! * ORGANIC_SCALE);
  });

  it("is deterministic call to call", () => {
    const a = buildOrganic(data, null, [], 100);
    const b = buildOrganic(data, null, [], 100);
    expectSameFloats(a.nodeTargets, b.nodeTargets);
    expectSameFloats(a.nodeOpacity, b.nodeOpacity);
    expectSameFloats(a.nodeScale, b.nodeScale);
    expectSameFloats(a.nodeDelay, b.nodeDelay);
    expect(a.routes.map((r) => r.key)).toEqual(b.routes.map((r) => r.key));
    a.routes.forEach((r, i) => expectSameFloats(r.points, b.routes[i]!.points));
    expect(a.labels.map((l) => l.key)).toEqual(b.labels.map((l) => l.key));
  });

  it("emits no NaN or Infinity anywhere and states the ambient fiber bound", () => {
    const l = buildOrganic(data, null, [], 3);
    assertLayoutSane(l);
    expect(l.routes.length).toBeLessThanOrEqual(3);
    expect(l.notes.join(" ")).toMatch(/strongest lifetime fibers/);
  });
});

/* ---------------------------------------------------------------- loom */

const buildHeroLoom = (cap = 100) =>
  buildLoom(data, "p:hero", heroDossier, titleNameOf, DEFAULT_MORPH_CONTROLS, cap);

describe("relationship loom", () => {
  it("docks the selected wrestler at the centre of the board", () => {
    const l = buildHeroLoom();
    const h = idx("p:hero");
    expect(l.nodeTargets[h * 3]).toBe(0);
    expect(l.nodeTargets[h * 3 + 1]).toBe(0);
    expect(l.nodeTargets[h * 3 + 2]).toBe(0);
    expect(l.nodeRole[h]).toBe(MR.SELECTED);
    expect(l.anchorId).toBe("p:hero");
  });

  it("gives a both-sides wrestler ONE canonical placement, in the strongest category, badged mixed", () => {
    const l = buildHeroLoom();
    const m = idx("p:mix");
    // opposed >= same → the opponent rail, x < 0 — a second (partner) placement
    // would have overwritten x to the positive rail
    expect(l.nodeTargets[m * 3]!).toBeLessThan(0);
    expect(l.nodeRole[m]).toBe(MR.MIXED);
    const labels = l.labels.filter((lb) => lb.key === "n:p:mix");
    expect(labels).toHaveLength(1);
    expect(labels[0]!.badge).toBe("±");
    expect(labels[0]!.sub).toMatch(/mixed/);
    // exactly one canonical relation trace for the pair
    expect(l.routes.filter((r) => r.key === pairKey("p:hero", "p:mix"))).toHaveLength(1);
  });

  it("separates opponents, partners and battle-royal contacts by rail", () => {
    const l = buildHeroLoom();
    expect(l.nodeTargets[idx("p:opp") * 3]!).toBeLessThan(0); // opponent rail, left
    expect(l.nodeRole[idx("p:opp")]).toBe(MR.OPPONENT);
    expect(l.nodeTargets[idx("p:par") * 3]!).toBeGreaterThan(0); // partner rail, right
    expect(l.nodeRole[idx("p:par")]).toBe(MR.PARTNER);
    expect(l.nodeTargets[idx("p:br") * 3 + 1]!).toBeLessThan(0); // battle-royal rail, below
    expect(l.nodeRole[idx("p:br")]).toBe(MR.BATTLE_ROYAL);
  });

  it("breaks strength ties by id, deterministically", () => {
    const a = buildHeroLoom();
    // equal-strength opponents: p:tiea sorts before p:tieb, so it sits higher
    expect(a.nodeTargets[idx("p:tiea") * 3 + 1]!).toBeGreaterThan(a.nodeTargets[idx("p:tieb") * 3 + 1]!);
    expect(a.nodeTargets[idx("p:tiea") * 3]!).toBeLessThanOrEqual(-LOOM.railX);
    const b = buildHeroLoom();
    expectSameFloats(a.nodeTargets, b.nodeTargets);
    expectSameFloats(a.nodeDelay, b.nodeDelay);
    expect(a.labels.map((l) => l.key)).toEqual(b.labels.map((l) => l.key));
    expect(a.routes.map((r) => r.key)).toEqual(b.routes.map((r) => r.key));
  });

  it("samples every trace to exactly TRACE_SAMPLES points and emits no NaN", () => {
    assertLayoutSane(buildHeroLoom());
  });

  it("keeps canonical relations and dashed context on different trace kinds", () => {
    const l = buildHeroLoom();
    const rel = l.routes.find((r) => r.key === pairKey("p:hero", "p:opp"))!;
    const ctxPromo = l.routes.find((r) => r.key === "ctx:p:hero:pr:a")!;
    const ctxTitle = l.routes.find((r) => r.key === "ctx:p:hero:t:1")!;
    expect(rel.kind).toBe(TK.RELATION);
    expect(ctxPromo.kind).toBe(TK.CONTEXT_PROMO);
    expect(ctxTitle.kind).toBe(TK.CONTEXT_TITLE);
    expect(ctxPromo.kind).not.toBe(rel.kind);
  });

  it("uses stable route keys: pair keys for relations, ctx: for context", () => {
    const l = buildHeroLoom();
    const relKeys = l.routes.filter((r) => r.kind === TK.RELATION).map((r) => r.key).sort();
    expect(relKeys).toEqual(
      ["p:mix", "p:opp", "p:tiea", "p:tieb", "p:par", "p:br"].map((id) => pairKey("p:hero", id)).sort(),
    );
    for (const r of l.routes) {
      if (r.kind !== TK.RELATION) expect(r.key.startsWith("ctx:")).toBe(true);
    }
    // no key appears twice — persistence of identity across morphs depends on it
    expect(new Set(l.routes.map((r) => r.key)).size).toBe(l.routes.length);
  });

  it("bounds relation traces by the cap and says so in the notes", () => {
    const capped = buildHeroLoom(2);
    expect(capped.routes.filter((r) => r.kind === TK.RELATION)).toHaveLength(2);
    expect(capped.notes.length).toBeGreaterThan(0);
    expect(capped.notes.join(" ")).toMatch(/strongest 2 of 6 relationship traces/);
    const full = buildHeroLoom(100);
    expect(full.routes.filter((r) => r.kind === TK.RELATION)).toHaveLength(6);
  });

  it("represents node-less promotions and belts as virtual chips", () => {
    const l = buildHeroLoom();
    const pr = l.virtuals.find((v) => v.id === "pr:x")!;
    expect(pr.role).toBe(MR.PROMO_CONTEXT);
    const t = l.virtuals.find((v) => v.id === "t:x")!;
    expect(t.role).toBe(MR.TITLE_CONTEXT);
  });
});

/* ----------------------------------------------------- background rack */

describe("background rack", () => {
  function runPack(exclude: Set<number>) {
    const n = data.count;
    const targets = new Float32Array(n * 3);
    const opacity = new Float32Array(n);
    const scale = new Float32Array(n);
    const role = new Uint8Array(n);
    const delay = new Float32Array(n);
    const board = { minX: -200, maxX: 200, minY: -120, maxY: 160 };
    const bounds = { ...board };
    packBackground(data, exclude, board, targets, opacity, scale, role, delay, bounds);
    return { targets, opacity, scale, role, delay, bounds };
  }

  it("gives every non-excluded node a finite target and leaves excluded ones alone", () => {
    const exclude = new Set([idx("p:hero")]);
    const { targets, opacity, role } = runPack(exclude);
    for (let i = 0; i < data.count; i++) {
      if (exclude.has(i)) {
        expect(opacity[i]).toBe(0); // untouched — the active board owns it
        continue;
      }
      for (const v of [targets[i * 3]!, targets[i * 3 + 1]!, targets[i * 3 + 2]!]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(opacity[i]!).toBeGreaterThan(0); // visibly compressed, never vanished
      expect(role[i]).toBe(MR.BACKGROUND);
    }
  });

  it("packs deterministically", () => {
    const a = runPack(new Set([0]));
    const b = runPack(new Set([0]));
    expectSameFloats(a.targets, b.targets);
    expectSameFloats(a.opacity, b.opacity);
    expectSameFloats(a.delay, b.delay);
    expect(a.bounds).toEqual(b.bounds);
  });
});

/* ------------------------------------------------------------- lineage */

describe("championship lineage", () => {
  it("orders reign segments chronologically regardless of record order", () => {
    const l = buildLineage(data, "t:1", lineageRecord, chronology);
    const reignRegions = l.regions.filter((r) => r.key.startsWith("cl:reign:"));
    expect(reignRegions.map((r) => r.key)).toEqual([
      "cl:reign:t:1:1966-01-01",
      "cl:reign:t:1:1975-01-01",
      "cl:reign:t:1:1980-06-01",
    ]);
    const xs = reignRegions.map((r) => r.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    assertLayoutSane(l);
  });

  it("draws unrecorded gaps and never calls them vacant", () => {
    const l = buildLineage(data, "t:1", lineageRecord, chronology);
    expect(l.regions.some((r) => r.key.startsWith("cl:gap:") && r.kind === RK.HATCH)).toBe(true);
    const gapLabels = l.labels.filter((lb) => lb.text === "unrecorded gap");
    expect(gapLabels).toHaveLength(1); // 1970→1975 is a year-plus hole; 1980's 152-day hole stays a quiet region
    expect(gapLabels[0]!.sub).toMatch(/no reign record in corpus/);
    expect(layoutText(l).toLowerCase()).not.toContain("vacan");
  });

  it("marks leading and trailing closed-record boundaries as unrecorded", () => {
    const bounded: ChampionshipRecord = {
      ...lineageRecord,
      changes: 1,
      reigns: [
        {
          holders: ["p:hero"],
          s: "1970-01-01",
          e: "1980-01-01",
          m: "m:bounded",
        },
      ],
    };
    const l = buildLineage(data, "t:1", bounded, chronology);
    const gaps = l.labels.filter((label) => label.text === "unrecorded gap");

    expect(gaps).toHaveLength(2);
    expect(gaps[0]!.sub).toMatch(/1966-01-01 → 1970-01-01/);
    expect(gaps[1]!.sub).toMatch(/1980-01-01 → 1998-01-01/);
    expect(l.regions.filter((region) => region.kind === RK.HATCH)).toHaveLength(2);
    expect(layoutText(l).toLowerCase()).not.toContain("vacan");
  });

  it("scopes pooled occurrence regions and labels to the title identity", () => {
    const first = buildLineage(
      data,
      "t:1",
      {
        ...lineageRecord,
        reigns: [
          {
            holders: ["p:hero"],
            s: "1970-01-01",
            e: "1971-01-01",
            m: "m:first-title",
          },
        ],
      },
      chronology,
    );
    const second = buildLineage(
      data,
      "t:other",
      {
        ...lineageRecord,
        n: "Other Title",
        reigns: [
          {
            holders: ["p:par"],
            s: "1970-01-01",
            e: "1971-01-01",
            m: "m:second-title",
          },
        ],
      },
      null,
    );
    const firstOccurrence = first.labels.find(
      (label) => label.key.includes("cl:reign:t:1:1970-01-01") && label.pick === "p:hero",
    )!;
    const secondOccurrence = second.labels.find(
      (label) => label.key.includes("cl:reign:t:other:1970-01-01") && label.pick === "p:par",
    )!;
    const firstRail = first.regions.find((region) => region.pick === "p:hero")!;
    const secondRail = second.regions.find((region) => region.pick === "p:par")!;

    expect(firstOccurrence.key).toContain("t:1:");
    expect(secondOccurrence.key).toContain("t:other:");
    expect(firstOccurrence.key).not.toBe(secondOccurrence.key);
    expect(firstRail.key).not.toBe(secondRail.key);
    expect(firstRail.key).toContain("t:1:");
    expect(secondRail.key).toContain("t:other:");
  });

  it("marks the open reign open in corpus, with a dissolving edge", () => {
    const l = buildLineage(data, "t:1", lineageRecord, chronology);
    expect(l.regions.find((r) => r.key === "cl:reign:t:1:1980-06-01")!.kind).toBe(RK.OPEN);
    expect(l.regions.find((r) => r.key === "cl:reign:t:1:1966-01-01")!.kind).toBe(RK.GOLD);
    expect(l.labels.some((lb) => lb.sub?.includes("open in corpus"))).toBe(true);
    expect(l.nodeRole[idx("p:hero")]).toBe(MR.HOLDER);
  });

  it("preserves a source-artifact name verbatim, with a persistent warning", () => {
    const l = buildLineage(data, "t:1", { ...lineageRecord, artifact: true }, null);
    const head = l.labels.find((lb) => lb.key === "n:t:1")!;
    expect(head.text).toBe("Alpha World Title");
    expect(head.tone).toBe("warn");
    expect(head.badge).toBe("!");
    expect(head.detail).toMatch(/source artifact/);
    expect(head.detail).toMatch(/not repaired/);
  });

  it("says why a no-changes lineage has no reigns — absent, not guessed", () => {
    const l = buildLineage(data, "t:nc", null, chronology);
    expect(l.notes.join(" ")).toMatch(/no title-change field/);
    expect(l.notes.join(" ")).toMatch(/not guessed/);
    expect(l.labels.some((lb) => lb.text === "no documented reign records")).toBe(true);
    expect(l.regions.some((r) => r.key.startsWith("cl:reign:"))).toBe(false);
    // the belt has no corpus node: it must survive as a virtual chip
    expect(l.virtuals.some((v) => v.id === "t:nc")).toBe(true);
    expect(layoutText(l).toLowerCase()).not.toContain("vacan");
  });

  it("uses deterministic, substantial Z lanes for co-holders and overlapping reigns", () => {
    const overlapping: ChampionshipRecord = {
      ...lineageRecord,
      changes: 2,
      reigns: [
        {
          holders: ["p:par", "p:hero"],
          s: "1970-01-01",
          e: "1975-01-01",
          m: "m:co",
        },
        {
          holders: ["p:opp"],
          s: "1972-01-01",
          e: "1976-01-01",
          m: "m:overlap",
        },
      ],
    };
    const a = buildLineage(data, "t:1", overlapping, chronology);
    const b = buildLineage(data, "t:1", overlapping, chronology);
    const rails = a.regions.filter((region) => region.key.startsWith("cl:reign:"));
    const laneZ = rails.map((region) => region.z);

    expect(rails).toHaveLength(3);
    expect(new Set(laneZ).size).toBe(3);
    expect(Math.max(...laneZ) - Math.min(...laneZ)).toBeGreaterThanOrEqual(200);
    // X is time: compare segment starts, not midpoints of unequal durations.
    const starts = rails.map((region) => region.x - region.w / 2);
    expect(starts[0]).toBeLessThanOrEqual(starts[1]!);
    expect(starts[1]).toBeLessThan(starts[2]!);
    expect(a.fitBounds?.minZ).toBeTypeOf("number");
    expect(a.fitBounds?.maxZ).toBeTypeOf("number");
    expect(a.fitBounds!.maxZ! - a.fitBounds!.minZ!).toBeGreaterThanOrEqual(300);
    for (const value of [
      a.bounds.minZ,
      a.bounds.maxZ,
      a.fitBounds!.minZ,
      a.fitBounds!.maxZ,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(a.regions.map(({ key, x, y, z }) => ({ key, x, y, z }))).toEqual(
      b.regions.map(({ key, x, y, z }) => ({ key, x, y, z })),
    );
    expectSameFloats(a.nodeTargets, b.nodeTargets);
    assertLayoutSane(a);
  });

  it("writes a repeated holder once at the earliest documented representative", () => {
    const repeated: ChampionshipRecord = {
      ...lineageRecord,
      changes: 2,
      reigns: [
        {
          holders: ["p:hero"],
          s: "1988-01-01",
          e: "1990-01-01",
          m: "m:later",
        },
        {
          holders: ["p:hero"],
          s: "1966-01-01",
          e: "1970-01-01",
          m: "m:earlier",
        },
      ],
    };
    const l = buildLineage(data, "t:1", repeated, chronology);
    const axis = l.timeAxis!;
    const xOf = (day: number) =>
      axis.x0 +
      ((day - axis.dayMin) / (axis.dayMax - axis.dayMin)) *
        (axis.x1 - axis.x0);
    const expectedX =
      (xOf(isoToDay("1966-01-01")) + xOf(isoToDay("1970-01-01"))) / 2;

    expect(l.nodeTargets[idx("p:hero") * 3]!).toBeCloseTo(expectedX, 4);
    expect(l.nodeRole[idx("p:hero")]).toBe(MR.HOLDER);
    expect(l.labels.filter((label) => label.key === "n:p:hero")).toHaveLength(1);
    expect(
      l.regions.filter(
        (region) =>
          region.key.startsWith("cl:reign:") && region.pick === "p:hero",
      ),
    ).toHaveLength(2);
    expect(
      l.labels.find((label) => label.key === "n:p:hero")!.detail,
    ).toMatch(/anchored at earliest documented reign/);
  });

  it("keeps a listed nonresident holder as one honest virtual entity", () => {
    const missingId = "p:not-graph-resident";
    const missing: ChampionshipRecord = {
      ...lineageRecord,
      changes: 2,
      reigns: [
        {
          holders: [missingId],
          s: "1966-01-01",
          e: "1970-01-01",
          m: "m:missing-1",
        },
        {
          holders: [missingId],
          s: "1980-01-01",
          e: null,
          m: "m:missing-2",
        },
      ],
    };
    const l = buildLineage(data, "t:1", missing, chronology);
    const reordered = buildLineage(
      data,
      "t:1",
      { ...missing, reigns: [...missing.reigns].reverse() },
      chronology,
    );
    const virtuals = l.virtuals.filter((virtual) => virtual.id === missingId);
    const reorderedVirtuals = reordered.virtuals.filter(
      (virtual) => virtual.id === missingId,
    );
    const label = l.labels.find((candidate) => candidate.key === `n:${missingId}`)!;

    expect(virtuals).toHaveLength(1);
    expect(reorderedVirtuals).toEqual(virtuals);
    expect(virtuals[0]!.role).toBe(MR.HOLDER);
    expect(label.badge).toBe("NO GRAPH NODE");
    expect(label.detail).toMatch(/listed in documented title-change records/);
    expect(label.detail).toMatch(/no graph-resident node/);
    expect(
      l.regions.filter(
        (region) => region.key.startsWith("cl:reign:") && region.pick === missingId,
      ),
    ).toHaveLength(2);
    expect(l.labels.some((candidate) => candidate.sub?.includes("open in corpus"))).toBe(true);
  });

  it("refuses supplied reign rows when chronology says the source has no title-change field", () => {
    const impossible: ChampionshipRecord = {
      ...lineageRecord,
      n: "Ghost Belt",
      reigns: [
        {
          holders: ["p:hero"],
          s: "1990-01-01",
          e: null,
          m: "m:must-not-render",
        },
      ],
    };
    const l = buildLineage(data, "t:nc", impossible, chronology);

    expect(l.regions.some((region) => region.key.startsWith("cl:reign:"))).toBe(false);
    expect(l.nodeRole[idx("p:hero")]).toBe(MR.BACKGROUND);
    expect(l.notes.join(" ")).toMatch(/no title-change field/);
    expect(l.notes.join(" ")).toMatch(/no lineage was invented/);
    expect(l.notes.join(" ")).toMatch(/not guessed/);
  });

  it("honors the corpus-context toggle without down-tiering active holders", () => {
    const visible = buildLineage(data, "t:1", lineageRecord, chronology, {
      context: true,
    });
    const hidden = buildLineage(data, "t:1", lineageRecord, chronology, {
      context: false,
    });
    const ambient = Array.from({ length: data.count }, (_, i) => i).filter(
      (i) => hidden.nodeRole[i] === MR.BACKGROUND,
    );

    expect(ambient.length).toBeGreaterThan(0);
    expect(ambient.some((i) => visible.nodeOpacity[i]! > 0.01)).toBe(true);
    expect(ambient.every((i) => hidden.nodeOpacity[i]! <= 0.0011)).toBe(true);
    for (const holder of ["p:opp", "p:par", "p:hero"]) {
      expect(hidden.nodeRole[idx(holder)]).toBe(MR.HOLDER);
      expect(hidden.nodeOpacity[idx(holder)]).toBeGreaterThan(0.9);
    }
  });
});

/* --------------------------------------------------------- motherboard */

describe("promotion motherboard", () => {
  it("banks say documented, grouped by first documented decade", () => {
    const l = buildMotherboard(data, "pr:a", alphaDetail, DEFAULT_MORPH_CONTROLS);
    const bankHeads = l.labels.filter((lb) => lb.key.startsWith("mb:bank:") && lb.key.endsWith(":h"));
    expect(bankHeads.length).toBeGreaterThan(0);
    for (const h of bankHeads) expect(h.text).toMatch(/\d+ documented$/);
    expect(bankHeads.some((h) => h.text.startsWith("1960S"))).toBe(true);
    expect(bankHeads.some((h) => h.text.startsWith("1980S"))).toBe(true);
    assertLayoutSane(l);
  });

  it("flags a no-changes belt module honestly", () => {
    const l = buildMotherboard(data, "pr:a", alphaDetail, DEFAULT_MORPH_CONTROLS);
    const gb = l.labels.find((lb) => lb.key === "n:t:nc")!;
    expect(gb.sub).toMatch(/no title-change field in source/);
    // the derived belt states its reigns instead
    expect(l.labels.find((lb) => lb.key === "n:t:1")!.sub).toMatch(/3 documented reigns/);
  });

  it("hides only ambient corpus context while preserving the promotion structure", () => {
    const shown = buildMotherboard(data, "pr:a", alphaDetail, {
      ...DEFAULT_MORPH_CONTROLS,
      context: true,
    });
    const hidden = buildMotherboard(data, "pr:a", alphaDetail, {
      ...DEFAULT_MORPH_CONTROLS,
      context: false,
    });

    expect(shown.nodeOpacity[idx("p:opp")]).toBeGreaterThan(0.01);
    expect(hidden.nodeRole[idx("p:opp")]).toBe(MR.BACKGROUND);
    expect(hidden.nodeOpacity[idx("p:opp")]).toBeLessThanOrEqual(0.0011);
    expect(hidden.nodeRole[idx("pr:a")]).toBe(MR.SELECTED);
    expect(hidden.nodeOpacity[idx("pr:a")]).toBe(1);
    expect(hidden.nodeRole[idx("p:hero")]).toBe(MR.MEMBER);
    expect(hidden.nodeOpacity[idx("p:hero")]).toBeGreaterThan(0.6);
    expect(hidden.nodeRole[idx("t:1")]).toBe(MR.TITLE_CONTEXT);
    expect(hidden.nodeOpacity[idx("t:1")]).toBeGreaterThan(0.8);
  });
});

/* ---------------------------------------------------- wording contract */

describe("wording contract", () => {
  it("never claims employment, contracts or vacancies on any board", () => {
    const layouts: MorphLayoutResult[] = [
      buildOrganic(data, null, [], 100),
      buildHeroLoom(),
      buildMotherboard(data, "pr:a", alphaDetail, DEFAULT_MORPH_CONTROLS),
      buildLineage(data, "t:1", lineageRecord, chronology),
      buildCareer(data, "p:hero", heroRoutes, heroDossier, chronology, DEFAULT_MORPH_CONTROLS),
    ];
    for (const l of layouts) {
      const text = layoutText(l);
      expect(text, `mode ${l.mode}`).not.toMatch(/\bcontract\b/i);
      expect(text.toLowerCase(), `mode ${l.mode}`).not.toContain("vacan");
      expect(text.toLowerCase(), `mode ${l.mode}`).not.toContain("roster");
      // "employment" may appear only as an explicit denial
      expectDeniedOrAbsent(text, "employ", [/not employment/i]);
    }
    // and the loom actually says the denial out loud on its promotion bus
    expect(layoutText(buildHeroLoom())).toMatch(/documented appearances, not employment/);
  });

  it("keeps the career circuit sane while it is at it", () => {
    assertLayoutSane(buildCareer(data, "p:hero", heroRoutes, heroDossier, chronology, DEFAULT_MORPH_CONTROLS));
  });
});

/* -------------------------------------------------------- mode routing */

describe("morph mode routing", () => {
  it("auto mode follows the selection's entity kind", () => {
    expect(morphModeFor(null, "auto", false)).toBe("organic");
    expect(morphModeFor("p:hero", "auto", false)).toBe("loom");
    expect(morphModeFor("pr:a", "auto", false)).toBe("motherboard");
    expect(morphModeFor("t:1", "auto", false)).toBe("lineage");
  });

  it("tissue always returns organic, whatever else is set", () => {
    expect(morphModeFor("p:hero", "loom", true)).toBe("organic");
    expect(morphModeFor("pr:a", "motherboard", true)).toBe("organic");
    expect(morphModeFor(null, "auto", true)).toBe("organic");
  });

  it("an override that cannot apply to the selection falls back to auto", () => {
    expect(morphModeFor("pr:a", "loom", false)).toBe("motherboard"); // loom needs a person
    expect(morphModeFor("p:hero", "lineage", false)).toBe("loom"); // lineage needs a title
    expect(morphModeFor("t:1", "motherboard", false)).toBe("lineage");
    expect(morphModeFor("p:hero", "career", false)).toBe("career"); // valid override applies
    expect(morphModeFor("p:hero", "orbit", false)).toBe("orbit"); // Orbit is a person topology
    expect(morphModeFor("pr:a", "orbit", false)).toBe("motherboard"); // Orbit never coerces a promotion
    expect(morphModeFor("p:hero", "organic", false)).toBe("organic"); // organic is always allowed
  });
});

/* ----------------------------------------------------- transition math */

describe("transition math", () => {
  it("elementProgress lands every delay at exactly 1 when the clock does", () => {
    for (const d of [0, 0.25, 0.5, 0.75, 1]) {
      expect(elementProgress(1, d)).toBe(1);
      expect(elementProgress(0, d)).toBe(0);
    }
  });

  it("easeQuintic is a monotonic easing fixed at the endpoints", () => {
    expect(easeQuintic(0)).toBe(0);
    expect(easeQuintic(1)).toBe(1);
    expect(easeQuintic(0.5)).toBeCloseTo(0.5, 12);
    let prev = -Infinity;
    for (let t = 0; t <= 1.00001; t += 0.01) {
      const v = easeQuintic(Math.min(1, t));
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("per-element progress is monotonic in the raw clock for any delay", () => {
    for (const d of [0, 0.4, 1]) {
      let prev = -Infinity;
      for (let raw = 0; raw <= 1.00001; raw += 0.02) {
        const p = elementProgress(Math.min(1, raw), d);
        expect(p).toBeGreaterThanOrEqual(prev);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
        prev = p;
      }
    }
  });

  it("mid-flight capture is continuous: captured travel composes into direct travel", () => {
    // MorphNodes.captureCurrent folds from = lerp(from, to, e) and restarts
    // the clock. The algebra that makes it snap-free:
    //   lerp(lerp(a,b,e1), b, e2) === lerp(a, b, e1 + e2 - e1*e2)
    const lerp = (a: number, b: number, e: number): number => a + (b - a) * e;
    const a = -137.5;
    const b = 412.25;
    for (const delay of [0, 0.3, 0.9]) {
      for (const capturedAtRaw of [0.2, 0.5, 0.83]) {
        const e1 = easeQuintic(elementProgress(capturedAtRaw, delay));
        const captured = lerp(a, b, e1);
        // continuity at the boundary — restarting at raw 0 is exactly where we were
        expect(lerp(captured, b, easeQuintic(elementProgress(0, delay)))).toBe(captured);
        // the retargeted flight still lands exactly on the target
        expect(lerp(captured, b, easeQuintic(elementProgress(1, delay)))).toBeCloseTo(b, 10);
        // and the composed path is the direct path
        for (const e2 of [0.1, 0.5, 0.99]) {
          expect(lerp(captured, b, e2)).toBeCloseTo(lerp(a, b, e1 + e2 - e1 * e2), 10);
        }
      }
    }
  });
});

/* ------------------------------------------------------------ URL state */

describe("morph url state", () => {
  let lastUrl = "";
  (globalThis as unknown as { history: unknown }).history = {
    replaceState: (_d: unknown, _t: string, url?: string) => {
      if (typeof url === "string") lastUrl = url;
    },
  };
  const loc = { hash: "" };
  (globalThis as unknown as { location: unknown }).location = loc;

  function resetMorph(): void {
    useMorph.setState({
      modeOverride: "auto",
      tissue: false,
      controls: { ...DEFAULT_MORPH_CONTROLS },
      camera: null,
      pendingCamera: null,
    });
    markMorphCameraTouched(false);
  }

  it("round-trips mode, controls and a touched camera through the fragment", async () => {
    installMorphUrl();
    useStore.setState({ model, core, lens: "morph" });
    resetMorph();
    useMorph.setState({
      modeOverride: "lineage",
      controls: { sort: "alpha", group: "champ", timeAxis: true },
      camera: { cx: 12.34, cy: -56.78, cz: 9.1, distance: 321, theta: 0.44, phi: 1.22 },
    });
    markMorphCameraTouched(true);
    writeUrl();
    await new Promise((r) => setTimeout(r, 250)); // writeUrl debounces 150 ms
    const frag = lastUrl;
    expect(frag).toContain("lens=morph");
    expect(frag).toContain("mom=lineage");
    expect(frag).toContain("mos=alpha");
    expect(frag).toContain("mog=champ");
    expect(frag).toContain("mox=1");

    resetMorph();
    loc.hash = frag;
    restoreFromUrl();
    await applyPendingMorphUrl();
    const s = useMorph.getState();
    expect(s.modeOverride).toBe("lineage");
    expect(s.controls.sort).toBe("alpha");
    expect(s.controls.group).toBe("champ");
    expect(s.controls.timeAxis).toBe(true);
    expect(s.pendingCamera).toEqual({ cx: 12.34, cy: -56.78, cz: 9.1, distance: 321, theta: 0.44, phi: 1.22 });
  });

  it("defaults never appear in the fragment", async () => {
    useStore.setState({ model, core, lens: "morph" });
    resetMorph();
    writeUrl();
    await new Promise((r) => setTimeout(r, 250));
    expect(lastUrl).not.toContain("mom=");
    expect(lastUrl).not.toContain("mos=");
    expect(lastUrl).not.toContain("mog=");
    expect(lastUrl).not.toContain("mox=");
    expect(lastUrl).not.toContain("mocx=");
  });

  it("an active default link clears prior lens-local state", async () => {
    useStore.setState({ model, core, lens: "morph" });
    useMorph.setState({
      modeOverride: "lineage",
      tissue: true,
      controls: { sort: "alpha", group: "champ", timeAxis: true, context: false },
      pendingCamera: { cx: 4, cy: 5, cz: 6, distance: 200, theta: 1, phi: 1 },
    });
    markMorphCameraTouched(true);
    loc.hash = "#2/lens=morph";
    restoreFromUrl();
    await applyPendingMorphUrl();
    const s = useMorph.getState();
    expect(s.modeOverride).toBe("auto");
    expect(s.tissue).toBe(false);
    expect(s.controls).toEqual(DEFAULT_MORPH_CONTROLS);
    expect(s.pendingCamera).toBeNull();
  });

  it("ignores invalid sort, group, mode and camera values", async () => {
    useStore.setState({ model, core, lens: "morph" });
    resetMorph();
    loc.hash = "#2/lens=morph/mom=bogus/mos=nope/mog=zap/mox=2/mocx=3/mocy=4/moch=-9";
    restoreFromUrl();
    await applyPendingMorphUrl();
    const s = useMorph.getState();
    expect(s.modeOverride).toBe("auto");
    expect(s.controls.sort).toBe(DEFAULT_MORPH_CONTROLS.sort);
    expect(s.controls.group).toBe(DEFAULT_MORPH_CONTROLS.group);
    expect(s.controls.timeAxis).toBe(false);
    expect(s.pendingCamera).toBeNull(); // half must be > 0
  });
});
