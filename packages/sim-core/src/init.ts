import type {
  AiProfile,
  AttributeBlock,
  AttributeKey,
  CompanyState,
  ContractState,
  IsoDate,
  PushLevel,
  SimOptions,
  SimState,
  SnapshotCompany,
  SnapshotWorker,
  TitleState,
  UniverseSnapshot,
  WorkerState,
} from "@kayfabe/sim-contract";
import { ATTRIBUTE_KEYS } from "@kayfabe/sim-contract";
import { RngHub } from "./rng";
import { addDays, fromEpochDay } from "./dates";
import { nextId } from "./ids";
import { askingPrice } from "./market";
import { resolveEra } from "./finance";

export const ENGINE_VERSION = "0.1.0";
export const SCHEMA_VERSION = 1;

/** Corpus day ints are epoch 1900-01-01; JS civil epoch days are 1970-01-01. */
const DAYS_1900_TO_1970 = 25567;

export function corpusDayToIso(day: number): IsoDate {
  return fromEpochDay(day - DAYS_1900_TO_1970);
}

function initAiProfile(c: SnapshotCompany, rng: RngHub): AiProfile {
  const r = rng.stream("init");
  const dna = c.productDna;
  const starBias =
    dna.starDriven > 70 ? "proven"
    : dna.characterSpectacle > 70 ? "charisma"
    : dna.athleticCompetition > 70 ? "workrate"
    : "size";
  return {
    riskTolerance: r.int(30, 70),
    starBias,
    youthBias: r.int(-20, 40),
    spendingDiscipline: c.sizeTier === "national" ? r.int(35, 55) : r.int(60, 85),
    planLoyalty: r.int(40, 75),
  };
}

function initWorker(w: SnapshotWorker, options: SimOptions, rng: RngHub): WorkerState {
  const r = rng.stream("init");
  // Hidden truth = seeded estimate + confidence-scaled noise (fog of scouting).
  const attributes = {} as AttributeBlock;
  for (const key of ATTRIBUTE_KEYS) {
    const seeded = w.seeded[key as AttributeKey];
    const spread = !options.scoutingFog
      ? 0
      : seeded.confidence === "high" ? 3
      : seeded.confidence === "medium" ? 6
      : seeded.confidence === "low" ? 10
      : 14;
    const noisy = seeded.value + (spread === 0 ? 0 : r.gaussish(0, spread));
    attributes[key as AttributeKey] = Math.max(1, Math.min(99, Math.round(noisy)));
  }
  return {
    personId: w.personId,
    name: w.displayName,
    personaNames: w.personas.map((p) => p.name),
    attributes,
    scouted: w.seeded,
    styles: w.styles,
    alignment: w.alignment,
    push: "midcard",
    morale: r.int(52, 72),
    momentum: 0,
    credibility: w.credibility,
    prestige: w.prestige,
    standing: {
      awarenessNational: w.awarenessNational,
      affinityNational: w.affinityNational,
      marketDelta: {},
    },
    condition: {
      fatigue: 0,
      wearMinutes: 0,
      injury: null,
      daysSinceMatch: 7,
    },
    debutYear: w.debutYear,
    experienceYears: w.experienceYears,
    historyNote: w.historyNote,
    active: true,
  };
}

/** Push levels assigned by within-company awareness percentile. */
function assignPushes(company: CompanyState, workers: Record<string, WorkerState>, roster: string[]): void {
  const ranked = [...roster].sort((a, b) => {
    const d = workers[b]!.standing.awarenessNational - workers[a]!.standing.awarenessNational;
    return d !== 0 ? d : a < b ? -1 : 1;
  });
  ranked.forEach((pid, i) => {
    const pct = i / Math.max(1, ranked.length);
    const push: PushLevel =
      pct < 0.1 ? "main_event" : pct < 0.3 ? "upper" : pct < 0.65 ? "midcard" : pct < 0.85 ? "lower" : "opener";
    workers[pid]!.push = push;
  });
}

/**
 * Create a playable universe from an immutable snapshot. Deterministic:
 * everything random flows through the world-seeded "init" stream.
 */
