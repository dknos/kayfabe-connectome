import { describe, expect, it } from "vitest";
import { RatingPeaks, RatingTransition, type RatingLayout } from "@kayfabe/ratings-renderer";

function layout(position: readonly [number, number, number], height: number): RatingLayout {
  return {
    generation: 1, mode: "promotions", scopeId: null, matchIds: ["m:test"],
    positions: Float32Array.from(position), heights: Float32Array.of(height), scales: Float32Array.of(2), opacity: Float32Array.of(0.9), rating: Float32Array.of(height / 42), required: new Uint8Array(1),
    aggregates: [], coverage: [], lanes: [], labels: [],
    bounds: { minX: -10, maxX: 10, minY: -50, maxY: 50, minZ: -10, maxZ: 10 }, dayRange: [0, 1], ratingRange: [-1, 5], ratingScale: 42,
    visibleExactMatches: 1, visibleAggregateBins: 0, omittedPromotions: 0, wantedLabels: 0, notes: [],
  };
}

describe("ratings renderer transitions", () => {
  it("eases and lands deterministically, with a reduced-motion escape hatch", () => {
    const transition = new RatingTransition();
    transition.retarget(100, 100);
    expect(transition.progress).toBe(0);
    expect(transition.tick(150)).toBeCloseTo(0.5);
    expect(transition.morphing).toBe(true);
    expect(transition.tick(200)).toBe(1);
    expect(transition.morphing).toBe(false);
    transition.reducedMotion = true;
    transition.retarget(210, 100);
    expect(transition.progress).toBe(1);
  });

  it("retargets from the current interpolated peak state without a position or signed-height snap", () => {
    const peaks = new RatingPeaks(1);
    try {
      peaks.retarget(layout([4, 0, 8], 42), 1, true);
      peaks.retarget(layout([104, 0, -12], -42), 0.35);
      const midFlight = peaks.currentTip(0, 0.35)!;
      peaks.retarget(layout([-40, 0, 22], 84), 0.35);
      const retargeted = peaks.currentTip(0, 0)!;
      retargeted.forEach((value, axis) => expect(value).toBeCloseTo(midFlight[axis]!, 5));
      expect(midFlight[1]).toBeGreaterThan(-42);
      expect(midFlight[1]).toBeLessThan(42);
    } finally {
      peaks.dispose();
    }
  });
});
