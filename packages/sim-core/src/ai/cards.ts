import type {
  AiDecisionRecord,
  MatchSide,
  PersonId,
  Program,
  Segment,
  ShowPlan,
  TitleId,
  WorkerState,
} from "@kayfabe/sim-contract";
import { diffDays } from "../dates";
import type { AiTickContext } from "./types";
import {
  aiSortedKeys,
  availableRoster,
  hashPick,
  matchWinScore,
  scoreCandidate,
} from "./util";

export interface CardResult {
  updates: { showId: string; segments: Segment[]; advertised: PersonId[] }[];
  decisions: AiDecisionRecord[];
}

/** Cards are written this close to showtime. */
const CARD_LEAD_DAYS = 2;

const DUR = {
  tv: { undercard: 8, mainEvent: 15, angle: 4 },
  ppv: { undercard: 10, mainEvent: 20, angle: 5 },
} as const;

function nextUncardedShow(ctx: AiTickContext): ShowPlan | null {
  let best: ShowPlan | null = null;
  for (const id of aiSortedKeys(ctx.shows)) {
    const s = ctx.shows[id]!;
    if (s.companyId !== ctx.company.id || s.status !== "scheduled") continue;
    if (s.segments.length > 0 || s.showType === "house") continue;
    const lead = diffDays(ctx.date, s.date);
    if (lead < 0 || lead > CARD_LEAD_DAYS) continue;
    if (!best || s.date < best.date || (s.date === best.date && s.id < best.id)) best = s;
  }
  return best;
}

