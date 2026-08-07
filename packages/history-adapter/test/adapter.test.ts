import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_KEYS,
  type AttributeKey,
  type SeededAttribute,
  type UniverseSnapshot,
  type WorkerSeeder,
} from "@kayfabe/sim-contract";
import {
  CorpusClient,
  buildUniverseSnapshot,
  canonicalPersonId,
  loadCrosswalk,
} from "../src/index";
import { makeNodeFetch } from "../src/nodeFetch";
import crosswalkJson from "../src/data/persona-crosswalk.json";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "corpus");
const START = "1997-01-06";

const stubSeeder: WorkerSeeder = (evidence) => {
  const value = Math.min(100, 40 + Math.round(evidence.matches / 10));
  const attributes = {} as Record<AttributeKey, SeededAttribute>;
  for (const key of ATTRIBUTE_KEYS) {
    attributes[key] = {
      value,
      confidence: evidence.matches >= 100 ? "medium" : "low",
      method: "stub-seeder@1",
      inputs: [`matches:${evidence.matches}`],
    };
  }
  return {
    attributes,
    awarenessNational: value,
    affinityNational: value,
    credibility: value,
    prestige: value,
    styles: ["allrounder"],
    alignment: "neutral",
  };
};

function buildFixtureSnapshot(): Promise<UniverseSnapshot> {
  return buildUniverseSnapshot({
    fetch: makeNodeFetch(FIXTURE_DIR),
    startDate: START,
    seedWorker: stubSeeder,
  });
}

describe("crosswalk", () => {
  it("merges Sydal/Bourne to one canonical person, reachable by either id", () => {
    const xw = loadCrosswalk(crosswalkJson);
    expect(canonicalPersonId(xw, "p:116704")).toBe("p:116704");
    expect(canonicalPersonId(xw, "p:35621")).toBe("p:116704");
    const group = xw.byCanonical.get("p:116704")!;
    const names = group.members.map((m) => m.persona);
    expect(names).toContain("Matt Sydal");
    expect(names).toContain("Evan Bourne");
  });

  it("rejects duplicate membership across groups", () => {
    expect(() =>
      loadCrosswalk({
        version: 1,
        groups: [
          {
            canonical: "p:1",
            displayName: "A",
            members: [
              { id: "p:1", persona: "A" },
              { id: "p:2", persona: "B" },
            ],
            note: "curated",
          },
          {
            canonical: "p:3",
            displayName: "C",
            members: [
              { id: "p:3", persona: "C" },
              { id: "p:2", persona: "B again" },
            ],
            note: "curated",
          },
        ],
      }),
    ).toThrow(/duplicate membership p:2/);
  });

  it("rejects a canonical id missing from its own members", () => {
    expect(() =>
      loadCrosswalk({
        version: 1,
        groups: [
          {
            canonical: "p:9",
            displayName: "X",
            members: [{ id: "p:1", persona: "X" }],
            note: "curated",
          },
        ],
      }),
    ).toThrow(/not among its members/);
  });
});

describe("CorpusClient", () => {
  it("returns [] for missing timeline years", async () => {
    const client = new CorpusClient(makeNodeFetch(FIXTURE_DIR));
    expect(await client.year(1958)).toEqual([]);
    expect((await client.year(1996)).length).toBeGreaterThan(0);
  });
});

