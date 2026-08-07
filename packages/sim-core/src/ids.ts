import type { SimState } from "@kayfabe/sim-contract";

/**
 * Deterministic ID minting: per-prefix counters stored in state. IDs sort
 * lexicographically in creation order, which keeps sorted-key iteration
 * aligned with causality.
 */
export function nextId(state: SimState, prefix: string): string {
  const n = (state.counters[prefix] ?? 0) + 1;
  state.counters[prefix] = n;
  return `${prefix}-${String(n).padStart(6, "0")}`;
}

/** Sorted keys of a record — the only sanctioned way to iterate state maps. */
export function sortedKeys<T>(rec: Record<string, T>): string[] {
  return Object.keys(rec).sort();
}

export function sortedValues<T>(rec: Record<string, T>): T[] {
  return sortedKeys(rec).map((k) => rec[k]!);
}
