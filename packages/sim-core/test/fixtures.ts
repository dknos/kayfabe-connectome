import type {
  AttributeKey,
  EvidenceSummary,
  SeededAttribute,
  SimOptions,
  SnapshotCompany,
  SnapshotTitle,
  SnapshotWorker,
  UniverseSnapshot,
} from "@kayfabe/sim-contract";
import { ATTRIBUTE_KEYS } from "@kayfabe/sim-contract";

/**
 * Synthetic snapshot for engine tests: two national companies at war plus an
 * indie, thirty workers, world titles with holders. No corpus required.
 */

function seeded(value: number): SeededAttribute {
  return { value, confidence: "medium", method: "fixture@1", inputs: ["fixture"] };
}

function attrBlock(base: number): Record<AttributeKey, SeededAttribute> {
  const out = {} as Record<AttributeKey, SeededAttribute>;
  for (const k of ATTRIBUTE_KEYS) out[k] = seeded(Math.max(20, Math.min(95, base)));
  return out;
}

function evidence(personId: string, matches: number): EvidenceSummary {
  return {
    personId,
    matches,
    firstYear: 1988,
    lastYear: 1996,
    careerYears: 8,
    distinctOpponents: Math.min(matches, 60),
    winShare: 0.5,
    mainEventShare: matches > 400 ? 0.4 : 0.1,
    titleMatchShare: matches > 400 ? 0.2 : 0.02,
    promoLevelMix: { national: 0.8, regional: 0.2, indie: 0 },
    formMix: { singles: 0.7, tag: 0.25, multi: 0.05 },
    meltzer: null,
    recentDensity: 80,
    topPromotions: [],
  };
}

export function makeWorker(personId: string, name: string, base: number): SnapshotWorker {
  return {
    personId,
    displayName: name,
    personas: [{ corpusId: personId, name }],
    seeded: attrBlock(base),
    awarenessNational: Math.min(90, base + 5),
    affinityNational: Math.max(0, base - 40),
    credibility: base,
    prestige: Math.max(10, base - 20),
    styles: ["allrounder"],
    alignment: "neutral",
    debutYear: 1988,
    experienceYears: 8,
    evidence: evidence(personId, base * 10),
    historyNote: `${base * 10} recorded matches 1988–1996.`,
  };
}