export function createUniverse(snapshot: UniverseSnapshot, options: SimOptions): SimState {
  const rng = new RngHub(options.worldSeed);
  const era = resolveEra(options.startDate);

  const state: SimState = {
    meta: {
      saveId: `universe-${options.worldSeed}`,
      engineVersion: ENGINE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      worldSeed: options.worldSeed,
      startDate: options.startDate,
      bundleHash: snapshot.meta.bundleHash,
      snapshotHash: snapshot.meta.snapshotHash,
      options,
    },
    currentDate: options.startDate,
    markets: {},
    venues: {},
    workers: {},
    companies: {},
    contracts: {},
    titles: {},
    storylines: {},
    shows: {},
    ledger: [],
    news: [],
    inbox: [],
    eventLog: [],
    aiLedger: [],
    rng: {},
    counters: {},
  };

  for (const m of snapshot.markets) state.markets[m.id] = { ...m };
  for (const v of snapshot.venues) state.venues[v.id] = { ...v };

  const companies = [...snapshot.companies].sort((a, b) => (a.companyId < b.companyId ? -1 : 1));
  for (const sc of companies) {
    const isPlayer = sc.companyId === options.playerCompanyId;
    const startCash =
      sc.sizeTier === "national" ? 500_000_000 : sc.sizeTier === "regional" ? 75_000_000 : 12_000_000;
    const company: CompanyState = {
      id: sc.companyId,
      name: sc.name,
      shortName: sc.shortName,
      active: true,
      cashCents: startCash,
      homeMarketId: sc.homeMarketId,
      productDna: { ...sc.productDna },
      prestige: sc.prestige,
      momentum: 0,
      standing: {
        awarenessNational: sc.awarenessNational,
        affinityNational: sc.affinityNational,
        marketDelta: {},
      },
      sizeTier: sc.sizeTier,
      detailTier: isPlayer ? "full" : sc.detailTier,
      tvDeal:
        era.tvAvailable && sc.sizeTier !== "indie"
          ? {
              programName: `${sc.shortName} Prime`,
              dayOfWeek: sc.sizeTier === "national" ? 0 : 5,
              weeklyRightsCents: era.weeklyTvRightsCents[sc.sizeTier],
              reach: sc.sizeTier === "national" ? 70 : 30,
            }
          : null,
      ppvWeek: era.ppvAvailable && sc.sizeTier === "national" ? 3 : null,
      aiControlled: !isPlayer,
      aiProfile: initAiProfile(sc, rng),
      programs: [],
      objectives: [],
      titleIds: [...sc.titleIds],
      nameHistory: [{ name: sc.name, from: options.startDate }],
    };
    state.companies[company.id] = company;
  }

  const workersSorted = [...snapshot.workers].sort((a, b) => (a.personId < b.personId ? -1 : 1));
  for (const sw of workersSorted) {
    state.workers[sw.personId] = initWorker(sw, options, rng);
  }

  // Contracts: every rostered worker starts under an era-appropriate deal.
  const r = rng.stream("init");
  for (const sc of companies) {
    const company = state.companies[sc.companyId]!;
    for (const pid of [...sc.rosterPersonIds].sort()) {
      const worker = state.workers[pid];
      if (!worker) continue;
      const kind =
        company.sizeTier === "national" && era.allowedContractKinds.includes("written")
          ? "written"
          : "appearance";
      const asking = askingPrice(worker, era, kind);
      const months = r.int(10, 30);
      const contract: ContractState = {
        id: nextId(state, "contract"),
        personId: pid,
        companyId: company.id,
        kind,
        exclusive: kind === "written",
        startDate: options.startDate,
        endDate: addDays(options.startDate, months * 30),
        perAppearanceCents: kind === "appearance" ? asking.perAppearanceCents : 0,
        weeklyDownsideCents: kind === "written" ? asking.weeklyDownsideCents : 0,
        promises: [],
        status: "active",
        signedDate: options.startDate,
      };
      state.contracts[contract.id] = contract;
    }
    assignPushes(company, state.workers, sc.rosterPersonIds.filter((p) => state.workers[p]));
  }

  const titlesSorted = [...snapshot.titles].sort((a, b) => (a.titleId < b.titleId ? -1 : 1));
  for (const st of titlesSorted) {
    const title: TitleState = {
      id: st.titleId,
      name: st.name,
      companyId: st.companyId,
      tier: st.tier,
      holderIds: [...st.holderIds],
      prestige: st.prestige,
      defensesSinceChange: 0,
      lineage: st.preStartReigns.map((reign) => ({
        holderIds: [...reign.holderIds],
        fromDate: corpusDayToIso(reign.fromDay),
        toDate: reign.toDay === null ? null : corpusDayToIso(reign.toDay),
        wonAtShowId: null,
        historical: true,
      })),
      active: true,
    };
    // Current holders' open reign continues into the save.
    if (title.holderIds.length > 0 && title.lineage.length > 0) {
      const last = title.lineage[title.lineage.length - 1]!;
      if (last.toDate !== null) {
        title.lineage.push({
          holderIds: [...title.holderIds],
          fromDate: options.startDate,
          toDate: null,
          wonAtShowId: null,
          historical: true,
        });
      }
    }
    state.titles[title.id] = title;
    // Champions carry main-event push and credibility.
    for (const pid of title.holderIds) {
      const w = state.workers[pid];
      if (w && title.tier === "world") {
        w.push = "main_event";
        w.credibility = Math.max(w.credibility, 70);
      }
    }
  }

  state.news.push({
    id: nextId(state, "news"),
    date: options.startDate,
    kind: "business",
    headline: "A new chapter begins",
    body: `The Ringside Ledger opens its ${options.startDate.slice(0, 4)} coverage. ${
      state.companies[options.playerCompanyId]?.name ?? "Your company"
    } is under new direction.`,
    companyId: options.playerCompanyId,
    personIds: [],
    rumor: false,
  });

  state.eventLog.push({
    seq: 1,
    date: options.startDate,
    type: "universe_created",
    refs: {
      seed: options.worldSeed,
      snapshot: snapshot.meta.snapshotHash,
      companies: companies.length,
      workers: workersSorted.length,
    },
  });
  state.counters["event_seq"] = 1;

  state.rng = rng.serialize();
  return state;
}
