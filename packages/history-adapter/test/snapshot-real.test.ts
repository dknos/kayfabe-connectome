import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_KEYS,
  type AttributeKey,
  type SeededAttribute,
  type WorkerSeeder,
} from "@kayfabe/sim-contract";
import { buildUniverseSnapshot, canonicalPersonId, loadCrosswalk } from "../src/index";
import { makeNodeFetch } from "../src/nodeFetch";
import crosswalkJson from "../src/data/persona-crosswalk.json";

const CORPUS_DIR = "/home/nemoclaw/kayfabe-connectome-simulator/data/materialized";
const hasCorpus = existsSync(`${CORPUS_DIR}/manifest.json`);

const stubSeeder: WorkerSeeder = (evidence) => {
  const value = Math.min(100, 30 + Math.round(Math.sqrt(evidence.matches)));
  const attributes = {} as Record<AttributeKey, SeededAttribute>;
  for (const key of ATTRIBUTE_KEYS) {
    attributes[key] = {
      value,
      confidence: evidence.matches >= 200 ? "medium" : "low",
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

describe.skipIf(!hasCorpus)("buildUniverseSnapshot (real corpus, 1997-01-06)", () => {
  it(
    "builds the flagship 1997 universe",
    async () => {
      const snap = await buildUniverseSnapshot({
        fetch: makeNodeFetch(CORPUS_DIR),
        startDate: "1997-01-06",
        seedWorker: stubSeeder,
      });

      // WWF / WCW / ECW present, playable, era-correct names.
      const byName = new Map(snap.companies.map((c) => [c.name, c]));
      for (const name of ["WWF", "WCW", "ECW"]) {
        const company = byName.get(name);
        expect(company, `${name} missing`).toBeDefined();
        expect(company!.playable, `${name} not playable`).toBe(true);
        expect(company!.detailTier).toBe("full");
        expect(company!.rosterPersonIds.length).toBeGreaterThanOrEqual(20);
        expect(company!.rosterPersonIds.length).toBeLessThanOrEqual(80);
      }
      expect(byName.get("WWF")!.companyId).toBe("pr:4140"); // lineage canonical

      // Sydal/Bourne canonicalization (not rostered in 1997 — unit-level check).
      const xw = loadCrosswalk(crosswalkJson);
      expect(canonicalPersonId(xw, "p:35621")).toBe("p:116704");
      expect(canonicalPersonId(xw, "p:116704")).toBe("p:116704");

      // Famous 1997 names present somewhere in the rosters.
      const rosterIds = new Set(snap.companies.flatMap((c) => c.rosterPersonIds));
      const workerById = new Map(snap.workers.map((w) => [w.personId, w]));
      const allNames = snap.workers.flatMap((w) => [
        w.displayName,
        ...w.personas.map((p) => p.name),
      ]);
      const hasName = (re: RegExp) => allNames.some((n) => re.test(n));
      expect(hasName(/steve austin|stone cold/i)).toBe(true);
      expect(hasName(/^sting$/i)).toBe(true);
      expect(hasName(/undertaker/i)).toBe(true);

      // Every worker on a roster exists and every roster member is a worker.
      for (const id of rosterIds) expect(workerById.has(id)).toBe(true);
      // Beyond the rosters: a hireable free-agent pool (free-agent-pool@1)
      // for player-founded startups, noted in data health.
      const freeAgents = snap.workers.filter((w) => !rosterIds.has(w.personId));
      expect(snap.workers.length).toBe(rosterIds.size + freeAgents.length);
      expect(freeAgents.length).toBeGreaterThanOrEqual(20);
      expect(freeAgents.length).toBeLessThanOrEqual(120);
      expect(snap.dataHealth.notes.join("\n")).toContain("free-agent-pool@1");

      // Every title holder is on some roster, or noted in data health.
      const notesText = snap.dataHealth.notes.join("\n");
      for (const title of snap.titles) {
        for (const holder of title.holderIds) {
          const ok = rosterIds.has(holder) || notesText.includes(holder);
          expect(ok, `holder ${holder} of ${title.name} neither rostered nor noted`).toBe(
            true,
          );
        }
      }

      // Anti-look-ahead: no evidence reaches past the start year.
      for (const w of snap.workers) {
        expect(w.evidence.lastYear ?? 0).toBeLessThanOrEqual(1997);
      }

      // Determinism spot checks.
      expect(snap.meta.snapshotHash).not.toBe("");
      expect(snap.meta.startDay).toBe(35434);
      expect(snap.meta.builderVersion).toBe("snapshot-builder@1");

      const wwf = byName.get("WWF")!;
      const champions = snap.titles
        .filter((t) => t.holderIds.length > 0)
        .map((t) => `${t.name}: ${t.holderNames.join(" & ")}`);
      console.log(`WWF roster size: ${wwf.rosterPersonIds.length}`);
      console.log(`champions:\n  ${champions.join("\n  ")}`);
      console.log(`snapshotHash: ${snap.meta.snapshotHash}`);
    },
    300_000,
  );
});
