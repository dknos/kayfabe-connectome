import { describe, expect, it } from "vitest";
import type {
  AttributeBlock,
  AttributeKey,
  CompanyState,
  ContractState,
  EraProfile,
  Market,
  PersonId,
  PushLevel,
  SeededAttribute,
  Segment,
  ShowPlan,
  TitleState,
  Venue,
  WorkerState,
} from "@kayfabe/sim-contract";
import { ATTRIBUTE_KEYS } from "@kayfabe/sim-contract";
import { RngStream, type RngState } from "../src/rng";
import { dayOfWeek } from "../src/dates";
import { aiDailyTick, type AiTickContext } from "../src/ai/index";

const DATE = "1997-01-06"; // Monday
const COMPANY = "co:test";
const WORLD_TITLE = "t:world";
const INJURED = "p:w12";
const EXPIRING = "p:w02";
const FREE_AGENT = "p:w13";

function attrs(value: number): AttributeBlock {
  const out = {} as AttributeBlock;
  for (const k of ATTRIBUTE_KEYS) out[k] = value;
  return out;
}

function scouted(value: number): Record<AttributeKey, SeededAttribute> {
  const out = {} as Record<AttributeKey, SeededAttribute>;
  for (const k of ATTRIBUTE_KEYS) {
    out[k] = { value, confidence: "medium", method: "test", inputs: [] };
  }
  return out;
}

const PUSHES: PushLevel[] = [
  "main_event", "upper", "upper", "midcard", "midcard", "midcard",
  "lower", "lower", "opener", "opener", "lower", "midcard",
];

function mkWorker(n: number, over: Partial<WorkerState> = {}): WorkerState {
  const pid = `p:w${String(n).padStart(2, "0")}`;
  return {
    personId: pid,
    name: `Worker ${String(n).padStart(2, "0")}`,
    personaNames: [`Worker ${String(n).padStart(2, "0")}`],
    attributes: attrs(60),
    scouted: scouted(60),
    styles: ["allrounder"],
    alignment: n % 2 === 1 ? "face" : "heel",
    push: PUSHES[n - 1] ?? "midcard",
    morale: 70,
    momentum: 60 - n * 4,
    credibility: 70 - n * 2,
    prestige: 50,
    standing: {
      awarenessNational: 90 - n * 3,
      affinityNational: 20,
      marketDelta: {},
    },
    condition: { fatigue: 10, wearMinutes: 0, injury: null, daysSinceMatch: n },
    debutYear: 1988,
    experienceYears: 5 + (n % 10),
    historyNote: "",
    active: true,
    ...over,
  };
}

function mkContract(n: number, over: Partial<ContractState> = {}): ContractState {
  return {
    id: `c-${String(n).padStart(3, "0")}`,
    personId: `p:w${String(n).padStart(2, "0")}`,
    companyId: COMPANY,
    kind: "written",
    exclusive: false,
    startDate: "1996-06-01",
    endDate: "1997-11-01",
    perAppearanceCents: 0,
    weeklyDownsideCents: 100_000,
    promises: [],
    status: "active",
    signedDate: "1996-06-01",
    ...over,
  };
}

const ERA: EraProfile = {
  id: "era-national-war",
  label: "The National War",
  appliesFrom: "1995-01-01",
  appliesTo: "2001-12-31",
  tvAvailable: true,
  ppvAvailable: true,
  streamingAvailable: false,
  weeklyTvRightsCents: { national: 25_000_000, regional: 2_500_000, indie: 0 },
  ppvBuyRateBase: 0.018,
  ppvPriceCents: 2995,
  ticketPriceTypicalCents: 2200,
  allowedContractKinds: ["handshake", "appearance", "written", "exclusive"],
  showOverheadCents: { national: 9_000_000, regional: 1_400_000, indie: 220_000 },
  weeklyOverheadCents: { national: 18_000_000, regional: 2_800_000, indie: 300_000 },
  newsSpeed: 60,
};

