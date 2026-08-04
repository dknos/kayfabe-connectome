// SYNTHETIC test fixtures — never production data.
//
// Everything here exercises the pure layer of @kayfabe/spacetime-renderer in
// plain node: the lens math twins, the LUT codec, path building and layout.
// The GLSL copies of lnCosh/focusIntegral/timeAxisX live in WorldlineField's
// vertex shader and must stay numerically identical to what these tests pin.
import { describe, expect, it } from "vitest";
import {
  DAYS_PER_YEAR, GAP_DISSOLVE_DAYS, LUT_LOG_DELTA_MAX, LUT_LOG_MAG_MAX,
  LUT_V_MAX, SAMPLE_STRIDE, SC, SPACETIME_TIERS, TIME_AXIS_DEFAULTS,
  WarpLookup, buildLayout, buildPath, classOf, easeQuintic, focusF,
  focusIntegral, halfToFloat, lnCosh, lutDecode, lutRowOfSpeed, timeAxisDay,
  timeAxisX, warpPosition, warpSpeedOfPlayback,
  type SpacetimeEvent, type SpacetimeScope, type TimeAxis,
} from "@kayfabe/spacetime-renderer";

const AXIS: TimeAxis = {
  day0: 30000,
  playheadDay: 33000,
  ...TIME_AXIS_DEFAULTS,
};

describe("focus field (the paper's shape function over history)", () => {
  it("is 1 at the playhead, even, and vanishes in deep history", () => {
    expect(focusF(0, 1.5, 1.1)).toBeCloseTo(1, 5);
    expect(focusF(2.3, 1.5, 1.1)).toBeCloseTo(focusF(-2.3, 1.5, 1.1), 10);
    expect(focusF(40, 1.5, 1.1)).toBeLessThan(1e-6);
  });

  it("lnCosh survives arguments that overflow cosh", () => {
    expect(lnCosh(0)).toBeCloseTo(0, 10);
    expect(lnCosh(2)).toBeCloseTo(Math.log(Math.cosh(2)), 10);
    // cosh(800) overflows double; ln cosh(800) ≈ 800 - ln 2.
    expect(lnCosh(800)).toBeCloseTo(800 - Math.LN2, 8);
  });

  it("focusIntegral is the exact antiderivative of focusF", () => {
    // Trapezoid the shape function and compare against the closed form.
    const R = 0.75, sigma = 1.4;
    const a = -2.0, b = 1.3;
    const n = 20000;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const s0 = a + ((b - a) * i) / n;
      const s1 = a + ((b - a) * (i + 1)) / n;
      acc += ((focusF(s0, R, sigma) + focusF(s1, R, sigma)) / 2) * (s1 - s0);
    }
    expect(focusIntegral(b, R, sigma) - focusIntegral(a, R, sigma)).toBeCloseTo(acc, 6);
  });
});

describe("time axis lens", () => {
  it("is strictly monotone through the bubble", () => {
    let prev = -Infinity;
    for (let day = AXIS.day0; day < AXIS.day0 + 8000; day += 7) {
      const x = timeAxisX(day, AXIS);
      expect(x).toBeGreaterThan(prev);
      expect(Number.isFinite(x)).toBe(true);
      prev = x;
    }
  });

  it("expands a playhead year by (1 + gain) against deep history", () => {
    const inside = timeAxisX(AXIS.playheadDay + 30, AXIS) - timeAxisX(AXIS.playheadDay - 30, AXIS);
    const outside = timeAxisX(AXIS.day0 + 30, AXIS) - timeAxisX(AXIS.day0 - 30, AXIS);
    expect(inside / outside).toBeGreaterThan(1 + AXIS.gain * 0.8);
    expect(inside / outside).toBeLessThan(1 + AXIS.gain * 1.05);
  });

  it("timeAxisDay inverts timeAxisX to under a day", () => {
    for (const day of [AXIS.day0 + 11, AXIS.playheadDay - 100, AXIS.playheadDay + 400, AXIS.day0 + 7900]) {
      const x = timeAxisX(day, AXIS);
      expect(Math.abs(timeAxisDay(x, AXIS, AXIS.day0 - 400, AXIS.day0 + 9000) - day)).toBeLessThan(1);
    }
  });
});

describe("LUT codec", () => {
  it("decodes the neutral texel to the identity optics", () => {
    const mid = lutDecode(0.5, 0.5, 0.5, 1);
    expect(mid.thetaApp).toBeCloseTo(Math.PI / 2, 10);
    expect(mid.delta).toBeCloseTo(1, 10);
    expect(mid.mag).toBeCloseTo(1, 10);
    expect(mid.vis).toBe(1);
  });

  it("row coordinate follows v = (vmax+1)^t - 1", () => {
    expect(lutRowOfSpeed(0)).toBe(0);
    expect(lutRowOfSpeed(LUT_V_MAX)).toBeCloseTo(1, 10);
    expect(lutRowOfSpeed(Math.sqrt(LUT_V_MAX + 1) - 1)).toBeCloseTo(0.5, 10);
    expect(lutRowOfSpeed(99)).toBeCloseTo(1, 10); // clamped, never past the table
  });

  it("halfToFloat decodes the reference encodings", () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x0000)).toBe(0);
    expect(halfToFloat(0x3555)).toBeCloseTo(1 / 3, 3);
  });
});

