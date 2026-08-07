/**
 * Participant effects and human-readable lines for segment reports.
 * Every delta is small and bounded; ranges are documented in
 * docs/simulator/rules/show.md. Deltas are outputs for the caller to apply
 * after the show — nothing here mutates worker state.
 */
import type {
  AngleBeat,
  BeatRole,
  FinishKind,
  InjuryLite,
  MatchPlan,
  ParticipantEffect,
  PersonId,
  ShowType,
  TitleState,
  WorkerState,
} from "@kayfabe/sim-contract";
import { clamp, getWorker, r1 } from "./util";

const DECISIVE: ReadonlySet<FinishKind> = new Set(["pin", "submission", "ko"]);
const CHEAP: ReadonlySet<FinishKind> = new Set(["dq", "countout"]);

const REACH: Record<ShowType, number> = { tv: 1, ppv: 0.8, house: 0.15 };

function awarenessDelta(
  attendance: number,
  showType: ShowType,
  mainEvent: boolean,
): number {
  return r1(
    Math.min(3, (0.2 + attendance / 15000) * REACH[showType] * (mainEvent ? 1.5 : 1)),
  );
}

function affinityDelta(reception: number): number {
  return r1(clamp((reception - 50) * 0.04, -2.5, 2.5));
}

export interface MatchEffectArgs {
  plan: MatchPlan;
  durationMin: number;
  reception: number;
  participants: PersonId[];
  sideOf: Record<PersonId, number>;
  contribution: Record<PersonId, number>;
  injuries: { personId: PersonId; injury: InjuryLite }[];
  workers: Record<PersonId, WorkerState>;
  attendance: number;
  showType: ShowType;
  titled: boolean;
}

export function buildMatchEffects(args: MatchEffectArgs): ParticipantEffect[] {
  const { plan, reception: r } = args;
  const decisive = DECISIVE.has(plan.finish);
  const cheap = CHEAP.has(plan.finish);
  const injuryByPerson = new Map(args.injuries.map((i) => [i.personId, i.injury]));

  return args.participants.map((id) => {
    const w = getWorker(args.workers, id);
    const side = args.sideOf[id]!;
    const isWinner = plan.winnerSide !== null && side === plan.winnerSide;
    const isLoser = plan.winnerSide !== null && side !== plan.winnerSide;

    let momentum = 0;
    if (isWinner) momentum = Math.min(12, 4 + r * 0.06);
    else if (isLoser && decisive) momentum = Math.max(-8, -(3 + Math.max(0, 60 - r) * 0.05));
    else if (isLoser && cheap) momentum = -1; // finish protected the loser

    let morale = 0;
    if (isWinner) morale += 2;
    if (plan.mainEvent) morale += 1.5;
    if (isLoser && decisive) morale -= 1.5;
    if (r >= 80) morale += 1;
    if (w.push === "main_event" && !plan.mainEvent) morale -= 1; // misused

    let credibility = 0;
    if (isWinner && decisive) credibility = args.titled ? 2.5 : 1.5;
    else if (isWinner && cheap) credibility = 0.5;
    else if (isLoser && decisive) credibility = -2;
    else if (isLoser && cheap) credibility = -0.5;

    return {
      personId: id,
      contribution: args.contribution[id]!,
      role: isWinner ? "winner" : isLoser ? "loser" : "participant",
      momentumDelta: r1(momentum),
      affinityDelta: affinityDelta(r),
      awarenessDelta: awarenessDelta(args.attendance, args.showType, plan.mainEvent),
      fatigueDelta: r1(Math.min(25, args.durationMin * (0.35 + plan.intensity / 200))),
      moraleDelta: r1(clamp(morale, -4, 4)),
      credibilityDelta: r1(credibility),
      injury: injuryByPerson.get(id) ?? null,
    };
  });
}

export interface AngleEffectArgs {
  reception: number;
  participants: PersonId[];
  contribution: Record<PersonId, number>;
  rolesByPerson: Record<PersonId, BeatRole[]>;
  minutesByPerson: Record<PersonId, number>;
  workers: Record<PersonId, WorkerState>;
  attendance: number;
  showType: ShowType;
  hasSaveBeat: boolean;
}

export function buildAngleEffects(args: AngleEffectArgs): ParticipantEffect[] {
  const r = args.reception;
  return args.participants.map((id) => {
    const roles = args.rolesByPerson[id]!;
    const aggressor = roles.includes("speaker") || roles.includes("attacker");
    const wt = aggressor ? 1 : 0.5;

    let credibility = 0;
    if (roles.includes("attacker") && r >= 70) credibility = 0.5;
    else if (roles.includes("victim") && !args.hasSaveBeat) credibility = -0.5;

    return {
      personId: id,
      contribution: args.contribution[id]!,
      role: [...roles].sort().join(", "),
      momentumDelta: r1(clamp((r - 55) * 0.08 * wt, -8, 10)),
      affinityDelta: affinityDelta(r),
      awarenessDelta: awarenessDelta(args.attendance, args.showType, false),
      fatigueDelta: r1(Math.min(25, args.minutesByPerson[id]! * 0.1)),
      moraleDelta: r1(clamp((r - 55) * 0.03, -4, 4)),
      credibilityDelta: r1(credibility),
      injury: null,
    };
  });
}

