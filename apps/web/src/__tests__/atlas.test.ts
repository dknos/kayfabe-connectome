import { describe, expect, it } from "vitest";
import type {
  AtlasPersonRoutes,
  AtlasPromotionDetail,
  AtlasPromotionsFile,
  AtlasTitlesFile,
  ChampionshipRecord,
  PersonDossier,
} from "@kayfabe/graph-contract";
import { isoToDay } from "@kayfabe/graph-contract";
import type { AtlasData } from "../atlas/atlasLoader";
import { buildOverview } from "../atlas/layout/overviewLayout";
import { buildPromotion } from "../atlas/layout/promotionLayout";
import { buildTitle, isReignKey, reignKey } from "../atlas/layout/titleLayout";
import { buildCareer } from "../atlas/layout/careerLayout";
import {
  DEFAULT_CONTROLS,
  TIME_W,
  focusAxis,
  makeAxis,
  packRows,
  type AtlasControls,
} from "../atlas/layout/layoutTypes";

/**
 * The layouts are pure functions of (data, controls) -> scene, which is the
 * whole reason they can be tested at all: none of this needs a GPU, a browser
 * or the 423 MB materialized tree.
 *
 * What is asserted here is not "does it draw" but the claims the lens makes:
 * that ordering is deterministic, that nothing is silently dropped, that a
 * missing record stays missing, and that no coordinate is ever NaN.
 */

const D0 = isoToDay("1960-01-01");
const D1 = isoToDay("2020-01-01");

function promotionsFixture(): AtlasPromotionsFile {
  return {
    count: 4,
    id: ["pr:a", "pr:b", "pr:c", "pr:none"],
    name: ["Alpha", "Bravo", "Charlie", "Undated"],
    firstDay: [isoToDay("1965-03-01"), isoToDay("1985-06-01"), isoToDay("1972-01-01"), -1],
    lastDay: [isoToDay("1999-01-01"), isoToDay("2015-01-01"), isoToDay("1978-01-01"), -1],
    cards: [400, 900, 20, 0],
    matches: [4000, 9000, 60, 0],
    people: [300, 800, 12, 0],
    titles: [2, 1, 0, 0],
    src: ["local_sql", "csv_initial_matches", "csv_initial_matches", "csv_initial_matches"],
    bit: [0, 6, -1, -1],
    yearFrom: [1965, 1985, 1972, 0],
    yearCounts: [[100, 200, 300], [500, 400], [30, 30], []],
  };
}

function titlesFixture(): AtlasTitlesFile {
  return {
    count: 4,
    id: ["t:1", "t:2", "t:3", "t:orphan"],
    name: ["Alpha World Title", "Alpha Tag Titles", "Bravo Title", "Wandering Belt"],
    pr: ["pr:a", "pr:a", "pr:b", ""],
    assoc: ["dominant", "registry", "registry", "unresolved"],
    assocShare: [0.5, 1, 1, 0],
    firstDay: [isoToDay("1966-01-01"), isoToDay("1970-01-01"), isoToDay("1986-01-01"), isoToDay("1990-01-01")],
    lastDay: [isoToDay("1998-01-01"), isoToDay("1996-01-01"), isoToDay("2014-01-01"), isoToDay("1995-01-01")],
    titleMatches: [300, 120, 400, 9],
    reigns: [3, 0, 0, 0],
    changes: [3, 0, 0, 0],
    holders: [2, 0, 0, 0],
    artifact: [0, 1, 0, 0],
    src: ["local_sql", "local_sql", "csv_initial_matches", "csv_initial_matches"],
    lineage: ["derived", "derived", "no-changes", "no-changes"],
  };
}

