/**
 * Typed access to the generated spike corpus.
 *
 * Built by tests/arena-spikes/build-spike-corpus.mjs and served through the
 * dev server's existing read-only /data/ route. Every field here is real
 * corpus evidence — names carry their real lengths, strengths carry their real
 * long tail, and positions are the canonical global-layout@3 coordinates.
 */

export interface SpikeCard {
  id: string;
  name: string;
  /** person scope: which semantic bank the documented relationship puts them in */
  bank?: "opposed" | "same" | "mixed";
  same?: number;
  opposed?: number;
  br?: number;
  titleMatches?: number;
  strength: number;
  firstYear: number;
  lastYear: number;
  /** promotion scope: decade of the person's span INSIDE this promotion */
  era?: string;
  careerFirstYear?: number;
  scopedMatches?: number;
  pos: [number, number, number] | null;
  community: number;
  reigns: number;
}

export interface SpikeScope {
  kind: "person" | "promotion";
  anchorId?: string;
  anchorName?: string;
  promotionId?: string;
  promotionName?: string;
  hasPromoBit?: boolean;
  total: number;
  banks?: { opposed: number; same: number; mixed: number };
  eraCounts?: Record<string, number>;
  eraDiffersFromGlobalDebut?: number;
  singleMatchTail?: number;
  strongTen?: number;
  atlas?: { matches: number; cards: number; people: number; titles: number; yearFrom: number; yearCounts: number[] } | null;
  cards: SpikeCard[];
}

export interface SpikeCorpus {
  version: number;
  generator: string;
  nameLengths: { min: number; p50: number; p90: number; p99: number; max: number };
  budgets: number[];
  scopes: Record<string, SpikeScope>;
}

export async function loadSpikeCorpus(): Promise<SpikeCorpus> {
  const response = await fetch("/data/arena-spike/corpus.json");
  if (!response.ok) {
    throw new Error(
      `spike corpus missing (${response.status}) — run: node tests/arena-spikes/build-spike-corpus.mjs`,
    );
  }
  return (await response.json()) as SpikeCorpus;
}

/**
 * A budget slice. The corpus is already sorted matches-desc-then-id, so a
 * prefix is both the strongest cards and a deterministic set — the same slice
 * every run, which is what makes a measurement comparable across spikes.
 */
export function budgetSlice(scope: SpikeScope, budget: number): SpikeCard[] {
  return scope.cards.slice(0, budget);
}
