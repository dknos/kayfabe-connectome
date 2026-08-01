import { describe, expect, it } from "vitest";
import type { GeoPlace } from "@kayfabe/geo-renderer";
import { heatColor, mix } from "@kayfabe/geo-renderer";
import type { GeoData } from "../geo/geoAdapter";
import { clampToRange, readCard } from "../geo/geoAdapter";
import { GeoScheduler } from "../geo/GeoScheduler";
import { comparePlaces, computeFootprint, greatCircleKm } from "../geo/geoAnalytics";
import { resolveMembers } from "../graph/members";
import { EF } from "../graph/model";

/**
 * A hand-built projection. Small enough to reason about by hand, which is the
 * only way to assert that "every in-scope card is accounted for" means what it
 * says.
 */

const STRIDE = 8;

function place(index: number, id: string, lat: number, lon: number, country: string): GeoPlace {
  return {
    index, id, displayName: `${id}, ${country}`, city: id, admin1: null, country,
    countryCode: country.slice(0, 2).toUpperCase(), latitude: lat, longitude: lon,
    precision: "city", resolution: "confirmed", confidence: 0.95, source: "geonames",
    cards: 0, matches: 0, titleMatches: 0, titleChanges: 0, firstDay: 0, lastDay: 0,
  };
}

interface CardSpec {
  day: number; promo?: number; place: number; matches: number; people?: number;
  titleMatches?: number; titleChanges?: number; flags?: number;
}

function build(cards: CardSpec[], places: GeoPlace[]): GeoData {
  const buf = new Uint32Array(cards.length * STRIDE);
  cards.forEach((c, i) => {
    const b = i * STRIDE;
    buf[b] = c.day;
    buf[b + 1] = c.promo ?? 0;
    buf[b + 2] = c.place + 1; // 0 = unplotted
    buf[b + 3] = 0;
    buf[b + 4] = c.matches;
    buf[b + 5] = c.people ?? 2;
    buf[b + 6] = (c.titleMatches ?? 0) | ((c.titleChanges ?? 0) << 16);
    buf[b + 7] = c.flags ?? 0;
  });
  return {
    manifest: {
      cards_bin: { count: cards.length, stride_u32: STRIDE, fields: [] },
      day_range: [cards[0]?.day ?? 0, cards[cards.length - 1]?.day ?? 0],
    } as never,
    places,
    placeIndexOf: new Map(places.map((p, i) => [p.id, i])),
    strings: {
      cardIds: cards.map((_c, i) => `c:${i}`),
      promotionIds: ["pr:1", "pr:2"],
      promotionNames: ["WWF", "NJPW"],
      eventNames: ["Show"],
    },
    cards: buf,
    cardCount: cards.length,
    stride: STRIDE,
    quality: {} as never,
    yearIndex: {},
  };
}

const PLACES = [
  place(0, "NewYork", 40.71, -74.01, "United States"),
  place(1, "Tokyo", 35.68, 139.75, "Japan"),
  place(2, "London", 51.5, -0.12, "United Kingdom"),
];

// 6 cards: two share day 100 (a same-day batch), one is unplotted.
const CARDS: CardSpec[] = [
  { day: 100, place: 0, matches: 8, titleMatches: 1, titleChanges: 1 },
  { day: 100, place: 1, matches: 5 },
  { day: 200, place: 0, matches: 10 },
  { day: 300, place: 2, matches: 4, titleMatches: 2 },
  { day: 400, place: -1, matches: 6 }, // location unresolved
  { day: 500, place: 1, matches: 3, titleChanges: 1 },
];

const data = build(CARDS, PLACES);
const ALL = CARDS.map((_c, i) => i);

describe("card decoding", () => {
  it("round-trips every field, including packed title counts", () => {
    const c = readCard(data, 0);
    expect(c).toMatchObject({
      cardId: "c:0", day: 100, placeIdx: 0, matchCount: 8,
      titleMatchCount: 1, titleChangeCount: 1,
    });
  });

  it("decodes an unresolved location as -1, never as place 0", () => {
    expect(readCard(data, 4).placeIdx).toBe(-1);
  });

  it("clamps a scope to a day range", () => {
    expect(clampToRange(data, ALL, 200, 400)).toEqual([2, 3, 4]);
  });
});

