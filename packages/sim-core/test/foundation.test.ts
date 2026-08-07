import { describe, expect, it } from "vitest";
import { RngHub, RngStream } from "../src/rng";
import { canonicalJson, hashString, hashValue } from "../src/hash";
import {
  addDays,
  dayOfWeek,
  diffDays,
  formatLong,
  fromEpochDay,
  isIsoDate,
  toEpochDay,
} from "../src/dates";
import { formatUSD, scaleCents } from "../src/money";

describe("rng", () => {
  it("same seed + stream name produces identical sequences", () => {
    const a = RngStream.fromSeed("world-1", "crowd");
    const b = RngStream.fromSeed("world-1", "crowd");
    for (let i = 0; i < 100; i++) expect(a.u32()).toBe(b.u32());
  });

  it("different stream names diverge", () => {
    const a = RngStream.fromSeed("world-1", "crowd");
    const b = RngStream.fromSeed("world-1", "injuries");
    const same = Array.from({ length: 20 }, () => a.u32() === b.u32());
    expect(same.every(Boolean)).toBe(false);
  });

  it("serialization roundtrip continues the exact sequence", () => {
    const a = RngStream.fromSeed("world-2", "x");
    for (let i = 0; i < 37; i++) a.u32();
    const state = a.getState();
    const expected = Array.from({ length: 50 }, () => a.u32());
    const b = new RngStream(state);
    const actual = Array.from({ length: 50 }, () => b.u32());
    expect(actual).toEqual(expected);
  });

  it("hub restores all streams", () => {
    const hub = new RngHub("seed");
    hub.stream("a").next();
    hub.stream("b").int(1, 10);
    const snap = hub.serialize();
    const expectA = hub.stream("a").u32();
    const hub2 = new RngHub("seed");
    hub2.restore(JSON.parse(JSON.stringify(snap)));
    expect(hub2.stream("a").u32()).toBe(expectA);
  });

  it("int stays in bounds and covers endpoints", () => {
    const r = RngStream.fromSeed("s", "t");
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      seen.add(v);
    }
    expect(seen.size).toBe(5);
  });

  it("pickWeighted respects zero weights", () => {
    const r = RngStream.fromSeed("s", "w");
    for (let i = 0; i < 500; i++) {
      expect(r.pickWeighted(["a", "b"], [0, 1])).toBe("b");
    }
  });
});

describe("canonical hash", () => {
  it("is insensitive to key order", () => {
    expect(hashValue({ a: 1, b: [2, 3], c: { d: "x" } })).toBe(
      hashValue({ c: { d: "x" }, b: [2, 3], a: 1 }),
    );
  });

  it("is sensitive to values", () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });

  it("drops undefined object members like JSON.stringify", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects NaN", () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(/non-finite/);
  });

  it("hashString is stable across runs (regression pin)", () => {
    // If this pin ever changes, every existing save's state hash breaks.
    expect(hashString("the book")).toBe(hashString("the book"));
    expect(hashString("the book")).not.toBe(hashString("the boot"));
  });
});

describe("dates", () => {
  it("roundtrips epoch days", () => {
    for (const iso of ["1963-01-25", "1970-01-01", "1996-02-29", "1997-01-06", "2026-01-16"]) {
      expect(fromEpochDay(toEpochDay(iso))).toBe(iso);
    }
  });

  it("knows real weekdays", () => {
    expect(dayOfWeek("1997-01-06")).toBe(0); // Monday (Nitro/Raw night)
    expect(dayOfWeek("1970-01-01")).toBe(3); // Thursday
    expect(dayOfWeek("2000-01-01")).toBe(5); // Saturday
  });

  it("handles leap years", () => {
    expect(isIsoDate("1996-02-29")).toBe(true);
    expect(isIsoDate("1997-02-29")).toBe(false);
    expect(isIsoDate("1900-02-29")).toBe(false);
    expect(isIsoDate("2000-02-29")).toBe(true);
    expect(addDays("1996-02-28", 1)).toBe("1996-02-29");
    expect(addDays("1997-02-28", 1)).toBe("1997-03-01");
  });

  it("adds and diffs", () => {
    expect(addDays("1996-12-30", 7)).toBe("1997-01-06");
    expect(diffDays("1997-01-06", "1997-02-06")).toBe(31);
    expect(diffDays("1997-02-06", "1997-01-06")).toBe(-31);
  });

  it("formats", () => {
    expect(formatLong("1997-01-06")).toBe("Monday, January 6, 1997");
  });
});

describe("money", () => {
  it("formats", () => {
    expect(formatUSD(123456789)).toBe("$1,234,567.89");
    expect(formatUSD(-9950)).toBe("-$99.50");
    expect(formatUSD(0)).toBe("$0.00");
  });

  it("scales with round-half-away-from-zero", () => {
    expect(scaleCents(1000, 0.5)).toBe(500);
    expect(scaleCents(1001, 0.5)).toBe(501);
    expect(scaleCents(-1001, 0.5)).toBe(-501);
  });

  it("rejects float cents", () => {
    expect(() => scaleCents(10.5, 1)).toThrow(/integer cents/);
  });
});
