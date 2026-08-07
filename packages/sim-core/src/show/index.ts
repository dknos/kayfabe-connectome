/**
 * Show/crowd simulation (crowd-flow@1 + segment-eval@1).
 *
 * Pure with respect to game state: reads the context, returns reports and
 * bounded deltas for the caller to apply; the only thing mutated is the
 * passed RngStream, whose draws are consumed on a fixed schedule (one per
 * match participant, in running order). The plan decides every winner —
 * the sim never overrides booking. Formulas: docs/simulator/rules/show.md.
 */
import type {
  CompanyState,
  CrowdState,
  FinishKind,
  Market,
  MatchPlan,
  PersonId,
  ScoreComponent,
  Segment,
  SegmentReport,
  ShowPlan,
  Storyline,
  StorylineId,
  TitleId,
  TitleState,
  Venue,
  WorkerState,
} from "@kayfabe/sim-contract";
import type { RngStream } from "../rng";
import { CROWD_FLOW_VERSION, initCrowd, updateCrowd } from "./crowd";
import {
  SEGMENT_EVAL_VERSION,
  evaluateAngleExecution,
  evaluateMatchExecution,
} from "./execution";
import { computeReception } from "./reception";
import {
  angleHeadline,
  buildAngleEffects,
  buildMatchEffects,
  finishLabel,
  matchHeadline,
} from "./effects";
import { clamp, finalizeScore, getWorker, mean, r1 } from "./util";

export { CROWD_FLOW_VERSION, SEGMENT_EVAL_VERSION, initCrowd, updateCrowd };

export interface ShowSimContext {
  show: ShowPlan; // segments in running order
  company: CompanyState;
  workers: Record<PersonId, WorkerState>;
  titles: Record<TitleId, TitleState>;
  storylines: Record<StorylineId, Storyline>;
  venue: Venue;
  market: Market;
  attendance: number; // already resolved by finance module
  rng: RngStream; // from ../rng
}

export interface TitleChange {
  titleId: TitleId;
  newHolderIds: PersonId[];
}

export interface ShowSimOutcome {
  crowdStart: CrowdState;
  segments: SegmentReport[]; // sim-contract shape, EXACT
  overall: number; // 0-100
  overallComponents: ScoreComponent[];
  titleChanges: TitleChange[];
  notes: string[];
}

const DECISIVE: ReadonlySet<FinishKind> = new Set(["pin", "submission", "ko"]);
const CHEAP: ReadonlySet<FinishKind> = new Set(["dq", "countout"]);

function validate(ctx: ShowSimContext): void {
  const missing = new Set<PersonId>();
  const need = (id: PersonId): void => {
    if (!ctx.workers[id]) missing.add(id);
  };
  for (const seg of ctx.show.segments) {
    if (seg.kind === "match") {
      const plan = seg.match;
      if (!plan) throw new Error(`show sim: segment ${seg.id} is a match without a plan`);
      if (plan.sides.length < 2) {
        throw new Error(`show sim: segment ${seg.id} needs at least two sides`);
      }
      for (const side of plan.sides) {
        if (side.members.length < 1) {
          throw new Error(`show sim: segment ${seg.id} has an empty side`);
        }
        for (const id of side.members) need(id);
      }
      if (
        plan.winnerSide !== null &&
        (plan.winnerSide < 0 || plan.winnerSide >= plan.sides.length)
      ) {
        throw new Error(`show sim: segment ${seg.id} winnerSide out of range`);
      }
    } else {
      const angle = seg.angle;
      if (!angle || angle.beats.length < 1) {
        throw new Error(`show sim: segment ${seg.id} is an angle without beats`);
      }
      for (const beat of angle.beats) {
        if (beat.participants.length < 1) {
          throw new Error(`show sim: segment ${seg.id} has a beat with no participants`);
        }
        for (const p of beat.participants) need(p.personId);
      }
    }
  }
  if (missing.size > 0) {
    throw new Error(`show sim: unknown workers ${[...missing].sort().join(", ")}`);
  }
}

