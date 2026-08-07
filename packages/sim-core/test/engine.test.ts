import { describe, expect, it } from "vitest";
import type { Command, Segment, SimState } from "@kayfabe/sim-contract";
import { createUniverse } from "../src/init";
import { applyCommand, advanceDays } from "../src/engine";
import { stateHash, buildSaveEnvelope, openSaveEnvelope } from "../src/persistence";
import { makeOptions, makeSnapshot } from "./fixtures";

function freshState(seed = "test-seed-1"): SimState {
  return createUniverse(makeSnapshot(), makeOptions({ worldSeed: seed }));
}

function bookableSegments(state: SimState): Segment[] {
  const roster = Object.keys(state.contracts)
    .sort()
    .map((id) => state.contracts[id]!)
    .filter((c) => c.companyId === "pr:9001" && c.status === "active")
    .map((c) => c.personId);
  const [champ, a, b, c, d, e] = roster;
  return [
    {
      id: "seg-t1",
      kind: "angle",
      durationMin: 8,
      match: null,
      angle: {
        beats: [
          {
            purpose: "promo",
            location: "ring",
            durationMin: 8,
            participants: [
              { personId: a!, role: "speaker" },
              { personId: b!, role: "target" },
            ],
            summary: "The challenger lays out the champion's failings.",
          },
        ],
      },
      storylineId: null,
    },
    {
      id: "seg-t2",
      kind: "match",
      durationMin: 12,
      match: {
        sides: [{ members: [c!] }, { members: [d!] }],
        titleId: null,
        winnerSide: 0,
        finish: "pin",
        stipulation: null,
        intensity: 55,
        risk: 30,
        mainEvent: false,
      },
      angle: null,
      storylineId: null,
    },
    {
      id: "seg-t3",
      kind: "match",
      durationMin: 18,
      match: {
        sides: [{ members: [champ!] }, { members: [e!] }],
        titleId: "t:9001",
        winnerSide: 1,
        finish: "pin",
        stipulation: null,
        intensity: 70,
        risk: 40,
        mainEvent: true,
      },
      angle: null,
      storylineId: null,
    },
  ];
}

function scheduleAndBook(state: SimState): { state: SimState; showId: string } {
  let res = applyCommand(state, {
    type: "SCHEDULE_SHOW",
    companyId: "pr:9001",
    name: "Test Supercard",
    date: state.currentDate,
    venueId: "v:9001",
    showType: "ppv",
    ticketPriceCents: 2200,
  });
  expect(res.errors).toEqual([]);
  const showId = Object.keys(res.state.shows).sort().at(-1)!;
  res = applyCommand(res.state, {
    type: "UPDATE_SHOW_CARD",
    showId,
    segments: bookableSegments(res.state),
    advertised: [],
  });
  expect(res.errors).toEqual([]);
  return { state: res.state, showId };
}

describe("universe creation", () => {
  it("is deterministic: same snapshot + options ⇒ same hash", () => {
    expect(stateHash(freshState())).toBe(stateHash(freshState()));
  });

  it("different seeds ⇒ different universes", () => {
    expect(stateHash(freshState("a"))).not.toBe(stateHash(freshState("b")));
  });

  it("gives every rostered worker a contract and every title a holder", () => {
    const s = freshState();
    const contracts = Object.values(s.contracts);
    expect(contracts.length).toBe(34);
    expect(contracts.every((c) => c.status === "active")).toBe(true);
    expect(s.titles["t:9001"]!.holderIds.length).toBe(1);
    expect(s.workers[s.titles["t:9001"]!.holderIds[0]!]!.push).toBe("main_event");
  });
});

describe("booking and running a show", () => {
  it("rejects invalid cards without mutating state", () => {
    const s = freshState();
    const { state: s2, showId } = scheduleAndBook(s);
    const bad = bookableSegments(s2);
    bad[1]!.match!.winnerSide = 9;
    const res = applyCommand(s2, { type: "UPDATE_SHOW_CARD", showId, segments: bad, advertised: [] });
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.state).toBe(s2);
  });

  it("runs the show: report, ledger, title change, effects", () => {
    const s = freshState();
    const { state: s2, showId } = scheduleAndBook(s);
    const champBefore = s2.titles["t:9001"]!.holderIds[0]!;
    const res = applyCommand(s2, { type: "RUN_SHOW", showId });
    expect(res.errors).toEqual([]);
    expect(res.report).not.toBeNull();
    const report = res.report!;
    expect(report.attendance).toBeGreaterThan(0);
    expect(report.segments.length).toBe(3);
    expect(report.overall).toBeGreaterThan(0);
    expect(report.overall).toBeLessThanOrEqual(100);
    for (const seg of report.segments) {
      expect(seg.receptionComponents.length).toBeGreaterThan(0);
      expect(seg.participantEffects.length).toBeGreaterThan(0);
    }
    // Booked title change happened.
    const title = res.state.titles["t:9001"]!;
    expect(title.holderIds[0]).not.toBe(champBefore);
    expect(title.lineage.at(-1)!.wonAtShowId).toBe(showId);
    expect(title.lineage.at(-2)!.toDate).toBe(res.state.currentDate);
    // Money moved and stayed balanced.
    expect(res.state.ledger.length).toBeGreaterThan(0);
    const company = res.state.companies["pr:9001"]!;
    const initial = 500_000_000;
    const net = res.state.ledger
      .filter((t) => t.companyId === "pr:9001")
      .reduce((sum, t) => sum + (t.direction === "in" ? t.amountCents : -t.amountCents), 0);
    expect(company.cashCents).toBe(initial + net);
    // Participants were affected.
    const winner = res.state.titles["t:9001"]!.holderIds[0]!;
    expect(res.state.workers[winner]!.momentum).toBeGreaterThan(0);
    expect(res.state.workers[winner]!.condition.daysSinceMatch).toBe(0);
    // News covered it.
    expect(res.state.news.some((n) => n.kind === "title_change")).toBe(true);
    expect(res.state.news.some((n) => n.kind === "show_results")).toBe(true);
  });

  it("dq finish does not move the title", () => {
    const s = freshState();
    let { state: s2, showId } = scheduleAndBook(s);
    const segs = bookableSegments(s2);
    segs[2]!.match!.finish = "dq";
    let res = applyCommand(s2, { type: "UPDATE_SHOW_CARD", showId, segments: segs, advertised: [] });
    expect(res.errors).toEqual([]);
    const champBefore = res.state.titles["t:9001"]!.holderIds[0]!;
    res = applyCommand(res.state, { type: "RUN_SHOW", showId });
    expect(res.errors).toEqual([]);
    expect(res.state.titles["t:9001"]!.holderIds[0]).toBe(champBefore);
  });
});