function makeData(): AtlasData {
  const promotions = promotionsFixture();
  const titles = titlesFixture();
  const promoIndex = new Map(promotions.id.map((id, i) => [id, i]));
  const titleIndex = new Map(titles.id.map((id, i) => [id, i]));
  const titlesByPromo = new Map<string, number[]>();
  const unresolvedTitles: number[] = [];
  titles.id.forEach((_id, i) => {
    const pr = titles.pr[i]!;
    if (!pr || titles.assoc[i] === "unresolved") unresolvedTitles.push(i);
    else titlesByPromo.set(pr, [...(titlesByPromo.get(pr) ?? []), i]);
  });
  return {
    manifest: {
      schema_version: "1.0.0",
      projection_version: "atlas-projection@1",
      epoch: "1900-01-01",
      algorithms: {},
      counts: { titlesWithReigns: 1 },
      date_range: ["1960-01-01", "2020-01-01"],
      day_range: [D0, D1],
      buckets: 256,
      reuses: {},
      checksums: {},
      validation: { passed: true, checks: {} },
    },
    promotions,
    titles,
    promoIndex,
    titleIndex,
    titlesByPromo,
    unresolvedTitles,
    maxPromoMatches: 9000,
    maxTitleMatches: 400,
  };
}

const base = {
  data: makeData(),
  controls: DEFAULT_CONTROLS,
  dayMin: D0,
  dayMax: D1,
  promoAllow: null,
  selected: null,
  hovered: null,
  playheadDay: null,
};

/**
 * Some words cannot be claims about this corpus — it records appearances, not
 * contracts, and title changes, not vacancies. They may still APPEAR, because
 * saying "not employment" out loud is the honest thing to do. So the assertion
 * is not that the word is absent; it is that every occurrence is a denial.
 */
function expectOnlyDenied(text: string, word: string, deniers: RegExp[]): void {
  const hay = text.toLowerCase();
  const needle = word.toLowerCase();
  let at = hay.indexOf(needle);
  let found = 0;
  // Scanned by index rather than a global regex: overlapping windows matter
  // here, and /g match would let one occurrence swallow the context of the
  // next, hiding an undenied claim behind a denied one.
  while (at >= 0) {
    found++;
    const window = text.slice(Math.max(0, at - 70), at + needle.length + 70);
    expect(deniers.some((d) => d.test(window)), `undenied claim: …${window}…`).toBe(true);
    at = hay.indexOf(needle, at + 1);
  }
  expect(found).toBeGreaterThan(0);
}

/** Every coordinate a layout emits must be a real number. */
function assertFinite(scene: ReturnType<typeof buildOverview>): void {
  for (const q of scene.quads) {
    for (const v of [q.x, q.y, q.z, q.w, q.h, q.alpha]) expect(Number.isFinite(v)).toBe(true);
    expect(q.w).toBeGreaterThan(0);
    expect(q.h).toBeGreaterThan(0);
  }
  for (const d of scene.dots) {
    for (const v of [d.x, d.y, d.z, d.size, d.alpha]) expect(Number.isFinite(v)).toBe(true);
  }
  for (const p of scene.paths) for (const v of p.points) expect(Number.isFinite(v)).toBe(true);
  for (const l of scene.labels) for (const v of [l.x, l.y, l.z]) expect(Number.isFinite(v)).toBe(true);
  for (const v of [scene.bounds.minX, scene.bounds.maxX, scene.bounds.minY, scene.bounds.maxY]) {
    expect(Number.isFinite(v)).toBe(true);
  }
}

/* ---------------------------------------------------------------- axis */

