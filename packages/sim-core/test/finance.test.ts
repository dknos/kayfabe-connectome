import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_KEYS,
  DNA_AXES,
  type AttributeBlock,
  type AttributeKey,
  type CompanyState,
  type ContractState,
  type Market,
  type ProductDna,
  type SeededAttribute,
  type ShowPlan,
  type Transaction,
  type Venue,
  type WorkerState,
} from "@kayfabe/sim-contract";
import { RngStream } from "../src/rng";
import {
  MARKETS,
  applyTransactions,
  auditLedger,
  estimateAttendance,
  forecastShow,
  resolveEra,
  runWeeklyFinances,
  settleShow,
  type AttendanceInputs,
} from "../src/finance/index";

function attributeBlock(v: number): AttributeBlock {
  const out = {} as AttributeBlock;
  for (const k of ATTRIBUTE_KEYS) out[k] = v;
  return out;
}

function scoutedBlock(v: number): Record<AttributeKey, SeededAttribute> {
  const out = {} as Record<AttributeKey, SeededAttribute>;
  for (const k of ATTRIBUTE_KEYS) {
    out[k] = { value: v, confidence: "low", method: "test", inputs: [] };
  }
  return out;
}

function productDna(v: number): ProductDna {
  const out = {} as ProductDna;
  for (const a of DNA_AXES) out[a] = v;
  return out;
}

function mkWorker(personId: string, awareness: number, affinity: number): WorkerState {
  return {
    personId,
    name: personId,
    personaNames: [personId],
    attributes: attributeBlock(60),
    scouted: scoutedBlock(60),
    styles: ["allrounder"],
    alignment: "face",
    push: "midcard",
    morale: 70,
    momentum: 0,
    credibility: 60,
    prestige: 50,
    standing: { awarenessNational: awareness, affinityNational: affinity, marketDelta: {} },
    condition: { fatigue: 0, wearMinutes: 0, injury: null, daysSinceMatch: 7 },
    debutYear: 1988,
    experienceYears: 9,
    historyNote: "",
    active: true,
  };
}

function mkCompany(over: Partial<CompanyState> = {}): CompanyState {
  return {
    id: "cmp:a",
    name: "Test Wrestling Alliance",
    shortName: "TWA",
    active: true,
    cashCents: 0,
    homeMarketId: "mkt:test",
    productDna: productDna(50),
    prestige: 50,
    momentum: 0,
    standing: { awarenessNational: 60, affinityNational: 20, marketDelta: {} },
    sizeTier: "regional",
    detailTier: "full",
    tvDeal: null,
    ppvWeek: null,
    aiControlled: false,
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
    nameHistory: [{ name: "Test Wrestling Alliance", from: "1997-01-06" }],
    ...over,
  };
}

function mkShow(over: Partial<ShowPlan> = {}): ShowPlan {
  return {
    id: "show-000001",
    companyId: "cmp:a",
    name: "Test Night",
    date: "1997-01-06",
    venueId: "ven:test",
    marketId: "mkt:test",
    showType: "tv",
    ticketPriceCents: 2200,
    segments: [],
    advertised: [],
    status: "scheduled",
    report: null,
    ...over,
  };
}

function mkVenue(capacity: number, over: Partial<Venue> = {}): Venue {
  return {
    id: "ven:test",
    name: "Test Arena",
    marketId: "mkt:test",
    capacity,
    prestige: 50,
    rentalCents: 500_000,
    ...over,
  };
}

function mkContract(over: Partial<ContractState> = {}): ContractState {
  return {
    id: "con-000001",
    personId: "p:1",
    companyId: "cmp:a",
    kind: "appearance",
    exclusive: false,
    startDate: "1996-06-01",
    endDate: null,
    perAppearanceCents: 25_000,
    weeklyDownsideCents: 0,
    promises: [],
    status: "active",
    signedDate: "1996-06-01",
    ...over,
  };
}

