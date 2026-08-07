/**
 * crowd-flow@1 — the audience as a stateful actor.
 *
 * The crowd arrives with a finite tank (energy) that hot segments spend and
 * breathers partially refill; fatigue accumulates with physical load and only
 * subsides during cool-downs; satisfaction chases reception; anticipation
 * builds through the card and is released by the main event. Every axis moves
 * through a bounded softsign step — never raw unbounded addition — so no
 * single segment can teleport the crowd across the 0–100 scale. Formulas and
 * constants are documented in docs/simulator/rules/show.md.
 */
import type { CrowdState, ShowType, Standing } from "@kayfabe/sim-contract";
import { clamp, clamp100, r1, soft } from "./util";

export const CROWD_FLOW_VERSION = "crowd-flow@1";

const SHOW_HEAT: Record<ShowType, number> = { ppv: 12, tv: 4, house: -6 };
const SHOW_ANTICIPATION: Record<ShowType, number> = { ppv: 68, tv: 52, house: 40 };

export interface CrowdInitArgs {
  showType: ShowType;
  attendance: number;
  capacity: number;
  venuePrestige: number;
  /** Baseline appetite for wrestling in the show's market, 0–100. */
  wrestlingInterest: number;
  /** Promoting company's standing; market delta applied for the show market. */
  standing: Standing;
  marketId: string;
}

export function initCrowd(args: CrowdInitArgs): CrowdState {
  const fill = clamp(args.attendance / Math.max(1, args.capacity), 0, 1);
  const delta = args.standing.marketDelta[args.marketId];
  const aff = clamp(args.standing.affinityNational + (delta?.affinity ?? 0), -100, 100);
  const awa = clamp100(args.standing.awarenessNational + (delta?.awareness ?? 0));
  const aff01 = (aff + 100) / 200;
  const heat = SHOW_HEAT[args.showType];
  return {
    energy: r1(clamp100(36 + 30 * fill + 16 * aff01 + heat + args.venuePrestige * 0.05)),
    attention: r1(clamp100(48 + 14 * fill + heat * 0.5)),
    investment: r1(
      clamp100(
        28 + 34 * aff01 + 0.12 * awa + (args.wrestlingInterest - 50) * 0.1 + heat * 0.5,
      ),
    ),
    fatigue: 0,
    hostility: r1(clamp100(Math.max(0, -aff) * 0.25)),
    satisfaction: 50,
    anticipation: r1(clamp100(SHOW_ANTICIPATION[args.showType] + 12 * fill)),
  };
}

export interface CrowdSegmentLoad {
  reception: number;
  kind: "match" | "angle";
  durationMin: number;
  /** Planned match intensity; 0 for angles. */
  intensity: number;
  storylineLinked: boolean;
  /** dq/countout/no-contest on a title match or main event. */
  cheapFinish: boolean;
  /** The flagged main event releases accumulated anticipation. */
  mainEventRelease: boolean;
}

export function updateCrowd(c: CrowdState, s: CrowdSegmentLoad): CrowdState {
  const load =
    s.kind === "match"
      ? s.durationMin * (0.3 + s.intensity / 200)
      : s.durationMin * 0.12;
  const hot = s.reception >= 80 ? 2 : 0;
  const relief = s.kind === "angle" ? 4 : s.intensity <= 40 ? 2 : 0;
  const recover = s.kind === "angle" ? 5 : s.intensity <= 40 ? 3 : 0;
  const spend = load * 0.5 + Math.max(0, s.reception - 60) * 0.1;

  const investBase = s.reception - 55 + (s.storylineLinked ? 6 : 0);
  const cheap = s.cheapFinish ? 6 : 0;
  const hostDelta =
    (s.reception < 45 ? (45 - s.reception) * 0.3 : -Math.max(0, s.reception - 60) * 0.1) +
    cheap;

  return {
    energy: r1(clamp100(c.energy + 12 * soft((recover - spend) / 12))),
    attention: r1(clamp100(c.attention + 10 * soft((s.reception - 52) / 14))),
    investment: r1(clamp100(c.investment + 8 * soft(investBase / 15))),
    fatigue: r1(clamp100(c.fatigue + 20 * soft((load + hot - relief) / 20))),
    hostility: r1(clamp100(c.hostility + 10 * soft(hostDelta / 10))),
    satisfaction: r1(clamp100(c.satisfaction + (s.reception - c.satisfaction) * 0.35)),
    anticipation: s.mainEventRelease
      ? r1(clamp100(c.anticipation * 0.3))
      : r1(clamp100(c.anticipation + 7 * soft((s.reception - 45) / 20))),
  };
}