const FINISH_LABEL: Record<FinishKind, string> = {
  pin: "pin",
  submission: "submission",
  dq: "DQ",
  countout: "count-out",
  ko: "KO",
  no_contest: "no contest",
  time_limit_draw: "time-limit draw",
};

export function finishLabel(finish: FinishKind): string {
  return FINISH_LABEL[finish];
}

function names(ids: readonly PersonId[], workers: Record<PersonId, WorkerState>): string {
  return ids.map((id) => getWorker(workers, id).name).join(" & ");
}

export function matchHeadline(
  plan: MatchPlan,
  workers: Record<PersonId, WorkerState>,
  title: TitleState | null,
): string {
  const label = FINISH_LABEL[plan.finish];
  const suffix = title ? ` — ${title.name}` : "";
  if (
    plan.winnerSide === null ||
    plan.finish === "no_contest" ||
    plan.finish === "time_limit_draw"
  ) {
    const all = plan.sides.map((s) => names(s.members, workers)).join(" vs. ");
    return `${all} — ${label}${suffix}`;
  }
  const winners = names(plan.sides[plan.winnerSide]!.members, workers);
  const losers = plan.sides
    .filter((_, i) => i !== plan.winnerSide)
    .map((s) => names(s.members, workers))
    .join(", ");
  return `${winners} def. ${losers} (${label})${suffix}`;
}

function byRole(beat: AngleBeat, role: BeatRole): PersonId[] {
  return beat.participants.filter((p) => p.role === role).map((p) => p.personId);
}

/** Verb agreeing with a simple singular/plural subject. */
function v(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function angleHeadline(
  beats: AngleBeat[],
  workers: Record<PersonId, WorkerState>,
): string {
  const beat = beats[0]!;
  const all = beat.participants.map((p) => p.personId);
  const speakers = byRole(beat, "speaker");
  const attackers = byRole(beat, "attacker");
  const victims = byRole(beat, "victim");
  const targets = byRole(beat, "target");
  const interviewers = byRole(beat, "interviewer");

  switch (beat.purpose) {
    case "promo": {
      const who = speakers.length > 0 ? speakers : all;
      const verb = v(who.length, "cuts", "cut");
      return targets.length > 0
        ? `${names(who, workers)} ${verb} a promo on ${names(targets, workers)}`
        : `${names(who, workers)} ${verb} a promo`;
    }
    case "challenge": {
      const who = speakers.length > 0 ? speakers : all;
      const at = targets.length > 0 ? targets : victims;
      const verb = v(who.length, "calls out", "call out");
      return at.length > 0
        ? `${names(who, workers)} ${verb} ${names(at, workers)}`
        : `${names(who, workers)} ${v(who.length, "issues", "issue")} a challenge`;
    }
    case "attack": {
      const who = attackers.length > 0 ? attackers : all;
      const at = victims.length > 0 ? victims : targets;
      const verb = v(who.length, "ambushes", "ambush");
      return at.length > 0
        ? `${names(who, workers)} ${verb} ${names(at, workers)}`
        : `${names(who, workers)} ${v(who.length, "runs", "run")} wild`;
    }
    case "betrayal": {
      const who = attackers.length > 0 ? attackers : all;
      const at = victims.length > 0 ? victims : targets;
      const verb = v(who.length, "turns on", "turn on");
      return at.length > 0
        ? `${names(who, workers)} ${verb} ${names(at, workers)}`
        : `${names(who, workers)} — betrayal`;
    }
    case "save": {
      const saved = victims.length > 0 ? victims : targets;
      const savers = all.filter((id) => !saved.includes(id));
      return saved.length > 0 && savers.length > 0
        ? `${names(savers, workers)} ${v(savers.length, "makes", "make")} the save for ${names(saved, workers)}`
        : `${names(all, workers)} — save`;
    }
    case "interview": {
      const who = interviewers.length > 0 ? interviewers : all;
      const guest = speakers.length > 0 ? speakers : targets;
      return guest.length > 0
        ? `${names(who, workers)} ${v(who.length, "interviews", "interview")} ${names(guest, workers)}`
        : `${names(all, workers)} — interview`;
    }
    case "contract_signing":
      return `Contract signing: ${names(all, workers)}`;
    case "video_package":
      return `Video package: ${names(all, workers)}`;
    case "reveal":
    case "celebration":
      return `${names(all, workers)} — ${beat.purpose}`;
  }
}