describe("time axis", () => {
  it("maps the range endpoints to the world extent", () => {
    const a = makeAxis(D0, D1);
    expect(a.x(D0)).toBeCloseTo(-TIME_W / 2, 6);
    expect(a.x(D1)).toBeCloseTo(TIME_W / 2, 6);
  });

  it("round-trips day -> x -> day", () => {
    const a = makeAxis(D0, D1);
    for (const d of [D0, D0 + 1234, (D0 + D1) / 2, D1]) {
      expect(a.dayAt(a.x(d))).toBeCloseTo(d, 4);
    }
  });

  it("is monotonic in time", () => {
    const a = makeAxis(D0, D1);
    let prev = -Infinity;
    for (let d = D0; d <= D1; d += 900) {
      const x = a.x(d);
      expect(x).toBeGreaterThan(prev);
      prev = x;
    }
  });

  it("labels decade ticks as major and never emits a tick outside the range", () => {
    const a = makeAxis(D0, D1);
    expect(a.ticks.length).toBeGreaterThan(4);
    for (const t of a.ticks) {
      expect(t.day).toBeGreaterThanOrEqual(D0);
      expect(t.day).toBeLessThanOrEqual(D1);
    }
    expect(a.ticks.some((t) => t.major)).toBe(true);
  });

  it("focusAxis zooms to the subject and falls back to the corpus when undated", () => {
    const f = focusAxis(isoToDay("2000-01-01"), isoToDay("2010-01-01"), D0, D1);
    expect(f.dayMin).toBeGreaterThan(D0);
    expect(f.dayMax).toBeLessThan(D1);
    const none = focusAxis(-1, -1, D0, D1);
    expect(none.dayMin).toBe(D0);
    expect(none.dayMax).toBe(D1);
  });

  it("focusAxis never inverts on a single-day subject", () => {
    const d = isoToDay("1990-05-05");
    const f = focusAxis(d, d, D0, D1);
    expect(f.dayMax).toBeGreaterThan(f.dayMin);
  });
});

/* ------------------------------------------------------------ packing */

describe("interval packing", () => {
  it("puts overlapping intervals in different rows", () => {
    const { rows, count } = packRows([
      { firstDay: 0, lastDay: 100 },
      { firstDay: 50, lastDay: 150 },
      { firstDay: 60, lastDay: 90 },
    ]);
    expect(count).toBe(3);
    expect(new Set(rows).size).toBe(3);
  });

  it("reuses a row for sequential intervals", () => {
    const { rows, count } = packRows([
      { firstDay: 0, lastDay: 10 },
      { firstDay: 20, lastDay: 30 },
      { firstDay: 40, lastDay: 50 },
    ]);
    expect(count).toBe(1);
    expect(rows).toEqual([0, 0, 0]);
  });

  it("honours the gap so touching intervals do not share a row", () => {
    const { count } = packRows([{ firstDay: 0, lastDay: 10 }, { firstDay: 12, lastDay: 20 }], 40);
    expect(count).toBe(2);
  });

  it("is deterministic for the same input", () => {
    const items = [
      { firstDay: 5, lastDay: 40 },
      { firstDay: 0, lastDay: 10 },
      { firstDay: 30, lastDay: 60 },
    ];
    expect(packRows(items)).toEqual(packRows(items));
  });
});

/* ----------------------------------------------------------- overview */

