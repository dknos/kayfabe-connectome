import type {
  MatchMoment,
  MatchPlan,
  TitleState,
  WorkerState,
} from "@kayfabe/sim-contract";
import { RngStream } from "../rng";

export const MATCH_ENGINE_VERSION = "match-engine@1";

/**
 * Beat-by-beat in-ring story (match-engine@1). Purely presentational over
 * the already-decided result: the log dramatizes execution/reception, it
 * never changes them. Deterministic per (showId, segmentId) via its own
 * derived RNG stream, so it consumes nothing from the show's draw schedule
 * and replays identically from a save.
 */
export interface MatchLogArgs {
  showId: string;
  segmentId: string;
  plan: MatchPlan;
  durationMin: number;
  workers: Record<string, WorkerState>;
  execution: number;
  reception: number;
  title: TitleState | null;
  titleChanged: boolean;
  /** 0–100 crowd temperature entering the match. */
  crowdStartHeat: number;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const clampHeat = (v: number): number => Math.max(5, Math.min(100, Math.round(v)));

function sideName(plan: MatchPlan, workers: Record<string, WorkerState>, side: number): string {
  const members = plan.sides[side]?.members ?? [];
  const names = members.map((id) => workers[id]?.name ?? id);
  if (names.length === 0) return `Side ${side + 1}`;
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]}'s team`;
}

function pickActor(
  rng: RngStream,
  plan: MatchPlan,
  workers: Record<string, WorkerState>,
  side: number,
): { id: string | null; name: string } {
  const members = plan.sides[side]?.members ?? [];
  if (members.length === 0) return { id: null, name: `Side ${side + 1}` };
  const id = members.length === 1 ? members[0]! : rng.pick(members);
  return { id, name: workers[id]?.name ?? id };
}

function hasStyle(workers: Record<string, WorkerState>, ids: string[], style: string): boolean {
  return ids.some((id) => workers[id]?.styles.includes(style as never));
}

