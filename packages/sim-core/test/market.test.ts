import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_KEYS,
  type AttributeBlock,
  type AttributeKey,
  type CompanyState,
  type ContractState,
  type EraProfile,
  type SeededAttribute,
  type WorkerState,
} from "@kayfabe/sim-contract";
import { aiOfferFor, askingPrice, evaluateOffer, type OfferTerms } from "../src/market/index";
import { RngStream } from "../src/rng";

function makeAttributes(overrides: Partial<AttributeBlock> = {}): AttributeBlock {
  const block = {} as AttributeBlock;
  for (const key of ATTRIBUTE_KEYS) block[key] = 50;
  return { ...block, ...overrides };
}

function makeScouted(attributes: AttributeBlock): Record<AttributeKey, SeededAttribute> {
  const scouted = {} as Record<AttributeKey, SeededAttribute>;
  for (const key of ATTRIBUTE_KEYS) {
    scouted[key] = { value: attributes[key], confidence: "medium", method: "test", inputs: [] };
  }
  return scouted;
}

function makeWorker(overrides: Partial<WorkerState> = {}): WorkerState {
  const attributes = makeAttributes();
  return {
    personId: "p:1",
    name: "Test Worker",
    personaNames: ["Test Worker"],
    attributes,
    scouted: makeScouted(attributes),
    styles: ["allrounder"],
    alignment: "neutral",
    push: "midcard",
    morale: 50,
    momentum: 0,
    credibility: 50,
    prestige: 55,
    standing: { awarenessNational: 60, affinityNational: 20, marketDelta: {} },
    condition: { fatigue: 0, wearMinutes: 0, injury: null, daysSinceMatch: 7 },
    debutYear: 1989,
    experienceYears: 8,
    historyNote: "",
    active: true,
    ...overrides,
  };
}

function makeCompany(overrides: Partial<CompanyState> = {}): CompanyState {
  return {
    id: "pr:1",
    name: "Test Wrestling",
    shortName: "TW",
    active: true,
    cashCents: 10_000_000_000,
    homeMarketId: "mkt:1",
    productDna: {
      athleticCompetition: 50,
      characterSpectacle: 50,
      serializedStory: 50,
      violence: 50,
      comedy: 50,
      starDriven: 50,
      nationalAmbition: 50,
    },
    prestige: 50,
    momentum: 0,
    standing: { awarenessNational: 50, affinityNational: 10, marketDelta: {} },
    sizeTier: "regional",
    detailTier: "full",
    tvDeal: null,
    ppvWeek: null,
    aiControlled: true,
    aiProfile: {
      riskTolerance: 50,
      starBias: "proven",
      youthBias: 0,
      spendingDiscipline: 50,
      planLoyalty: 50,
    },
    programs: [],
    objectives: [],
    titleIds: [],
    nameHistory: [],
    ...overrides,
  };
}

const warEra: EraProfile = {
  id: "era-national-war",
  label: "The National War",
  appliesFrom: "1995-01-01",
  appliesTo: "2001-12-31",
  tvAvailable: true,
  ppvAvailable: true,
  streamingAvailable: false,
  weeklyTvRightsCents: { national: 25000000, regional: 2500000, indie: 0 },
  ppvBuyRateBase: 0.018,
  ppvPriceCents: 2995,
  ticketPriceTypicalCents: 2200,
  allowedContractKinds: ["handshake", "appearance", "written", "exclusive"],
  showOverheadCents: { national: 9000000, regional: 1400000, indie: 220000 },
  weeklyOverheadCents: { national: 18000000, regional: 2800000, indie: 300000 },
  newsSpeed: 60,
};

const territoryEra: EraProfile = {
  ...warEra,
  id: "era-territory",
  label: "Territory Era",
  appliesFrom: "1947-01-01",
  appliesTo: "1983-12-31",
  ppvAvailable: false,
  ticketPriceTypicalCents: 800,
  allowedContractKinds: ["handshake", "appearance"],
};

function makeContract(companyId: string, personId: string): ContractState {
  return {
    id: "ct:1",
    personId,
    companyId,
    kind: "written",
    exclusive: false,
    startDate: "1995-01-01",
    endDate: "1997-03-01",
    perAppearanceCents: 100_000,
    weeklyDownsideCents: 300_000,
    promises: [],
    status: "active",
    signedDate: "1995-01-01",
  };
}

function rng(name: string): RngStream {
  return RngStream.fromSeed("negotiation-test", name);
}

function writtenOfferAt(worker: WorkerState, era: EraProfile, share: number): OfferTerms {
  const ask = askingPrice(worker, era, "written");
  return {
    kind: "written",
    lengthMonths: 12,
    perAppearanceCents: Math.round(ask.perAppearanceCents * share),
    weeklyDownsideCents: Math.round(ask.weeklyDownsideCents * share),
    exclusive: false,
  };
}

