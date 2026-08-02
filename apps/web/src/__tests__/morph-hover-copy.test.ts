// SYNTHETIC test fixtures — never production data.
import { describe, expect, it } from "vitest";
import { MR, TK, type MorphLayoutResult } from "@kayfabe/morph-renderer";
import { describeHover } from "../morph/MorphInspector";
import type { MorphData, NeighborRel } from "../morph/morphAdapter";

const direct: NeighborRel = {
  index: 1,
  id: "p:direct",
  name: "Direct Person",
  same: 3,
  opposed: 7,
  br: 2,
  title: 0,
  firstDay: 29_220,
  lastDay: 32_872,
  promoMask: 0,
};

const ids = ["p:selected", "p:direct", "p:bridge", "p:other"];
const names = new Map([
  ["p:selected", "Selected Person"],
  ["p:direct", "Direct Person"],
  ["p:bridge", "Bridge Person"],
  ["p:other", "Other Intermediary"],
  ["pr:test", "Test Promotion"],
  ["t:test", "Test Championship"],
]);

const data = {
  indexOf: (id: string) => {
    const index = ids.indexOf(id);
    return index < 0 ? undefined : index;
  },
  idOf: (index: number) => ids[index] ?? null,
  nameOf: (id: string) => names.get(id) ?? null,
  relationsOf: (index: number) => index === 0 ? [direct] : [],
} as unknown as MorphData;

const orbit = {
  mode: "orbit",
  nodeRole: Uint8Array.from([MR.SELECTED, MR.OPPONENT, MR.BRIDGE, MR.PARTNER]),
  routes: [
    { key: "bridge:direct", kind: TK.BRIDGE, a: 1, b: 2, width: 2.2 },
    { key: "bridge:other", kind: TK.BRIDGE, a: 3, b: 2, width: 1.1 },
  ],
} as unknown as MorphLayoutResult;

describe("Morph hover card language", () => {
  it("identifies the selected center without inventing a self relationship", () => {
    const info = describeHover("p:selected", "p:selected", data, orbit);
    expect(info.why).toBe("Selected person at the center of Orbit Map");
    expect(info.evidence).toContain("Inner radius is one graph hop · outer radius is two graph hops");
    expect(info.evidence.join(" ")).not.toMatch(/direct relationship/i);
  });

  it("describes direct evidence with component counts and dates", () => {
    const info = describeHover("p:direct", "p:selected", data, orbit);
    expect(info.why).toBe("Direct relationship with Selected Person");
    expect(info.evidence.join(" | ")).toContain("Opposed ×7 · same-side ×3 · battle royal ×2");
    expect(info.evidence.join(" | ")).toMatch(/First documented \d{4}-\d{2}-\d{2} · latest documented \d{4}-\d{2}-\d{2}/);
    expect(info.caveat).toBeNull();
  });

  it("describes a bridge as two hops and explicitly denies a direct claim", () => {
    const info = describeHover("p:bridge", "p:selected", data, orbit);
    expect(info.why).toBe("Two hops from Selected Person");
    expect(info.evidence).toContain("Supported through 2 displayed connections");
    expect(info.evidence).toContain("Strongest displayed route through Direct Person");
    expect(info.caveat).toBe("No direct relationship is claimed by this placement.");
  });

  it("never presents promotion appearance context as employment", () => {
    const info = describeHover("pr:test", "p:selected", data, orbit);
    expect(info.why).toBe("Documented appearance context for Selected Person");
    expect(info.caveat).toMatch(/does not establish employment/i);
  });

  it("keeps championship claims bounded to recorded source data", () => {
    const info = describeHover("t:test", "p:selected", data, orbit);
    expect(info.why).toBe("Documented championship context");
    expect(info.caveat).toMatch(/only when the source records them/i);
  });
});