describe("overview layout", () => {
  it("represents every promotion, including undated ones", () => {
    const s = buildOverview(base);
    expect(s.stats.represented).toBe(4);
    expect(s.lanes.filter((l) => l.key.startsWith("pr:"))).toHaveLength(4);
    // The undated promotion gets a lane and a label but no span rail.
    expect(s.quads.some((q) => q.key === "plat:pr:none")).toBe(true);
    expect(s.quads.some((q) => q.key === "rail:pr:none")).toBe(false);
  });

  it("draws a rail for every championship placed in a promotion", () => {
    const s = buildOverview(base);
    for (const id of ["t:1", "t:2", "t:3"]) {
      expect(s.quads.some((q) => q.key === `title:${id}`)).toBe(true);
    }
  });

  it("gives titles the records place nowhere their own band, never a promotion", () => {
    const s = buildOverview(base);
    expect(s.lanes.some((l) => l.key === "atlas:unresolved-titles")).toBe(true);
    expect(s.quads.some((q) => q.key === "title:t:orphan")).toBe(true);
    // and it is NOT inside any promotion's title set
    for (const arr of base.data.titlesByPromo.values()) {
      expect(arr).not.toContain(base.data.titleIndex.get("t:orphan"));
    }
  });

  it("orders lanes deterministically", () => {
    const a = buildOverview(base);
    const b = buildOverview(base);
    expect(a.lanes.map((l) => l.key)).toEqual(b.lanes.map((l) => l.key));
  });

  it("sorts by documented volume inside a group by default", () => {
    const s = buildOverview(base);
    const ys = new Map(s.lanes.map((l) => [l.key, l.y]));
    // Alpha (1960s) is grouped above Bravo (1980s); Y descends down the board.
    expect(ys.get("pr:a")!).toBeGreaterThan(ys.get("pr:b")!);
  });

  it("alphabetical grouping changes the order and stays deterministic", () => {
    const controls: AtlasControls = { ...DEFAULT_CONTROLS, group: "alpha", sort: "alpha" };
    const s1 = buildOverview({ ...base, controls });
    const s2 = buildOverview({ ...base, controls });
    expect(s1.lanes.map((l) => l.key)).toEqual(s2.lanes.map((l) => l.key));
    expect(s1.lanes[0]!.key).toBe("pr:a");
  });

  it("folds the activity tail into a stated residual instead of dropping it", () => {
    const s = buildOverview({ ...base, controls: { ...DEFAULT_CONTROLS, minActivity: 1000 } });
    expect(s.stats.represented).toBe(2);
    expect(s.stats.notes.join(" ")).toMatch(/residual band/);
    expect(s.stats.notes.join(" ")).toMatch(/2 promotions/);
  });

  it("never hides the selection behind the activity floor", () => {
    const s = buildOverview({
      ...base,
      selected: "pr:c",
      controls: { ...DEFAULT_CONTROLS, minActivity: 1000 },
    });
    expect(s.lanes.some((l) => l.key === "pr:c")).toBe(true);
  });

  it("honours the shared promotion filter", () => {
    const s = buildOverview({ ...base, promoAllow: new Set(["pr:a"]) });
    expect(s.stats.represented).toBe(1);
  });

  it("hides championships when the layer is off", () => {
    const s = buildOverview({ ...base, controls: { ...DEFAULT_CONTROLS, showTitles: false } });
    expect(s.quads.some((q) => q.kind === 2)).toBe(false);
  });

  it("emits an anchor for every selectable entity", () => {
    const s = buildOverview(base);
    for (const id of ["pr:a", "pr:b", "pr:c", "pr:none", "t:1", "t:2", "t:3", "t:orphan"]) {
      expect(s.anchors.has(id)).toBe(true);
    }
  });

  it("produces no NaN geometry", () => {
    assertFinite(buildOverview(base));
    assertFinite(buildOverview({ ...base, playheadDay: isoToDay("1990-01-01") }));
  });

  it("gives every quad and dot a stable key", () => {
    const s = buildOverview(base);
    expect(new Set(s.quads.map((q) => q.key)).size).toBe(s.quads.length);
    expect(new Set(s.labels.map((l) => l.key)).size).toBe(s.labels.length);
  });
});

/* ---------------------------------------------------------- promotion */

function promoDetail(): AtlasPromotionDetail {
  return {
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
        assoc: "dominant", assocShare: 0.5, lineage: "derived",
        yearFrom: 1966, yearCounts: [5, 6, 7],
      },
      {
        t: "t:2", n: "Alpha Tag Titles",
        firstDay: isoToDay("1970-01-01"), lastDay: isoToDay("1996-01-01"),
        titleMatches: 120, reigns: 0, changes: 0, holders: 0, artifact: 1,
        assoc: "registry", assocShare: 1, lineage: "no-changes",
        yearFrom: 1970, yearCounts: [2, 3],
      },
    ],
    members: [
      { p: "p:1", n: "One", firstDay: isoToDay("1966-01-01"), lastDay: isoToDay("1975-01-01"), matches: 500, cards: 50, champ: 1 },
      { p: "p:2", n: "Two", firstDay: isoToDay("1968-01-01"), lastDay: isoToDay("1980-01-01"), matches: 200, cards: 20 },
      { p: "p:3", n: "Three", firstDay: isoToDay("1985-01-01"), lastDay: isoToDay("1990-01-01"), matches: 30, cards: 5 },
    ],
  };
}