describe("askingPrice", () => {
  it("is deterministic and era-scaled", () => {
    const worker = makeWorker();
    const a = askingPrice(worker, warEra, "written");
    const b = askingPrice(worker, warEra, "written");
    expect(a).toEqual(b);
    const territory = askingPrice(worker, territoryEra, "written");
    expect(a.perAppearanceCents).toBeGreaterThan(territory.perAppearanceCents);
    expect(a.weeklyDownsideCents).toBeGreaterThan(territory.weeklyDownsideCents);
  });

  it("charges more for bigger names and pays no downside on per-shot deals", () => {
    const jobber = makeWorker({
      prestige: 10,
      standing: { awarenessNational: 5, affinityNational: 0, marketDelta: {} },
    });
    const star = makeWorker({
      prestige: 85,
      standing: { awarenessNational: 90, affinityNational: 60, marketDelta: {} },
    });
    expect(askingPrice(star, warEra, "written").perAppearanceCents).toBeGreaterThan(
      askingPrice(jobber, warEra, "written").perAppearanceCents,
    );
    expect(askingPrice(makeWorker(), warEra, "appearance").weeklyDownsideCents).toBe(0);
  });
});

describe("evaluateOffer", () => {
  it("accepts a fair offer at asking price from a neutral worker", () => {
    const worker = makeWorker();
    const out = evaluateOffer({
      worker,
      company: makeCompany(),
      offer: writtenOfferAt(worker, warEra, 1),
      era: warEra,
      rivalInterest: 0,
      currentContract: null,
      rng: rng("fair"),
    });
    expect(out.accepted).toBe(true);
    expect(out.counter).toBeNull();
    expect(out.reasons.length).toBeGreaterThan(0);
  });

  it("rejects a lowball with a plain-language money reason", () => {
    const worker = makeWorker();
    const out = evaluateOffer({
      worker,
      company: makeCompany(),
      offer: writtenOfferAt(worker, warEra, 0.4),
      era: warEra,
      rivalInterest: 0,
      currentContract: null,
      rng: rng("lowball"),
    });
    expect(out.accepted).toBe(false);
    expect(out.counter).toBeNull();
    expect(out.reasons.some((r) => r.includes("well below what similar names earn"))).toBe(true);
    for (const reason of out.reasons) expect(reason).not.toMatch(/\d/);
  });

  it("counters a near-miss with terms between the offer and the asking price", () => {
    const worker = makeWorker();
    const ask = askingPrice(worker, warEra, "written");
    const offer = { ...writtenOfferAt(worker, warEra, 0.8), lengthMonths: 18 };
    const out = evaluateOffer({
      worker,
      company: makeCompany(),
      offer,
      era: warEra,
      rivalInterest: 0,
      currentContract: null,
      rng: rng("nearmiss"),
    });
    expect(out.accepted).toBe(false);
    expect(out.counter).not.toBeNull();
    const counter = out.counter!;
    expect(counter.perAppearanceCents).toBeGreaterThan(offer.perAppearanceCents);
    expect(counter.perAppearanceCents).toBeLessThan(ask.perAppearanceCents);
    expect(counter.weeklyDownsideCents).toBeGreaterThan(offer.weeklyDownsideCents);
    expect(counter.weeklyDownsideCents).toBeLessThan(ask.weeklyDownsideCents);
    expect([3, 6, 12, 18, 24, 36]).toContain(counter.lengthMonths);
  });

  it("loyalty: a happy worker re-signs at a discount a stranger turns down", () => {
    const worker = makeWorker({ morale: 90, attributes: makeAttributes({ loyalty: 90 }) });
    const company = makeCompany({ prestige: 40 });
    const offer = writtenOfferAt(worker, warEra, 0.88);
    const reSign = evaluateOffer({
      worker,
      company,
      offer,
      era: warEra,
      rivalInterest: 0,
      currentContract: makeContract(company.id, worker.personId),
      rng: rng("resign"),
    });
    expect(reSign.accepted).toBe(true);
    const stranger = evaluateOffer({
      worker,
      company,
      offer,
      era: warEra,
      rivalInterest: 0,
      currentContract: null,
      rng: rng("stranger"),
    });
    expect(stranger.accepted).toBe(false);
  });

  it("demands a premium for exclusivity on otherwise-fair money", () => {
    const worker = makeWorker();
    const company = makeCompany();
    const fair = writtenOfferAt(worker, warEra, 1);
    const nonExclusive = evaluateOffer({
      worker,
      company,
      offer: fair,
      era: warEra,
      rivalInterest: 0,
      currentContract: null,
      rng: rng("nonexclusive"),
    });
    expect(nonExclusive.accepted).toBe(true);
    const exclusive = evaluateOffer({
      worker,
      company,
      offer: { ...fair, exclusive: true },
      era: warEra,
      rivalInterest: 0,
      currentContract: null,
      rng: rng("exclusive"),
    });
    expect(exclusive.accepted).toBe(false);
    expect(exclusive.reasons.some((r) => r.includes("exclusive"))).toBe(true);
  });

  it("flags a rival when the market is hot", () => {
    const worker = makeWorker();
    const out = evaluateOffer({
      worker,
      company: makeCompany(),
      offer: writtenOfferAt(worker, warEra, 0.8),
      era: warEra,
      rivalInterest: 80,
      currentContract: null,
      rng: rng("rival"),
    });
    expect(out.accepted).toBe(false);
    expect(out.reasons).toContain("a rival is offering more");
  });

  it("rejects era-inappropriate deals with an era reason", () => {
    const worker = makeWorker();
    const company = makeCompany();
    const exclusiveFlag = evaluateOffer({
      worker,
      company,
      offer: {
        kind: "appearance",
        lengthMonths: 6,
        perAppearanceCents: 1_000_000,
        weeklyDownsideCents: 0,
        exclusive: true,
      },
      era: territoryEra,
      rivalInterest: 0,
      currentContract: null,
      rng: rng("era-flag"),
    });
    expect(exclusiveFlag.accepted).toBe(false);
    expect(exclusiveFlag.counter).toBeNull();
    expect(exclusiveFlag.reasons.some((r) => r.includes("era"))).toBe(true);
    const exclusiveKind = evaluateOffer({
      worker,
      company,
      offer: {
        kind: "exclusive",
        lengthMonths: 36,
        perAppearanceCents: 1_000_000,
        weeklyDownsideCents: 2_000_000,
        exclusive: true,
      },
      era: territoryEra,
      rivalInterest: 0,
      currentContract: null,
      rng: rng("era-kind"),
    });
    expect(exclusiveKind.accepted).toBe(false);
    expect(exclusiveKind.counter).toBeNull();
    expect(exclusiveKind.reasons.some((r) => r.includes("era"))).toBe(true);
  });

  it("is deterministic given a cloned rng state", () => {
    const worker = makeWorker();
    const company = makeCompany();
    const offer = { ...writtenOfferAt(worker, warEra, 0.8), lengthMonths: 18 };
    const stream = rng("determinism");
    for (let i = 0; i < 17; i++) stream.next();
    const clone = new RngStream(stream.getState());
    const ctx = {
      worker,
      company,
      offer,
      era: warEra,
      rivalInterest: 30,
      currentContract: null,
    };
    const a = evaluateOffer({ ...ctx, rng: stream });
    const b = evaluateOffer({ ...ctx, rng: clone });
    expect(a).toEqual(b);
  });
});

