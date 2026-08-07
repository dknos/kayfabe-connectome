/**
 * segment-eval@1 — execution scoring: how well the performers did the thing
 * they were actually asked to do. Matches score on style-weighted in-ring
 * craft; angle beats score each participant on their AngleBeat role only
 * (a silent victim is never rated on promo delivery). The only RNG in the
 * whole show simulation lives here: one injury roll per match participant,
 * always drawn in flattened side order so the draw schedule never depends
 * on attributes or outcomes.
 */
import type {
  AngleBeat,
  BeatRole,
  InjuryLite,
  IsoDate,
  MatchPlan,
  PersonId,
  ScoreComponent,
  SegmentId,
  WorkerState,
  WorkerStyle,
} from "@kayfabe/sim-contract";
import { addDays } from "../dates";
import { hashString } from "../hash";
import type { RngStream } from "../rng";
import { chemistryPair, clamp100, getWorker, finalizeScore, mean, r1 } from "./util";

export const SEGMENT_EVAL_VERSION = "segment-eval@1";

/** Injuries cannot roll below this hazard — safe workers in safe matches
 *  are never hurt by the dice (hazard = risk/100 × (100−safety)/100). */
const INJURY_HAZARD_FLOOR = 0.02;
const INJURY_MAX_CHANCE = 0.25;
const INJURY_BASE_DAYS = { minor: 7, moderate: 30, severe: 120 } as const;
const INJURY_DISRUPTION = { minor: 3, moderate: 8, severe: 15 } as const;
const INJURY_KINDS = {
  minor: ["bruised ribs", "sprained ankle", "hyperextended elbow"],
  moderate: ["torn shoulder muscle", "knee sprain", "concussion"],
  severe: ["torn ACL", "broken collarbone", "ruptured disc"],
} as const;

type Severity = keyof typeof INJURY_BASE_DAYS;

function styleSkill(style: WorkerStyle, w: WorkerState): number {
  const a = w.attributes;
  switch (style) {
    case "technician":
      return a.technical;
    case "brawler":
    case "hardcore":
      return a.brawling;
    case "highflyer":
      return a.aerial;
    case "powerhouse":
      return (a.athleticism + a.brawling) / 2;
    case "allrounder":
      return (a.technical + a.brawling + a.aerial) / 3;
    case "entertainer":
      return (a.charisma + a.psychology) / 2;
  }
}

function inRingCraft(w: WorkerState): number {
  const a = w.attributes;
  const buckets =
    w.styles.length > 0 ? w.styles.map((s) => styleSkill(s, w)) : [a.fundamentals];
  return (
    0.28 * a.fundamentals +
    0.22 * a.psychology +
    0.14 * a.athleticism +
    0.36 * mean(buckets)
  );
}

export interface MatchExecArgs {
  plan: MatchPlan;
  durationMin: number;
  segmentId: SegmentId;
  showDate: IsoDate;
  workers: Record<PersonId, WorkerState>;
  rng: RngStream;
}

export interface MatchExecResult {
  execution: number;
  components: ScoreComponent[];
  /** Flattened side order (side 0 members, then side 1, …). */
  participants: PersonId[];
  sideOf: Record<PersonId, number>;
  contribution: Record<PersonId, number>;
  injuries: { personId: PersonId; injury: InjuryLite }[];
  chemAvg: number;
  opposedPairs: [PersonId, PersonId][];
}

