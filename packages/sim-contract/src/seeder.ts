import type {
  Alignment,
  AttributeKey,
  SeededAttribute,
  WorkerStyle,
} from "./core";
import type { EvidenceSummary } from "./snapshot";

/**
 * Result of seeding one worker from pre-start evidence.
 * Implemented by @kayfabe/sim-core (evidence-seeder@1); injected into
 * @kayfabe/history-adapter's snapshot builder so the two packages stay
 * decoupled (adapter never depends on sim-core).
 */
export interface WorkerSeedResult {
  attributes: Record<AttributeKey, SeededAttribute>;
  awarenessNational: number;
  affinityNational: number;
  credibility: number;
  prestige: number;
  styles: WorkerStyle[];
  alignment: Alignment;
}

export type WorkerSeeder = (evidence: EvidenceSummary) => WorkerSeedResult;
