import { describe, expect, it } from "vitest";
import type { AttributeKey, EvidenceSummary } from "@kayfabe/sim-contract";
import { hashValue } from "../src/hash";
import { ATTRIBUTE_PRIORS, SEEDER_METHOD, seedWorker } from "../src/seeder";

function ev(overrides: Partial<EvidenceSummary> = {}): EvidenceSummary {
  return {
    personId: "p:test",
    matches: 0,
    firstYear: null,
    lastYear: null,
    careerYears: 0,
    distinctOpponents: 0,
    winShare: null,
    mainEventShare: null,
    titleMatchShare: 0,
    promoLevelMix: { national: 0, regional: 0, indie: 1 },
    formMix: { singles: 1, tag: 0, multi: 0 },
    meltzer: null,
    recentDensity: 0,
    topPromotions: [],
    ...overrides,
  };
}

const rookie = ev({
  personId: "p:rookie",
  matches: 3,
  firstYear: 1996,
  lastYear: 1996,
  careerYears: 1,
  distinctOpponents: 3,
  recentDensity: 3,
});

const star = ev({
  personId: "p:star",
  matches: 800,
  firstYear: 1985,
  lastYear: 1996,
  careerYears: 12,
  distinctOpponents: 260,
  winShare: 0.62,
  mainEventShare: 0.5,
  titleMatchShare: 0.2,
  promoLevelMix: { national: 0.9, regional: 0.1, indie: 0 },
  formMix: { singles: 0.7, tag: 0.2, multi: 0.1 },
  meltzer: { count: 40, mean: 4.5, best: 5.5 },
  recentDensity: 90,
});

function attrKeys(result: ReturnType<typeof seedWorker>): AttributeKey[] {
  return Object.keys(result.attributes).sort() as AttributeKey[];
}

describe("evidence-seeder@1", () => {
  it("sparse rookie regresses to priors with speculative confidence", () => {
    const res = seedWorker(rookie);
    for (const key of attrKeys(res)) {
      const seeded = res.attributes[key];
      expect(Math.abs(seeded.value - ATTRIBUTE_PRIORS[key]), key).toBeLessThanOrEqual(5);
      expect(seeded.confidence, key).toBe("speculative");
      expect(seeded.method, key).toBe(SEEDER_METHOD);
    }
    expect(res.attributes.fundamentals.inputs).toContain("matches:3");
  });

  it("national main-eventer seeds high star presence, awareness, and in-ring confidence", () => {
    const res = seedWorker(star);
    expect(res.attributes.starPresence.value).toBeGreaterThan(70);
    expect(res.awarenessNational).toBeGreaterThan(70);
    expect(res.attributes.fundamentals.confidence).toBe("high");
    expect(res.attributes.psychology.confidence).toBe("high");
    expect(res.attributes.technical.confidence).toBe("high");
    expect(res.styles).toContain("technician");
  });

  it("title-heavy midcarder gains credibility and prestige but not skill", () => {
    const mid = ev({
      personId: "p:mid",
      matches: 400,
      firstYear: 1989,
      lastYear: 1996,
      careerYears: 8,
      distinctOpponents: 120,
      winShare: 0.55,
      mainEventShare: 0.12,
      titleMatchShare: 0.05,
      promoLevelMix: { national: 0.4, regional: 0.5, indie: 0.1 },
      formMix: { singles: 0.8, tag: 0.15, multi: 0.05 },
      meltzer: { count: 12, mean: 3, best: 4 },
      recentDensity: 60,
    });
    const titled = ev({ ...mid, titleMatchShare: 0.4 });
    const a = seedWorker(mid);
    const b = seedWorker(titled);
    expect(b.credibility).toBeGreaterThan(a.credibility);
    expect(b.prestige).toBeGreaterThan(a.prestige);
    expect(b.attributes.technical.value).toBe(a.attributes.technical.value);
    // Title share is positioning evidence only: no attribute moves at all.
    expect(b.attributes).toEqual(a.attributes);
  });

  it("is deterministic: same evidence twice gives an identical result", () => {
    const a = seedWorker(star);
    const b = seedWorker(star);
    expect(b).toEqual(a);
    expect(hashValue(b)).toBe(hashValue(a));
  });

  it("identical stats under different personIds differ slightly but within ±4", () => {
    const a = seedWorker(ev({ ...star, personId: "p:aaa" }));
    const b = seedWorker(ev({ ...star, personId: "p:bbb" }));
    let totalDiff = 0;
    for (const key of attrKeys(a)) {
      const diff = Math.abs(a.attributes[key].value - b.attributes[key].value);
      expect(diff, key).toBeLessThanOrEqual(4);
      totalDiff += diff;
    }
    for (const scalar of [
      "awarenessNational",
      "affinityNational",
      "credibility",
      "prestige",
    ] as const) {
      const diff = Math.abs(a[scalar] - b[scalar]);
      expect(diff, scalar).toBeLessThanOrEqual(4);
      totalDiff += diff;
    }
    expect(totalDiff).toBeGreaterThan(0);
  });

  it("stays within bounds for empty, sparse, rich, and extreme careers", () => {
    const extreme = ev({
      personId: "p:extreme",
      matches: 5000,
      firstYear: 1956,
      lastYear: 1996,
      careerYears: 40,
      distinctOpponents: 2000,
      winShare: 1,
      mainEventShare: 1,
      titleMatchShare: 1,
      promoLevelMix: { national: 1, regional: 0, indie: 0 },
      formMix: { singles: 0, tag: 1, multi: 0 },
      meltzer: { count: 500, mean: 7, best: 7 },
      recentDensity: 300,
    });
    for (const evidence of [ev(), rookie, star, extreme]) {
      const res = seedWorker(evidence);
      for (const key of attrKeys(res)) {
        expect(res.attributes[key].value, key).toBeGreaterThanOrEqual(1);
        expect(res.attributes[key].value, key).toBeLessThanOrEqual(99);
      }
      expect(res.awarenessNational).toBeGreaterThanOrEqual(5);
      expect(res.awarenessNational).toBeLessThanOrEqual(95);
      expect(res.affinityNational).toBeGreaterThanOrEqual(0);
      expect(res.affinityNational).toBeLessThanOrEqual(60);
      expect(res.credibility).toBeGreaterThanOrEqual(1);
      expect(res.credibility).toBeLessThanOrEqual(99);
      expect(res.prestige).toBeGreaterThanOrEqual(1);
      expect(res.prestige).toBeLessThanOrEqual(99);
      expect(res.alignment).toBe("neutral");
      expect(res.styles.length).toBeGreaterThan(0);
    }
  });

  it("null meltzer means no in-ring quality lift and no meltzer inputs", () => {
    const noMelt = seedWorker(ev({ ...star, meltzer: null }));
    const withMelt = seedWorker(star);
    expect(noMelt.attributes.technical.value).toBeLessThan(withMelt.attributes.technical.value);
    expect(noMelt.attributes.fundamentals.confidence).toBe("medium");
    for (const key of attrKeys(noMelt)) {
      for (const input of noMelt.attributes[key].inputs) {
        expect(input, key).not.toMatch(/meltzer/i);
      }
    }
  });
});