const promoBase = {
  data: makeData(),
  detail: promoDetail(),
  controls: DEFAULT_CONTROLS,
  dayMin: D0,
  dayMax: D1,
  selected: "pr:a" as string | null,
  hovered: null,
  playheadDay: null,
  rel: null,
};

describe("promotion focus layout", () => {
  it("gives every championship its own lane", () => {
    const s = buildPromotion(promoBase);
    expect(s.lanes.filter((l) => l.group === "Championships")).toHaveLength(2);
  });

  it("bands wrestlers by their first documented appearance FOR THIS promotion", () => {
    const s = buildPromotion(promoBase);
    const bands = s.lanes.filter((l) => l.group === "Participants").map((l) => l.label);
    expect(bands.some((b) => b.startsWith("1960s"))).toBe(true);
    expect(bands.some((b) => b.startsWith("1980s"))).toBe(true);
  });

  it("represents every documented participant", () => {
    const s = buildPromotion(promoBase);
    for (const p of ["p:1", "p:2", "p:3"]) {
      expect(s.quads.some((q) => q.key === `mem:${p}`)).toBe(true);
    }
  });

  it("says so when a title has no derivable lineage", () => {
    const s = buildPromotion(promoBase);
    expect(s.stats.notes.join(" ")).toMatch(/no title-change field/);
  });

  it("names a 50% association an undecided placement, not a majority", () => {
    const s = buildPromotion(promoBase);
    const lab = s.labels.find((l) => l.key === "titlelab:t:1")!;
    expect(lab.sub).toMatch(/undecided/);
    expect(lab.sub).not.toMatch(/majority/);
    expect(lab.badge).toBe("undecided");
  });

  it("flags a source-artifact belt", () => {
    const s = buildPromotion(promoBase);
    expect(s.labels.find((l) => l.key === "titlelab:t:2")!.badge).toBe("source artifact");
  });

  it("only ever mentions employment to deny it", () => {
    const s = buildPromotion(promoBase);
    const text = JSON.stringify([s.labels, s.stats.notes]);
    expectOnlyDenied(text, "employ", [/not employment/i]);
  });

  it("discloses a truncated roster rather than implying completeness", () => {
    const s = buildPromotion({
      ...promoBase,
      detail: { ...promoDetail(), membersTruncated: 42, people: 45 },
    });
    expect(s.stats.notes.join(" ")).toMatch(/42 further documented participants/);
  });

  it("frames the championships when it opens, and the whole board on request", () => {
    const s = buildPromotion(promoBase);
    expect(s.fitBounds).toBeDefined();
    expect(s.fitBounds!.minY).toBeGreaterThanOrEqual(s.bounds.minY);
    expect(s.fitBounds!.maxY).toBe(s.bounds.maxY);
  });

  it("draws direct fibres only for a focused wrestler, and discloses the cap", () => {
    const rel = {
      neighbours: (id: string) =>
        id === "p:1"
          ? [
              { id: "p:2", same: 0, opposed: 30, br: 0 },
              { id: "p:3", same: 12, opposed: 0, br: 0 },
              { id: "p:2", same: 0, opposed: 1, br: 0 },
            ]
          : [],
      nameOf: () => null,
      communityOf: () => 1,
    };
    const none = buildPromotion({ ...promoBase, rel });
    expect(none.paths).toHaveLength(0); // nothing focused -> no fibres
    const some = buildPromotion({ ...promoBase, rel, selected: "p:1" });
    expect(some.paths.length).toBeGreaterThan(0);
    expect(some.stats.notes.join(" ")).toMatch(/never merged into one line/);
  });

  it("respects the relation threshold", () => {
    const rel = {
      neighbours: () => [{ id: "p:2", same: 0, opposed: 3, br: 0 }],
      nameOf: () => null,
      communityOf: () => 1,
    };
    const s = buildPromotion({
      ...promoBase,
      rel,
      selected: "p:1",
      controls: { ...DEFAULT_CONTROLS, relThreshold: 10 },
    });
    expect(s.paths).toHaveLength(0);
  });

  it("produces no NaN geometry", () => {
    assertFinite(buildPromotion(promoBase) as never);
  });
});

