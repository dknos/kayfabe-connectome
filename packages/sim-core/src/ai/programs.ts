import type {
  AiDecisionRecord,
  IsoDate,
  PersonId,
  Program,
  TitleState,
} from "@kayfabe/sim-contract";
import { addDays, compareDates, diffDays } from "../dates";
import type { AiTickContext, NewShow } from "./types";
import {
  aiSortedKeys,
  availableRoster,
  clamp,
  scoreCandidate,
  type ScoredCandidate,
} from "./util";

export interface ProgramResult {
  programs: Program[];
  decisions: AiDecisionRecord[];
}

const PHASE_ORDER = { building: 0, peak: 1, blowoff: 2, done: 3 } as const;

function phaseForDaysLeft(daysLeft: number): Program["phase"] {
  return daysLeft > 14 ? "building" : daysLeft > 7 ? "peak" : "blowoff";
}

/** Managed tiers, in priority order. Tag programs are out of slice scope. */
const TIER_PRIORITY = { world: 0, secondary: 1, other: 2 } as const;

function managedTitles(ctx: AiTickContext): TitleState[] {
  const out: TitleState[] = [];
  for (const tid of [...ctx.company.titleIds].sort()) {
    const t = ctx.titles[tid];
    if (!t || !t.active || t.companyId !== ctx.company.id || t.tier === "tag") continue;
    out.push(t);
  }
  out.sort(
    (a, b) =>
      TIER_PRIORITY[a.tier as keyof typeof TIER_PRIORITY] -
        TIER_PRIORITY[b.tier as keyof typeof TIER_PRIORITY] || (a.id < b.id ? -1 : 1),
  );
  return out;
}

/** Earliest company PPV after today, counting shows planned this tick. */
function nextPpvDate(ctx: AiTickContext, planned: NewShow[]): IsoDate {
  let best: IsoDate | null = null;
  const consider = (date: IsoDate): void => {
    if (compareDates(date, ctx.date) <= 0) return;
    if (best === null || compareDates(date, best) < 0) best = date;
  };
  for (const id of aiSortedKeys(ctx.shows)) {
    const s = ctx.shows[id]!;
    if (s.companyId === ctx.company.id && s.showType === "ppv" && s.status === "scheduled") {
      consider(s.date);
    }
  }
  for (const s of planned) {
    if (s.showType === "ppv") consider(s.date);
  }
  return best ?? addDays(ctx.date, 28);
}

/** The blowoff title match ran on a completed show near the target date. */
function blowoffCompleted(ctx: AiTickContext, program: Program): boolean {
  if (program.titleId === null) return false;
  const windowStart = addDays(program.targetDate, -7);
  for (const id of aiSortedKeys(ctx.shows)) {
    const s = ctx.shows[id]!;
    if (s.companyId !== ctx.company.id || s.status !== "completed") continue;
    if (compareDates(s.date, windowStart) < 0 || compareDates(s.date, ctx.date) > 0) continue;
    for (const seg of s.segments) {
      if (seg.match && seg.match.titleId === program.titleId) return true;
    }
  }
  return false;
}

/**
 * Maintain one program per managed active title (world always first).
 * Existing programs advance building→peak→blowoff by proximity to their
 * target date; a finished blowoff marks the program done, and the next
 * tick replaces the done program with a successor. Returns the FULL
 * replacement list for company.programs.
 */
export function maintainPrograms(ctx: AiTickContext, planned: NewShow[]): ProgramResult {
  const decisions: AiDecisionRecord[] = [];
  const { company } = ctx;
  const titles = managedTitles(ctx);
  const managedIds = new Set(titles.map((t) => t.id));
  const target = nextPpvDate(ctx, planned);

  // Carry programs this module does not manage (no title / foreign title).
  const carried: Program[] = company.programs.filter(
    (p) => p.titleId === null || !managedIds.has(p.titleId),
  );

  const committed = new Set<PersonId>();
  for (const p of carried) for (const pid of p.participants) committed.add(pid);

  const managed: Program[] = [];
  for (const title of titles) {
    const existing = company.programs
      .filter((p) => p.titleId === title.id)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const live = existing.find((p) => p.phase !== "done");

    if (live) {
      const advanced = advanceProgram(ctx, live, decisions);
      managed.push(advanced);
      for (const pid of advanced.participants) committed.add(pid);
      continue;
    }
    // No live program (none yet, or the previous one finished): build the
    // successor, avoiding the just-finished participants where possible.
    const previous = existing.find((p) => p.phase === "done") ?? null;
    const created = createProgram(ctx, title, target, previous, committed, decisions);
    if (created) {
      managed.push(created);
      for (const pid of created.participants) committed.add(pid);
    }
  }

  return { programs: [...managed, ...carried], decisions };
}