export function evaluateMatchExecution(args: MatchExecArgs): MatchExecResult {
  const { plan, durationMin, workers, rng } = args;

  const participants: PersonId[] = [];
  const sideOf: Record<PersonId, number> = {};
  for (let s = 0; s < plan.sides.length; s++) {
    for (const id of plan.sides[s]!.members) {
      participants.push(id);
      if (!(id in sideOf)) sideOf[id] = s;
    }
  }

  const opposedPairs: [PersonId, PersonId][] = [];
  for (let i = 0; i < plan.sides.length; i++) {
    for (let j = i + 1; j < plan.sides.length; j++) {
      for (const a of plan.sides[i]!.members) {
        for (const b of plan.sides[j]!.members) opposedPairs.push([a, b]);
      }
    }
  }
  const chemAvg =
    opposedPairs.length > 0
      ? mean(opposedPairs.map(([a, b]) => chemistryPair(a, b)))
      : 0;

  const staminaNeed = durationMin * (plan.intensity / 100) * 3.5;
  const crafts: number[] = [];
  const fatiguePens: number[] = [];
  const staminaPens: number[] = [];
  const hurtPens: number[] = [];
  for (const id of participants) {
    const w = getWorker(workers, id);
    crafts.push(inRingCraft(w));
    fatiguePens.push(0.15 * w.condition.fatigue);
    staminaPens.push(0.2 * Math.max(0, staminaNeed - w.attributes.stamina));
    hurtPens.push(w.condition.injury ? 12 : 0);
  }

  // One roll per participant, always drawn, so the rng schedule is fixed.
  const injuries: { personId: PersonId; injury: InjuryLite }[] = [];
  const injuredSet = new Set<PersonId>();
  for (const id of participants) {
    const w = getWorker(workers, id);
    const hazard = (plan.risk / 100) * ((100 - w.attributes.safety) / 100);
    const chance =
      hazard <= INJURY_HAZARD_FLOOR
        ? 0
        : (INJURY_MAX_CHANCE * (hazard - INJURY_HAZARD_FLOOR)) /
          (1 - INJURY_HAZARD_FLOOR);
    const u = rng.next();
    if (chance > 0 && u < chance) {
      const t = u / chance;
      const severity: Severity = t < 0.6 ? "minor" : t < 0.9 ? "moderate" : "severe";
      const kinds = INJURY_KINDS[severity];
      const kind =
        kinds[parseInt(hashString(`injury|${id}|${args.segmentId}`).slice(0, 8), 16) % kinds.length]!;
      const outDays = Math.round(
        INJURY_BASE_DAYS[severity] * (0.75 + plan.intensity / 200),
      );
      injuries.push({
        personId: id,
        injury: { kind, severity, outUntil: addDays(args.showDate, outDays) },
      });
      injuredSet.add(id);
    }
  }
  let disruption = 0;
  for (const { injury } of injuries) {
    disruption = Math.max(disruption, INJURY_DISRUPTION[injury.severity]);
  }

  const craftMean = mean(crafts);
  const carried = craftMean + 0.15 * (Math.max(...crafts) - craftMean);

  const parts: ScoreComponent[] = [
    {
      label: "In-ring craft",
      value: carried,
      note: "style-weighted skill of the workers, lifted toward the best performer",
    },
    { label: "Chemistry", value: 1.5 * chemAvg, note: "how these opponents mesh" },
    {
      label: "Fatigue coming in",
      value: -mean(fatiguePens),
      note: "tired performers work slower",
    },
    {
      label: "Overbooked length",
      value: -mean(staminaPens),
      note: "match length × intensity beyond the workers' stamina",
    },
    {
      label: "Working hurt",
      value: -mean(hurtPens),
      note: "booked while carrying an injury",
    },
    {
      label: "Injury disruption",
      value: -disruption,
      note: "an in-match injury broke the flow",
    },
  ];
  const { score, components } = finalizeScore(parts);

  const contribution: Record<PersonId, number> = {};
  for (let i = 0; i < participants.length; i++) {
    const id = participants[i]!;
    const personal =
      crafts[i]! -
      fatiguePens[i]! -
      staminaPens[i]! -
      hurtPens[i]! -
      (injuredSet.has(id) ? disruption : 0);
    contribution[id] = r1(clamp100(personal));
  }

  return {
    execution: score,
    components,
    participants,
    sideOf,
    contribution,
    injuries,
    chemAvg,
    opposedPairs,
  };
}

/** What each beat role is actually judged on. No promo for silent roles. */
function roleScore(role: BeatRole, w: WorkerState): number {
  const a = w.attributes;
  switch (role) {
    case "speaker":
      return 0.45 * a.promo + 0.35 * a.charisma + 0.2 * a.crowdConnection;
    case "interviewer":
      return 0.5 * a.promo + 0.3 * a.charisma + 0.2 * a.psychology;
    case "attacker":
      // menace proxy: physical presence, aura, and character work
      return 0.4 * a.brawling + 0.35 * a.starPresence + 0.25 * a.charisma;
    case "victim":
      // selling, not speaking
      return 0.5 * a.psychology + 0.3 * a.fundamentals + 0.2 * a.crowdConnection;
    case "target":
      return 0.4 * a.crowdConnection + 0.3 * a.charisma + 0.3 * a.psychology;
    case "bystander":
      return 0.5 * a.reliability + 0.5 * a.psychology;
  }
}

const ROLE_WEIGHT: Record<BeatRole, number> = {
  speaker: 1,
  attacker: 1,
  victim: 0.7,
  target: 0.7,
  interviewer: 0.5,
  bystander: 0.25,
};

