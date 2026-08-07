/**
 * Numeric helpers shared by the show simulation. All curves are rational
 * (no Math.tanh/exp) so results are bit-identical across JS engines; these
 * numbers end up inside hashed save state.
 */
import type { PersonId, ScoreComponent, WorkerState } from "@kayfabe/sim-contract";
import { hashString } from "../hash";

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp100(v: number): number {
  return clamp(v, 0, 100);
}

/** One-decimal rounding; every reported score, delta and crowd axis uses it. */
export function r1(v: number): number {
  const r = Math.round(v * 10) / 10;
  return r === 0 ? 0 : r; // normalize -0 so canonical JSON stays stable
}

/** Softsign: tanh-like S-curve into (−1, 1). */
export function soft(x: number): number {
  return x / (1 + Math.abs(x));
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error("show sim: mean of empty list");
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

/** Deterministic pairwise chemistry proxy, integer −3..+3. */
export function chemistryPair(a: string, b: string): number {
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  return (parseInt(hashString(`chem|${key}`).slice(0, 8), 16) % 7) - 3;
}

export function getWorker(
  workers: Record<PersonId, WorkerState>,
  id: PersonId,
): WorkerState {
  const w = workers[id];
  if (!w) throw new Error(`show sim: unknown worker ${id}`);
  return w;
}

/**
 * Finalize an additive score: round parts, drop zeros, clamp the sum to
 * 0–100 and absorb any clamping into a visible component so the parts
 * always sum (to rounding) to the reported score.
 */
export function finalizeScore(parts: ScoreComponent[]): {
  score: number;
  components: ScoreComponent[];
} {
  const components = parts
    .map((c) => ({ ...c, value: r1(c.value) }))
    .filter((c) => c.value !== 0);
  let sum = 0;
  for (const c of components) sum += c.value;
  const clamped = clamp100(sum);
  if (Math.abs(clamped - sum) >= 0.05) {
    components.push({
      label: "Score bounded",
      value: r1(clamped - sum),
      note: "score clamped to the 0–100 scale",
    });
  }
  return { score: r1(clamped), components };
}
