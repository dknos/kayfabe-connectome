/**
 * evidence-seeder@1 — turns one worker's pre-start EvidenceSummary into a
 * WorkerSeedResult.
 *
 * Pure and deterministic: no RNG, no wall clock. Per-person variation comes
 * from hashing (personId, attribute key) into bounded integer offsets so two
 * workers with identical careers are not attribute-sheet clones.
 *
 * Estimation model (full formula tables in docs/simulator/rules/seeder.md):
 * every attribute starts at a role-conditioned prior and moves toward each
 * evidence signal by Bayesian-style shrinkage, weight = n/(n+k). Sparse
 * careers therefore regress to priors with low/speculative confidence — they
 * are *uncertain*, never punished with low values for missing data.
 * Championships and win shares are positioning evidence (credibility,
 * prestige, push), never treated as skill.
 */

import type {
  AttributeKey,
  ConfidenceGrade,
  EvidenceSummary,
  SeededAttribute,
  WorkerSeedResult,
  WorkerStyle,
} from "@kayfabe/sim-contract";
import { hashString } from "../hash";

export const SEEDER_METHOD = "evidence-seeder@1";

/**
 * Role-conditioned priors. The slice seeds wrestlers only, so one column;
 * personality attributes anchor at 50 because the corpus carries no
 * personality evidence at all.
 */
export const ATTRIBUTE_PRIORS: Record<AttributeKey, number> = {
  fundamentals: 45,
  psychology: 45,
  athleticism: 45,
  technical: 45,
  brawling: 45,
  aerial: 45,
  stamina: 45,
  safety: 45,
  charisma: 45,
  promo: 45,
  starPresence: 45,
  crowdConnection: 45,
  reliability: 50,
  ambition: 50,
  ego: 50,
  loyalty: 50,
};

const CREDIBILITY_PRIOR = 45;
const PRESTIGE_PRIOR = 40;

// Shrinkage half-strengths: evidence weight = n/(n+k), so k is the sample
// size at which evidence and prior split the estimate 50/50.
const K_INRING = 150; // matches → execution-curve signals
const K_TECH_VOLUME = 300; // matches → technical (volume alone is weak evidence)
const K_MELTZER_TECHNICAL = 12; // rated matches → technical
const K_MELTZER_PSYCHOLOGY = 20;
const K_MELTZER_FUNDAMENTALS = 25;
const K_POSITIONING = 250; // matches → presentation positioning lifts
const K_STANDING = 200; // matches → credibility/prestige/push
const K_SMALL_FOLD = 300; // matches → tag/opponent/longevity/reliability folds

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function log10p(x: number): number {
  return Math.log10(1 + x);
}

/** One shrinkage update: move `current` toward `signal` by n/(n+k). */
function shrinkToward(current: number, signal: number, n: number, k: number): number {
  return current + (n / (n + k)) * (signal - current);
}

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** Deterministic per-person offset in [-2, +2]; keys the anti-clone jitter. */
function personOffset(personId: string, tag: string): number {
  return (parseInt(hashString(`${personId}#${tag}`).slice(0, 8), 16) % 5) - 2;
}

/**
 * Ring-time experience curve: log-scale diminishing returns on volume plus a
 * small career-span bonus. Feeds fundamentals/psychology/stamina.
 */
function experienceSignal(matches: number, careerYears: number): number {
  return clamp(32 + 17 * log10p(matches) + Math.min(9, 0.75 * careerYears), 1, 90);
}

/** Match-quality signal from Meltzer coverage (mean on −1..7). */
function meltzerSignal(mean: number, best: number): number {
  return clamp(42 + 10 * mean + 2 * Math.max(0, best - mean), 1, 95);
}

