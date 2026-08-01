// SYNTHETIC test fixtures — never production data.
import { describe, expect, it } from "vitest";
import { bucketOf, fnv1a32, isoToDay, pairKey, type Manifest, type NodesColumnar, type TimelineEvent } from "@kayfabe/graph-contract";
import { EF, GraphModel, STRIDE, type Filters } from "../graph/model";
import { TimelineEngine } from "../timeline/TimelineEngine";

const manifest = {
  schema_version: "1.0.0",
  built_at: "",
  source_fingerprint: "test",
  layout_version: "t",
  projection_version: "t",
  algorithms: {},
  counts: {},
  date_range: ["2000-01-01", "2001-12-31"],
  edges_bin: { count: 2, stride_u32: 10, fields: [] },
  promo_bits: { "1": 0 },
  form_bits: { singles: 0, tag_team: 1, multi_way: 2, battle_royal: 3, team_implied: 4, unknown: 5 },
  checksums: {},
  validation: { passed: true, checks: {} },
} as unknown as Manifest;

const nodes: NodesColumnar = {
  count: 4,
  id: ["p:1", "p:2", "p:3", "p:4"],
  type: [0, 0, 0, 0],
  name: ["A", "B", "C", "D"],
  community: [0, 0, 1, 1],
  pos: new Array(12).fill(0),
  firstDay: [0, 0, 0, 0],
  lastDay: [100, 100, 100, 100],
  matches: [1, 1, 1, 1],
  degree: [1, 1, 1, 1],
  reigns: [0, 0, 0, 0],
  promoMask: [1, 1, 1, 1],
  resolution: [0, 0, 0, 0],
};

function edge(a: number, b: number, same: number, opposed: number): number[] {
  const rec = new Array(STRIDE).fill(0);
  rec[EF.a] = a;
  rec[EF.b] = b;
  rec[EF.same] = same;
  rec[EF.opposed] = opposed;
  rec[EF.firstDay] = isoToDay("2000-06-01");
  rec[EF.lastDay] = isoToDay("2001-06-01");
  rec[EF.promoMask] = 1;
  rec[EF.formMask] = 0b111111;
  return rec;
}

const edges = Uint32Array.from([...edge(0, 1, 3, 5), ...edge(1, 2, 0, 2)]);
const model = new GraphModel(nodes, edges, manifest);
const baseFilters: Filters = {
  dayMin: model.fullDayRange[0],
  dayMax: model.fullDayRange[1],
  promoMask: 0xff,
  formMask: 0xff,
  showSame: true,
  showOpposed: true,
  showBr: true,
  minEncounters: 1,
};

describe("contract primitives", () => {
  it("fnv1a32 matches the reference implementation vector", () => {
    // independently computed: fnv1a32 of empty string is the offset basis
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });
  it("pairKey sorts lexicographically and buckets deterministically", () => {
    expect(pairKey("p:2", "p:1")).toBe("p:1|p:2");
    expect(bucketOf("p:1|p:2")).toBe(bucketOf(pairKey("p:1", "p:2")));
    expect(bucketOf("p:1|p:2")).toMatch(/^[0-9a-f]{2}$/);
  });
  it("day encoding round-trips (1900 epoch, matches the Python side)", () => {
    expect(isoToDay("1900-01-01")).toBe(0);
    expect(isoToDay("1950-01-01")).toBe(18262);
    expect(isoToDay("1963-01-25")).toBe(4772 + 18262);
    expect(isoToDay("1947-12-14")).toBeGreaterThan(0);
  });
});

describe("GraphModel filtering", () => {
  it("aggregate filter respects minEncounters", () => {
    const v = model.filterAggregate({ ...baseFilters, minEncounters: 3 });
    expect([...v.visible]).toEqual([0]);
  });
  it("relationship-class toggles drop classes before thresholding", () => {
    const v = model.filterAggregate({ ...baseFilters, showOpposed: false, showBr: false });
    expect([...v.visible]).toEqual([0]); // only the pair with same-side history survives
    expect(v.weights[0]!.opposed).toBe(0);
  });
  it("BFS finds fewest-hops path across the chain", () => {
    const v = model.filterAggregate(baseFilters);
    const p = model.shortestPath("p:1", "p:3", v, "fewest");
    expect(p?.nodes).toEqual(["p:1", "p:2", "p:3"]);
  });
  it("partner-only path refuses opposed-only links", () => {
    const v = model.filterAggregate(baseFilters);
    expect(model.shortestPath("p:1", "p:3", v, "partners")).toBeNull();
  });
});