function makeCtx(rng?: RngStream): AiTickContext {
  const workers: Record<PersonId, WorkerState> = {};
  for (let n = 1; n <= 12; n++) workers[`p:w${String(n).padStart(2, "0")}`] = mkWorker(n);
  workers[INJURED] = mkWorker(12, {
    condition: {
      fatigue: 10,
      wearMinutes: 0,
      injury: {
        kind: "knee",
        severity: "moderate",
        occurredOn: "1997-01-02",
        outUntil: "1997-03-01",
        note: "test injury",
      },
      daysSinceMatch: 12,
    },
  });
  workers[FREE_AGENT] = mkWorker(13, {
    push: "midcard",
    standing: { awarenessNational: 60, affinityNational: 10, marketDelta: {} },
  });

  const contracts: ContractState[] = [];
  for (let n = 1; n <= 12; n++) {
    contracts.push(mkContract(n, n === 2 ? { endDate: "1997-01-26" } : {}));
  }

  const company: CompanyState = {
    id: COMPANY,
    name: "Test Championship Wrestling",
    shortName: "TCW",
    active: true,
    cashCents: 50_000_000,
    homeMarketId: "mkt:home",
    productDna: {
      athleticCompetition: 60,
      characterSpectacle: 55,
      serializedStory: 60,
      violence: 40,
      comedy: 20,
      starDriven: 65,
      nationalAmbition: 80,
    },
    prestige: 70,
    momentum: 10,
    standing: { awarenessNational: 75, affinityNational: 30, marketDelta: {} },
    sizeTier: "national",
    detailTier: "standard",
    tvDeal: {
      programName: "Monday Mayhem",
      dayOfWeek: 0,
      weeklyRightsCents: 25_000_000,
      reach: 70,
    },
    ppvWeek: 3,
    aiControlled: true,
    aiProfile: {
      riskTolerance: 40,
      starBias: "proven",
      youthBias: 0,
      spendingDiscipline: 60,
      planLoyalty: 80,
    },
    programs: [],
    objectives: [],
    titleIds: [WORLD_TITLE],
    nameHistory: [{ name: "Test Championship Wrestling", from: "1990-01-01" }],
  };

  const title: TitleState = {
    id: WORLD_TITLE,
    name: "TCW World Championship",
    companyId: COMPANY,
    tier: "world",
    holderIds: ["p:w01"],
    prestige: 85,
    defensesSinceChange: 2,
    lineage: [],
    active: true,
  };

  const market: Market = {
    id: "mkt:home",
    name: "Home Market",
    region: "Northeast",
    population: 8_000_000,
    wrestlingInterest: 75,
    economicStrength: 70,
  };

  const venues: Record<string, Venue> = {
    "v:alpha": { id: "v:alpha", name: "Alpha Arena", marketId: "mkt:home", capacity: 15000, prestige: 80, rentalCents: 500_000 },
    "v:beta": { id: "v:beta", name: "Beta Hall", marketId: "mkt:home", capacity: 8000, prestige: 60, rentalCents: 250_000 },
    "v:gamma": { id: "v:gamma", name: "Gamma Gym", marketId: "mkt:home", capacity: 5000, prestige: 40, rentalCents: 120_000 },
  };

  const shows: Record<string, ShowPlan> = {
    s1: {
      id: "s1",
      companyId: COMPANY,
      name: "Monday Mayhem",
      date: "1997-01-07",
      venueId: "v:beta",
      marketId: "mkt:home",
      showType: "tv",
      ticketPriceCents: 2200,
      segments: [],
      advertised: [],
      status: "scheduled",
      report: null,
    },
  };

  const counters: Record<string, number> = {};
  return {
    company,
    date: DATE,
    workers,
    contractsByCompany: { [COMPANY]: contracts },
    titles: { [WORLD_TITLE]: title },
    shows,
    venues,
    markets: { "mkt:home": market },
    era: ERA,
    rng: rng ?? RngStream.fromSeed("test-world", `ai:${COMPANY}`),
    nextId: (prefix: string) => {
      const n = (counters[prefix] ?? 0) + 1;
      counters[prefix] = n;
      return `${prefix}-${String(n).padStart(6, "0")}`;
    },
  };
}

