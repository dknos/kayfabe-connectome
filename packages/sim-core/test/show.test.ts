import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_KEYS,
  DNA_AXES,
  type AngleBeat,
  type AttributeBlock,
  type AttributeKey,
  type CompanyState,
  type Market,
  type MatchPlan,
  type ProductDna,
  type ScoreComponent,
  type SeededAttribute,
  type Segment,
  type ShowPlan,
  type ShowType,
  type Storyline,
  type TitleState,
  type Venue,
  type WorkerState,
  type WorkerStyle,
} from "@kayfabe/sim-contract";
import { RngStream } from "../src/rng";
import {
  simulateShowPerformance,
  type ShowSimContext,
} from "../src/show/index";

function mkAttrs(base: number, over: Partial<AttributeBlock> = {}): AttributeBlock {
  const block = Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, base])) as AttributeBlock;
  return { ...block, ...over };
}

function mkWorker(
  id: string,
  opts: {
    base?: number;
    attrs?: Partial<AttributeBlock>;
    styles?: WorkerStyle[];
    fatigue?: number;
    push?: WorkerState["push"];
  } = {},
): WorkerState {
  const attributes = mkAttrs(opts.base ?? 60, opts.attrs);
  const scouted = Object.fromEntries(
    ATTRIBUTE_KEYS.map((k): [AttributeKey, SeededAttribute] => [
      k,
      { value: attributes[k], confidence: "high", method: "test", inputs: [] },
    ]),
  ) as Record<AttributeKey, SeededAttribute>;
  return {
    personId: id,
    name: id.toUpperCase(),
    personaNames: [id.toUpperCase()],
    attributes,
    scouted,
    styles: opts.styles ?? ["allrounder"],
    alignment: "face",
    push: opts.push ?? "midcard",
    morale: 60,
    momentum: 0,
    credibility: 60,
    prestige: 50,
    standing: { awarenessNational: 55, affinityNational: 30, marketDelta: {} },
    condition: {
      fatigue: opts.fatigue ?? 0,
      wearMinutes: 0,
      injury: null,
      daysSinceMatch: 7,
    },
    debutYear: 1990,
    experienceYears: 7,
    historyNote: "",
    active: true,
  };
}

function mkDna(v: number): ProductDna {
  return Object.fromEntries(DNA_AXES.map((a) => [a, v])) as ProductDna;
}

function mkCompany(): CompanyState {
  return {
    id: "c1",
    name: "Test Wrestling",
    shortName: "TW",
    active: true,
    cashCents: 0,
    homeMarketId: "m1",
    productDna: mkDna(50),
    prestige: 60,
    momentum: 0,
    standing: { awarenessNational: 55, affinityNational: 30, marketDelta: {} },
    sizeTier: "national",
    detailTier: "full",
    tvDeal: null,
    ppvWeek: null,
    aiControlled: false,
    aiProfile: {
      riskTolerance: 50,
      starBias: "workrate",
      youthBias: 0,
      spendingDiscipline: 50,
      planLoyalty: 50,
    },
    programs: [],
    objectives: [],
    titleIds: [],
    nameHistory: [],
  };
}

const VENUE: Venue = {
  id: "v1",
  name: "Test Arena",
  marketId: "m1",
  capacity: 10000,
  prestige: 60,
  rentalCents: 0,
};

const MARKET: Market = {
  id: "m1",
  name: "Testville",
  region: "midwest",
  population: 2_000_000,
  wrestlingInterest: 60,
  economicStrength: 60,
};

function mkMatchSeg(
  id: string,
  sides: string[][],
  opts: Partial<MatchPlan> & { durationMin?: number; storylineId?: string | null } = {},
): Segment {
  const { durationMin, storylineId, ...plan } = opts;
  return {
    id,
    kind: "match",
    durationMin: durationMin ?? 15,
    match: {
      sides: sides.map((members) => ({ members })),
      titleId: null,
      winnerSide: 0,
      finish: "pin",
      stipulation: null,
      intensity: 60,
      risk: 0,
      mainEvent: false,
      ...plan,
    },
    angle: null,
    storylineId: storylineId ?? null,
  };
}