const mkEvent = (over: Partial<TimelineEvent>): TimelineEvent => ({
  m: "m:1", c: "c:1", d: "2000-06-01", pr: "pr:1", en: "Test Show", loc: "Test",
  form: "singles", stip: "", res: "def. (pin)", fin: "pin",
  w: ["p:1"], l: ["p:2"], unk: false, t: null, tc: 0, dur: null,
  ...over,
});

describe("record-level derivation (CANONICAL-MODEL rules)", () => {
  it("multi-way loser groups NEVER yield partner or within-group observations", () => {
    const ev = mkEvent({ form: "multi_way", w: ["p:1"], l: ["p:2", "p:3"] });
    const v = model.filterFromRecords(baseFilters, [ev]);
    // p:2|p:3 (edge 1) must receive nothing from this three-way
    const idx = [...v.visible].indexOf(1);
    expect(idx).toBe(-1);
    const f = TimelineEngine.derive(ev);
    expect(f.pulses.filter((p) => p.kind === "same")).toHaveLength(0);
  });
  it("tag matches yield partners on both sides", () => {
    const ev = mkEvent({ form: "tag_team", w: ["p:1", "p:2"], l: ["p:3", "p:4"] });
    const f = TimelineEngine.derive(ev);
    const same = f.pulses.filter((p) => p.kind === "same");
    expect(same).toHaveLength(2);
  });
  it("battle royals produce br-class opposition and no partners", () => {
    const ev = mkEvent({ form: "battle_royal", w: ["p:1"], l: ["p:2", "p:3"] });
    const f = TimelineEngine.derive(ev);
    expect(f.pulses.every((p) => p.kind === "br")).toBe(true);
  });
  it("drawn multi-ways yield no partner observations at all", () => {
    const ev = mkEvent({ form: "multi_way", res: "draw (NC)", w: ["p:1", "p:2"], l: ["p:3"] });
    const f = TimelineEngine.derive(ev);
    expect(f.pulses.filter((p) => p.kind === "same")).toHaveLength(0);
  });

  it("explicit units (csv grammar): loser units oppose each other", () => {
    // triple threat 'p:1' def. 'p:2, p:3' — p:2 × p:3 is genuine opposition
    const ev = mkEvent({ form: "multi_way", w: ["p:1"], l: ["p:2", "p:3"], lu: [["p:2"], ["p:3"]] });
    const v = model.filterFromRecords(baseFilters, [ev]);
    expect([...v.visible]).toContain(1); // p:2|p:3 edge receives an opposed obs
    const f = TimelineEngine.derive(ev);
    const opposedPairs = f.pulses.filter((p) => p.kind === "opposed").map((p) => `${p.a}|${p.b}`);
    expect(opposedPairs).toContain("p:2|p:3");
  });

  it("explicit team units in multi-ways get partner obs; collapsed blobs never do", () => {
    const explicit = mkEvent({
      form: "multi_way",
      w: ["p:1", "p:2"],
      l: ["p:3", "p:4"],
      lu: [["p:3"], ["p:4"]],
    });
    const fExplicit = TimelineEngine.derive(explicit);
    // winner side is a decisive single unit -> partners; loser singleton units -> none
    expect(fExplicit.pulses.filter((p) => p.kind === "same")).toHaveLength(1);
    const collapsed = mkEvent({ form: "multi_way", w: ["p:1"], l: ["p:2", "p:3"] });
    const fCollapsed = TimelineEngine.derive(collapsed);
    expect(fCollapsed.pulses.filter((p) => p.kind === "same")).toHaveLength(0);
  });

  it("promotions without a named bit fall back to the manifest other-bit", () => {
    const m2 = { ...manifest, promo_other_bit: 30 } as typeof manifest;
    const model2 = new GraphModel(nodes, edges, m2);
    const ev = mkEvent({ pr: "pr:c400" }); // unknown promotion
    const withOther = model2.filterFromRecords({ ...baseFilters, promoMask: 0x7fffffff }, [ev]);
    expect([...withOther.visible]).toContain(0);
    const withoutOther = model2.filterFromRecords(
      { ...baseFilters, promoMask: 0x7fffffff & ~(1 << 30) },
      [ev],
    );
    expect([...withoutOther.visible]).not.toContain(0);
  });
});
