/**
 * segment-eval@1 — reception scoring: how the crowd took what it was shown.
 * Execution carries most of the weight, then the crowd's own state, the
 * stakes, star power, novelty, product-DNA fit, and pacing placement.
 * Additive components; finalizeScore keeps the parts summing to the score.
 */
import type {
  CrowdState,
  IsoDate,
  MatchPlan,
  PersonId,
  ProductDna,
  ScoreComponent,
  Storyline,
  StorylineId,
  TitleState,
  WorkerState,
} from "@kayfabe/sim-contract";
import { diffDays } from "../dates";
import { clamp, clamp100, finalizeScore, getWorker, mean, sortedKeys } from "./util";

const TITLE_STAKES: Record<TitleState["tier"], number> = {
  world: 8,
  secondary: 5,
  tag: 4,
  other: 3,
};

const REPETITION_PENALTY = -8;
const OVEREXPOSURE_PENALTY = -3;
const OVEREXPOSURE_WINDOW_DAYS = 14;
const OVEREXPOSURE_BEATS = 3;
const CONFUSION_PER_PAIR = -5;
const COOLDOWN_ENERGY = 42;

export interface ReceptionArgs {
  crowd: CrowdState;
  execution: number;
  kind: "match" | "angle";
  /** null for angles. */
  plan: MatchPlan | null;
  participants: PersonId[];
  /** Cross-side pairs (matches) or attacker→struck pairs (angles). */
  opposedPairs: readonly [PersonId, PersonId][];
  workers: Record<PersonId, WorkerState>;
  title: TitleState | null;
  /** The storyline the segment is booked under, when resolvable. */
  storyline: Storyline | null;
  storylines: Record<StorylineId, Storyline>;
  dna: ProductDna;
  showDate: IsoDate;
  /** 0-based index of the earlier segment with this exact pairing, if any. */
  repeatedSegmentIndex: number | null;
  /** Angle only: an attack/betrayal beat is present. */
  hasAttackBeat: boolean;
}

export interface ReceptionFlags {
  titleStakes: boolean;
  mainEventPayoff: boolean;
  confusionPairs: number;
  cooldown: "breather" | "burnout" | null;
  overexposed: boolean;
}

export interface ReceptionResult {
  reception: number;
  components: ScoreComponent[];
  flags: ReceptionFlags;
}

interface FitFeatures {
  athleticCompetition: number;
  characterSpectacle: number;
  serializedStory: number;
  violence: number;
}

/** Signed alignment between what was shown and what this audience buys. */
function productFit(dna: ProductDna, feat: FitFeatures): number {
  // fixed axis order (not object iteration) for determinism
  const axes: (keyof FitFeatures)[] = [
    "athleticCompetition",
    "characterSpectacle",
    "serializedStory",
    "violence",
  ];
  let fit = 0;
  for (const axis of axes) {
    fit += 3 * ((dna[axis] - 50) / 50) * ((feat[axis] - 50) / 50);
  }
  return clamp(fit, -8, 8);
}

/**
 * Confusion: people who share a storyline side fighting each other with no
 * storyline attached to the segment reads as nonsense to the crowd.
 */
function countConfusionPairs(args: ReceptionArgs): number {
  if (args.storyline !== null) return 0;
  let conflicts = 0;
  for (const [a, b] of args.opposedPairs) {
    for (const key of sortedKeys(args.storylines)) {
      const st = args.storylines[key]!;
      if (st.phase !== "building" && st.phase !== "peak" && st.phase !== "blowoff") continue;
      const ra = st.participants.find((p) => p.personId === a)?.role;
      const rb = st.participants.find((p) => p.personId === b)?.role;
      if (ra !== undefined && rb !== undefined && ra === rb) {
        conflicts++;
        break; // one conflict per pair
      }
    }
  }
  return conflicts;
}