function mkAngleSeg(
  id: string,
  beats: AngleBeat[],
  storylineId: string | null = null,
): Segment {
  const durationMin = beats.reduce((a, b) => a + b.durationMin, 0);
  return { id, kind: "angle", durationMin, match: null, angle: { beats }, storylineId };
}

function promoBeat(speaker: string, durationMin = 6): AngleBeat {
  return {
    purpose: "promo",
    location: "ring",
    durationMin,
    participants: [{ personId: speaker, role: "speaker" }],
    summary: `${speaker} talks`,
  };
}

function attackBeat(attacker: string, victim: string, durationMin = 4): AngleBeat {
  return {
    purpose: "attack",
    location: "ring",
    durationMin,
    participants: [
      { personId: attacker, role: "attacker" },
      { personId: victim, role: "victim" },
    ],
    summary: `${attacker} jumps ${victim}`,
  };
}

function mkCtx(opts: {
  segments: Segment[];
  workers: WorkerState[];
  titles?: TitleState[];
  storylines?: Storyline[];
  attendance?: number;
  showType?: ShowType;
  rng?: RngStream;
}): ShowSimContext {
  const show: ShowPlan = {
    id: "show-1",
    companyId: "c1",
    name: "Test Show",
    date: "1997-01-06",
    venueId: "v1",
    marketId: "m1",
    showType: opts.showType ?? "tv",
    ticketPriceCents: 1500,
    segments: opts.segments,
    advertised: [],
    status: "scheduled",
    report: null,
  };
  return {
    show,
    company: mkCompany(),
    workers: Object.fromEntries(opts.workers.map((w) => [w.personId, w])),
    titles: Object.fromEntries((opts.titles ?? []).map((t) => [t.id, t])),
    storylines: Object.fromEntries((opts.storylines ?? []).map((s) => [s.id, s])),
    venue: VENUE,
    market: MARKET,
    attendance: opts.attendance ?? 8000,
    rng: opts.rng ?? RngStream.fromSeed("test-world", "crowd"),
  };
}

function mkTitle(id: string, holderIds: string[]): TitleState {
  return {
    id,
    name: "TW World Championship",
    companyId: "c1",
    tier: "world",
    holderIds,
    prestige: 70,
    defensesSinceChange: 3,
    lineage: [],
    active: true,
  };
}

const sum = (cs: ScoreComponent[]): number => cs.reduce((a, c) => a + c.value, 0);