function worldProgram(ctx: AiTickContext, programs: Program[]): Program | null {
  const candidates = programs
    .filter((p) => {
      if (p.phase === "done" || p.titleId === null) return false;
      const t = ctx.titles[p.titleId];
      return t !== undefined && t.tier === "world" && t.companyId === ctx.company.id;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return candidates[0] ?? null;
}

function singlesMatch(
  ctx: AiTickContext,
  opts: {
    a: PersonId;
    b: PersonId;
    winner: 0 | 1;
    titleId: TitleId | null;
    mainEvent: boolean;
    durationMin: number;
    finish: "pin" | "dq";
  },
): Segment {
  const sides: MatchSide[] = [{ members: [opts.a] }, { members: [opts.b] }];
  return {
    id: ctx.nextId("seg"),
    kind: "match",
    durationMin: opts.durationMin,
    match: {
      sides,
      titleId: opts.titleId,
      winnerSide: opts.winner,
      finish: opts.finish,
      stipulation: null,
      intensity: opts.mainEvent ? (opts.titleId ? 75 : 65) : 50,
      risk: opts.mainEvent ? (opts.titleId ? 50 : 45) : 35,
      mainEvent: opts.mainEvent,
    },
    angle: null,
    storylineId: null,
  };
}

function promoAngle(
  ctx: AiTickContext,
  speaker: PersonId,
  purpose: "challenge" | "promo",
  summary: string,
  durationMin: number,
): Segment {
  return {
    id: ctx.nextId("seg"),
    kind: "angle",
    durationMin,
    match: null,
    angle: {
      beats: [
        {
          purpose,
          location: "ring",
          durationMin,
          participants: [{ personId: speaker, role: "speaker" }],
          summary,
        },
      ],
    },
    storylineId: null,
  };
}

/**
 * Undercard winner: momentum + push utility; deterministic personId
 * tie-break. Jobbers get protected with a DQ finish occasionally when the
 * booker's planLoyalty is low (chaotic bookers hedge their squashes).
 */
function undercardMatch(ctx: AiTickContext, a: WorkerState, b: WorkerState, durationMin: number): Segment {
  const sa = matchWinScore(a);
  const sb = matchWinScore(b);
  const winner: 0 | 1 = sa === sb ? (a.personId < b.personId ? 0 : 1) : sa > sb ? 0 : 1;
  const gap = Math.abs(sa - sb);
  let finish: "pin" | "dq" = "pin";
  if (ctx.company.aiProfile.planLoyalty < 40 && gap > 25 && ctx.rng.chance(0.25)) {
    finish = "dq";
  }
  return singlesMatch(ctx, {
    a: a.personId,
    b: b.personId,
    winner,
    titleId: null,
    mainEvent: false,
    durationMin,
    finish,
  });
}

/** Least-recently-used first (most days since a match), personId tie-break. */
function byLru(a: WorkerState, b: WorkerState): number {
  return (
    b.condition.daysSinceMatch - a.condition.daysSinceMatch ||
    (a.personId < b.personId ? -1 : 1)
  );
}

function byWinScore(a: WorkerState, b: WorkerState): number {
  return matchWinScore(b) - matchWinScore(a) || (a.personId < b.personId ? -1 : 1);
}

/**
 * Card the company's next un-carded show (within CARD_LEAD_DAYS).
 * TV targets 1 angle + 4 matches; PPV targets 6 matches + 1 angle,
 * degrading gracefully when the roster cannot fill the shape. Cards keep
 * every person to a single segment (stricter than validateCard, which
 * would allow angle repeats).
 */
export function planCards(ctx: AiTickContext, programs: Program[]): CardResult {
  const decisions: AiDecisionRecord[] = [];
  const show = nextUncardedShow(ctx);
  if (!show) return { updates: [], decisions };

  const roster = availableRoster(ctx, show.date);
  if (roster.length < 2) return { updates: [], decisions };

  const program = worldProgram(ctx, programs);
  const booked = new Set<PersonId>();
  const take = (pid: PersonId): void => {
    booked.add(pid);
  };
  const free = (): WorkerState[] => roster.filter((w) => !booked.has(w.personId));

  const segments: Segment[] =
    show.showType === "ppv"
      ? buildPpvCard(ctx, show, program, take, free)
      : buildTvCard(ctx, show, program, take, free);

  if (segments.length === 0) return { updates: [], decisions };

  const advertised = [...booked].sort();
  const meConsidered = roster
    .slice()
    .sort(byWinScore)
    .slice(0, 3)
    .map((w) => ({
      option: w.personId,
      utility: Math.round(matchWinScore(w) * 1000) / 1000,
    }));
  decisions.push({
    seq: 0,
    date: ctx.date,
    companyId: ctx.company.id,
    action: `book-card:${show.id}`,
    reason: `card:${show.showType}:${show.date}`,
    considered: meConsidered,
  });

  return {
    updates: [{ showId: show.id, segments, advertised }],
    decisions,
  };
}

function buildTvCard(
  ctx: AiTickContext,
  show: ShowPlan,
  program: Program | null,
  take: (pid: PersonId) => void,
  free: () => WorkerState[],
): Segment[] {
  const d = DUR.tv;

  // Split the program pair across the show: one wrestles the main event,
  // the other sells the feud on the mic. The split alternates by date hash
  // so weekly TV does not repeat itself.
  const progPeople = (program?.participants ?? [])
    .map((pid) => free().find((w) => w.personId === pid))
    .filter((w): w is WorkerState => w !== undefined);
  let wrestler: WorkerState | null = null;
  let speaker: WorkerState | null = null;
  if (progPeople.length >= 2) {
    const flip = hashPick(`${ctx.company.id}:${show.date}:me`, 2);
    wrestler = progPeople[flip]!;
    speaker = progPeople[1 - flip]!;
  } else if (progPeople.length === 1) {
    wrestler = progPeople[0]!;
  }

  if (wrestler) take(wrestler.personId);
  if (speaker) take(speaker.personId);

  // Main event: program participant vs the strongest fresh opponent.
  // Never a title match on TV — the belt only moves at the blowoff.
  const opponents = free().sort(byWinScore);
  let mainEvent: Segment | null = null;
  if (wrestler && opponents.length > 0) {
    const opp = opponents[0]!;
    take(opp.personId);
    mainEvent = singlesMatch(ctx, {
      a: wrestler.personId,
      b: opp.personId,
      winner: 0,
      titleId: null,
      mainEvent: true,
      durationMin: d.mainEvent,
      finish: "pin",
    });
  } else {
    const top = free().sort(byWinScore);
    if (top.length >= 2) {
      const a = top[0]!;
      const b = top[1]!;
      take(a.personId);
      take(b.personId);
      mainEvent = singlesMatch(ctx, {
        a: a.personId,
        b: b.personId,
        winner: matchWinScore(a) >= matchWinScore(b) ? 0 : 1,
        titleId: null,
        mainEvent: true,
        durationMin: d.mainEvent,
        finish: "pin",
      });
    }
  }
  if (!mainEvent) return [];

  // Undercard rotates by least-recently-used.
  const undercard: Segment[] = [];
  const pool = free().sort(byLru);
  for (let i = 0; i + 1 < pool.length && undercard.length < 3; i += 2) {
    const a = pool[i]!;
    const b = pool[i + 1]!;
    take(a.personId);
    take(b.personId);
    undercard.push(undercardMatch(ctx, a, b, d.undercard));
  }

  let angle: Segment | null = null;
  if (speaker) {
    angle = promoAngle(
      ctx,
      speaker.personId,
      "challenge",
      `${speaker.name} calls out the champion ahead of the showdown.`,
      d.angle,
    );
  } else {
    const leftovers = free().sort(
      (a, b) =>
        scoreCandidate(b, ctx.company.aiProfile, {}).utility -
          scoreCandidate(a, ctx.company.aiProfile, {}).utility ||
        (a.personId < b.personId ? -1 : 1),
    );
    if (leftovers.length > 0) {
      const s = leftovers[0]!;
      take(s.personId);
      angle = promoAngle(ctx, s.personId, "promo", `${s.name} states their case for a bigger spot.`, d.angle);
    }
  }

  const segments: Segment[] = [];
  segments.push(...undercard.slice(0, 2));
  if (angle) segments.push(angle);
  segments.push(...undercard.slice(2));
  segments.push(mainEvent);
  return segments;
}

function buildPpvCard(
  ctx: AiTickContext,
  show: ShowPlan,
  program: Program | null,
  take: (pid: PersonId) => void,
  free: () => WorkerState[],
): Segment[] {
  const d = DUR.ppv;

  // Main event: the program's title match — the only place the belt is up.
  let mainEvent: Segment | null = null;
  if (program && program.titleId !== null && program.participants.length >= 2) {
    const a = free().find((w) => w.personId === program.participants[0]);
    const b = free().find((w) => w.personId === program.participants[1]);
    if (a && b) {
      take(a.personId);
      take(b.personId);
      mainEvent = singlesMatch(ctx, {
        a: a.personId,
        b: b.personId,
        winner: program.intendedWinner === b.personId ? 1 : 0,
        titleId: program.titleId,
        mainEvent: true,
        durationMin: d.mainEvent,
        finish: "pin",
      });
    }
  }
  if (!mainEvent) {
    const top = free().sort(byWinScore);
    if (top.length < 2) return [];
    const a = top[0]!;
    const b = top[1]!;
    take(a.personId);
    take(b.personId);
    mainEvent = singlesMatch(ctx, {
      a: a.personId,
      b: b.personId,
      winner: matchWinScore(a) >= matchWinScore(b) ? 0 : 1,
      titleId: null,
      mainEvent: true,
      durationMin: d.mainEvent,
      finish: "pin",
    });
  }

  // Undercard: up to 5 more matches, leaving one voice for the angle when
  // the roster allows. LRU rotation, same as TV.
  const pool = free().sort(byLru);
  const reserveForAngle = pool.length % 2 === 1 || pool.length > 10 ? 1 : 0;
  const matchCount = Math.min(5, Math.floor((pool.length - reserveForAngle) / 2));
  const undercard: Segment[] = [];
  for (let i = 0; undercard.length < matchCount; i += 2) {
    const a = pool[i]!;
    const b = pool[i + 1]!;
    take(a.personId);
    take(b.personId);
    undercard.push(undercardMatch(ctx, a, b, d.undercard));
  }

  let angle: Segment | null = null;
  const leftovers = free().sort(
    (a, b) =>
      scoreCandidate(b, ctx.company.aiProfile, {}).utility -
        scoreCandidate(a, ctx.company.aiProfile, {}).utility ||
      (a.personId < b.personId ? -1 : 1),
  );
  if (leftovers.length > 0) {
    const s = leftovers[0]!;
    take(s.personId);
    angle = promoAngle(ctx, s.personId, "promo", `${s.name} makes a statement on the big stage.`, d.angle);
  }

  const segments: Segment[] = [...undercard];
  if (angle) segments.push(angle);
  segments.push(mainEvent);
  return segments;
}