export function computeReception(args: ReceptionArgs): ReceptionResult {
  const { crowd, plan } = args;
  const parts: ScoreComponent[] = [];
  const flags: ReceptionFlags = {
    titleStakes: false,
    mainEventPayoff: false,
    confusionPairs: 0,
    cooldown: null,
    overexposed: false,
  };

  parts.push({
    label: "Execution carried through",
    value: 0.62 * args.execution,
    note: "the work itself, as the crowd saw it",
  });
  parts.push({
    label: "Crowd energy",
    value: (crowd.energy - 50) * 0.15,
    note: "a lively room lifts everything",
  });
  parts.push({
    label: "Crowd attention",
    value: (crowd.attention - 50) * 0.08,
    note: "an audience that is still watching",
  });
  parts.push({
    label: "Crowd burnout",
    value: -crowd.fatigue * 0.18,
    note: "a spent crowd cannot answer the bell",
  });

  if (args.title !== null) {
    flags.titleStakes = true;
    parts.push({
      label: "Title stakes",
      value: TITLE_STAKES[args.title.tier],
      note: `${args.title.name} on the line`,
    });
  }
  if (args.storyline !== null) {
    parts.push({
      label: "Storyline heat",
      value: args.storyline.heat * 0.08,
      note: `invested in "${args.storyline.name}"`,
    });
  }
  if (plan?.mainEvent) {
    parts.push({
      label: "Main-event spot",
      value: 4 + (crowd.anticipation - 50) * 0.1,
      note: "the match the card built toward",
    });
    flags.mainEventPayoff = crowd.anticipation >= 65;
  }

  if (args.participants.length > 0) {
    const star = mean(
      args.participants.map((id) => {
        const w = getWorker(args.workers, id);
        return (
          0.5 * w.standing.awarenessNational + 0.5 * Math.abs(w.standing.affinityNational)
        );
      }),
    );
    parts.push({
      label: "Star power",
      value: star * 0.1,
      note: "how known and how felt these performers are",
    });
  }

  if (args.repeatedSegmentIndex !== null) {
    parts.push({
      label: "Repetition",
      value: REPETITION_PENALTY,
      note: `same pairing as segment ${args.repeatedSegmentIndex + 1}`,
    });
  }
  if (args.storyline !== null) {
    const recent = args.storyline.beats.filter((b) => {
      const d = diffDays(b.date, args.showDate);
      return d >= 0 && d <= OVEREXPOSURE_WINDOW_DAYS;
    }).length;
    if (recent >= OVEREXPOSURE_BEATS) {
      flags.overexposed = true;
      parts.push({
        label: "Storyline overexposure",
        value: OVEREXPOSURE_PENALTY,
        note: "this story has been on screen a lot lately",
      });
    }
  }

  const feat: FitFeatures =
    args.kind === "match" && plan
      ? {
          violence: clamp100(
            0.6 * plan.intensity + 0.4 * plan.risk + (plan.stipulation ? 15 : 0),
          ),
          athleticCompetition: mean(
            args.participants.map((id) => {
              const a = getWorker(args.workers, id).attributes;
              return (a.technical + a.athleticism + a.aerial) / 3;
            }),
          ),
          characterSpectacle: mean(
            args.participants.map((id) => {
              const a = getWorker(args.workers, id).attributes;
              return (a.charisma + a.starPresence) / 2;
            }),
          ),
          serializedStory:
            args.storyline !== null ? clamp100(55 + args.storyline.heat * 0.45) : 30,
        }
      : {
          violence: args.hasAttackBeat ? 70 : 20,
          athleticCompetition: 15,
          characterSpectacle:
            args.participants.length > 0
              ? mean(
                  args.participants.map((id) => {
                    const a = getWorker(args.workers, id).attributes;
                    return (a.charisma + a.starPresence) / 2;
                  }),
                )
              : 50,
          serializedStory:
            args.storyline !== null ? clamp100(60 + args.storyline.heat * 0.4) : 35,
        };
  parts.push({
    label: "Product fit",
    value: productFit(args.dna, feat),
    note: "match between what was shown and what this audience buys tickets for",
  });

  const confusion = countConfusionPairs(args);
  if (confusion > 0) {
    flags.confusionPairs = confusion;
    parts.push({
      label: "Confusion",
      value: CONFUSION_PER_PAIR * Math.min(2, confusion),
      note: "storyline allies fighting with no on-screen reason",
    });
  }

  if (crowd.energy < COOLDOWN_ENERGY) {
    const intensity = plan?.intensity ?? 0;
    if (args.kind === "angle" || intensity <= 40) {
      flags.cooldown = "breather";
      parts.push({
        label: "Pacing slot",
        value: 3,
        note: "a well-placed breather for a tired crowd",
      });
    } else if (intensity >= 70) {
      flags.cooldown = "burnout";
      parts.push({
        label: "Pacing slot",
        value: -4,
        note: "the crowd was too spent for another war",
      });
    }
  }

  const { score, components } = finalizeScore(parts);
  return { reception: score, components, flags };
}