describe("show simulation", () => {
  it("a great main event raises the overall grade over a weak one", () => {
    const opener = mkMatchSeg("s1", [["o1"], ["o2"]]);
    const main = mkMatchSeg("s2", [["me1"], ["me2"]], {
      mainEvent: true,
      durationMin: 20,
    });
    const run = (base: number) =>
      simulateShowPerformance(
        mkCtx({
          segments: [opener, main],
          workers: [
            mkWorker("o1"),
            mkWorker("o2"),
            mkWorker("me1", { base }),
            mkWorker("me2", { base }),
          ],
          rng: RngStream.fromSeed("me-test", "crowd"),
        }),
      );
    const great = run(92);
    const weak = run(40);
    expect(great.segments[1]!.execution).toBeGreaterThan(weak.segments[1]!.execution);
    expect(great.overall).toBeGreaterThan(weak.overall);
  });

  it("a silent victim in an attack angle is not scored on promo", () => {
    const seg = mkAngleSeg("s1", [attackBeat("att", "vic")]);
    const run = (victimPromo: number) =>
      simulateShowPerformance(
        mkCtx({
          segments: [seg],
          workers: [
            mkWorker("att", { base: 70, attrs: { promo: 90 } }),
            mkWorker("vic", { base: 70, attrs: { promo: victimPromo } }),
          ],
          rng: RngStream.fromSeed("victim-test", "crowd"),
        }),
      );
    const mute = run(5);
    const gifted = run(90);
    expect(mute.segments[0]!.execution).toBe(gifted.segments[0]!.execution);
    expect(mute.segments[0]!.reception).toBe(gifted.segments[0]!.reception);

    // …while a speaker IS scored on promo
    const talk = (speakerPromo: number) =>
      simulateShowPerformance(
        mkCtx({
          segments: [mkAngleSeg("s1", [promoBeat("spk")])],
          workers: [mkWorker("spk", { base: 70, attrs: { promo: speakerPromo } })],
          rng: RngStream.fromSeed("speaker-test", "crowd"),
        }),
      );
    expect(talk(90).segments[0]!.execution).toBeGreaterThan(
      talk(5).segments[0]!.execution,
    );
  });

  it("emits a title change when the challenger side wins clean, not on DQ", () => {
    const workers = [mkWorker("champ"), mkWorker("chal")];
    const run = (finish: MatchPlan["finish"], winnerSide: number) =>
      simulateShowPerformance(
        mkCtx({
          segments: [
            mkMatchSeg("s1", [["chal"], ["champ"]], {
              titleId: "t1",
              winnerSide,
              finish,
            }),
          ],
          workers,
          titles: [mkTitle("t1", ["champ"])],
          rng: RngStream.fromSeed("title-test", "crowd"),
        }),
      );
    expect(run("pin", 0).titleChanges).toEqual([
      { titleId: "t1", newHolderIds: ["chal"] },
    ]);
    const dq = run("dq", 0);
    expect(dq.titleChanges).toEqual([]);
    expect(dq.segments[0]!.notes.join(" ")).toMatch(/do not change hands/);
    // champion retains clean: no change either
    expect(run("pin", 1).titleChanges).toEqual([]);
  });

  it("three consecutive 90-intensity matches burn the crowd for the third", () => {
    const pairs: string[][][] = [
      [["a1"], ["a2"]],
      [["b1"], ["b2"]],
      [["e1"], ["e2"]],
    ];
    const wrestlers = pairs.flat(2).map((id) => mkWorker(id, { base: 75 }));
    const talkers = [mkWorker("t1", { base: 75 }), mkWorker("t2", { base: 75 })];
    const hotMatch = (id: string, sides: string[][]) =>
      mkMatchSeg(id, sides, { intensity: 90, durationMin: 15 });

    const hot = simulateShowPerformance(
      mkCtx({
        segments: [
          hotMatch("s1", pairs[0]!),
          hotMatch("s2", pairs[1]!),
          hotMatch("s3", pairs[2]!),
        ],
        workers: wrestlers,
        rng: RngStream.fromSeed("fatigue-hot", "crowd"),
      }),
    );
    const spaced = simulateShowPerformance(
      mkCtx({
        segments: [
          hotMatch("s1", pairs[0]!),
          mkAngleSeg("s2", [promoBeat("t1")]),
          hotMatch("s3", pairs[1]!),
          mkAngleSeg("s4", [promoBeat("t2")]),
          hotMatch("s5", pairs[2]!),
        ],
        workers: [...wrestlers, ...talkers],
        rng: RngStream.fromSeed("fatigue-spaced", "crowd"),
      }),
    );
    // same pairing, same execution — only the crowd differs
    expect(hot.segments[2]!.execution).toBe(spaced.segments[4]!.execution);
    expect(hot.segments[2]!.reception).toBeLessThan(spaced.segments[4]!.reception);
  });

  it("penalizes an identical rematch on the same card", () => {
    const out = simulateShowPerformance(
      mkCtx({
        segments: [
          mkMatchSeg("s1", [["a1"], ["a2"]]),
          mkMatchSeg("s2", [["a1"], ["a2"]]),
        ],
        workers: [mkWorker("a1"), mkWorker("a2")],
        rng: RngStream.fromSeed("repeat-test", "crowd"),
      }),
    );
    const first = out.segments[0]!.receptionComponents.find(
      (c) => c.label === "Repetition",
    );
    const second = out.segments[1]!.receptionComponents.find(
      (c) => c.label === "Repetition",
    );
    expect(first).toBeUndefined();
    expect(second).toBeDefined();
    expect(second!.value).toBeLessThan(0);
    expect(out.segments[1]!.notes.join(" ")).toMatch(/repeated segment 1/);
  });

  it("reckless matches injure, safe matches never do", () => {
    const count = (risk: number, safety: number, seedName: string): number => {
      let injuries = 0;
      for (let i = 0; i < 60; i++) {
        const out = simulateShowPerformance(
          mkCtx({
            segments: [
              mkMatchSeg("s1", [["h1"], ["h2"]], { risk, intensity: 80 }),
            ],
            workers: [
              mkWorker("h1", { attrs: { safety } }),
              mkWorker("h2", { attrs: { safety } }),
            ],
            rng: RngStream.fromSeed(seedName, String(i)),
          }),
        );
        injuries += out.segments[0]!.participantEffects.filter(
          (e) => e.injury !== null,
        ).length;
      }
      return injuries;
    };
    expect(count(95, 5, "inj-high")).toBeGreaterThan(0);
    expect(count(5, 95, "inj-low")).toBe(0);
  });

  it("injuries carry severity and a future out-until date", () => {
    // seed chosen so the reckless match produces at least one injury
    for (let i = 0; i < 60; i++) {
      const out = simulateShowPerformance(
        mkCtx({
          segments: [mkMatchSeg("s1", [["h1"], ["h2"]], { risk: 95, intensity: 80 })],
          workers: [
            mkWorker("h1", { attrs: { safety: 5 } }),
            mkWorker("h2", { attrs: { safety: 5 } }),
          ],
          rng: RngStream.fromSeed("inj-detail", String(i)),
        }),
      );
      const hurt = out.segments[0]!.participantEffects.find((e) => e.injury !== null);
      if (hurt) {
        expect(["minor", "moderate", "severe"]).toContain(hurt.injury!.severity);
        expect(hurt.injury!.outUntil > "1997-01-06").toBe(true);
        expect(hurt.injury!.kind.length).toBeGreaterThan(0);
        return;
      }
    }
    throw new Error("no injury produced across 60 reckless matches");
  });

  it("is deterministic from a cloned rng state and does not mutate inputs", () => {
    const build = (rng: RngStream) =>
      mkCtx({
        segments: [
          mkMatchSeg("s1", [["a1"], ["a2"]], { risk: 60, intensity: 80 }),
          mkAngleSeg("s2", [attackBeat("b1", "a1")]),
          mkMatchSeg("s3", [["b1"], ["b2"]], {
            mainEvent: true,
            titleId: "t1",
            durationMin: 20,
          }),
        ],
        workers: [
          mkWorker("a1", { attrs: { safety: 30 } }),
          mkWorker("a2", { attrs: { safety: 30 } }),
          mkWorker("b1", { base: 80 }),
          mkWorker("b2", { base: 80 }),
        ],
        titles: [mkTitle("t1", ["b2"])],
        rng,
      });
    const rngA = RngStream.fromSeed("det-test", "crowd");
    const state = rngA.getState();
    const ctxA = build(rngA);
    const workersBefore = JSON.stringify(ctxA.workers);
    const outA = simulateShowPerformance(ctxA);
    expect(JSON.stringify(ctxA.workers)).toBe(workersBefore);

    const outB = simulateShowPerformance(build(new RngStream(state)));
    expect(outB).toEqual(outA);
  });

  it("keeps every score in bounds with components summing to it", () => {
    const story: Storyline = {
      id: "st1",
      companyId: "c1",
      name: "The Grudge",
      premise: "bad blood",
      participants: [
        { personId: "b1", role: "protagonist" },
        { personId: "b2", role: "antagonist" },
      ],
      titleId: null,
      heat: 70,
      phase: "peak",
      startDate: "1996-11-01",
      targetDate: null,
      beats: [],
      milestones: [],
    };
    const out = simulateShowPerformance(
      mkCtx({
        segments: [
          mkMatchSeg("s1", [["a1"], ["a2"]], { intensity: 85, durationMin: 12 }),
          mkAngleSeg("s2", [promoBeat("b1"), attackBeat("b2", "b1")], "st1"),
          mkMatchSeg("s3", [["c1"], ["c2"]], { finish: "dq", titleId: "t1" }),
          mkMatchSeg("s4", [["b1"], ["b2"]], {
            mainEvent: true,
            durationMin: 22,
            storylineId: "st1",
          }),
        ],
        workers: [
          mkWorker("a1", { fatigue: 70 }),
          mkWorker("a2"),
          mkWorker("b1", { base: 85, push: "main_event" }),
          mkWorker("b2", { base: 85 }),
          mkWorker("c1", { base: 45 }),
          mkWorker("c2", { base: 45, push: "main_event" }),
        ],
        titles: [mkTitle("t1", ["c1"])],
        storylines: [story],
        showType: "ppv",
        rng: RngStream.fromSeed("bounds-test", "crowd"),
      }),
    );

    for (const seg of out.segments) {
      expect(seg.execution).toBeGreaterThanOrEqual(0);
      expect(seg.execution).toBeLessThanOrEqual(100);
      expect(seg.reception).toBeGreaterThanOrEqual(0);
      expect(seg.reception).toBeLessThanOrEqual(100);
      expect(sum(seg.executionComponents)).toBeCloseTo(seg.execution, 1);
      expect(sum(seg.receptionComponents)).toBeCloseTo(seg.reception, 1);
      for (const axis of Object.values(seg.crowdAfter)) {
        expect(axis).toBeGreaterThanOrEqual(0);
        expect(axis).toBeLessThanOrEqual(100);
      }
      for (const e of seg.participantEffects) {
        expect(e.contribution).toBeGreaterThanOrEqual(0);
        expect(e.contribution).toBeLessThanOrEqual(100);
        expect(Math.abs(e.momentumDelta)).toBeLessThanOrEqual(12);
        expect(Math.abs(e.affinityDelta)).toBeLessThanOrEqual(2.5);
        expect(e.awarenessDelta).toBeGreaterThanOrEqual(0);
        expect(e.awarenessDelta).toBeLessThanOrEqual(3);
        expect(e.fatigueDelta).toBeGreaterThanOrEqual(0);
        expect(e.fatigueDelta).toBeLessThanOrEqual(25);
        expect(Math.abs(e.moraleDelta)).toBeLessThanOrEqual(4);
        expect(Math.abs(e.credibilityDelta)).toBeLessThanOrEqual(2.5);
      }
    }
    expect(out.overall).toBeGreaterThanOrEqual(0);
    expect(out.overall).toBeLessThanOrEqual(100);
    expect(sum(out.overallComponents)).toBeCloseTo(out.overall, 1);

    // exhausted worker surfaced in plain language
    expect(out.segments[0]!.notes.join(" ")).toMatch(/exhausted/);
    // dq on a title match cannot change the title
    expect(out.titleChanges).toEqual([]);
  });

  it("headlines read like results", () => {
    const out = simulateShowPerformance(
      mkCtx({
        segments: [
          mkMatchSeg("s1", [["a1"], ["a2"]], { titleId: "t1", winnerSide: 0 }),
        ],
        workers: [mkWorker("a1"), mkWorker("a2")],
        titles: [mkTitle("t1", ["a2"])],
        rng: RngStream.fromSeed("headline-test", "crowd"),
      }),
    );
    expect(out.segments[0]!.headline).toBe(
      "A1 def. A2 (pin) — TW World Championship",
    );
    expect(out.titleChanges).toEqual([{ titleId: "t1", newHolderIds: ["a1"] }]);
    expect(out.notes.join(" ")).toMatch(/NEW CHAMPION/);
  });
});