/** float -> IEEE half, enough for building fixtures. */
function floatToHalf(v: number): number {
  if (v === 0) return 0;
  const sign = v < 0 ? 0x8000 : 0;
  const a = Math.abs(v);
  const exp = Math.floor(Math.log2(a));
  const frac = Math.round((a / Math.pow(2, exp) - 1) * 1024);
  return sign | ((exp + 15) << 10) | frac;
}

function syntheticLut(width: number, height: number, texel: (s: number, t: number) => [number, number, number, number]): { f16: ArrayBuffer; rgba8: ArrayBuffer } {
  const f16 = new Uint16Array(width * height * 4);
  const rgba8 = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const [r, g, b, a] = texel(col / (width - 1), row / (height - 1));
      const o = (row * width + col) * 4;
      [r, g, b, a].forEach((x, c) => {
        f16[o + c] = floatToHalf(x);
        rgba8[o + c] = Math.round(x * 255);
      });
    }
  }
  return { f16: f16.buffer, rgba8: rgba8.buffer };
}

describe("WarpLookup sampling and warpPosition", () => {
  // Identity table: theta_app == theta_src, no shift, everything visible.
  const identity = syntheticLut(16, 4, (s) => [s, 0.5, 0.5, 1]);
  const lut = new WarpLookup(identity.f16, identity.rgba8, 16, 4);

  it("bilinear-samples the identity table as the identity", () => {
    for (const theta of [0.2, 1.1, 2.4]) {
      const s = lut.sample(theta, 3);
      expect(s.thetaApp).toBeCloseTo(theta, 2);
      expect(s.delta).toBeCloseTo(1, 2);
      expect(s.vis).toBeCloseTo(1, 5);
    }
  });

  it("warpPosition is exact identity at v=0 or mix=0", () => {
    const out = { x: 0, y: 0, z: 0, delta: 1, mag: 1, vis: 1 };
    warpPosition(lut, 5, 3, -2, 0, 0, 0, 0, 1, 4, out);
    expect([out.x, out.y, out.z]).toEqual([5, 3, -2]);
    warpPosition(lut, 5, 3, -2, 0, 0, 0, 4, 0, 4, out);
    expect([out.x, out.y, out.z]).toEqual([5, 3, -2]);
  });

  it("swings the polar angle toward the table's answer, preserving distance", () => {
    // A table that pulls everything to the forward axis.
    const fwd = syntheticLut(16, 4, (s) => [s * 0.5, 0.5, 0.5, 1]);
    const lutF = new WarpLookup(fwd.f16, fwd.rgba8, 16, 4);
    const out = { x: 0, y: 0, z: 0, delta: 1, mag: 1, vis: 1 };
    // Source directly abeam (theta = pi/2) far outside the near-field ramp.
    warpPosition(lutF, 0, 100, 0, 0, 0, 0, 2, 1, 4, out);
    const dist = Math.hypot(out.x, out.y, out.z);
    expect(dist).toBeCloseTo(100, 4);
    const theta = Math.acos(out.x / dist);
    expect(theta).toBeCloseTo(Math.PI / 4, 1); // pulled halfway forward
  });
});

/* ------------------------------------------------------------- fixtures */

function ev(day: number, over: Partial<SpacetimeEvent> = {}): SpacetimeEvent {
  return {
    day,
    promoIdx: 0,
    form: 0,
    result: 1,
    titleMatch: false,
    titleChange: false,
    apx: false,
    ppv: false,
    persona: 0,
    unk: false,
    same: new Int32Array(0),
    opposed: new Int32Array([7]),
    context: new Int32Array(0),
    matchRef: `m:s${day}`,
    eventName: "SYNTH",
    rating100p1: 0,
    ...over,
  };
}

function syntheticScope(): SpacetimeScope {
  const events = [
    ev(40000), ev(40030), ev(40090, { titleMatch: true, titleChange: true }),
    // a documented gap far longer than the dissolve threshold
    ev(40090 + GAP_DISSOLVE_DAYS + 900), ev(40090 + GAP_DISSOLVE_DAYS + 960),
  ];
  return {
    subjectId: "p:1",
    subjectLabel: "Synth Subject",
    nodeIdx: 1,
    personas: [
      { id: "p:1", label: "Synth Subject", nodeIdx: 1, firstDay: 40000, lastDay: 42000 },
      { id: "p:2", label: "Old Ring Name", nodeIdx: 2, firstDay: 40000, lastDay: 40100 },
    ],
    events,
    relationships: [
      { p: "p:7", n: "Opponent A", nodeIdx: 7, same: 0, opposed: 12, br: 0, firstDay: 40000, lastDay: 41200, buckets: [[2005, 12]] },
      { p: "p:8", n: "Partner B", nodeIdx: 8, same: 9, opposed: 0, br: 0, firstDay: 40010, lastDay: 41000, buckets: [[2005, 9]] },
      { p: "p:9", n: "Mixed C", nodeIdx: 9, same: 3, opposed: 4, br: 0, firstDay: 40020, lastDay: 41100, buckets: [[2005, 7]] },
      { p: "p:10", n: "Royal D", nodeIdx: 10, same: 0, opposed: 0, br: 2, firstDay: 40030, lastDay: 40400, buckets: [[2005, 2]] },
    ],
    promos: [{ pr: "pr:1", n: "SYNTH PROMO", count: 5, firstDay: 40000, lastDay: 42000, promoIdx: 0 }],
    titles: [],
    dayRange: [40000, 40090 + GAP_DISSOLVE_DAYS + 960],
  };
}