function sameMembers(a: readonly PersonId[], b: readonly PersonId[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((id, i) => id === sb[i]);
}

export function simulateShowPerformance(ctx: ShowSimContext): ShowSimOutcome {
  validate(ctx);
  const { show, workers } = ctx;
  const dna = ctx.company.productDna;

  const crowdStart = initCrowd({
    showType: show.showType,
    attendance: ctx.attendance,
    capacity: ctx.venue.capacity,
    venuePrestige: ctx.venue.prestige,
    wrestlingInterest: ctx.market.wrestlingInterest,
    standing: ctx.company.standing,
    marketId: ctx.market.id,
  });

  const reports: SegmentReport[] = [];
  const titleChanges: TitleChange[] = [];
  const showNotes: string[] = [];
  const pairingFirstIndex = new Map<string, number>();
  let crowd = crowdStart;

  for (let i = 0; i < show.segments.length; i++) {
    const seg = show.segments[i]!;
    const storyline =
      seg.storylineId !== null ? (ctx.storylines[seg.storylineId] ?? null) : null;
    const notes: string[] = [];
    if (crowd.fatigue >= 60) {
      notes.push("The crowd was burned out before this segment began.");
    }

    let report: SegmentReport;
    if (seg.kind === "match") {
      const plan = seg.match as MatchPlan;
      const title = plan.titleId !== null ? (ctx.titles[plan.titleId] ?? null) : null;
      const exec = evaluateMatchExecution({
        plan,
        durationMin: seg.durationMin,
        segmentId: seg.id,
        showDate: show.date,
        workers,
        rng: ctx.rng,
      });

      const pairingKey = [...exec.participants].sort().join("|");
      const repeated = pairingFirstIndex.get(pairingKey);
      if (repeated === undefined) pairingFirstIndex.set(pairingKey, i);

      const rec = computeReception({
        crowd,
        execution: exec.execution,
        kind: "match",
        plan,
        participants: exec.participants,
        opposedPairs: exec.opposedPairs,
        workers,
        title,
        storyline,
        storylines: ctx.storylines,
        dna,
        showDate: show.date,
        repeatedSegmentIndex: repeated ?? null,
        hasAttackBeat: false,
      });

      const effects = buildMatchEffects({
        plan,
        durationMin: seg.durationMin,
        reception: rec.reception,
        participants: exec.participants,
        sideOf: exec.sideOf,
        contribution: exec.contribution,
        injuries: exec.injuries,
        workers,
        attendance: ctx.attendance,
        showType: show.showType,
        titled: title !== null,
      });

      // THE PLAN decides the winner; the sim only settles title consequences.
      if (title !== null && plan.winnerSide !== null) {
        const winners = plan.sides[plan.winnerSide]!.members;
        if (DECISIVE.has(plan.finish)) {
          if (!sameMembers(title.holderIds, winners)) {
            titleChanges.push({ titleId: title.id, newHolderIds: [...winners] });
            const names = winners.map((id) => getWorker(workers, id).name).join(" & ");
            notes.push(`Title change: ${names} captured the ${title.name}.`);
            showNotes.push(`NEW CHAMPION: ${names} captured the ${title.name}.`);
          }
        } else if (CHEAP.has(plan.finish)) {
          notes.push(
            `Championships do not change hands on ${finishLabel(plan.finish)} — title retained.`,
          );
        }
      }

      for (const id of exec.participants) {
        const w = getWorker(workers, id);
        if (w.condition.fatigue >= 60) notes.push(`${w.name} looked exhausted.`);
        if (w.condition.injury) notes.push(`${w.name} worked hurt.`);
      }
      for (const { personId, injury } of exec.injuries) {
        const name = getWorker(workers, personId).name;
        notes.push(
          `${name} was injured (${injury.kind}, ${injury.severity}) — out until ${injury.outUntil}.`,
        );
        showNotes.push(
          `${name} injured (${injury.severity} ${injury.kind}), out until ${injury.outUntil}.`,
        );
      }
      if (rec.flags.titleStakes) notes.push("Title stakes lifted this segment.");
      if (repeated !== undefined) {
        notes.push(`This pairing repeated segment ${repeated + 1}.`);
      }
      if (rec.flags.overexposed) {
        notes.push("This storyline has been on screen a lot lately.");
      }
      if (rec.flags.confusionPairs > 0) {
        notes.push("Storyline allies fought without an on-screen reason — the crowd was confused.");
      }
      if (rec.flags.cooldown === "breather") {
        notes.push("A well-placed breather — the crowd caught its breath.");
      }
      if (rec.flags.cooldown === "burnout") {
        notes.push("The crowd was too spent for another war.");
      }
      if (rec.flags.mainEventPayoff) notes.push("Main-event anticipation paid off.");
      if (CHEAP.has(plan.finish) && (title !== null || plan.mainEvent)) {
        notes.push(
          `The ${finishLabel(plan.finish)} finish protected the loser, but the crowd wanted a decisive result.`,
        );
      }

      crowd = updateCrowd(crowd, {
        reception: rec.reception,
        kind: "match",
        durationMin: seg.durationMin,
        intensity: plan.intensity,
        storylineLinked: storyline !== null,
        cheapFinish:
          (CHEAP.has(plan.finish) || plan.finish === "no_contest") &&
          (title !== null || plan.mainEvent),
        mainEventRelease: plan.mainEvent,
      });

      report = {
        segmentId: seg.id,
        kind: "match",
        headline: matchHeadline(plan, workers, title),
        execution: exec.execution,
        reception: rec.reception,
        executionComponents: exec.components,
        receptionComponents: rec.components,
        participantEffects: effects,
        crowdAfter: crowd,
        notes,
      };
    } else {
      const beats = seg.angle!.beats;
      const exec = evaluateAngleExecution({ beats, workers });

      const pairingKey = [...exec.participants].sort().join("|");
      const repeated = pairingFirstIndex.get(pairingKey);
      if (repeated === undefined) pairingFirstIndex.set(pairingKey, i);

      const rec = computeReception({
        crowd,
        execution: exec.execution,
        kind: "angle",
        plan: null,
        participants: exec.participants,
        opposedPairs: exec.opposedPairs,
        workers,
        title: null,
        storyline,
        storylines: ctx.storylines,
        dna,
        showDate: show.date,
        repeatedSegmentIndex: repeated ?? null,
        hasAttackBeat: exec.hasAttackBeat,
      });

      const effects = buildAngleEffects({
        reception: rec.reception,
        participants: exec.participants,
        contribution: exec.contribution,
        rolesByPerson: exec.rolesByPerson,
        minutesByPerson: exec.minutesByPerson,
        workers,
        attendance: ctx.attendance,
        showType: show.showType,
        hasSaveBeat: exec.hasSaveBeat,
      });

      for (const id of exec.participants) {
        const w = getWorker(workers, id);
        if (w.condition.fatigue >= 60) notes.push(`${w.name} looked exhausted.`);
      }
      if (repeated !== undefined) {
        notes.push(`This pairing repeated segment ${repeated + 1}.`);
      }
      if (rec.flags.overexposed) {
        notes.push("This storyline has been on screen a lot lately.");
      }
      if (rec.flags.confusionPairs > 0) {
        notes.push("Storyline allies fought without an on-screen reason — the crowd was confused.");
      }
      if (rec.flags.cooldown === "breather") {
        notes.push("A well-placed breather — the crowd caught its breath.");
      }

      crowd = updateCrowd(crowd, {
        reception: rec.reception,
        kind: "angle",
        durationMin: seg.durationMin,
        intensity: 0,
        storylineLinked: storyline !== null,
        cheapFinish: false,
        mainEventRelease: false,
      });

      report = {
        segmentId: seg.id,
        kind: "angle",
        headline: angleHeadline(beats, workers),
        execution: exec.execution,
        reception: rec.reception,
        executionComponents: exec.components,
        receptionComponents: rec.components,
        participantEffects: effects,
        crowdAfter: crowd,
        notes,
      };
    }
    reports.push(report);
  }

  const { overall, overallComponents, overallNotes } = computeOverall(
    ctx,
    reports,
    crowd,
  );
  showNotes.push(...overallNotes);

  return {
    crowdStart,
    segments: reports,
    overall,
    overallComponents,
    titleChanges,
    notes: showNotes,
  };
}

function computeOverall(
  ctx: ShowSimContext,
  reports: SegmentReport[],
  finalCrowd: CrowdState,
): { overall: number; overallComponents: ScoreComponent[]; overallNotes: string[] } {
  const notes: string[] = [];
  if (reports.length === 0) {
    return {
      overall: 0,
      overallComponents: [],
      overallNotes: ["No segments were booked."],
    };
  }
  const dna = ctx.company.productDna;
  const segs = ctx.show.segments;
  const n = reports.length;

  let wSum = 0;
  let wr = 0;
  for (let i = 0; i < n; i++) {
    const seg = segs[i]!;
    const plan = seg.kind === "match" ? seg.match : null;
    let w = Math.max(1, seg.durationMin);
    if (plan?.mainEvent) w *= 1.8 + Math.max(0, dna.starDriven - 50) / 100;
    if (seg.storylineId !== null && dna.serializedStory > 60) w *= 1.15;
    if (i === n - 1 && !plan?.mainEvent) w *= 1.3; // closing impression
    wSum += w;
    wr += w * reports[i]!.reception;
  }

  const parts: ScoreComponent[] = [
    {
      label: "Card quality",
      value: wr / wSum,
      note: "segment receptions, weighted by length, main event, and product DNA",
    },
  ];

  let build = 0;
  if (n >= 3) {
    const third = Math.ceil(n / 3);
    const first = mean(reports.slice(0, third).map((r) => r.reception));
    const last = mean(reports.slice(n - third).map((r) => r.reception));
    build = last - first;
    parts.push({
      label: "Pacing arc",
      value: clamp(build * 0.15, -4, 4),
      note: "whether the card built toward its finish",
    });
  }

  parts.push({
    label: "Crowd sent home",
    value: (finalCrowd.satisfaction - 50) * 0.12,
    note: "how satisfied the audience was walking out",
  });

  let closerIdx = n - 1;
  for (let i = n - 1; i >= 0; i--) {
    const seg = segs[i]!;
    if (seg.kind === "match" && seg.match?.mainEvent) {
      closerIdx = i;
      break;
    }
  }
  const closer = segs[closerIdx]!;
  if (closer.kind === "match" && closer.match) {
    const finish = closer.match.finish;
    const value = DECISIVE.has(finish)
      ? 3
      : finish === "no_contest"
        ? -6
        : CHEAP.has(finish)
          ? -4
          : -2; // time-limit draw
    parts.push({
      label: "Closing finish",
      value,
      note: `the show went off the air on a ${finishLabel(finish)}`,
    });
  }

  const { score, components } = finalizeScore(parts);

  if (finalCrowd.fatigue >= 70) notes.push("The crowd was burned out by the end of the show.");
  if (build >= 8) notes.push("The card built to its finish.");
  if (build <= -8) notes.push("The show peaked too early.");
  if (finalCrowd.satisfaction >= 70) notes.push("The crowd went home happy.");
  if (finalCrowd.satisfaction <= 35) notes.push("The crowd went home unhappy.");

  return { overall: score, overallComponents: components, overallNotes: notes };
}