describe("scheduler accounting", () => {
  it("accounts for every in-scope card exactly once", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    let emitted = 0;
    while (!s.done) emitted += s.stepCard()!.intents.length;
    expect(emitted).toBe(CARDS.length);
    expect(s.counters.cardsProcessed).toBe(CARDS.length);
    expect(s.counters.matchesRepresented).toBe(36);
    expect(s.counters.intentsDropped).toBe(0);
  });

  it("counts an unresolved card everywhere except geographically", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    while (!s.done) s.stepCard();
    expect(s.counters.unresolvedCards).toBe(1);
    expect(s.counters.resolvedCards).toBe(5);
    expect(s.counters.cardsProcessed).toBe(6);
    // three distinct places, not four — the unresolved card adds none
    expect(s.counters.uniquePlaces).toBe(3);
  });

  it("groups same-day cards into one batch", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    const batch = s.stepBatch()!;
    expect(batch.day).toBe(100);
    expect(batch.intents).toHaveLength(2);
    // same-day cards share a batch id, which is what stops arcs joining them
    expect(new Set(batch.intents.map((i) => i.batchId)).size).toBe(1);
  });

  it("gives cards on different dates different batch ids", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    const a = s.stepBatch()!;
    const b = s.stepBatch()!;
    expect(a.intents[0]!.batchId).not.toBe(b.intents[0]!.batchId);
  });

  it("record time consumes a stable number of cards per second", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    s.setClock("record", 2);
    expect(s.advance(1)!.intents).toHaveLength(2);
    expect(s.advance(0.5)!.intents).toHaveLength(1);
  });

  it("calendar time consumes everything the clock passed, losing nothing at speed", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    s.setClock("calendar", 1000); // one tick jumps the whole range
    const batch = s.advance(1)!;
    expect(batch.intents).toHaveLength(CARDS.length);
    expect(s.counters.cardsProcessed).toBe(CARDS.length);
  });

  it("never emits fractional cards in record time", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    s.setClock("record", 1);
    expect(s.advance(0.4)).toBeNull();
    expect(s.advance(0.4)).toBeNull();
    expect(s.advance(0.4)!.intents).toHaveLength(1); // carry accumulated to 1.2
  });

  it("seek recomputes counters from scratch rather than leaving a stale total", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    while (!s.done) s.stepCard();
    const full = { ...s.counters };
    s.seek(2);
    expect(s.counters.cardsProcessed).toBe(2);
    expect(s.counters.matchesRepresented).toBe(13);
    s.seek(CARDS.length);
    expect(s.counters).toEqual(full);
  });

  it("jumps to the next new place", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    s.stepCard(); // NewYork
    const b = s.nextNewPlace()!;
    expect(b.intents[b.intents.length - 1]!.placeIdx).toBe(1); // Tokyo
  });

  it("jumps to the next documented title change", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    s.stepCard(); // card 0 already carries one
    const b = s.nextTitleChange()!;
    const last = b.intents[b.intents.length - 1]!;
    expect(last.titleChangeCount).toBe(1);
    expect(last.cardId).toBe("c:5");
  });

  it("reports scope totals independent of playback position", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    const before = s.scopeTotals();
    s.stepCard();
    expect(s.scopeTotals()).toEqual(before);
    expect(before.cardsProcessed).toBe(CARDS.length);
    expect(before.titleChanges).toBe(2);
  });

  it("exposes only plotted places for the heat layer", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    expect(s.scopePlaces()).toEqual([0, 1, 2]);
  });

  it("daily batches consume whole dates, one date per tick", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    s.setClock("record", 1);
    s.setDailyBatches(true);
    // day 100 holds two cards; one tick takes the whole date, not one card
    const first = s.advance(1)!;
    expect(first.intents).toHaveLength(2);
    expect(new Set(first.intents.map((i) => i.day))).toEqual(new Set([100]));
    expect(s.advance(1)!.intents).toHaveLength(1); // day 200
  });

  it("match beats never add a card or a place to any counter", () => {
    // A beat is inspector-only: the scheduler is not advanced by one, so the
    // counters a ten-match show produces are identical either way.
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    s.stepCard();
    const before = { ...s.counters };
    // stepping matches inside the card touches nothing here
    expect(s.counters).toEqual(before);
    expect(s.counters.cardsProcessed).toBe(1);
  });

  it("resets cleanly between scopes", () => {
    const s = new GeoScheduler(data);
    s.setScope(ALL);
    while (!s.done) s.stepCard();
    s.setScope([0, 1]);
    expect(s.counters.cardsProcessed).toBe(0);
    expect(s.position).toBe(0);
  });
});