const TEST_MARKET: Market = {
  id: "mkt:test",
  name: "Test Market",
  region: "Test",
  population: 5_000_000,
  wrestlingInterest: 70,
  economicStrength: 60,
};

const ERA_1997 = resolveEra("1997-01-06");

function baseInputs(over: Partial<AttendanceInputs> = {}): AttendanceInputs {
  return {
    company: mkCompany(),
    show: mkShow(),
    venue: mkVenue(50_000),
    market: TEST_MARKET,
    advertisedWorkers: [],
    era: ERA_1997,
    rng: null,
    ...over,
  };
}

function txCounter(): () => string {
  let n = 0;
  return () => `tx-${String(++n).padStart(6, "0")}`;
}

describe("era resolution", () => {
  it("picks era-national-war for 1997-01-06", () => {
    expect(ERA_1997.id).toBe("era-national-war");
    expect(ERA_1997.ppvAvailable).toBe(true);
  });

  it("respects window boundaries", () => {
    expect(resolveEra("1994-12-31").id).toBe("era-national-expansion");
    expect(resolveEra("1995-01-01").id).toBe("era-national-war");
    expect(resolveEra("1980-06-01").id).toBe("era-territory");
    expect(resolveEra("2026-12-31").id).toBe("era-streaming");
  });

  it("throws outside all windows", () => {
    expect(() => resolveEra("1946-12-31")).toThrow(/no era profile/);
    expect(() => resolveEra("not-a-date")).toThrow(/invalid ISO date/);
  });
});

