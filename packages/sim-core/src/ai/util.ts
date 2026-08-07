import type {
  AiProfile,
  IsoDate,
  PersonId,
  PushLevel,
  WorkerState,
} from "@kayfabe/sim-contract";
import { hashString } from "../hash";
import { compareDates } from "../dates";
import type { AiTickContext } from "./types";

/** Sorted keys — the only sanctioned way the AI iterates a Record. */
export function aiSortedKeys<T>(rec: Record<string, T>): string[] {
  return Object.keys(rec).sort();
}

/**
 * Deterministic index in [0, n) derived from a string key. Used for venue
 * rotation and show-name selection so scheduling consumes no rng draws
 * (fewer draws = the shared company stream stays stable across code paths).
 */
export function hashPick(key: string, n: number): number {
  if (n <= 0) throw new Error("hashPick: n must be positive");
  return parseInt(hashString(key).slice(0, 8), 16) % n;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const PUSH_RANK: Record<PushLevel, number> = {
  main_event: 50,
  upper: 40,
  midcard: 30,
  lower: 20,
  opener: 10,
  unused: 0,
};

export function pushRank(push: PushLevel): number {
  return PUSH_RANK[push];
}

/** Bookable on `date`: active and not injured past it (mirrors validateCard). */
export function isAvailable(w: WorkerState, date: IsoDate): boolean {
  if (!w.active) return false;
  const inj = w.condition.injury;
  return inj === null || compareDates(inj.outUntil, date) <= 0;
}

export interface UtilityPart {
  label: string;
  value: number;
}

export interface ScoredCandidate {
  personId: PersonId;
  utility: number;
  parts: UtilityPart[];
  /** Label of the largest positive part, for reason codes. */
  dominant: string;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Challenger/booking utility: momentum + awareness + credibility +
 * alignment opposition + not-recently-repeated + youthBias/starBias.
 * Weights are design values documented in docs/simulator/rules/ai.md.
 */
export function scoreCandidate(
  w: WorkerState,
  profile: AiProfile,
  opts: {
    /** Alignment of the person they would oppose, when known. */
    opposeAlignment?: WorkerState["alignment"];
    /** Recently featured in the previous program for this slot. */
    recentlyRepeated?: boolean;
  },
): ScoredCandidate {
  const parts: UtilityPart[] = [];
  parts.push({ label: "momentum", value: round3(w.momentum * 0.5) });
  parts.push({ label: "awareness", value: round3(w.standing.awarenessNational * 0.4) });
  parts.push({ label: "credibility", value: round3(w.credibility * 0.3) });

  let opposition = 0;
  if (opts.opposeAlignment !== undefined) {
    if (w.alignment !== "neutral" && opts.opposeAlignment !== "neutral") {
      opposition = w.alignment !== opts.opposeAlignment ? 20 : 0;
    } else {
      opposition = 5;
    }
  }
  parts.push({ label: "opposition", value: opposition });

  parts.push({ label: "freshness", value: opts.recentlyRepeated ? -25 : 0 });

  // youthBias −100 (veterans) .. 100 (youth): reward the preferred career age.
  const youth = round3(-(profile.youthBias / 100) * (w.experienceYears - 10));
  parts.push({ label: "youth", value: youth });

  let star = 0;
  switch (profile.starBias) {
    case "charisma":
      star = w.attributes.charisma * 0.2;
      break;
    case "workrate":
      star = ((w.attributes.technical + w.attributes.psychology) / 2) * 0.2;
      break;
    case "size":
      star = w.styles.includes("powerhouse") ? 15 : w.attributes.brawling * 0.1;
      break;
    case "proven":
      star = w.prestige * 0.2 + Math.min(w.experienceYears, 25) * 0.5;
      break;
  }
  parts.push({ label: "starBias", value: round3(star) });

  let utility = 0;
  for (const p of parts) utility += p.value;

  let dominant = "momentum";
  let best = -Infinity;
  for (const p of parts) {
    if (p.value > best) {
      best = p.value;
      dominant = p.label;
    }
  }
  return { personId: w.personId, utility: round3(utility), parts, dominant };
}

/** Winner-picking weight for non-program matches: momentum + push. */
export function matchWinScore(w: WorkerState): number {
  return w.momentum * 0.5 + pushRank(w.push);
}

/** The company's roster: people on its active contracts, sorted, deduped. */
export function rosterOf(ctx: AiTickContext): PersonId[] {
  const contracts = ctx.contractsByCompany[ctx.company.id] ?? [];
  const ids = new Set<PersonId>();
  for (const c of [...contracts].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    ids.add(c.personId);
  }
  return [...ids].sort();
}

/** Roster members that exist and are bookable on `date`. */
export function availableRoster(ctx: AiTickContext, date: IsoDate): WorkerState[] {
  const out: WorkerState[] = [];
  for (const pid of rosterOf(ctx)) {
    const w = ctx.workers[pid];
    if (w && isAvailable(w, date)) out.push(w);
  }
  return out;
}