describe("geographic analytics", () => {
  it("computes a great-circle distance", () => {
    // New York to London is ~5,570 km
    const d = greatCircleKm(40.71, -74.01, 51.5, -0.12);
    expect(d).toBeGreaterThan(5500);
    expect(d).toBeLessThan(5620);
  });

  it("uses a spherical centroid, not a mean of degrees", () => {
    // Tokyo (+139.75) and Los Angeles (-118) average to -0 in naive degrees,
    // putting the "centre" in the Atlantic. The spherical mean is in the Pacific.
    const p = [place(0, "Tokyo", 35.68, 139.75, "Japan"),
               place(1, "LA", 34.05, -118.24, "United States")];
    const d2 = build([{ day: 1, place: 0, matches: 1 }, { day: 2, place: 1, matches: 1 }], p);
    const fp = computeFootprint(d2, [0, 1]);
    expect(fp.centroid).not.toBeNull();
    expect(Math.abs(fp.centroid!.longitude)).toBeGreaterThan(150);
  });

  it("skips same-day pairs when totalling record-sequence distance", () => {
    // Cards 0 and 1 share day 100 across New York and Tokyo. Counting that hop
    // would invent an ordering the source does not record.
    const fp = computeFootprint(data, [0, 1]);
    expect(fp.recordSequenceKm).toBe(0);
    // Different days DO contribute.
    const fp2 = computeFootprint(data, [0, 5]);
    expect(fp2.recordSequenceKm).toBeGreaterThan(9000);
  });

  it("counts only plotted places but every card", () => {
    const fp = computeFootprint(data, ALL);
    expect(fp.cards).toBe(6);
    expect(fp.places).toBe(3);
    expect(fp.countries).toBe(3);
  });

  it("compares two scopes on canonical places", () => {
    const c = comparePlaces(data, [0, 2], [1, 3]);
    expect(c.aOnly.map((p) => p.id)).toEqual(["NewYork"]);
    expect(c.bOnly.map((p) => p.id).sort()).toEqual(["London", "Tokyo"]);
    expect(c.shared).toHaveLength(0);
    expect(c.overlapFraction).toBe(0);
  });

  it("reports overlap as intersection over union", () => {
    const c = comparePlaces(data, [0, 1], [1, 5]);
    expect(c.shared.map((p) => p.id)).toEqual(["Tokyo"]);
    // A={NewYork,Tokyo} B={Tokyo} -> 1/2
    expect(c.overlapFraction).toBeCloseTo(0.5);
  });
});

describe("visual encodings", () => {
  it("mixes colours linearly and clamps out-of-range weights", () => {
    const a = [0, 0, 0] as const;
    const b = [1, 1, 1] as const;
    expect(mix(a, b, 0.5)).toEqual([0.5, 0.5, 0.5]);
    expect(mix(a, b, -3)).toEqual([0, 0, 0]);
    expect(mix(a, b, 9)).toEqual([1, 1, 1]);
  });

  it("uses a square-rooted heat ramp so the long tail stays visible", () => {
    const low = heatColor(0.01);
    const mid = heatColor(0.25);
    // sqrt(0.25) = 0.5, so a quarter-weight place sits at the ramp's midpoint —
    // a linear ramp would leave it almost indistinguishable from zero.
    expect(mid[0]).toBeGreaterThan(low[0]);
    expect(heatColor(0.25)[0]).toBeCloseTo(mix(heatColor(0), heatColor(1), 0.5)[0], 5);
  });
});

/* ------------------------------------------------------------------ members */

