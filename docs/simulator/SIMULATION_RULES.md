# THE BOOK — Simulation Rules

Umbrella document for the engine's numerical systems. Every formula here is original,
bounded, and covered by tests; each subsystem's full derivation lives in its own rules
file, written alongside the code that implements it:

| System | Version | Rules document | Implementation | Tests |
|---|---|---|---|---|
| Ratings seeding | `evidence-seeder@1` | [rules/seeder.md](rules/seeder.md) | `sim-core/src/seeder/` | `test/seeder.test.ts` |
| Crowd & segment evaluation | `crowd-flow@1`, `segment-eval@1` | [rules/show.md](rules/show.md) | `sim-core/src/show/` | `test/show.test.ts` |
| Attendance & money | `attendance-demand@1`, `ledger@1` | [rules/finance.md](rules/finance.md) | `sim-core/src/finance/` | `test/finance.test.ts` |
| Contract negotiation | `negotiation@1` | [rules/negotiation.md](rules/negotiation.md) | `sim-core/src/market/` | `test/market.test.ts` |
| AI booking | `ai-booker@1` | [rules/ai.md](rules/ai.md) | `sim-core/src/ai/` | `test/ai.test.ts` |
| Snapshot & rosters | `snapshot-builder@1`, `roster-infer@1` | [HISTORICAL_SNAPSHOTS.md](HISTORICAL_SNAPSHOTS.md) | `history-adapter/src/` | adapter tests |

## Cross-cutting principles

1. **Bounded, explainable, never raw addition.** Scores compose through normalized
   components with soft nonlinear transforms; every player-facing number decomposes into
   labeled `ScoreComponent`s.
2. **Execution vs reception.** A segment is first *performed* (worker execution of their
   actual roles) and then *received* (execution measured against expectation, stakes,
   affinity, novelty, product alignment, pacing). A company is graded against its own
   Product DNA, not a universal taste.
3. **Separate audience quantities.** Awareness ≠ affinity ≠ momentum ≠ credibility ≠
   prestige. Drawing power derives from combinations, never one popularity scalar.
4. **Missing data is not zero.** Sparse evidence widens confidence, never lowers value.
5. **Determinism.** All randomness through named seeded streams; no wall clock; no
   float money; sorted iteration; state hashes reproduce across save/load.
6. **The plan decides finishes.** The simulation grades booking; it never overrides a
   booked winner. Titles change hands only through booked title matches (DQ/count-out
   protects the champion) or explicit administrative action.
