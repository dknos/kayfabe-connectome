import type { Segment, SimState, ShowPlan } from "@kayfabe/sim-contract";

/**
 * Booking validation shared by the player UI path and AI-generated cards.
 * Returns problems; an empty array means the card is bookable. These are
 * the BOOKING INVARIANTS from the test plan — AI cards pass through the
 * same gate as player cards.
 */
export function validateCard(
  state: SimState,
  show: ShowPlan,
  segments: Segment[],
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const seg of segments) {
    const label = `segment ${seg.id}`;
    if (seg.durationMin <= 0) errors.push(`${label}: duration must be positive`);
    if (seg.kind === "match") {
      const match = seg.match;
      if (!match) {
        errors.push(`${label}: match segment without match plan`);
        continue;
      }
      if (match.sides.length < 2) errors.push(`${label}: a match needs at least two sides`);
      if (match.sides.some((s) => s.members.length === 0)) {
        errors.push(`${label}: every side needs at least one participant`);
      }
      const finishNeedsWinner = match.finish !== "no_contest" && match.finish !== "time_limit_draw";
      if (finishNeedsWinner) {
        if (
          match.winnerSide === null ||
          match.winnerSide < 0 ||
          match.winnerSide >= match.sides.length
        ) {
          errors.push(`${label}: winner must be one of the match's sides`);
        }
      }
      if (match.titleId !== null) {
        const title = state.titles[match.titleId];
        if (!title) errors.push(`${label}: unknown title ${match.titleId}`);
        else if (title.companyId !== show.companyId) {
          errors.push(`${label}: ${title.name} belongs to another company`);
        }
      }
      for (const side of match.sides) {
        for (const pid of side.members) checkParticipant(pid, label);
      }
    } else {
      const angle = seg.angle;
      if (!angle || angle.beats.length === 0) {
        errors.push(`${label}: angle segment needs at least one beat`);
        continue;
      }
      for (const beat of angle.beats) {
        if (beat.durationMin <= 0) errors.push(`${label}: beat duration must be positive`);
        if (beat.participants.length === 0) {
          errors.push(`${label}: beat needs participants`);
        }
        for (const p of beat.participants) checkParticipant(p.personId, label, true);
      }
    }
  }

  function checkParticipant(pid: string, label: string, allowRepeat = false): void {
    const worker = state.workers[pid];
    if (!worker) {
      errors.push(`${label}: unknown worker ${pid}`);
      return;
    }
    if (worker.condition.injury && worker.condition.injury.outUntil > show.date) {
      errors.push(`${label}: ${worker.name} is injured until ${worker.condition.injury.outUntil}`);
    }
    const hasContract = Object.keys(state.contracts)
      .sort()
      .some((cid) => {
        const c = state.contracts[cid]!;
        return c.personId === pid && c.companyId === show.companyId && c.status === "active";
      });
    if (!hasContract) errors.push(`${label}: ${worker.name} is not under contract here`);
    if (!allowRepeat) {
      if (seen.has(pid)) errors.push(`${label}: ${worker.name} is already in another match on this card`);
      seen.add(pid);
    }
  }

  return errors;
}