/* ------------------------------------------------------------ lineage */

const derivedRecord: ChampionshipRecord = {
  n: "Alpha World Title",
  pr: "pr:a",
  artifact: false,
  titleMatches: 300,
  changes: 3,
  reigns: [
    { holders: ["p:1"], s: "1966-01-01", e: "1970-01-01", m: "m:1", endM: "m:2" },
    // a deliberate hole between 1970 and 1975 — the record is silent
    { holders: ["p:2", "p:3"], s: "1975-01-01", e: "1980-01-01", m: "m:3", endM: "m:4" },
    { holders: ["p:1"], s: "1980-01-01", e: null, m: "m:5" },
  ],
};

const titleBase = {
  data: makeData(),
  titleId: "t:1",
  record: derivedRecord,
  controls: DEFAULT_CONTROLS,
  dayMin: D0,
  dayMax: D1,
  selected: null,
  hovered: null,
  playheadDay: null,
  siblings: [
    { t: "t:1", n: "Alpha World Title", firstDay: D0, lastDay: D1, reigns: 3 },
    { t: "t:2", n: "Alpha Tag Titles", firstDay: D0, lastDay: D1, reigns: 0 },
  ],
  promotionName: "Alpha",
  nameOf: (id: string) => ({ "p:1": "One", "p:2": "Two", "p:3": "Three" })[id] ?? null,
  yearFrom: 1966,
  yearCounts: [5, 6, 7],
};

