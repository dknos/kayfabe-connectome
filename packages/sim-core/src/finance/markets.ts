/**
 * Original market dataset (see docs/simulator/DATA_CONTRACT.md §2.3),
 * validated once at module load and exposed sorted by id so every consumer
 * iterates it in the same order.
 */

import type { Market } from "@kayfabe/sim-contract";
import marketsJson from "../data/markets.json";

type RawMarket = (typeof marketsJson)["markets"][number];

function parseMarket(raw: RawMarket): Market {
  if (!Number.isSafeInteger(raw.population) || raw.population <= 0) {
    throw new Error(`markets: bad population for ${raw.id}`);
  }
  return {
    id: raw.id,
    name: raw.name,
    region: raw.region,
    population: raw.population,
    wrestlingInterest: raw.wrestlingInterest,
    economicStrength: raw.economicStrength,
  };
}

export const MARKETS: readonly Market[] = marketsJson.markets
  .map(parseMarket)
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