export interface AngleExecArgs {
  beats: AngleBeat[];
  workers: Record<PersonId, WorkerState>;
}

export interface AngleExecResult {
  execution: number;
  components: ScoreComponent[];
  /** First-appearance order across beats. */
  participants: PersonId[];
  contribution: Record<PersonId, number>;
  rolesByPerson: Record<PersonId, BeatRole[]>;
  minutesByPerson: Record<PersonId, number>;
  opposedPairs: [PersonId, PersonId][];
  hasAttackBeat: boolean;
  hasSaveBeat: boolean;
}

export function evaluateAngleExecution(args: AngleExecArgs): AngleExecResult {
  const { beats, workers } = args;

  const participants: PersonId[] = [];
  const rolesByPerson: Record<PersonId, BeatRole[]> = {};
  const minutesByPerson: Record<PersonId, number> = {};
  const scoreSum: Record<PersonId, number> = {};
  const scoreWeight: Record<PersonId, number> = {};
  const opposedPairs: [PersonId, PersonId][] = [];
  let hasAttackBeat = false;
  let hasSaveBeat = false;

  const beatCrafts: number[] = [];
  const beatChems: number[] = [];
  const beatDurations: number[] = [];

  for (const beat of beats) {
    const dur = Math.max(1, beat.durationMin);
    if (beat.purpose === "attack" || beat.purpose === "betrayal") hasAttackBeat = true;
    if (beat.purpose === "save") hasSaveBeat = true;

    let wSum = 0;
    let wScore = 0;
    for (const p of beat.participants) {
      const w = getWorker(workers, p.personId);
      const score = roleScore(p.role, w);
      const weight = ROLE_WEIGHT[p.role];
      wScore += score * weight;
      wSum += weight;

      if (!(p.personId in rolesByPerson)) {
        participants.push(p.personId);
        rolesByPerson[p.personId] = [];
        minutesByPerson[p.personId] = 0;
        scoreSum[p.personId] = 0;
        scoreWeight[p.personId] = 0;
      }
      if (!rolesByPerson[p.personId]!.includes(p.role)) rolesByPerson[p.personId]!.push(p.role);
      minutesByPerson[p.personId]! += dur;
      scoreSum[p.personId]! += score * dur;
      scoreWeight[p.personId]! += dur;
    }
    beatCrafts.push(wSum > 0 ? wScore / wSum : 0);
    beatDurations.push(dur);

    const ids = beat.participants.map((p) => p.personId);
    const pairChems: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        pairChems.push(chemistryPair(ids[i]!, ids[j]!));
      }
    }
    beatChems.push(pairChems.length > 0 ? mean(pairChems) : 0);

    if (beat.purpose === "attack" || beat.purpose === "betrayal") {
      const attackers = beat.participants.filter((p) => p.role === "attacker");
      const struck = beat.participants.filter(
        (p) => p.role === "victim" || p.role === "target",
      );
      for (const a of attackers) {
        for (const v of struck) opposedPairs.push([a.personId, v.personId]);
      }
    }
  }

  const totalDur = beatDurations.reduce((a, d) => a + d, 0);
  let craft = 0;
  let chem = 0;
  for (let i = 0; i < beats.length; i++) {
    craft += beatCrafts[i]! * (beatDurations[i]! / totalDur);
    chem += beatChems[i]! * (beatDurations[i]! / totalDur);
  }

  const fatiguePen =
    participants.length > 0
      ? 0.08 * mean(participants.map((id) => getWorker(workers, id).condition.fatigue))
      : 0;

  const parts: ScoreComponent[] = [
    {
      label: "Delivery",
      value: craft,
      note: "role-weighted performance: each participant judged only on what they were asked to do",
    },
    { label: "Chemistry", value: 0.75 * chem, note: "how these performers mesh" },
    {
      label: "Fatigue coming in",
      value: -fatiguePen,
      note: "tired performers lose the room",
    },
  ];
  const { score, components } = finalizeScore(parts);

  const contribution: Record<PersonId, number> = {};
  for (const id of participants) {
    const w = getWorker(workers, id);
    const avg = scoreWeight[id]! > 0 ? scoreSum[id]! / scoreWeight[id]! : 0;
    contribution[id] = r1(clamp100(avg - 0.08 * w.condition.fatigue));
  }

  return {
    execution: score,
    components,
    participants,
    contribution,
    rolesByPerson,
    minutesByPerson,
    opposedPairs,
    hasAttackBeat,
    hasSaveBeat,
  };
}