describe("buildUniverseSnapshot (fixture corpus)", () => {
  it("builds the WWF as a playable, lineage-resolved company", async () => {
    const snap = await buildFixtureSnapshot();
    expect(snap.companies).toHaveLength(1);
    const wwf = snap.companies[0]!;
    // Lineage: pr:11791 stitches into the canonical WWE-line id with the
    // era-correct 1997 name.
    expect(wwf.companyId).toBe("pr:4140");
    expect(wwf.name).toBe("WWF");
    expect(wwf.lineageIds).toContain("pr:11561");
    expect(wwf.lineageIds).toContain("pr:11791");
    expect(wwf.playable).toBe(true);
    expect(wwf.detailTier).toBe("full");
    expect(wwf.homeMarketId).toBe("mkt:nyc");
  });

  it("applies roster thresholds with crosswalk-aggregated appearances", async () => {
    const snap = await buildFixtureSnapshot();
    const roster = snap.companies[0]!.rosterPersonIds;
    expect(roster).toEqual(
      [
        "p:116704", // Sydal+Bourne: 4+4 appearances, only via the crosswalk
        "p:9002",
        "p:9003",
        "p:9004",
        "p:9005",
        "p:9006",
        "p:9013",
        "p:9014",
      ].sort(),
    );
    // Below thresholds: volume (p:9011 3 apps), recency (p:9010 last 1996-06),
    // and p:9012 whose 5 pre-start appearances only reach 8 with post-start
    // matches — anti-look-ahead keeps it off the roster.
    expect(roster).not.toContain("p:9010");
    expect(roster).not.toContain("p:9011");
    expect(roster).not.toContain("p:9012");
    expect(roster).not.toContain("p:9015");
  });

  it("merges personas and names the worker by the latest pre-start persona", async () => {
    const snap = await buildFixtureSnapshot();
    const sydal = snap.workers.find((w) => w.personId === "p:116704")!;
    expect(sydal.personas.map((p) => p.name).sort()).toEqual(["Evan Bourne", "Matt Sydal"]);
    // Latest pre-start appearance (1997-01-04) was recorded under Evan Bourne.
    expect(sydal.displayName).toBe("Evan Bourne");
  });

  it("excludes post-start matches from evidence (anti-look-ahead)", async () => {
    const snap = await buildFixtureSnapshot();
    const sydal = snap.workers.find((w) => w.personId === "p:116704")!;
    // 4 pre-start rows under each persona; the 1997-02-01 match is filtered.
    expect(sydal.evidence.matches).toBe(8);
    expect(sydal.evidence.lastYear).toBeLessThanOrEqual(1997);
    for (const w of snap.workers) {
      expect(w.evidence.lastYear ?? 0).toBeLessThanOrEqual(1997);
    }
    // The post-start-only opponent never appears anywhere in the snapshot.
    expect(snap.workers.some((w) => w.personId === "p:9015")).toBe(false);
  });

  it("computes winShare from decided matches only", async () => {
    const snap = await buildFixtureSnapshot();
    const champ = snap.workers.find((w) => w.personId === "p:9002")!;
    // 9 pre-start rows: 6 wins, 2 losses, 1 draw -> 6/8 decided.
    expect(champ.evidence.matches).toBe(9);
    expect(champ.evidence.winShare).toBeCloseTo(6 / 8, 10);
    // person-matches@1 has no placement; unknown stays null, never zero.
    expect(champ.evidence.mainEventShare).toBeNull();
  });

  it("resolves champions at the start date, including open reigns", async () => {
    const snap = await buildFixtureSnapshot();
    const world = snap.titles.find((t) => t.titleId === "t:100")!;
    expect(world.tier).toBe("world");
    expect(world.lineageComplete).toBe(true);
    expect(world.holderIds).toEqual(["p:9002"]); // open reign (e null)
    expect(world.holderNames).toEqual(["Current Champ"]);
    expect(world.preStartReigns).toHaveLength(2);
    expect(world.preStartReigns[0]!.toDay).not.toBeNull(); // ended 1996-06-01
    expect(world.preStartReigns[1]!.toDay).toBeNull();

    const ic = snap.titles.find((t) => t.titleId === "t:102")!;
    expect(ic.holderIds).toEqual([]); // last reign ended pre-start -> vacant

    // csv title with no derivable lineage and no window activity is skipped
    // but counted in data health.
    expect(snap.titles.some((t) => t.titleId === "t:c5")).toBe(false);
    expect(snap.dataHealth.titlesWithoutLineage).toBe(1);
  });

  it("notes champions who are not on any roster", async () => {
    const snap = await buildFixtureSnapshot();
    const legacy = snap.titles.find((t) => t.titleId === "t:103")!;
    expect(legacy.holderIds).toEqual(["p:9001"]);
    expect(
      snap.dataHealth.notes.some(
        (n) => n.startsWith("champions-not-rostered:") && n.includes("p:9001"),
      ),
    ).toBe(true);
  });

  it("reports near-duplicate rostered names as alias suspects", async () => {
    const snap = await buildFixtureSnapshot();
    const suspect = snap.dataHealth.aliasSuspects.find((s) =>
      s.ids.includes("p:9013"),
    )!;
    expect(suspect.ids).toEqual(["p:9013", "p:9014"]);
    expect(suspect.names.sort()).toEqual(["Phantom", "The Phantom"]);
  });

  it("carries quarantined-record counts from the manifest", async () => {
    const snap = await buildFixtureSnapshot();
    expect(snap.dataHealth.quarantinedRecords).toBe(5); // 2 + 3 in fixture manifest
  });

  it("is deterministic: two builds hash identically", async () => {
    const a = await buildFixtureSnapshot();
    const b = await buildFixtureSnapshot();
    expect(a.meta.snapshotHash).toBe(b.meta.snapshotHash);
    expect(a.meta.snapshotHash).not.toBe("");
    expect(a.meta.builderVersion).toBe("snapshot-builder@1");
    expect(a.meta.seederMethod).toBe("stub-seeder@1");
    expect(a.meta.rosterInference).toEqual({
      method: "roster-infer@1",
      windowDays: 540,
      minAppearances: 6,
      maxDaysSinceLast: 120,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