describe("time and the living world", () => {
  it("30 days: AI rivals run shows, world stays consistent", () => {
    const s = freshState();
    const end = advanceDays(s, 30);
    expect(end.currentDate).toBe("1997-02-05");
    const rivalShows = Object.values(end.shows).filter(
      (sh) => sh.companyId === "pr:9002" && sh.status === "completed",
    );
    expect(rivalShows.length).toBeGreaterThanOrEqual(3);
    for (const sh of rivalShows) {
      expect(sh.report).not.toBeNull();
      expect(sh.report!.segments.length).toBeGreaterThan(0);
    }
    // Rival AI keeps persistent plans.
    expect(end.companies["pr:9002"]!.programs.length).toBeGreaterThan(0);
    // Referential integrity: every show participant exists and was contracted.
    for (const sh of Object.values(end.shows)) {
      for (const seg of sh.segments) {
        if (seg.match) {
          for (const side of seg.match.sides) {
            for (const pid of side.members) expect(end.workers[pid]).toBeDefined();
          }
        }
      }
    }
    // Ledger stayed balanced for every company.
    for (const cid of Object.keys(end.companies)) {
      const initial = end.companies[cid]!.sizeTier === "national" ? 500_000_000 : end.companies[cid]!.sizeTier === "regional" ? 75_000_000 : 12_000_000;
      const net = end.ledger
        .filter((t) => t.companyId === cid)
        .reduce((sum, t) => sum + (t.direction === "in" ? t.amountCents : -t.amountCents), 0);
      expect(end.companies[cid]!.cashCents).toBe(initial + net);
    }
  });

  it("identical command sequences reproduce identical hashes", () => {
    const cmds: Command[] = [{ type: "ADVANCE_DAY" }, { type: "ADVANCE_DAY" }, { type: "ADVANCE_DAY" }];
    let a = freshState();
    let b = freshState();
    for (const c of cmds) {
      a = applyCommand(a, c).state;
      b = applyCommand(b, c).state;
    }
    expect(stateHash(a)).toBe(stateHash(b));
  });
});

describe("contracts", () => {
  it("player offer flow: lowball rejected, fair offer signs", () => {
    const s = freshState();
    // Free agent: release someone first, then re-offer after expiry of exclusivity.
    const contractId = Object.keys(s.contracts)
      .sort()
      .find((id) => s.contracts[id]!.companyId === "pr:9001")!;
    const personId = s.contracts[contractId]!.personId;
    let res = applyCommand(s, { type: "RELEASE_WORKER", contractId });
    expect(res.errors).toEqual([]);
    const lowball = applyCommand(res.state, {
      type: "OFFER_CONTRACT",
      companyId: "pr:9001",
      personId,
      kind: "appearance",
      lengthMonths: 12,
      perAppearanceCents: 100,
      weeklyDownsideCents: 0,
      exclusive: false,
    });
    expect(lowball.offerOutcome).not.toBeNull();
    expect(lowball.offerOutcome!.accepted).toBe(false);
    expect(lowball.offerOutcome!.reasons.length).toBeGreaterThan(0);

    const generous = applyCommand(res.state, {
      type: "OFFER_CONTRACT",
      companyId: "pr:9001",
      personId,
      kind: "written",
      lengthMonths: 24,
      perAppearanceCents: 0,
      weeklyDownsideCents: 2_000_000,
      exclusive: true,
    });
    expect(generous.offerOutcome!.accepted).toBe(true);
    const active = Object.values(generous.state.contracts).find(
      (c) => c.personId === personId && c.status === "active",
    );
    expect(active).toBeDefined();
    expect(active!.weeklyDownsideCents).toBe(2_000_000);
  });
});

describe("persistence", () => {
  it("save → open reproduces the exact state hash", () => {
    const s = advanceDays(freshState(), 5);
    const before = stateHash(s);
    const envelope = buildSaveEnvelope(s, "2026-08-07T00:00:00.000Z");
    const roundTripped = JSON.parse(JSON.stringify(envelope));
    const { state: loaded } = openSaveEnvelope(roundTripped, "fixture-bundle");
    expect(stateHash(loaded)).toBe(before);
    // And the loaded universe continues deterministically.
    const a = advanceDays(loaded, 3);
    const b = advanceDays(s, 3);
    expect(stateHash(a)).toBe(stateHash(b));
  });

  it("rejects tampered saves", () => {
    const s = freshState();
    const envelope = buildSaveEnvelope(s, "2026-08-07T00:00:00.000Z");
    envelope.state.companies["pr:9001"]!.cashCents += 1;
    expect(() => openSaveEnvelope(envelope, null)).toThrow(/hash mismatch/);
  });
});
