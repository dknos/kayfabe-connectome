import { describe, expect, it } from "vitest";
import { createUniverse } from "../src/init";
import { advanceDays } from "../src/engine";
import { stateHash } from "../src/persistence";
import { makeOptions, makeSnapshot } from "./fixtures";

/**
 * Headless one-year benchmark (PERFORMANCE.md records the measured numbers).
 * The fixture world is 3 companies / 34 workers — small, but it exercises
 * the full daily pipeline including two AI companies running weekly TV and
 * monthly PPVs. The assertion is a generous ceiling so CI failures mean a
 * real regression, not machine noise.
 */
describe("benchmark", () => {
  it("simulates one full year headless", () => {
    const state = createUniverse(makeSnapshot(), makeOptions({ worldSeed: "bench" }));
    const t0 = performance.now();
    const end = advanceDays(state, 365);
    const elapsed = performance.now() - t0;
    const shows = Object.values(end.shows).filter((s) => s.status === "completed").length;
    // eslint-disable-next-line no-console
    console.log(
      `[benchmark] 365 days in ${elapsed.toFixed(0)}ms (${(elapsed / 365).toFixed(1)}ms/day), ` +
        `${shows} completed shows, ${end.ledger.length} transactions, hash ${stateHash(end).slice(0, 12)}`,
    );
    expect(end.currentDate).toBe("1998-01-06");
    // One AI national company: 52 weekly TV + 12 monthly PPVs.
    expect(shows).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(60_000);
  });
});