describe("championship lineage layout", () => {
  it("places one block per documented reign, in date order", () => {
    const s = buildTitle(titleBase);
    const blocks = s.quads.filter((q) => q.key.startsWith("reign:t:1:"));
    expect(blocks).toHaveLength(3);
    const xs = blocks.map((b) => b.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it("draws an unrecorded gap and never calls it a vacancy", () => {
    const s = buildTitle(titleBase);
    expect(s.quads.some((q) => q.key.startsWith("gap:"))).toBe(true);
    expect(s.lineage.gaps).toBe(1);
    const text = JSON.stringify([s.stats.notes, s.labels]);
    expect(text).toMatch(/unrecorded/);
    // "vacant" may only ever appear as a denial — the corpus records title
    // changes, so it has nothing to say about vacancy either way.
    expectOnlyDenied(text, "vacan", [/not vacan/i, /not that the belt was vacant/i]);
  });

  it("marks the open reign as open in corpus and excludes it from the stats", () => {
    const s = buildTitle(titleBase);
    expect(s.quads.some((q) => q.key === "reign:t:1:2" && q.kind === 4)).toBe(true);
    expect(s.lineage.openReigns).toBe(1);
    expect(s.lineage.closedReigns).toBe(2);
    expect(s.labels.some((l) => l.text === "open in corpus")).toBe(true);
  });

  it("computes duration statistics only from closed reigns", () => {
    const s = buildTitle(titleBase);
    const a = isoToDay("1970-01-01") - isoToDay("1966-01-01");
    const b = isoToDay("1980-01-01") - isoToDay("1975-01-01");
    expect(s.lineage.longestDays).toBe(Math.max(a, b));
    expect(s.lineage.medianDays).toBe(Math.round((a + b) / 2));
  });

  it("gives every holder of a multi-holder reign its own node", () => {
    const s = buildTitle(titleBase);
    expect(s.dots.filter((d) => d.key.startsWith("holder:t:1:1:"))).toHaveLength(2);
    expect(s.lineage.holders).toBe(3);
  });

  it("never connects consecutive reigns, and says why", () => {
    const s = buildTitle(titleBase);
    // the only paths are holder stems, never reign-to-reign connectors
    expect(s.paths.every((p) => p.key.startsWith("hlink:"))).toBe(true);
    expect(s.stats.notes.join(" ")).toMatch(/not evidence the belt passed directly/);
  });

  it("shows title-match activity, not invented reigns, when the source cannot record changes", () => {
    const s = buildTitle({
      ...titleBase,
      titleId: "t:3",
      record: { n: "Bravo Title", pr: "pr:b", artifact: false, reigns: [], titleMatches: 400, changes: 0 },
      promotionName: "Bravo",
    });
    expect(s.quads.some((q) => q.key.startsWith("reign:"))).toBe(false);
    expect(s.quads.some((q) => q.key.startsWith("tmbar:"))).toBe(true);
    expect(s.stats.notes.join(" ")).toMatch(/no title-change field/);
    expect(s.stats.notes.join(" ")).toMatch(/not guessed/);
  });

  it("keeps a source-artifact name verbatim and badges it", () => {
    const s = buildTitle({
      ...titleBase,
      titleId: "t:2",
      record: { n: "Alpha Tag Titles", pr: "pr:a", artifact: true, reigns: [], titleMatches: 120, changes: 0 },
    });
    expect(s.lineage.artifact).toBe(true);
    expect(s.labels.find((l) => l.key === "titlehead")!.badge).toBe("source artifact");
    expect(s.stats.notes.join(" ")).toMatch(/concatenation artifact/);
  });

  it("carries a promotion breadcrumb and offers siblings for comparison", () => {
    const s = buildTitle(titleBase);
    expect(s.breadcrumbs.map((b) => b.label)).toEqual([
      "All promotions",
      "Alpha",
      "Alpha World Title",
    ]);
    expect(s.quads.some((q) => q.key === "sib:t:2")).toBe(true);
    expect(s.quads.some((q) => q.key === "sib:t:1")).toBe(false); // never itself
  });

  it("calls a 50% association undecided rather than a majority", () => {
    const s = buildTitle(titleBase);
    const spine = s.labels.find((l) => l.key === "spinelab")!;
    expect(spine.sub).toMatch(/do not decide/);
    expect(spine.sub).not.toMatch(/majority/i);
  });

  it("uses reign keys that round-trip and are recognisable as sub-entities", () => {
    expect(isReignKey(reignKey("t:1", 4))).toBe(true);
    expect(isReignKey("t:1")).toBe(false);
    expect(isReignKey("pr:4140")).toBe(false);
  });

  it("produces no NaN geometry, with or without a lineage", () => {
    assertFinite(buildTitle(titleBase) as never);
    assertFinite(
      buildTitle({
        ...titleBase,
        titleId: "t:3",
        record: null,
        playheadDay: isoToDay("1990-01-01"),
      }) as never,
    );
  });
});

/* ------------------------------------------------------------- career */

const routes: AtlasPersonRoutes = {
  n: "One",
  firstDay: isoToDay("1966-01-01"),
  lastDay: isoToDay("2010-01-01"),
  matches: 700,
  routes: [
    { pr: "pr:a", firstDay: isoToDay("1966-01-01"), lastDay: isoToDay("1975-01-01"), matches: 500, cards: 50 },
    { pr: "pr:b", firstDay: isoToDay("1990-01-01"), lastDay: isoToDay("2010-01-01"), matches: 200, cards: 20 },
  ],
};

const dossier: PersonDossier = {
  n: "One",
  first: "1966-01-01",
  last: "2010-01-01",
  m: 700,
  promos: { "pr:a": 500, "pr:b": 200 },
  years: {},
  top: { partners: [["p:2", 20]], opponents: [["p:3", 40]] },
  teams: [],
  titles: [
    { t: "t:1", reigns: [{ s: "1966-01-01", e: "1970-01-01", m: "m:1" }] },
    // a belt whose promotion this wrestler never appeared in
    { t: "t:orphan", reigns: [{ s: "1991-01-01", e: null, m: "m:9" }] },
  ],
  src: {},
};

const careerBase = {
  data: makeData(),
  personId: "p:1",
  routes,
  dossier,
  controls: DEFAULT_CONTROLS,
  dayMin: D0,
  dayMax: D1,
  selected: null,
  hovered: null,
  playheadDay: null,
  nameOf: (id: string) => ({ "p:2": "Two", "p:3": "Three" })[id] ?? null,
  communityOf: () => 3,
};

describe("career route layout", () => {
  it("orders promotion lanes by first documented appearance", () => {
    const s = buildCareer(careerBase);
    const lanes = s.lanes.filter((l) => l.group === "Promotions").map((l) => l.key);
    expect(lanes.slice(0, 2)).toEqual(["pr:a", "pr:b"]);
  });

  it("keeps overlapping spans overlapping instead of sequencing them", () => {
    const overlapping: AtlasPersonRoutes = {
      ...routes,
      routes: [
        { pr: "pr:a", firstDay: isoToDay("1990-01-01"), lastDay: isoToDay("2000-01-01"), matches: 10, cards: 5 },
        { pr: "pr:b", firstDay: isoToDay("1992-01-01"), lastDay: isoToDay("1998-01-01"), matches: 10, cards: 5 },
      ],
    };
    const s = buildCareer({ ...careerBase, routes: overlapping });
    const a = s.quads.find((q) => q.key === "route:pr:a")!;
    const b = s.quads.find((q) => q.key === "route:pr:b")!;
    expect(a.y).not.toBe(b.y); // separate lanes
    // and their x ranges genuinely overlap — nothing was clipped to sequence them
    expect(b.x - b.w / 2).toBeGreaterThan(a.x - a.w / 2);
    expect(b.x + b.w / 2).toBeLessThan(a.x + a.w / 2);
  });

  it("attaches a reign to its belt's promotion lane when the wrestler worked there", () => {
    const s = buildCareer(careerBase);
    expect(s.quads.some((q) => q.key === "reign:t:1:0")).toBe(true);
  });

  it("puts a reign the records cannot place in its own lane, never a guessed one", () => {
    const s = buildCareer(careerBase);
    expect(s.lanes.some((l) => l.key === "atlas:unresolved-title-lane")).toBe(true);
    expect(s.quads.some((q) => q.key.startsWith("ureign:t:orphan"))).toBe(true);
    expect(s.stats.notes.join(" ")).toMatch(/Guessing a lane would be a claim/);
  });

  it("separates opponents from same-side partners", () => {
    const s = buildCareer(careerBase);
    expect(s.quads.some((q) => q.key === "rel:opp:p:3")).toBe(true);
    expect(s.quads.some((q) => q.key === "rel:tag:p:2")).toBe(true);
    expect(s.stats.notes.join(" ")).toMatch(/never\s+merged/);
  });

  it("applies the relation threshold to the relationship groups", () => {
    const s = buildCareer({ ...careerBase, controls: { ...DEFAULT_CONTROLS, relThreshold: 30 } });
    expect(s.quads.some((q) => q.key === "rel:opp:p:3")).toBe(true); // 40 >= 30
    expect(s.quads.some((q) => q.key === "rel:tag:p:2")).toBe(false); // 20 < 30
  });

  it("never calls a documented span a contract, and denies employment", () => {
    const s = buildCareer(careerBase);
    const text = JSON.stringify([s.labels, s.stats.notes]);
    expect(text).not.toMatch(/\bcontract\b/i);
    expectOnlyDenied(text, "employ", [/not employment/i]);
  });

  it("says an empty title row is a source limit, not a career without belts", () => {
    const s = buildCareer({ ...careerBase, dossier: { ...dossier, titles: [] } });
    expect(s.stats.notes.join(" ")).toMatch(/limit of the source/);
  });

  it("survives a wrestler with no routes at all", () => {
    const s = buildCareer({ ...careerBase, routes: null, dossier: null });
    expect(s.state).toBe("career");
    expect(s.stats.notes.join(" ")).toMatch(/No documented promotion appearances/);
    assertFinite(s as never);
  });

  it("produces no NaN geometry", () => {
    assertFinite(buildCareer(careerBase) as never);
  });
});
