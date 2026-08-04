/**
 * The belt index behind the Arena Array's championship glyphs.
 *
 * The distinction being tested is the whole reason the index exists: a reign
 * held alone and a reign held with a partner are different marks on a card,
 * and the corpus records that difference only in `reigns[].holders`.
 */
import { describe, expect, it } from "vitest";
import type { ChampionshipsFile } from "@kayfabe/graph-contract";
import { buildBeltIndex } from "../arena/arenaBelts";

const reign = (holders: string[]) => ({ holders, s: "2001-01-01", e: null, m: "m:1" });

const FILE = {
  "t:1": {
    n: "Singles Title", pr: "pr:1", artifact: false, titleMatches: 3, changes: 2,
    reigns: [reign(["p:a"]), reign(["p:b"]), reign(["p:a"])],
  },
  "t:2": {
    n: "Tag Titles", pr: "pr:1", artifact: false, titleMatches: 2, changes: 1,
    reigns: [reign(["p:a", "p:c"]), reign(["p:c", "p:d", "p:e"])],
  },
  // A concatenated belt name the materializer refused to split. The reign is
  // still documented, so it still counts — only the belt's NAME is unreliable,
  // and a glyph never claims which belt it was.
  "t:3": {
    n: "Title A / Title B", pr: "pr:2", artifact: true, titleMatches: 1, changes: 1,
    reigns: [reign(["p:b"])],
  },
} as unknown as ChampionshipsFile;

describe("arena belt index", () => {
  const index = buildBeltIndex(FILE);

  it("counts a reign held alone as singles and a reign held with anyone else as tag", () => {
    expect(index.get("p:a")).toEqual({ singles: 2, tag: 1 });
    expect(index.get("p:c")).toEqual({ singles: 0, tag: 2 });
  });

  it("credits every holder of a multi-person reign, not just the first", () => {
    expect(index.get("p:d")).toEqual({ singles: 0, tag: 1 });
    expect(index.get("p:e")).toEqual({ singles: 0, tag: 1 });
  });

  it("counts reigns from source-artifact titles like any other documented reign", () => {
    expect(index.get("p:b")).toEqual({ singles: 2, tag: 0 });
  });

  it("has no entry for someone the corpus documents no reign for", () => {
    expect(index.get("p:none")).toBeUndefined();
  });
});
