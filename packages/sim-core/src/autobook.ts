import type { ContractState, PersonId, Segment, SimState } from "@kayfabe/sim-contract";
import { buildCardForShow } from "./ai";
import { resolveEra } from "./finance";
import { RngStream } from "./rng";
import { sortedKeys } from "./ids";

/**
 * Player-facing auto-book (autobook@1): fill one show's card through the
 * same booking philosophy the AI uses — programs respected, roster rotated,
 * no double-booking. Pure: never mutates state, never consumes the engine's
 * RNG streams (its stream derives from the show id, so auto-booking the
 * same show in the same universe always proposes the same card, and the
 * player is free to edit every segment before saving).
 */
export function autoBookCard(
  state: SimState,
  showId: string,
): { segments: Segment[]; advertised: PersonId[] } | null {
  const show = state.shows[showId];
  if (!show || show.status !== "scheduled") return null;
  const company = state.companies[show.companyId];
  if (!company) return null;

  const contractsByCompany: Record<string, ContractState[]> = {};
  for (const cid of sortedKeys(state.companies)) contractsByCompany[cid] = [];
  for (const id of sortedKeys(state.contracts)) {
    const c = state.contracts[id]!;
    if (c.status === "active") (contractsByCompany[c.companyId] ??= []).push(c);
  }

  let seq = 0;
  const built = buildCardForShow(
    {
      company,
      date: state.currentDate,
      workers: state.workers,
      contractsByCompany,
      titles: state.titles,
      shows: state.shows,
      venues: state.venues,
      markets: state.markets,
      era: resolveEra(state.currentDate),
      rng: RngStream.fromSeed(state.meta.worldSeed, `autobook:${showId}`),
      nextId: (prefix) => `${prefix}-a${++seq}`,
    },
    show,
    company.programs,
  );
  return built;
}