describe("aiOfferFor", () => {
  it("is deterministic and offers era-allowed kinds only", () => {
    const worker = makeWorker();
    const national = makeCompany({ sizeTier: "national", prestige: 80 });
    const warOffer = aiOfferFor(worker, national, warEra);
    expect(warOffer).toEqual(aiOfferFor(worker, national, warEra));
    expect(warEra.allowedContractKinds).toContain(warOffer.kind);
    expect(warOffer.kind).toBe("exclusive");
    expect(warOffer.exclusive).toBe(true);
    expect(warOffer.lengthMonths).toBeGreaterThan(0);

    const territoryOffer = aiOfferFor(worker, national, territoryEra);
    expect(territoryEra.allowedContractKinds).toContain(territoryOffer.kind);
    expect(territoryOffer.exclusive).toBe(false);
    expect(territoryOffer.weeklyDownsideCents).toBe(0);
  });

  it("keeps the weekly commitment within the company's means", () => {
    const star = makeWorker({
      prestige: 85,
      momentum: 40,
      standing: { awarenessNational: 90, affinityNational: 60, marketDelta: {} },
    });
    const broke = makeCompany({ sizeTier: "indie", cashCents: 5_200_000 });
    const offer = aiOfferFor(star, broke, warEra);
    const weeklyCap = Math.floor(broke.cashCents / 26);
    const weekly = offer.weeklyDownsideCents + 2 * offer.perAppearanceCents;
    expect(weekly).toBeLessThanOrEqual(weeklyCap);
    expect(offer.perAppearanceCents).toBeGreaterThan(0);
    expect(warEra.allowedContractKinds).toContain(offer.kind);
    expect(Number.isSafeInteger(offer.perAppearanceCents)).toBe(true);
    expect(Number.isSafeInteger(offer.weeklyDownsideCents)).toBe(true);
  });
});