function segmentParticipants(seg: Segment): PersonId[] {
  const out: PersonId[] = [];
  if (seg.match) for (const side of seg.match.sides) out.push(...side.members);
  if (seg.angle) for (const beat of seg.angle.beats) out.push(...beat.participants.map((p) => p.personId));
  return out;
}

describe("ai-booker@1", () => {
  it("keeps the weekly TV pipeline filled and places the monthly PPV", () => {
    const actions = aiDailyTick(makeCtx());
    const tv = actions.scheduleShows.filter((s) => s.showType === "tv");
    expect(tv.map((s) => s.date)).toEqual(["1997-01-13", "1997-01-20", "1997-01-27"]);
    for (const s of tv) {
      expect(dayOfWeek(s.date)).toBe(0);
      expect(s.name).toBe("Monday Mayhem");
      expect(["v:alpha", "v:beta", "v:gamma"]).toContain(s.venueId);
      expect(s.marketId).toBe("mkt:home");
      expect(s.ticketPriceCents).toBe(2200);
    }
    const ppv = actions.scheduleShows.filter((s) => s.showType === "ppv");
    expect(ppv).toHaveLength(1);
    expect(ppv[0]!.date).toBe("1997-01-19"); // Sunday of week 3
    expect(ppv[0]!.venueId).toBe("v:alpha"); // biggest home venue
    expect(actions.decisions.some((d) => d.reason.startsWith("ppv-monthly:"))).toBe(true);
  });

  it("creates a world-title program with reasons and considered options", () => {
    const actions = aiDailyTick(makeCtx());
    const prog = actions.programUpdates.find((p) => p.titleId === WORLD_TITLE);
    expect(prog).toBeDefined();
    expect(prog!.participants[0]).toBe("p:w01"); // reigning champion
    expect(prog!.participants).toHaveLength(2);
    expect(prog!.participants).toContain(prog!.intendedWinner);
    expect(prog!.intendedWinner).toBe("p:w01"); // planLoyalty 80: champ retains
    expect(prog!.reason).toMatch(/^build-challenger:/);
    expect(prog!.targetDate).toBe("1997-01-19"); // the PPV planned this tick
    const decision = actions.decisions.find((d) => d.action.startsWith("create-program:"));
    expect(decision).toBeDefined();
    expect(decision!.considered).toHaveLength(3);
    for (const c of decision!.considered) expect(Number.isFinite(c.utility)).toBe(true);
  });

  it("cards the next show with a valid 1-angle, 4-match TV card", () => {
    const ctx = makeCtx();
    const actions = aiDailyTick(ctx);
    expect(actions.cardUpdates).toHaveLength(1);
    const cu = actions.cardUpdates[0]!;
    expect(cu.showId).toBe("s1");
    expect(cu.segments).toHaveLength(5);
    expect(cu.segments.filter((s) => s.kind === "match")).toHaveLength(4);
    expect(cu.segments.filter((s) => s.kind === "angle")).toHaveLength(1);

    const roster = new Set(
      Array.from({ length: 12 }, (_, i) => `p:w${String(i + 1).padStart(2, "0")}`),
    );
    const seen = new Set<PersonId>();
    for (const seg of cu.segments) {
      expect(seg.durationMin).toBeGreaterThan(0);
      for (const pid of segmentParticipants(seg)) {
        expect(roster.has(pid)).toBe(true);
        expect(seen.has(pid)).toBe(false); // nobody twice on one card
        seen.add(pid);
      }
      if (seg.kind === "match") {
        const m = seg.match!;
        expect(m.sides.length).toBeGreaterThanOrEqual(2);
        for (const side of m.sides) expect(side.members.length).toBeGreaterThan(0);
        expect(m.winnerSide).not.toBeNull();
        expect(m.winnerSide!).toBeGreaterThanOrEqual(0);
        expect(m.winnerSide!).toBeLessThan(m.sides.length);
        expect(m.titleId).toBeNull(); // the belt is only up at the blowoff PPV
      } else {
        expect(seg.angle!.beats.length).toBeGreaterThan(0);
        for (const beat of seg.angle!.beats) {
          expect(beat.durationMin).toBeGreaterThan(0);
          expect(beat.participants.length).toBeGreaterThan(0);
        }
      }
    }
    const last = cu.segments[cu.segments.length - 1]!;
    expect(last.kind).toBe("match");
    expect(last.match!.mainEvent).toBe(true);
    expect(cu.advertised).toEqual([...seen].sort());
    // The AI never mutates its inputs: the show is carded via actions only.
    expect(ctx.shows["s1"]!.segments).toHaveLength(0);
    expect(ctx.company.programs).toHaveLength(0);
  });

  it("never books an injured worker", () => {
    const actions = aiDailyTick(makeCtx());
    for (const cu of actions.cardUpdates) {
      for (const seg of cu.segments) {
        expect(segmentParticipants(seg)).not.toContain(INJURED);
      }
      expect(cu.advertised).not.toContain(INJURED);
    }
    const prog = actions.programUpdates.find((p) => p.titleId === WORLD_TITLE);
    expect(prog!.participants).not.toContain(INJURED);
  });

  it("offers a re-sign to a pushed worker whose contract is expiring", () => {
    const actions = aiDailyTick(makeCtx());
    const offer = actions.offers.find((o) => o.personId === EXPIRING);
    expect(offer).toBeDefined();
    expect(ERA.allowedContractKinds).toContain(offer!.kind);
    expect(offer!.kind).toBe("exclusive"); // national + upper push + era allows
    expect(offer!.exclusive).toBe(true);
    expect(offer!.weeklyDownsideCents).toBeGreaterThan(0);
    expect(Number.isSafeInteger(offer!.weeklyDownsideCents)).toBe(true);
    expect(Number.isSafeInteger(offer!.perAppearanceCents)).toBe(true);
    expect(offer!.lengthMonths).toBeGreaterThan(0);
    expect(
      actions.decisions.some(
        (d) => d.action === `offer-contract:${EXPIRING}` && d.reason === "re-sign:expiring",
      ),
    ).toBe(true);
    // Nobody gets cut while cash is healthy.
    expect(actions.releaseContractIds).toEqual([]);
  });

  it("is deterministic: cloned rng states produce identical actions", () => {
    const seedStream = RngStream.fromSeed("test-world", `ai:${COMPANY}`);
    const state = seedStream.getState();
    const a1 = aiDailyTick(makeCtx(new RngStream([...state] as RngState)));
    const a2 = aiDailyTick(makeCtx(new RngStream([...state] as RngState)));
    expect(a1).toEqual(a2);
  });

  it("persists a live program across ticks instead of recreating it", () => {
    const first = aiDailyTick(makeCtx());
    const prog = first.programUpdates.find((p) => p.titleId === WORLD_TITLE)!;

    const ctx2 = makeCtx();
    ctx2.company.programs = first.programUpdates.map((p) => ({
      ...p,
      participants: [...p.participants],
    }));
    ctx2.date = "1997-01-07";
    const second = aiDailyTick(ctx2);

    const worldProgs = second.programUpdates.filter((p) => p.titleId === WORLD_TITLE);
    expect(worldProgs).toHaveLength(1);
    expect(worldProgs[0]!.id).toBe(prog.id);
    expect(worldProgs[0]!.participants).toEqual(prog.participants);
    expect(worldProgs[0]!.intendedWinner).toBe(prog.intendedWinner);
    expect(second.decisions.some((d) => d.action.startsWith("create-program:"))).toBe(false);
  });
});