describe("markets dataset", () => {
  it("loads all markets sorted by id", () => {
    expect(MARKETS.length).toBe(12);
    const ids = MARKETS.map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("attendance demand", () => {
  it("is deterministic without rng", () => {
    const a = estimateAttendance(baseInputs());
    const b = estimateAttendance(baseInputs());
    expect(a).toBe(b);
    expect(Number.isSafeInteger(a)).toBe(true);
    expect(a).toBeGreaterThan(0);
  });

  it("is deterministic with the same rng stream state", () => {
    const a = estimateAttendance(baseInputs({ rng: RngStream.fromSeed("w", "crowd") }));
    const b = estimateAttendance(baseInputs({ rng: RngStream.fromSeed("w", "crowd") }));
    expect(a).toBe(b);
  });

  it("rng noise stays within the ±8% band of the expectation", () => {
    const expectation = estimateAttendance(baseInputs());
    for (let i = 0; i < 25; i++) {
      const noisy = estimateAttendance(baseInputs({ rng: RngStream.fromSeed("w", `roll-${i}`) }));
      expect(Math.abs(noisy - expectation)).toBeLessThanOrEqual(expectation * 0.08 + 2);
    }
  });

  it("responds monotonically to company awareness", () => {
    const low = estimateAttendance(
      baseInputs({ company: mkCompany({ standing: { awarenessNational: 40, affinityNational: 20, marketDelta: {} } }) }),
    );
    const high = estimateAttendance(
      baseInputs({ company: mkCompany({ standing: { awarenessNational: 70, affinityNational: 20, marketDelta: {} } }) }),
    );
    expect(high).toBeGreaterThan(low);
  });

  it("responds monotonically to card appeal", () => {
    const cold = estimateAttendance(baseInputs());
    const oneName = estimateAttendance(baseInputs({ advertisedWorkers: [mkWorker("p:1", 90, 70)] }));
    const stacked = estimateAttendance(
      baseInputs({
        advertisedWorkers: [mkWorker("p:1", 90, 70), mkWorker("p:2", 85, 60), mkWorker("p:3", 80, -65)],
      }),
    );
    expect(oneName).toBeGreaterThan(cold);
    expect(stacked).toBeGreaterThan(oneName);
  });

  it("famous heels draw: negative affinity still counts through |affinity|", () => {
    const heel = estimateAttendance(baseInputs({ advertisedWorkers: [mkWorker("p:1", 90, -70)] }));
    const face = estimateAttendance(baseInputs({ advertisedWorkers: [mkWorker("p:1", 90, 70)] }));
    expect(heel).toBe(face);
  });

  it("overpricing reduces attendance", () => {
    const typical = estimateAttendance(baseInputs());
    const doubled = estimateAttendance(baseInputs({ show: mkShow({ ticketPriceCents: 4664 }) }));
    expect(doubled).toBeLessThan(typical);
    // Reference price for this market is ~2332c; double it and demand halves.
    expect(doubled).toBeLessThan(typical * 0.6);
  });

  it("orders show types house < tv < ppv", () => {
    const house = estimateAttendance(baseInputs({ show: mkShow({ showType: "house" }) }));
    const tv = estimateAttendance(baseInputs({ show: mkShow({ showType: "tv" }) }));
    const ppv = estimateAttendance(baseInputs({ show: mkShow({ showType: "ppv" }) }));
    expect(house).toBeLessThan(tv);
    expect(tv).toBeLessThan(ppv);
  });

  it("clamps to venue capacity", () => {
    const inputs = baseInputs({
      venue: mkVenue(500),
      advertisedWorkers: [mkWorker("p:1", 95, 80), mkWorker("p:2", 90, 75), mkWorker("p:3", 88, 70)],
    });
    expect(estimateAttendance(inputs)).toBe(500);
    expect(estimateAttendance({ ...inputs, venue: mkVenue(0) })).toBe(0);
  });
});

describe("show forecast", () => {
  it("ranges contain the rng-null expectation even when an rng is supplied", () => {
    const inputs = baseInputs({ advertisedWorkers: [mkWorker("p:1", 80, 50)] });
    const expectation = estimateAttendance(inputs);
    const forecast = forecastShow({ ...inputs, rng: RngStream.fromSeed("w", "crowd") });
    const [lo, hi] = forecast.attendanceRange;
    expect(lo).toBeLessThanOrEqual(expectation);
    expect(hi).toBeGreaterThanOrEqual(expectation);
    expect(forecast.gateCentsRange[0]).toBe(lo * inputs.show.ticketPriceCents);
    expect(forecast.gateCentsRange[1]).toBe(hi * inputs.show.ticketPriceCents);
    expect(forecast.qualityRange[0]).toBeLessThanOrEqual(forecast.qualityRange[1]);
  });

  it("contains the expectation when demand clamps at capacity", () => {
    const inputs = baseInputs({
      venue: mkVenue(500),
      advertisedWorkers: [mkWorker("p:1", 95, 80), mkWorker("p:2", 90, 75), mkWorker("p:3", 88, 70)],
    });
    const forecast = forecastShow(inputs);
    expect(forecast.attendanceRange[1]).toBe(500);
    expect(forecast.attendanceRange[0]).toBeLessThanOrEqual(500);
    expect(forecast.warnings.some((w) => /sellout/i.test(w))).toBe(true);
  });

  it("warns on missing advertised names", () => {
    const forecast = forecastShow(baseInputs());
    expect(forecast.warnings.some((w) => /no advertised names/i.test(w))).toBe(true);
  });

  it("warns on overpricing", () => {
    const forecast = forecastShow(baseInputs({ show: mkShow({ ticketPriceCents: 4664 }) }));
    expect(forecast.warnings.some((w) => /price/i.test(w))).toBe(true);
  });

  it("warns on an oversized venue", () => {
    const forecast = forecastShow(baseInputs({ venue: mkVenue(100_000) }));
    expect(forecast.warnings.some((w) => /too big/i.test(w))).toBe(true);
  });

  it("warns on market saturation", () => {
    const hotMarket: Market = {
      id: "mkt:hot",
      name: "Hot Market",
      region: "Test",
      population: 400_000,
      wrestlingInterest: 90,
      economicStrength: 60,
    };
    const forecast = forecastShow(
      baseInputs({
        market: hotMarket,
        venue: mkVenue(2_000, { marketId: "mkt:hot" }),
        show: mkShow({ showType: "ppv", marketId: "mkt:hot", ticketPriceCents: 2332 }),
        company: mkCompany({ standing: { awarenessNational: 90, affinityNational: 80, marketDelta: {} } }),
        advertisedWorkers: [mkWorker("p:1", 95, 90), mkWorker("p:2", 95, 90), mkWorker("p:3", 95, 90)],
      }),
    );
    expect(forecast.warnings.some((w) => /saturation/i.test(w))).toBe(true);
  });

  it("is deterministic", () => {
    const a = forecastShow(baseInputs({ advertisedWorkers: [mkWorker("p:1", 80, 50)] }));
    const b = forecastShow(baseInputs({ advertisedWorkers: [mkWorker("p:1", 80, 50)] }));
    expect(a).toEqual(b);
  });
});

describe("show settlement", () => {
  const settleArgs = () => ({
    show: mkShow({ showType: "ppv" as const, ticketPriceCents: 2000 }),
    company: mkCompany(),
    venue: mkVenue(10_000),
    attendance: 8_000,
    era: ERA_1997,
    appearanceWorkers: [
      { contract: mkContract({ id: "con-000001", personId: "p:appearance", perAppearanceCents: 25_000 }) },
      {
        contract: mkContract({
          id: "con-000002",
          personId: "p:downside",
          kind: "exclusive",
          exclusive: true,
          perAppearanceCents: 15_000,
          weeklyDownsideCents: 400_000,
        }),
      },
      { contract: mkContract({ id: "con-000003", personId: "p:free", perAppearanceCents: 0 }) },
    ],
    nextTxId: txCounter(),
  });

  it("emits one transaction per line, summing exactly to the lines", () => {
    const result = settleShow(settleArgs());
    expect(result.transactions.length).toBe(result.revenue.length + result.expenses.length);
    const inTotal = result.transactions
      .filter((t) => t.direction === "in")
      .reduce((s, t) => s + t.amountCents, 0);
    const outTotal = result.transactions
      .filter((t) => t.direction === "out")
      .reduce((s, t) => s + t.amountCents, 0);
    expect(inTotal).toBe(result.revenue.reduce((s, l) => s + l.amountCents, 0));
    expect(outTotal).toBe(result.expenses.reduce((s, l) => s + l.amountCents, 0));
    expect(result.profitCents).toBe(inTotal - outTotal);
    const lineByMemo = new Map(
      [...result.revenue, ...result.expenses].map((l) => [l.label, l.amountCents]),
    );
    for (const tx of result.transactions) {
      expect(lineByMemo.get(tx.memo)).toBe(tx.amountCents);
      expect(tx.showId).toBe("show-000001");
      expect(tx.companyId).toBe("cmp:a");
      expect(Number.isSafeInteger(tx.amountCents)).toBe(true);
      expect(tx.amountCents).toBeGreaterThan(0);
    }
  });

  it("computes tickets as attendance × price, and includes ppv + merch on ppv shows", () => {
    const result = settleShow(settleArgs());
    const tickets = result.revenue.find((l) => /ticket/i.test(l.label));
    expect(tickets?.amountCents).toBe(8_000 * 2_000);
    expect(result.revenue.some((l) => /pay-per-view/i.test(l.label))).toBe(true);
    expect(result.revenue.some((l) => /merchandise/i.test(l.label))).toBe(true);
  });

  it("skips ppv revenue for non-ppv shows", () => {
    const args = settleArgs();
    const result = settleShow({ ...args, show: mkShow({ showType: "tv", ticketPriceCents: 2000 }) });
    expect(result.revenue.some((l) => /pay-per-view/i.test(l.label))).toBe(false);
  });

  it("charges venue rental and era production overhead", () => {
    const result = settleShow(settleArgs());
    expect(result.expenses.find((l) => /venue rental/i.test(l.label))?.amountCents).toBe(500_000);
    expect(result.expenses.find((l) => /production/i.test(l.label))?.amountCents).toBe(
      ERA_1997.showOverheadCents.regional,
    );
  });

  it("pays appearance fees but not for exclusive downside talent", () => {
    const result = settleShow(settleArgs());
    const feeTxs = result.transactions.filter((t) => t.category === "appearance_fees");
    expect(feeTxs.length).toBe(1);
    expect(feeTxs[0]!.personId).toBe("p:appearance");
    expect(feeTxs[0]!.amountCents).toBe(25_000);
    expect(result.transactions.some((t) => t.personId === "p:downside")).toBe(false);
    expect(result.transactions.some((t) => t.personId === "p:free")).toBe(false);
  });

  it("rejects a show/company mismatch and non-integer attendance", () => {
    const args = settleArgs();
    expect(() => settleShow({ ...args, company: mkCompany({ id: "cmp:b" }) })).toThrow(/belongs to/);
    expect(() => settleShow({ ...args, attendance: 8000.5 })).toThrow(/attendance/);
  });
});

describe("weekly finances", () => {
  const era = ERA_1997;

  it("pays downside guarantees only for contracts that carry one", () => {
    const company = mkCompany();
    const txs = runWeeklyFinances({
      company,
      activeContracts: [
        mkContract({ id: "con-000002", personId: "p:downside", exclusive: true, weeklyDownsideCents: 400_000 }),
        mkContract({ id: "con-000001", personId: "p:appearance" }),
        mkContract({ id: "con-000003", personId: "p:gone", weeklyDownsideCents: 300_000, status: "terminated" }),
      ],
      era,
      date: "1997-01-10",
      nextTxId: txCounter(),
    });
    const payroll = txs.filter((t) => t.category === "talent_payroll");
    expect(payroll.length).toBe(1);
    expect(payroll[0]!.personId).toBe("p:downside");
    expect(payroll[0]!.amountCents).toBe(400_000);
    expect(payroll[0]!.direction).toBe("out");
  });

  it("charges office overhead by size tier and pays tv rights only with a deal", () => {
    const noDeal = runWeeklyFinances({
      company: mkCompany(),
      activeContracts: [],
      era,
      date: "1997-01-10",
      nextTxId: txCounter(),
    });
    expect(noDeal.find((t) => t.category === "office_overhead")?.amountCents).toBe(
      era.weeklyOverheadCents.regional,
    );
    expect(noDeal.some((t) => t.category === "broadcast_rights")).toBe(false);

    const withDeal = runWeeklyFinances({
      company: mkCompany({
        tvDeal: { programName: "Test Live", dayOfWeek: 0, weeklyRightsCents: 2_500_000, reach: 60 },
      }),
      activeContracts: [],
      era,
      date: "1997-01-10",
      nextTxId: txCounter(),
    });
    const rights = withDeal.find((t) => t.category === "broadcast_rights");
    expect(rights?.direction).toBe("in");
    expect(rights?.amountCents).toBe(2_500_000);
  });

  it("rejects contracts belonging to another company", () => {
    expect(() =>
      runWeeklyFinances({
        company: mkCompany(),
        activeContracts: [mkContract({ companyId: "cmp:other" })],
        era,
        date: "1997-01-10",
        nextTxId: txCounter(),
      }),
    ).toThrow(/belongs to/);
  });
});

describe("ledger balance", () => {
  it("stays balanced across a multi-show, multi-company sequence", () => {
    const nextTxId = txCounter();
    const a = mkCompany({ id: "cmp:a", cashCents: 50_000_000 });
    const b = mkCompany({ id: "cmp:b", cashCents: 2_000_000, sizeTier: "indie", homeMarketId: "mkt:test" });
    const initialCash = { "cmp:a": 50_000_000, "cmp:b": 2_000_000 };
    const ledger: Transaction[] = [];

    const showA1 = settleShow({
      show: mkShow({ id: "show-000001", showType: "tv" }),
      company: a,
      venue: mkVenue(6_000),
      attendance: 4_200,
      era: ERA_1997,
      appearanceWorkers: [{ contract: mkContract({ id: "con-000001", personId: "p:1" }) }],
      nextTxId,
    });
    const showA2 = settleShow({
      show: mkShow({ id: "show-000002", showType: "ppv", ticketPriceCents: 2_500 }),
      company: a,
      venue: mkVenue(12_000),
      attendance: 9_100,
      era: ERA_1997,
      appearanceWorkers: [{ contract: mkContract({ id: "con-000002", personId: "p:2", perAppearanceCents: 60_000 }) }],
      nextTxId,
    });
    const showB1 = settleShow({
      show: mkShow({ id: "show-000003", companyId: "cmp:b", showType: "house", ticketPriceCents: 900 }),
      company: b,
      venue: mkVenue(800, { rentalCents: 40_000 }),
      attendance: 310,
      era: ERA_1997,
      appearanceWorkers: [],
      nextTxId,
    });
    const weeklyA = runWeeklyFinances({
      company: a,
      activeContracts: [
        mkContract({ id: "con-000003", personId: "p:3", exclusive: true, weeklyDownsideCents: 350_000 }),
      ],
      era: ERA_1997,
      date: "1997-01-12",
      nextTxId,
    });
    const weeklyB = runWeeklyFinances({
      company: b,
      activeContracts: [],
      era: ERA_1997,
      date: "1997-01-12",
      nextTxId,
    });

    ledger.push(...showA1.transactions, ...showA2.transactions, ...showB1.transactions, ...weeklyA, ...weeklyB);
    applyTransactions(a, ledger.filter((t) => t.companyId === "cmp:a"));
    applyTransactions(b, ledger.filter((t) => t.companyId === "cmp:b"));

    const companies = { "cmp:a": a, "cmp:b": b };
    expect(auditLedger(companies, ledger, initialCash)).toEqual([]);

    // Cash moved by exactly the settled profit plus the weekly net.
    const weeklyNetA = weeklyA.reduce(
      (s, t) => s + (t.direction === "in" ? t.amountCents : -t.amountCents),
      0,
    );
    expect(a.cashCents).toBe(50_000_000 + showA1.profitCents + showA2.profitCents + weeklyNetA);

    // Corruption is caught, and named.
    a.cashCents += 1;
    const errors = auditLedger(companies, ledger, initialCash);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("cmp:a");
    a.cashCents -= 1;
  });

  it("reports unknown companies and missing initial cash instead of guessing zero", () => {
    const a = mkCompany({ id: "cmp:a", cashCents: 1_000 });
    const ghostTx: Transaction = {
      id: "tx-ghost",
      date: "1997-01-06",
      companyId: "cmp:ghost",
      direction: "in",
      amountCents: 500,
      category: "other_income",
      memo: "ghost",
      showId: null,
      personId: null,
    };
    const errors = auditLedger({ "cmp:a": a }, [ghostTx], {});
    expect(errors.some((e) => /unknown company cmp:ghost/.test(e))).toBe(true);
    expect(errors.some((e) => /cmp:a: no initial cash/.test(e))).toBe(true);
  });

  it("applyTransactions rejects wrong-company and non-positive transactions", () => {
    const a = mkCompany({ id: "cmp:a", cashCents: 0 });
    const tx: Transaction = {
      id: "tx-1",
      date: "1997-01-06",
      companyId: "cmp:b",
      direction: "in",
      amountCents: 100,
      category: "tickets",
      memo: "t",
      showId: null,
      personId: null,
    };
    expect(() => applyTransactions(a, [tx])).toThrow(/belongs to/);
    expect(() => applyTransactions(a, [{ ...tx, companyId: "cmp:a", amountCents: 0 }])).toThrow(/positive/);
    expect(() => applyTransactions(a, [{ ...tx, companyId: "cmp:a", amountCents: 10.5 }])).toThrow(/integer/);
  });
});
