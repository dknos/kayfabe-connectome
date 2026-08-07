/**
 * ai-booker@1 — the rival-company AI. One call per AI company per
 * simulated day; the engine applies the returned actions through the same
 * validation gates as player commands. Pure: never mutates the context;
 * randomness only via the dedicated company rng stream; every Record is
 * iterated in sorted-key order. Rules doc: docs/simulator/rules/ai.md.
 */
import type { AiActions, AiTickContext } from "./types";
import { planSchedule } from "./scheduling";
import { maintainPrograms } from "./programs";
import { planCards } from "./cards";
import { upkeepRoster } from "./roster";

export type { AiActions, AiContractOffer, AiTickContext, NewShow } from "./types";
export { buildCardForShow } from "./cards";

export function aiDailyTick(ctx: AiTickContext): AiActions {
  // Fixed subsystem order keeps the rng draw sequence stable:
  // scheduling draws nothing (hash-rotated), then programs, cards, roster.
  const schedule = planSchedule(ctx);
  const programs = maintainPrograms(ctx, schedule.shows);
  const cards = planCards(ctx, programs.programs);
  const roster = upkeepRoster(ctx);

  return {
    scheduleShows: schedule.shows,
    cardUpdates: cards.updates,
    programUpdates: programs.programs,
    releaseContractIds: roster.releases,
    offers: roster.offers,
    decisions: [
      ...schedule.decisions,
      ...programs.decisions,
      ...cards.decisions,
      ...roster.decisions,
    ],
  };
}