export function generateMatchLog(args: MatchLogArgs): MatchMoment[] {
  const { plan, workers, durationMin } = args;
  const rng = RngStream.fromSeed(`${args.showId}/${args.segmentId}`, "match-beats");
  const log: MatchMoment[] = [];
  const nSides = plan.sides.length;
  const allIds = plan.sides.flatMap((s) => s.members);
  const winner = plan.winnerSide;
  const decisive = plan.finish === "pin" || plan.finish === "submission" || plan.finish === "ko";

  // Heat rises from the entrance temperature toward the match's reception.
  const startHeat = args.crowdStartHeat * 0.75 + 10;
  const heatAt = (t: number, spike: number): number =>
    clampHeat(startHeat + (args.reception - startHeat) * Math.min(1, t / durationMin) + spike);

  const push = (
    t: number,
    kind: MatchMoment["kind"],
    side: number | null,
    actorId: string | null,
    description: string,
    spike: number,
  ): void => {
    log.push({ t: round1(t), kind, side, actorId, description, heat: heatAt(t, spike) });
  };

  // Entrances: the bigger star enters last.
  const order = [...Array(nSides).keys()].sort((a, b) => {
    const aw = (s: number): number =>
      Math.max(0, ...(plan.sides[s]?.members ?? []).map((id) => workers[id]?.standing.awarenessNational ?? 0));
    return aw(a) - aw(b);
  });
  order.forEach((s, i) => {
    const star = Math.max(
      0,
      ...(plan.sides[s]?.members ?? []).map((id) => workers[id]?.standing.awarenessNational ?? 0),
    );
    push(0, "entrance", s, null, `${sideName(plan, workers, s)} ${i === nSides - 1 ? "enters to the biggest reaction of the night so far" : "makes the walk"}.`, star / 12);
  });

  // Opening exchange, flavored by who is in there.
  const opener = plan.intensity >= 70 || hasStyle(workers, allIds, "brawler")
    ? "They skip the handshake and start throwing — this one is a fight from the bell."
    : hasStyle(workers, allIds, "technician")
      ? "A crisp opening exchange on the mat — holds, counters, and a clean break."
      : "Collar-and-elbow at the bell; both sides feel out the early pace.";
  push(0.5, "lockup", null, null, opener, 0);

  // Body: alternating control with cutoffs/comebacks; the winner takes the
  // last stretch (unless the finish is cheap, where the loser is rolling
  // when it all goes wrong — protection the crowd can read).
  const phases = Math.max(2, Math.min(6, Math.round(durationMin / 4)));
  const bodyStart = 1.2;
  const bodyEnd = durationMin * 0.72;
  let controlSide = winner !== null ? (winner + 1) % nSides : 0;
  for (let p = 0; p < phases; p++) {
    const t = bodyStart + ((bodyEnd - bodyStart) * p) / Math.max(1, phases - 1);
    const last = p === phases - 1;
    if (last && winner !== null) controlSide = decisive ? winner : (winner + 1) % nSides;
    const actor = pickActor(rng, plan, workers, controlSide);
    const lines = [
      `${actor.name} takes over and grinds it down.`,
      `${actor.name} in control now, working with purpose.`,
      `${actor.name} slows the pace and picks the target apart.`,
      `${actor.name} strings offense together — the building leans in.`,
    ];
    push(t, "control", controlSide, actor.id, rng.pick(lines), rng.int(-3, 3));

    if (!last) {
      const nextSide = (controlSide + 1) % nSides;
      const rally = pickActor(rng, plan, workers, nextSide);
      if (rng.chance(0.45)) {
        push(
          t + (bodyEnd - bodyStart) / Math.max(1, phases - 1) / 2,
          "cutoff",
          controlSide,
          actor.id,
          `${rally.name} stirs — and ${actor.name} cuts it off cold.`,
          -4,
        );
      } else {
        push(
          t + (bodyEnd - bodyStart) / Math.max(1, phases - 1) / 2,
          "comeback",
          nextSide,
          rally.id,
          `${rally.name} fires back — the comeback is on.`,
          8,
        );
      }
      controlSide = nextSide;
    }
  }

  // High spots scale with planned risk and who can fly.
  const flyers = hasStyle(workers, allIds, "highflyer");
  const spots = Math.min(3, Math.round(plan.risk / 40) + (flyers ? 1 : 0));
  for (let s = 0; s < spots; s++) {
    const side = winner !== null && rng.chance(0.6) ? winner : rng.int(0, nSides - 1);
    const actor = pickActor(rng, plan, workers, side);
    const t = bodyStart + 1 + rng.next() * (bodyEnd - bodyStart - 1);
    const lines = flyers
      ? [
          `${actor.name} goes to the top — and connects with something enormous.`,
          `${actor.name} launches over the ropes and wipes everyone out!`,
        ]
      : [
          `${actor.name} uncorks the big one — the building comes up as one.`,
          `${actor.name} risks it all and it lands.`,
        ];
    push(t, "highspot", side, actor.id, rng.pick(lines), 10 + plan.risk / 10);
  }

  // Near-falls in the final third: better matches earn more credible ones.
  const nearfalls = Math.max(decisive ? 1 : 0, Math.min(3, Math.round(args.reception / 34)));
  for (let n = 0; n < nearfalls; n++) {
    const kickSide = winner !== null ? winner : rng.int(0, nSides - 1);
    const coverSide = (kickSide + 1) % nSides;
    const survivor = pickActor(rng, plan, workers, kickSide);
    const t = durationMin * (0.74 + 0.2 * (n / Math.max(1, nearfalls)));
    push(
      t,
      "nearfall",
      coverSide,
      null,
      n === nearfalls - 1
        ? `${survivor.name} kicks out at two-and-NINE-tenths — nobody in the building is sitting down.`
        : `${survivor.name} shoulders out at two and a half!`,
      15 + rng.int(0, 6),
    );
  }

  // The finish, exactly as booked.
  log.sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind));
  const titleTail = args.title
    ? args.titleChanged
      ? ` — and NEW ${args.title.name} holder!`
      : ` — the ${args.title.name} is retained.`
    : "";
  let finishText: string;
  if (winner === null || plan.finish === "no_contest") {
    finishText =
      plan.finish === "time_limit_draw"
        ? `The bell rings — the time limit expires with both sides still standing.${titleTail}`
        : `Chaos swallows the match whole — the referee throws it out.${titleTail}`;
  } else {
    const w = sideName(plan, workers, winner);
    const finishLines: Record<string, string> = {
      pin: `${w} hits the finish and hooks the leg — one, two, THREE.${titleTail}`,
      submission: `${w} locks it in the middle of the ring — there's the tap.${titleTail}`,
      ko: `${w} flattens them — the referee waves it off.${titleTail}`,
      dq: `A blatant shortcut in full view — ${w} wins it by disqualification.${titleTail}`,
      countout: `The count reaches ten — ${w} takes it on the floor.${titleTail}`,
      time_limit_draw: `The bell rings on the time limit.${titleTail}`,
      no_contest: `No contest.${titleTail}`,
    };
    finishText = finishLines[plan.finish] ?? finishLines["pin"]!;
  }
  push(durationMin, "finish", winner, null, finishText, decisive ? 18 : -6);

  return log;
}
