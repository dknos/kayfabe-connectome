import { describe, expect, it } from "vitest";
import type { SimState, SnapshotCompany, UniverseSnapshot, Venue } from "@kayfabe/sim-contract";
import { createUniverse } from "../src/init";
import { advanceDays, applyCommand } from "../src/engine";
import { makeOptions, makeSnapshot, makeWorker } from "./fixtures";

/** The fixture universe plus a player-founded startup and a free-agent pool. */
function makeFounderSnapshot(): UniverseSnapshot {
  const base = makeSnapshot();
  const founded: SnapshotCompany = {
    companyId: "co:founded",
    name: "Garage League Wrestling",
    shortName: "GLW",
    lineageIds: [],
    sizeTier: "indie",
    detailTier: "full",
    homeMarketId: "mkt:philadelphia",
    rosterPersonIds: [],
    titleIds: [],
    awarenessNational: 4,
    affinityNational: 2,
    prestige: 10,
    productDna: {
      athleticCompetition: 70,
      characterSpectacle: 40,
      serializedStory: 50,
      violence: 55,
      comedy: 15,
      starDriven: 40,
      nationalAmbition: 60,
    },
    playable: true,
    startCashCents: 100_000_000, // $1M backing
  };
  const hall: Venue = {
    id: "v:founded-hall",
    name: "Front Street Athletic Club",
    marketId: "mkt:philadelphia",
    capacity: 800,
    prestige: 25,
    rentalCents: 120_000,
  };
  const freeAgents = Array.from({ length: 6 }, (_, i) =>
    makeWorker(`p:9${String(400 + i)}`, `Free Agent ${i + 1}`, 55 - i * 4),
  );
  return {
    ...base,
    companies: [...base.companies, founded],
    venues: [...base.venues, hall],
    workers: [...base.workers, ...freeAgents],
  };
}

function founderState(): SimState {
  return createUniverse(makeFounderSnapshot(), makeOptions({ playerCompanyId: "co:founded", worldSeed: "founder-1" }));
}

function playerContracts(state: SimState): string[] {
  return Object.keys(state.contracts)
    .sort()
    .filter((id) => {
      const c = state.contracts[id]!;
      return c.companyId === "co:founded" && c.status === "active";
    });
}

function hire(state: SimState, personId: string): SimState {
  const res = applyCommand(state, {
    type: "OFFER_CONTRACT",
    companyId: "co:founded",
    personId,
    kind: "written",
    lengthMonths: 24,
    perAppearanceCents: 0,
    weeklyDownsideCents: 1_200_000,
    exclusive: true,
  });
  expect(res.errors).toEqual([]);
  expect(res.offerOutcome!.accepted).toBe(true);
  return res.state;
}

describe("founding a promotion", () => {
  it("starts with backing capital, an empty roster, and a hireable pool", () => {
    const s = founderState();
    const glw = s.companies["co:founded"]!;
    expect(glw.cashCents).toBe(100_000_000);
    expect(glw.sizeTier).toBe("indie");
    expect(glw.tvDeal).toBeNull();
    expect(glw.aiControlled).toBe(false);
    expect(playerContracts(s)).toEqual([]);
    // The free agents exist as workers with no contract anywhere.
    for (let i = 0; i < 6; i++) {
      const pid = `p:9${String(400 + i)}`;
      expect(s.workers[pid]).toBeDefined();
      const attached = Object.values(s.contracts).some(
        (c) => c.personId === pid && c.status === "active",
      );
      expect(attached).toBe(false);
    }
  });

  it("hires free agents with a generous written deal", () => {
    let s = founderState();
    s = hire(s, "p:9400");
    s = hire(s, "p:9401");
    expect(playerContracts(s).length).toBe(2);
    expect(s.workers["p:9400"]!.morale).toBeGreaterThan(50);
  });

  it("creates its own championship and crowns an inaugural champion in the ring", () => {
    let s = founderState();
    s = hire(s, "p:9400");
    s = hire(s, "p:9401");

    let res = applyCommand(s, { type: "CREATE_TITLE", name: "GLW World Championship", tier: "world" });
    expect(res.errors).toEqual([]);
    s = res.state;
    const titleId = Object.keys(s.titles).sort().find((id) => s.titles[id]!.name.startsWith("GLW"))!;
    expect(s.titles[titleId]!.holderIds).toEqual([]);
    expect(s.companies["co:founded"]!.titleIds).toContain(titleId);

    // Duplicate names are refused.
    const dup = applyCommand(s, { type: "CREATE_TITLE", name: "glw world championship", tier: "world" });
    expect(dup.errors.length).toBeGreaterThan(0);

    // Book the inaugural title match at the home hall.
    res = applyCommand(s, {
      type: "SCHEDULE_SHOW",
      companyId: "co:founded",
      name: "GLW Night One",
      date: s.currentDate,
      venueId: "v:founded-hall",
      showType: "house",
      ticketPriceCents: 1200,
    });
    expect(res.errors).toEqual([]);
    s = res.state;
    const showId = Object.keys(s.shows).sort().at(-1)!;
    res = applyCommand(s, {
      type: "UPDATE_SHOW_CARD",
      showId,
      segments: [
        {
          id: "seg-1",
          kind: "match",
          durationMin: 15,
          match: {
            sides: [{ members: ["p:9400"] }, { members: ["p:9401"] }],
            titleId,
            winnerSide: 0,
            finish: "pin",
            stipulation: null,
            intensity: 60,
            risk: 35,
            mainEvent: true,
          },
          angle: null,
          storylineId: null,
        },
      ],
      advertised: [],
    });
    expect(res.errors).toEqual([]);
    res = applyCommand(res.state, { type: "RUN_SHOW", showId });
    expect(res.errors).toEqual([]);
    s = res.state;
    expect(s.titles[titleId]!.holderIds).toEqual(["p:9400"]);
    expect(s.titles[titleId]!.lineage.at(-1)!.wonAtShowId).toBe(showId);
    expect(s.news.some((n) => n.kind === "title_change")).toBe(true);
  });

  it("grows from indie to regional and lands a TV deal (company-growth@1)", () => {
    let s = founderState();
    const glw = s.companies["co:founded"]!;
    // White-box: put the company at the threshold (awareness, cash, body of work).
    glw.standing.awarenessNational = 40;
    glw.cashCents = 30_000_000;
    for (let i = 0; i < 10; i++) {
      const id = `show-9${String(i).padStart(5, "0")}`;
      s.shows[id] = {
        id,
        companyId: "co:founded",
        name: `GLW Show ${i}`,
        date: "1997-01-03",
        venueId: "v:founded-hall",
        marketId: "mkt:philadelphia",
        showType: "house",
        ticketPriceCents: 1200,
        segments: [],
        advertised: [],
        status: "completed",
        report: null,
      };
    }
    // 1997-01-06 is a Monday; the first advanced day is Tuesday, so run a week.
    s = advanceDays(s, 7);
    const after = s.companies["co:founded"]!;
    expect(after.sizeTier).toBe("regional");
    expect(after.tvDeal).not.toBeNull();
    expect(s.news.some((n) => n.headline.includes("outgrows"))).toBe(true);
    // Growth is earned, not free: weekly overhead now bills at the regional rate.
    expect(s.ledger.some((t) => t.companyId === "co:founded" && t.category === "office_overhead")).toBe(true);
  });
});