function advanceProgram(
  ctx: AiTickContext,
  program: Program,
  decisions: AiDecisionRecord[],
): Program {
  const daysLeft = diffDays(ctx.date, program.targetDate);
  let phase: Program["phase"] = program.phase;

  const finished =
    program.phase === "blowoff" && (blowoffCompleted(ctx, program) || daysLeft < 0);
  if (finished) {
    phase = "done";
  } else {
    const due = phaseForDaysLeft(daysLeft);
    if (PHASE_ORDER[due] > PHASE_ORDER[phase]) phase = due;
  }

  if (phase === program.phase) return { ...program };
  decisions.push({
    seq: 0,
    date: ctx.date,
    companyId: ctx.company.id,
    action: `advance-program:${program.id}`,
    reason: `phase:${phase}`,
    considered: [],
  });
  return { ...program, phase };
}

function createProgram(
  ctx: AiTickContext,
  title: TitleState,
  target: IsoDate,
  previous: Program | null,
  committed: Set<PersonId>,
  decisions: AiDecisionRecord[],
): Program | null {
  const { company } = ctx;
  const roster = availableRoster(ctx, ctx.date);
  const champion =
    title.holderIds.length === 1
      ? roster.find((w) => w.personId === title.holderIds[0]) ?? null
      : null;

  const recentIds = new Set(previous?.participants ?? []);
  const pool = roster.filter(
    (w) =>
      !committed.has(w.personId) &&
      w.personId !== champion?.personId &&
      !title.holderIds.includes(w.personId),
  );
  if (pool.length === 0 || (champion === null && pool.length < 2)) return null;

  const scored: ScoredCandidate[] = pool
    .map((w) =>
      scoreCandidate(w, company.aiProfile, {
        opposeAlignment: champion?.alignment,
        recentlyRepeated: recentIds.has(w.personId),
      }),
    )
    .sort((a, b) => b.utility - a.utility || (a.personId < b.personId ? -1 : 1));
  const considered = scored
    .slice(0, 3)
    .map((s) => ({ option: s.personId, utility: s.utility }));

  const daysLeft = diffDays(ctx.date, target);
  let participants: PersonId[];
  let intendedWinner: PersonId;
  let reason: string;

  if (champion) {
    const challenger = scored[0]!;
    participants = [champion.personId, challenger.personId];
    // Champ retains when planLoyalty is high; otherwise riskTolerance sets
    // the title-change appetite. The rng draw only happens on this branch,
    // which is fully determined by company state.
    if (company.aiProfile.planLoyalty >= 70) {
      intendedWinner = champion.personId;
      reason = `build-challenger:${challenger.dominant}`;
    } else {
      const changeChance = clamp(company.aiProfile.riskTolerance / 300 + 0.1, 0.05, 0.5);
      if (ctx.rng.chance(changeChance)) {
        intendedWinner = challenger.personId;
        reason = `title-change:${challenger.dominant}`;
      } else {
        intendedWinner = champion.personId;
        reason = `build-challenger:${challenger.dominant}`;
      }
    }
  } else {
    // Vacant (or multi-holder / off-roster champion): crown via the top two.
    participants = [scored[0]!.personId, scored[1]!.personId];
    intendedWinner = scored[0]!.personId;
    reason = "crown-champion:vacant";
  }

  const program: Program = {
    id: ctx.nextId("prog"),
    companyId: company.id,
    titleId: title.id,
    participants,
    intendedWinner,
    targetDate: target,
    phase: phaseForDaysLeft(daysLeft),
    reason,
    storylineId: null,
  };
  decisions.push({
    seq: 0,
    date: ctx.date,
    companyId: company.id,
    action: `create-program:${program.id}`,
    reason,
    considered,
  });
  return program;
}