export function seedWorker(evidence: EvidenceSummary): WorkerSeedResult {
  const id = evidence.personId;
  const m = evidence.matches;
  const years = evidence.careerYears;
  const national = evidence.promoLevelMix.national;
  const mes = evidence.mainEventShare;
  const win = evidence.winShare;
  const tms = evidence.titleMatchShare;
  const tagShare = evidence.formMix.tag;
  const opponents = evidence.distinctOpponents;
  const density = evidence.recentDensity;
  const meltzer = evidence.meltzer;

  const expSig = experienceSignal(m, years);
  const expInputs = [`matches:${fmt(m)}`, `careerYears:${fmt(years)}`];
  const qualSig = meltzer ? meltzerSignal(meltzer.mean, meltzer.best) : null;
  const meltzerInputs = meltzer
    ? [
        `meltzerCount:${fmt(meltzer.count)}`,
        `meltzerMean:${fmt(meltzer.mean)}`,
        `meltzerBest:${fmt(meltzer.best)}`,
      ]
    : [];

  const speculative = m < 10;
  const inRingConf: ConfidenceGrade = speculative
    ? "speculative"
    : meltzer && meltzer.count >= 15 && m >= 100
      ? "high"
      : m >= 100
        ? "medium"
        : "low";
  const priorOnlyConf: ConfidenceGrade = speculative ? "speculative" : "low";
  const presentationConf: ConfidenceGrade = speculative
    ? "speculative"
    : mes === null || m < 100
      ? "low"
      : m >= 300 && national >= 0.5
        ? "high"
        : "medium";
  const staminaConf: ConfidenceGrade = speculative
    ? "speculative"
    : m >= 300 && density >= 30
      ? "high"
      : m >= 100
        ? "medium"
        : "low";

  const attr = (
    key: AttributeKey,
    value: number,
    confidence: ConfidenceGrade,
    inputs: string[],
  ): SeededAttribute => ({
    value: round1(clamp(value + personOffset(id, key), 1, 99)),
    confidence,
    method: SEEDER_METHOD,
    inputs,
  });

  const priorOnly = (key: AttributeKey, confidence: ConfidenceGrade): SeededAttribute =>
    attr(key, ATTRIBUTE_PRIORS[key], confidence, [`prior:${fmt(ATTRIBUTE_PRIORS[key])}`]);

  // --- in-ring execution -------------------------------------------------

  let fundamentals = shrinkToward(ATTRIBUTE_PRIORS.fundamentals, expSig, m, K_INRING);
  const fundamentalsInputs = ["prior:45", ...expInputs];
  if (meltzer && qualSig !== null) {
    fundamentals = shrinkToward(fundamentals, qualSig, meltzer.count, K_MELTZER_FUNDAMENTALS);
    fundamentalsInputs.push(...meltzerInputs);
  }

  let psychology = shrinkToward(ATTRIBUTE_PRIORS.psychology, expSig, m, K_INRING);
  const psychologyInputs = ["prior:45", ...expInputs];
  if (meltzer && qualSig !== null) {
    psychology = shrinkToward(psychology, qualSig, meltzer.count, K_MELTZER_PSYCHOLOGY);
    psychologyInputs.push(...meltzerInputs);
  }
  if (tagShare > 0) {
    psychology += 6 * tagShare * (m / (m + K_SMALL_FOLD));
    psychologyInputs.push(`formTag:${fmt(tagShare)}`);
  }
  if (opponents > 0) {
    psychology += Math.min(4, 1.4 * log10p(opponents)) * (m / (m + K_SMALL_FOLD));
    psychologyInputs.push(`distinctOpponents:${fmt(opponents)}`);
  }

  let stamina = shrinkToward(ATTRIBUTE_PRIORS.stamina, expSig, m, K_INRING);
  const staminaInputs = ["prior:45", ...expInputs];
  if (density > 0) {
    stamina += 12 * (density / (density + 60));
    staminaInputs.push(`recentDensity:${fmt(density)}`);
  }

  let technical = shrinkToward(ATTRIBUTE_PRIORS.technical, expSig, m, K_TECH_VOLUME);
  const technicalInputs = ["prior:45", ...expInputs];
  if (meltzer && qualSig !== null) {
    technical = shrinkToward(technical, qualSig, meltzer.count, K_MELTZER_TECHNICAL);
    technicalInputs.push(...meltzerInputs);
  }

  const safety =
    ATTRIBUTE_PRIORS.safety +
    (Math.min(8, 2.2 * log10p(m)) + Math.min(5, 0.45 * years)) * (m / (m + K_SMALL_FOLD));

  // --- presentation (positioning evidence: being placed on top implies the
  // presentation was valued — never a direct skill reading) ----------------

  const positioningLift = (mesWeight: number, natWeight: number): number =>
    ((mes ?? 0) * mesWeight + national * natWeight) * (m / (m + K_POSITIONING));
  const posInputs = [
    "prior:45",
    ...(mes !== null ? [`mainEventShare:${fmt(mes)}`] : []),
    `nationalShare:${fmt(national)}`,
  ];

  const charisma = ATTRIBUTE_PRIORS.charisma + positioningLift(42, 14);
  const promo = ATTRIBUTE_PRIORS.promo + positioningLift(38, 13);
  const crowdConnection = ATTRIBUTE_PRIORS.crowdConnection + positioningLift(40, 12);

  let starPresence = ATTRIBUTE_PRIORS.starPresence + positioningLift(52, 16);
  const starPresenceInputs = [...posInputs];
  if (win !== null) {
    starPresence += 20 * (win - 0.5) * (m / (m + K_STANDING));
    starPresenceInputs.push(`winShare:${fmt(win)}`);
  }

  // --- professional / personality ----------------------------------------

  let reliability =
    ATTRIBUTE_PRIORS.reliability +
    (Math.min(5, 0.35 * years) + 4 * (density / (density + 80))) * (m / (m + K_SMALL_FOLD));
  const reliabilityInputs = ["prior:50", ...expInputs];
  if (density > 0) reliabilityInputs.push(`recentDensity:${fmt(density)}`);

  const attributes: Record<AttributeKey, SeededAttribute> = {
    fundamentals: attr("fundamentals", fundamentals, inRingConf, fundamentalsInputs),
    psychology: attr("psychology", psychology, inRingConf, psychologyInputs),
    athleticism: priorOnly("athleticism", priorOnlyConf),
    technical: attr("technical", technical, inRingConf, technicalInputs),
    brawling: priorOnly("brawling", priorOnlyConf),
    aerial: priorOnly("aerial", priorOnlyConf),
    stamina: attr("stamina", stamina, staminaConf, staminaInputs),
    safety: attr("safety", safety, priorOnlyConf, ["prior:45", ...expInputs]),
    charisma: attr("charisma", charisma, presentationConf, posInputs),
    promo: attr("promo", promo, presentationConf, posInputs),
    starPresence: attr("starPresence", starPresence, presentationConf, starPresenceInputs),
    crowdConnection: attr("crowdConnection", crowdConnection, presentationConf, posInputs),
    reliability: attr("reliability", reliability, priorOnlyConf, reliabilityInputs),
    ambition: priorOnly("ambition", "speculative"),
    ego: priorOnly("ego", "speculative"),
    loyalty: priorOnly("loyalty", "speculative"),
  };

  // --- standing scalars ---------------------------------------------------

  const awarenessNational = round1(
    clamp(
      5 + 20 * log10p(m * national) + 25 * (mes ?? 0) + personOffset(id, "awarenessNational"),
      5,
      95,
    ),
  );

  // Mildly positive only: the corpus cannot evidence heat, so nobody seeds
  // with negative national affinity.
  const affinityNational = round1(
    clamp(
      6 +
        32 * (mes ?? 0) +
        10 * (density / (density + 60)) +
        8 * national +
        personOffset(id, "affinityNational"),
      0,
      60,
    ),
  );

  const credibilitySignal = 30 + 40 * (win ?? 0.5) + 34 * tms;
  const credibility = round1(
    clamp(
      shrinkToward(CREDIBILITY_PRIOR, credibilitySignal, m, K_STANDING) +
        personOffset(id, "credibility"),
      1,
      99,
    ),
  );

  const prestigeSignal = 28 + 42 * tms + Math.min(14, 1.1 * years) + 16 * national;
  const prestige = round1(
    clamp(
      shrinkToward(PRESTIGE_PRIOR, prestigeSignal, m, K_STANDING) + personOffset(id, "prestige"),
      1,
      99,
    ),
  );

  const styles: WorkerStyle[] = [];
  if (meltzer && meltzer.count >= 10 && meltzer.mean >= 4) styles.push("technician");
  if ((mes ?? 0) >= 0.3 && (!meltzer || meltzer.mean < 3.5)) styles.push("entertainer");
  if (styles.length === 0) styles.push("allrounder");

  return {
    attributes,
    awarenessNational,
    affinityNational,
    credibility,
    prestige,
    styles,
    // Alignment is a booking decision, not a career fact.
    alignment: "neutral",
  };
}
