import { describe, expect, it } from "vitest";
import type { MatchPlan, SimState } from "@kayfabe/sim-contract";
import { generateMatchLog } from "../src/show/matchEngine";
import { autoBookCard } from "../src/autobook";
import { createUniverse } from "../src/init";
import { applyCommand } from "../src/engine";
import { validateCard } from "../src/validate";
import { stateHash } from "../src/persistence";
import { makeOptions, makeSnapshot, makeWorker } from "./fixtures";

function workersFor(plan: MatchPlan) {
  const out: Record<string, ReturnType<typeof toWorker>> = {};
  for (const side of plan.sides) {
    for (const id of side.members) out[id] = toWorker(id);
  }
  return out;
}

function toWorker(id: string) {
  const snap = makeWorker(id, `W ${id}`, 70);
  return {
    personId: id,
    name: snap.displayName,
    personaNames: [snap.displayName],
    attributes: Object.fromEntries(Object.entries(snap.seeded).map(([k, v]) => [k, v.value])) as never,
    scouted: snap.seeded,
    styles: snap.styles,
    alignment: snap.alignment,
    push: "midcard" as const,
    morale: 60,
    momentum: 0,
    credibility: 60,
    prestige: 40,
    standing: { awarenessNational: 60, affinityNational: 20, marketDelta: {} },
    condition: { fatigue: 0, wearMinutes: 0, injury: null, daysSinceMatch: 7 },
    debutYear: 1988,
    experienceYears: 8,
    historyNote: "",
    active: true,
  };
}

const basePlan: MatchPlan = {
  sides: [{ members: ["p:1"] }, { members: ["p:2"] }],
  titleId: null,
  winnerSide: 0,
  finish: "pin",
  stipulation: null,
  intensity: 60,
  risk: 50,
  mainEvent: true,
};

function log(overrides: Partial<Parameters<typeof generateMatchLog>[0]> = {}) {
  const plan = (overrides.plan ?? basePlan) as MatchPlan;
  return generateMatchLog({
    showId: "show-000001",
    segmentId: "seg-1",
    plan,
    durationMin: 16,
    workers: workersFor(plan) as never,
    execution: 70,
    reception: 74,
    title: null,
    titleChanged: false,
    crowdStartHeat: 55,
    ...overrides,
  });
}

describe("match-engine@1", () => {
  it("tells a complete story: entrances first, booked finish last", () => {
    const beats = log();
    expect(beats[0]!.kind).toBe("entrance");
    const last = beats[beats.length - 1]!;
    expect(last.kind).toBe("finish");
    expect(last.t).toBe(16);
    expect(last.description).toContain("THREE");
    // Chronological throughout.
    for (let i = 1; i < beats.length; i++) expect(beats[i]!.t).toBeGreaterThanOrEqual(beats[i - 1]!.t);
    // Heat stays in bounds.
    for (const b of beats) {
      expect(b.heat).toBeGreaterThanOrEqual(5);
      expect(b.heat).toBeLessThanOrEqual(100);
    }
  });

  it("is deterministic per (show, segment) and varies across segments", () => {
    expect(log()).toEqual(log());
    const other = generateMatchLog({
      showId: "show-000001",
      segmentId: "seg-2",
      plan: basePlan,
      durationMin: 16,
      workers: workersFor(basePlan) as never,
      execution: 70,
      reception: 74,
      title: null,
      titleChanged: false,
      crowdStartHeat: 55,
    });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(log()));
  });

  it("places near-falls in the final third and scales them with reception", () => {
    const hot = log({ reception: 92 });
    const cold = log({ reception: 30 });
    const nf = (l: typeof hot) => l.filter((b) => b.kind === "nearfall");
    expect(nf(hot).length).toBeGreaterThan(nf(cold).length);
    for (const b of nf(hot)) expect(b.t).toBeGreaterThan(16 * 0.66);
  });

  it("announces a title change in the finish call", () => {
    const title = {
      id: "t:9001",
      name: "AWA-X World Championship",
      companyId: "pr:9001",
      tier: "world" as const,
      holderIds: ["p:2"],
      prestige: 80,
      defensesSinceChange: 2,
      lineage: [],
      active: true,
    };
    const beats = log({ title, titleChanged: true });
    expect(beats.at(-1)!.description).toContain("NEW");
    const retained = log({ title, titleChanged: false });
    expect(retained.at(-1)!.description).toContain("retained");
  });

  it("respects non-decisive finishes", () => {
    const dq = log({ plan: { ...basePlan, finish: "dq" } });
    expect(dq.at(-1)!.description.toLowerCase()).toContain("disqualification");
    const draw = log({ plan: { ...basePlan, winnerSide: null, finish: "time_limit_draw" } });
    expect(draw.at(-1)!.description.toLowerCase()).toContain("time limit");
  });
});

describe("autobook@1", () => {
  function stateWithShow(): { state: SimState; showId: string } {
    const state = createUniverse(makeSnapshot(), makeOptions());
    const res = applyCommand(state, {
      type: "SCHEDULE_SHOW",
      companyId: "pr:9001",
      name: "Auto Night",
      date: state.currentDate,
      venueId: "v:9001",
      showType: "ppv",
      ticketPriceCents: 2000,
    });
    expect(res.errors).toEqual([]);
    return { state: res.state, showId: Object.keys(res.state.shows).sort().at(-1)! };
  }

  it("fills a valid card without touching state", () => {
    const { state, showId } = stateWithShow();
    const before = stateHash(state);
    const built = autoBookCard(state, showId);
    expect(built).not.toBeNull();
    expect(stateHash(state)).toBe(before);
    const { segments, advertised } = built!;
    expect(segments.length).toBeGreaterThanOrEqual(4);
    expect(validateCard(state, state.shows[showId]!, segments)).toEqual([]);
    // Nobody appears twice anywhere on the card.
    const seen = new Set<string>();
    for (const seg of segments) {
      const ids = seg.match
        ? seg.match.sides.flatMap((s) => s.members)
        : seg.angle!.beats.flatMap((b) => b.participants.map((p) => p.personId));
      for (const id of ids) {
        expect(seen.has(id), `${id} double-booked`).toBe(false);
        seen.add(id);
      }
    }
    expect(advertised.length).toBeGreaterThan(0);
    // The proposal is deterministic and the card actually books + runs.
    expect(autoBookCard(state, showId)).toEqual(built);
    let res = applyCommand(state, { type: "UPDATE_SHOW_CARD", showId, segments, advertised });
    expect(res.errors).toEqual([]);
    res = applyCommand(res.state, { type: "RUN_SHOW", showId });
    expect(res.errors).toEqual([]);
    expect(res.report!.segments.length).toBe(segments.length);
    // Match segments carry the beat-by-beat log; angles do not.
    for (const seg of res.report!.segments) {
      if (seg.kind === "match") {
        expect(seg.matchLog).not.toBeNull();
        expect(seg.matchLog!.length).toBeGreaterThan(4);
        expect(seg.matchLog!.at(-1)!.kind).toBe("finish");
      } else {
        expect(seg.matchLog).toBeNull();
      }
    }
  });
});