export function makeSnapshot(): UniverseSnapshot {
  const workers: SnapshotWorker[] = [];
  const apexRoster: string[] = [];
  const rivalRoster: string[] = [];
  for (let i = 0; i < 14; i++) {
    const id = `p:9${String(100 + i)}`;
    workers.push(makeWorker(id, `Apex Star ${i + 1}`, 82 - i * 3));
    apexRoster.push(id);
  }
  for (let i = 0; i < 14; i++) {
    const id = `p:9${String(200 + i)}`;
    workers.push(makeWorker(id, `Rival Ace ${i + 1}`, 80 - i * 3));
    rivalRoster.push(id);
  }
  const indieRoster: string[] = [];
  for (let i = 0; i < 6; i++) {
    const id = `p:9${String(300 + i)}`;
    workers.push(makeWorker(id, `Indie Kid ${i + 1}`, 45 - i * 2));
    indieRoster.push(id);
  }

  const companies: SnapshotCompany[] = [
    {
      companyId: "pr:9001",
      name: "Apex Wrestling Alliance",
      shortName: "AWA-X",
      lineageIds: ["pr:9001"],
      sizeTier: "national",
      detailTier: "full",
      homeMarketId: "mkt:nyc",
      rosterPersonIds: apexRoster,
      titleIds: ["t:9001"],
      awarenessNational: 70,
      affinityNational: 25,
      prestige: 70,
      productDna: {
        athleticCompetition: 50,
        characterSpectacle: 75,
        serializedStory: 70,
        violence: 35,
        comedy: 30,
        starDriven: 80,
        nationalAmbition: 90,
      },
      playable: true,
    },
    {
      companyId: "pr:9002",
      name: "Continental Grand Prix",
      shortName: "CGP",
      lineageIds: ["pr:9002"],
      sizeTier: "national",
      detailTier: "full",
      homeMarketId: "mkt:atlanta",
      rosterPersonIds: rivalRoster,
      titleIds: ["t:9002"],
      awarenessNational: 68,
      affinityNational: 22,
      prestige: 68,
      productDna: {
        athleticCompetition: 75,
        characterSpectacle: 50,
        serializedStory: 55,
        violence: 40,
        comedy: 20,
        starDriven: 75,
        nationalAmbition: 88,
      },
      playable: true,
    },
    {
      companyId: "pr:9003",
      name: "Boardwalk Hardcore",
      shortName: "BWH",
      lineageIds: ["pr:9003"],
      sizeTier: "indie",
      detailTier: "standard",
      homeMarketId: "mkt:philadelphia",
      rosterPersonIds: indieRoster,
      titleIds: [],
      awarenessNational: 25,
      affinityNational: 15,
      prestige: 30,
      productDna: {
        athleticCompetition: 60,
        characterSpectacle: 40,
        serializedStory: 45,
        violence: 90,
        comedy: 25,
        starDriven: 40,
        nationalAmbition: 35,
      },
      playable: false,
    },
  ];

  const titles: SnapshotTitle[] = [
    {
      titleId: "t:9001",
      name: "AWA-X World Championship",
      companyId: "pr:9001",
      tier: "world",
      holderIds: [apexRoster[0]!],
      holderNames: ["Apex Star 1"],
      preStartReigns: [
        { holderIds: [apexRoster[1]!], holderNames: ["Apex Star 2"], fromDay: 34500, toDay: 35200 },
        { holderIds: [apexRoster[0]!], holderNames: ["Apex Star 1"], fromDay: 35200, toDay: null },
      ],
      prestige: 85,
      lineageComplete: true,
    },
    {
      titleId: "t:9002",
      name: "CGP World Championship",
      companyId: "pr:9002",
      tier: "world",
      holderIds: [rivalRoster[0]!],
      holderNames: ["Rival Ace 1"],
      preStartReigns: [
        { holderIds: [rivalRoster[0]!], holderNames: ["Rival Ace 1"], fromDay: 35000, toDay: null },
      ],
      prestige: 82,
      lineageComplete: true,
    },
  ];

  return {
    meta: {
      schemaVersion: 1,
      builderVersion: "fixture@1",
      bundleHash: "fixture-bundle",
      crosswalkVersion: 1,
      startDate: "1997-01-06",
      startDay: 35435,
      rosterInference: {
        method: "fixture",
        windowDays: 540,
        minAppearances: 6,
        maxDaysSinceLast: 120,
      },
      seederMethod: "fixture@1",
      snapshotHash: "fixture-snapshot-hash",
    },
    markets: [
      { id: "mkt:nyc", name: "New York Tri-State", region: "Northeast", population: 18000000, wrestlingInterest: 72, economicStrength: 82 },
      { id: "mkt:atlanta", name: "Atlanta / Georgia", region: "Southeast", population: 5000000, wrestlingInterest: 74, economicStrength: 70 },
      { id: "mkt:philadelphia", name: "Philadelphia", region: "Northeast", population: 6000000, wrestlingInterest: 78, economicStrength: 66 },
    ],
    venues: [
      { id: "v:9001", name: "Crown Square Garden", marketId: "mkt:nyc", capacity: 15000, prestige: 90, rentalCents: 4_000_000 },
      { id: "v:9002", name: "Peachtree Coliseum", marketId: "mkt:atlanta", capacity: 12000, prestige: 75, rentalCents: 2_500_000 },
      { id: "v:9003", name: "Front Street Armory", marketId: "mkt:philadelphia", capacity: 1800, prestige: 55, rentalCents: 300_000 },
    ],
    companies,
    workers,
    titles,
    dataHealth: {
      aliasSuspects: [],
      titlesWithoutLineage: 0,
      workersLowConfidence: 0,
      quarantinedRecords: 0,
      notes: ["fixture universe"],
    },
  };
}

export function makeOptions(overrides?: Partial<SimOptions>): SimOptions {
  return {
    historicalMode: "open_alternate",
    playerRole: "owner_booker",
    playerCompanyId: "pr:9001",
    startDate: "1997-01-06",
    worldSeed: "test-seed-1",
    scoutingFog: true,
    abstractTierEnabled: true,
    ...overrides,
  };
}