describe("who lights up", () => {
  // The encounter graph's edges are person-person only, so promotion and
  // championship nodes have none. Each node type has to answer from a
  // different signal, and each answer has to say what it is.
  const nodes = {
    count: 6,
    id: ["p:1", "p:2", "p:3", "pr:big", "pr:small", "t:9"],
    type: [0, 0, 0, 1, 1, 2],
    name: ["Flair", "Steamboat", "Muta", "BIG", "SMALL", "Belt"],
    promoMask: [0b0011, 0b0001, 0b0000, 0, 0, 0],
    community: [0, 0, 0, -1, -1, -1],
  } as never;
  const model = {
    nodes,
    indexOfId: new Map(["p:1", "p:2", "p:3", "pr:big", "pr:small", "t:9"].map((id, i) => [id, i])),
    // Flair wrestled Steamboat and Muta.
    neighbors: (n: number) => (n === 0 ? [{ node: 1, edge: 0 }, { node: 2, edge: 1 }] : []),
    edgeField: () => 0,
  } as never;
  const manifest = { promo_bits: { big: 0 } } as never;
  const search = [
    { id: "p:1", t: "person", n: "Flair", m: 9, pm: ["BIG", "SMALL"] },
    { id: "p:3", t: "person", n: "Muta", m: 4, pm: ["SMALL"] },
  ] as never;
  const champs = {
    "t:9": { n: "Belt", pr: "pr:big", artifact: false, titleMatches: 3, changes: 2,
             reigns: [{ holders: ["p:2"], s: "1", e: null, m: "m:1" },
                      { holders: ["p:3"], s: "2", e: null, m: "m:2" }] },
  } as never;

  it("splits a wrestler's connections by what KIND of connection it is", () => {
    // p:1 opposed p:2 and teamed with p:3. Opponent and tag partner are
    // different documented relationships, not one blurred set.
    const m = {
      nodes,
      indexOfId: new Map(["p:1", "p:2", "p:3", "pr:big", "pr:small", "t:9"].map((id, i) => [id, i])),
      neighbors: (n: number) => (n === 0 ? [{ node: 1, edge: 0 }, { node: 2, edge: 1 }] : []),
      edgeField: (e: number, f: number) =>
        f === EF.opposed ? (e === 0 ? 4 : 0) : f === EF.same ? (e === 1 ? 2 : 0) : 0,
    } as never;
    const r = resolveMembers(m, manifest, search, "p:1", null);
    const g = (k: string) => r.groups!.find((x) => x.key === k)!;
    expect(g("opposed").ids).toEqual(["p:2"]);
    expect(g("same").ids).toEqual(["p:3"]);
    expect(g("br").ids).toEqual([]);
    expect(g("all").ids.sort()).toEqual(["p:2", "p:3"]);
    // every group carries the fiber tone of the relationship it selects
    expect(g("opposed").tone).toBe("opposed");
    expect(g("same").tone).toBe("same");
  });

  it("lights everyone a wrestler shares a documented match with", () => {
    const r = resolveMembers(model, manifest, search, "p:1", null);
    expect(r.ids.sort()).toEqual(["p:2", "p:3"]);
    expect(r.basis).toContain("share a documented match");
  });

  it("lights a promotion's roster from the bitmask when it has a bit", () => {
    const r = resolveMembers(model, manifest, search, "pr:big", null);
    expect(r.ids.sort()).toEqual(["p:1", "p:2"]);
    expect(r.caveat).toBeUndefined();
  });

  it("falls back to promotion NAMES when the promotion has no bit, and says so", () => {
    // SMALL shares the "other" bit with 134 promotions, so the mask cannot
    // identify it — the search index's top-six names are the only signal.
    const r = resolveMembers(model, manifest, search, "pr:small", null);
    expect(r.ids.sort()).toEqual(["p:1", "p:3"]);
    expect(r.caveat).toMatch(/top six/);
  });

  it("lights a championship's documented holders, and says holders only", () => {
    const r = resolveMembers(model, manifest, search, "t:9", champs);
    expect(r.ids.sort()).toEqual(["p:2", "p:3"]);
    expect(r.caveat).toMatch(/challenged for this title without winning/);
  });

  it("reports honestly while the reign records are still loading", () => {
    const r = resolveMembers(model, manifest, search, "t:9", null);
    expect(r.ids).toEqual([]);
    expect(r.basis).toContain("loading");
  });

  it("never invents a member that is not a node in the graph", () => {
    const stray = {
      "t:9": { n: "Belt", pr: "pr:big", artifact: false, titleMatches: 1, changes: 1,
               reigns: [{ holders: ["p:404"], s: "1", e: null, m: "m:1" }] },
    } as never;
    expect(resolveMembers(model, manifest, search, "t:9", stray).ids).toEqual([]);
  });

  it("returns an empty set for no selection", () => {
    expect(resolveMembers(model, manifest, search, null, null).ids).toEqual([]);
  });
});
