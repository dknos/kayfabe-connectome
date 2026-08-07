import type { Market } from "@kayfabe/sim-contract";
// Markets are owned by sim-core (DATA_CONTRACT §2.3). The adapter reads the
// dataset directly rather than importing sim-core code: ARCHITECTURE.md keeps
// history-adapter off sim-core so the seeder stays an injected black box.
import marketsData from "../../sim-core/src/data/markets.json";

export function loadMarkets(): Market[] {
  return [...marketsData.markets].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * City/state keywords -> market id, for mapping corpus `loc` strings
 * ("Philadelphia, Pennsylvania") onto the market dataset. First hit wins;
 * entries are ordered most-specific-first so "New York" beats state matches.
 */
const MARKET_KEYWORDS: [string, string][] = [
  ["new york", "mkt:nyc"],
  ["brooklyn", "mkt:nyc"],
  ["queens", "mkt:nyc"],
  ["new jersey", "mkt:nyc"],
  ["long island", "mkt:nyc"],
  ["philadelphia", "mkt:philadelphia"],
  ["boston", "mkt:boston"],
  ["massachusetts", "mkt:boston"],
  ["connecticut", "mkt:boston"],
  ["rhode island", "mkt:boston"],
  ["new hampshire", "mkt:boston"],
  ["maine", "mkt:boston"],
  ["atlanta", "mkt:atlanta"],
  ["georgia", "mkt:atlanta"],
  ["alabama", "mkt:atlanta"],
  ["tennessee", "mkt:atlanta"],
  ["charlotte", "mkt:carolinas"],
  ["carolina", "mkt:carolinas"],
  ["virginia", "mkt:carolinas"],
  ["florida", "mkt:florida"],
  ["orlando", "mkt:florida"],
  ["miami", "mkt:florida"],
  ["tampa", "mkt:florida"],
  ["chicago", "mkt:chicago"],
  ["illinois", "mkt:chicago"],
  ["michigan", "mkt:chicago"],
  ["ohio", "mkt:chicago"],
  ["indiana", "mkt:chicago"],
  ["wisconsin", "mkt:chicago"],
  ["minnesota", "mkt:chicago"],
  ["st. louis", "mkt:stlouis"],
  ["missouri", "mkt:stlouis"],
  ["kansas", "mkt:stlouis"],
  ["iowa", "mkt:stlouis"],
  ["texas", "mkt:texas"],
  ["dallas", "mkt:texas"],
  ["houston", "mkt:texas"],
  ["san antonio", "mkt:texas"],
  ["oklahoma", "mkt:texas"],
  ["louisiana", "mkt:texas"],
  ["arkansas", "mkt:texas"],
  ["los angeles", "mkt:losangeles"],
  ["california", "mkt:losangeles"],
  ["nevada", "mkt:losangeles"],
  ["arizona", "mkt:losangeles"],
  ["seattle", "mkt:pacificnw"],
  ["portland", "mkt:pacificnw"],
  ["washington", "mkt:pacificnw"],
  ["oregon", "mkt:pacificnw"],
  ["toronto", "mkt:toronto"],
  ["ontario", "mkt:toronto"],
  ["pennsylvania", "mkt:philadelphia"],
];

/** Match a corpus location string to a market id, or null when nothing hits. */
export function marketForLocation(loc: string): string | null {
  const lower = loc.toLowerCase();
  for (const [keyword, marketId] of MARKET_KEYWORDS) {
    if (lower.includes(keyword)) return marketId;
  }
  return null;
}