describe("worldline paths", () => {
  it("dissolves across undocumented gaps instead of implying activity", () => {
    const path = buildPath(0, SC.OPPOSED, [40000, 40060, 40060 + GAP_DISSOLVE_DAYS + 500], 3, -2);
    const s = path.samples;
    expect(s.length % SAMPLE_STRIDE).toBe(0);
    let sawDissolve = false;
    for (let o = 0; o < s.length; o += SAMPLE_STRIDE) {
      expect(Number.isFinite(s[o]!)).toBe(true);
      if (s[o + 4]! === 1) {
        sawDissolve = true;
        expect(s[o + 3]!).toBe(0); // dissolved samples carry no ink
      }
    }
    expect(sawDissolve).toBe(true);
  });

  it("touches the centre at every documented shared day", () => {
    const days = [40000, 40200];
    const path = buildPath(0, SC.SAME, days, -3, -2);
    const s = path.samples;
    for (const d of days) {
      let touched = false;
      for (let o = 0; o < s.length; o += SAMPLE_STRIDE) {
        if (s[o]! === d && Math.abs(s[o + 1]!) < 1) touched = true;
      }
      expect(touched).toBe(true);
    }
  });

  it("carries persona provenance on the subject's own line", () => {
    const path = buildPath(-1, SC.CENTER, [40000, 40100], 0, 0, [1, 0]);
    const s = path.samples;
    const personas = new Set<number>();
    for (let o = 0; o < s.length; o += SAMPLE_STRIDE) personas.add(s[o + 5]!);
    expect(personas.has(1)).toBe(true);
  });
});

describe("layout", () => {
  it("reports what the budget hides, and never drops it silently", () => {
    const layout = buildLayout(syntheticScope(), 2);
    expect(layout.drawnWorldlines).toBe(2);
    expect(layout.hiddenWorldlines).toBe(2);
    expect(layout.notes.join(" ")).toContain("2 documented relationships beyond");
  });

  it("bands by relationship family: opponents above, partners below", () => {
    const layout = buildLayout(syntheticScope(), 10);
    const byRel = new Map(layout.lines.map((l) => [l.relIndex, l]));
    expect(byRel.get(-1)!.cls).toBe(SC.CENTER);
    expect(byRel.get(0)!.laneY).toBeGreaterThan(0); // opposed
    expect(byRel.get(1)!.laneY).toBeLessThan(0); // same-side
    expect(byRel.get(3)!.cls).toBe(SC.BR);
    expect(Math.abs(byRel.get(3)!.laneY)).toBeGreaterThan(Math.abs(byRel.get(0)!.laneY));
  });

  it("classOf keeps mixed a third thing, never an average", () => {
    const scope = syntheticScope();
    expect(classOf(scope.relationships[2]!)).toBe(SC.MIXED);
    expect(classOf(scope.relationships[3]!)).toBe(SC.BR);
  });
});

describe("animation constants", () => {
  it("easeQuintic pins its endpoints and midpoint", () => {
    expect(easeQuintic(0)).toBe(0);
    expect(easeQuintic(1)).toBe(1);
    expect(easeQuintic(0.5)).toBeCloseTo(0.5, 10);
  });

  it("playback speed maps to warp and saturates at the table's top row", () => {
    expect(warpSpeedOfPlayback(0)).toBe(0);
    expect(warpSpeedOfPlayback(DAYS_PER_YEAR)).toBeCloseTo(1, 10);
    expect(warpSpeedOfPlayback(1e9)).toBe(LUT_V_MAX);
  });

  it("tier budgets degrade individually and stay ordered", () => {
    expect(SPACETIME_TIERS.low.worldlines).toBeLessThan(SPACETIME_TIERS.high.worldlines);
    expect(SPACETIME_TIERS.low.bloom).toBe(false);
    expect(SPACETIME_TIERS.high.bloom).toBe(true);
  });

  it("LUT clamp constants match the materializer's channel encoding", () => {
    // spacetime_lut.py: LOG_DELTA_MAX = 6.0, LOG_MAG_MAX = 3.0 — byte-identical
    // decode on both sides or the halo lies about the shift.
    expect(LUT_LOG_DELTA_MAX).toBe(6.0);
    expect(LUT_LOG_MAG_MAX).toBe(3.0);
  });
});
